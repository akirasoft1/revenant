"""hangar-service WRITE client for voice chat edits (spec
docs/superpowers/specs/2026-10-09-hangar-chat-edits-design.md).

Backs the three local Live tools `hangar_fit`, `hangar_add_ship` and
`hangar_reset`. The acting member is NEVER a tool argument: `call()` takes it
as its own positional parameter, which `LiveBridge` fills from trusted
plumbing (the current SetSpeaker user id, else the SessionStart opener). The
model's `args` are only ever read for ship/item/slot/vehicle/nickname -- a
`member_id` the model invents is ignored. The id goes into both the URL path
and `X-Acting-Member`, so hangar-service's write rule (acting member == path
member) makes these calls unable to touch anyone else's hangar.

Auth: hangar-service runs with Cloud Run's invoker IAM check OFF
(`--no-invoker-iam-check`, since the web editor) -- the APP authenticates every
`/v1` call itself, so every call still carries a Google-signed ID token minted
from the mounted `hangar-api-sa` key with `target_audience` = HANGAR_API_URL
exactly (the app checks audience + allow-listed caller email). Minting is blocking (google-auth + requests), so it
runs in a thread, single-flight, cached until 5 minutes before expiry. (Same
shape as sc-knowledge/src/hangar.py, which is the read-only side.)

Never raises (except cancellation): every failure is a `{error, message}`
dict for the model, mirroring hangar-service's own envelope, which is passed
through unchanged for any 4xx (so `ambiguous`/`choose_slot`/`not_found`/
`incompatible` reach the model with their `field`/`candidates`/`slots`/
`owned`/`suggestions`). Bound: token + request share one `timeout_s` (5s); the
bridge additionally caps the whole tool call at 6s.

Every tool is a WRITE, so a timeout after the request went out cannot say
whether it landed: that case returns `MAYBE_APPLIED` (`maybe_applied: true`)
and the prompt tells the model to check before retrying -- a blind retry of
`hangar_add_ship` would add a second ship. A failure before anything was sent
(token mint, connect) is a plain `unavailable`. `prewarm()` mints the ID token
at startup so the first edit doesn't pay for it inside the voice bound.
"""
import asyncio
import logging
import re
import time
from datetime import timezone
from typing import Any, Callable
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

_TOKEN_REFRESH_MARGIN_S = 300.0
_DEFAULT_TIMEOUT_S = 5.0
_MEMBER_ID = re.compile(r"\d{1,25}")

FIT_TOOL = "hangar_fit"
ADD_SHIP_TOOL = "hangar_add_ship"
RESET_TOOL = "hangar_reset"
TOOL_NAMES = frozenset({FIT_TOOL, ADD_SHIP_TOOL, RESET_TOOL})

UNKNOWN_SPEAKER = {
    "error": "unknown_speaker",
    "message": ("I can't tell who's speaking, so I can't edit a hangar right now \u2014 use "
                "text chat or the web editor."),
}
MAYBE_APPLIED = {
    "error": "unavailable",
    "maybe_applied": True,
    "message": ("The hangar service didn't answer in time \u2014 the change may have been "
                "saved; check before retrying"),
}


def valid_member_id(member_id) -> bool:
    return isinstance(member_id, str) and bool(_MEMBER_ID.fullmatch(member_id))


class HangarUnavailable(Exception):
    """Could not mint an ID token for hangar-service."""


def _default_credentials_factory(key_path: str, audience: str):
    from google.oauth2 import service_account
    return service_account.IDTokenCredentials.from_service_account_file(
        key_path, target_audience=audience)


def _default_request_factory():
    import google.auth.transport.requests
    return google.auth.transport.requests.Request()


class IdTokenProvider:
    """Google ID token for `audience`, minted from a service-account key."""

    def __init__(self, key_path: str, audience: str, *,
                 credentials_factory: Callable[[str, str], Any] = _default_credentials_factory,
                 request_factory: Callable[[], Any] = _default_request_factory,
                 clock: Callable[[], float] = time.time,
                 refresh_margin_s: float = _TOKEN_REFRESH_MARGIN_S) -> None:
        self._key_path = key_path
        self._audience = audience
        self._credentials_factory = credentials_factory
        self._request_factory = request_factory
        self._clock = clock
        self._margin = refresh_margin_s
        self._creds = None
        self._token: str | None = None
        self._expires_at = 0.0
        self._refresh: asyncio.Future | None = None

    def _fresh(self) -> bool:
        return self._token is not None and self._expires_at - self._clock() > self._margin

    def _mint(self) -> tuple[str, float]:
        # Runs in a worker thread (google-auth refresh is blocking I/O).
        if self._creds is None:
            self._creds = self._credentials_factory(self._key_path, self._audience)
        self._creds.refresh(self._request_factory())
        expiry = self._creds.expiry
        expires_at = (expiry.replace(tzinfo=timezone.utc).timestamp() if expiry is not None
                      else self._clock() + 3600)
        return self._creds.token, expires_at

    async def _do_refresh(self) -> str:
        try:
            token, expires_at = await asyncio.to_thread(self._mint)
        except Exception as e:
            # Never log the token; the key path and audience are not secret.
            logger.warning("hangar edit ID-token mint failed (key %s, audience %s): %s: %s",
                           self._key_path, self._audience, type(e).__name__, e, exc_info=True)
            raise HangarUnavailable(
                f"could not mint an ID token from {self._key_path} for {self._audience}: "
                f"{type(e).__name__}: {e}") from e
        self._token, self._expires_at = token, expires_at
        return token

    async def token(self) -> str:
        if self._fresh():
            return self._token  # type: ignore[return-value]
        # Single-flight; shield() so a caller's timeout abandons its WAIT,
        # not the mint -- the token still lands in the cache.
        if self._refresh is None or self._refresh.done():
            self._refresh = asyncio.ensure_future(self._do_refresh())
        return await asyncio.shield(self._refresh)


def _text(args: dict, key: str) -> str | None:
    v = args.get(key)
    if isinstance(v, str) and v.strip():
        return v.strip()
    return None


def _invalid(message: str) -> dict:
    return {"error": "invalid_request", "message": message}


def _unavailable(message: str) -> dict:
    return {"error": "unavailable", "message": message}


class HangarEditClient:
    """POST-only hangar-service client for the three chat-edit tools."""

    def __init__(self, base_url: str, tokens, *, transport: httpx.AsyncBaseTransport | None = None,
                 timeout_s: float = _DEFAULT_TIMEOUT_S) -> None:
        self._base = base_url.rstrip("/")
        self._tokens = tokens
        self._timeout = timeout_s
        self._http = httpx.AsyncClient(base_url=self._base, timeout=httpx.Timeout(timeout_s),
                                       transport=transport,
                                       headers={"Accept": "application/json"})

    async def call(self, name: str, member_id, args: dict) -> dict:
        """Run one edit tool for `member_id` (bound by the caller, never the
        model). Returns the server JSON or an `{error, message, ...}` dict."""
        if name not in TOOL_NAMES:
            return {"error": "unknown_tool", "message": f"no such tool: {name}"}
        if not valid_member_id(member_id):
            return dict(UNKNOWN_SPEAKER)
        args = args if isinstance(args, dict) else {}
        if name == FIT_TOOL:
            ship, item = _text(args, "ship"), _text(args, "item")
            if not ship or not item:
                return _invalid("hangar_fit needs the ship and the item that was fitted")
            body = {"ship": ship, "item": item}
            slot = _text(args, "slot")
            if slot:
                body["slot"] = slot
            return await self._post(f"/v1/members/{member_id}/fit", member_id, body)
        if name == ADD_SHIP_TOOL:
            vehicle = _text(args, "vehicle")
            if not vehicle:
                return _invalid("hangar_add_ship needs the ship model that was bought")
            body = {"vehicle": vehicle}
            nickname = _text(args, "nickname")
            if nickname:
                body["nickname"] = nickname
            out = await self._post(f"/v1/members/{member_id}/ships", member_id, body)
            if "error" in out:
                return out
            # The full Ship carries the whole loadout (dozens of slots) --
            # noise in a Live audio context. The model only needs to confirm.
            ship = out.get("ship") if isinstance(out.get("ship"), dict) else {}
            return {"added": True, "ship": {"shipId": ship.get("shipId"),
                                            "vehicle": ship.get("vehicleName"),
                                            "nickname": ship.get("nickname")}}
        # RESET_TOOL
        ship, slot = _text(args, "ship"), _text(args, "slot")
        if not ship:
            return _invalid("hangar_reset needs the ship to put back to stock")
        if not slot:
            return _invalid("hangar_reset needs a slot -- ask which part to reset, or pass \"all\" "
                            "for the whole ship")
        if "/" in ship:
            return _invalid("a ship name can't contain '/'")
        return await self._post(f"/v1/members/{member_id}/ships/{quote(ship, safe='')}/reset",
                                member_id, {"slot": slot})

    async def prewarm(self) -> None:
        """Mint (and cache) the ID token now. Never raises: a failure is
        logged and the first edit simply retries."""
        try:
            async with asyncio.timeout(self._timeout):
                await self._tokens.token()
            logger.info("hangar edit: ID token prewarmed")
        except Exception as e:  # noqa: BLE001
            logger.warning("hangar edit: ID token prewarm failed (%s: %s); the first edit will "
                           "retry", type(e).__name__, e)

    async def _post(self, path: str, member_id: str, body: dict) -> dict:
        sent = False
        try:
            async with asyncio.timeout(self._timeout):
                token = await self._tokens.token()
                sent = True   # from here on the write may reach the service
                resp = await self._http.request(
                    "POST", path, json=body,
                    headers={"Authorization": f"Bearer {token}", "X-Acting-Member": member_id})
        except TimeoutError:
            if sent:
                return dict(MAYBE_APPLIED)
            return _unavailable(f"hangar-service POST {path} timed out after {self._timeout}s")
        except HangarUnavailable as e:
            return _unavailable(str(e))
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            return _unavailable(f"hangar-service POST {path} failed: {type(e).__name__}: {e}")
        except httpx.TimeoutException:
            return dict(MAYBE_APPLIED)   # read/write/pool timeout after the request started
        except httpx.HTTPError as e:
            return _unavailable(f"hangar-service POST {path} failed: {type(e).__name__}: {e}")
        except Exception as e:  # noqa: BLE001 - never raise into the tool path
            return _unavailable(f"hangar-service POST {path} failed: {type(e).__name__}: {e}")
        try:
            data = resp.json()
        except ValueError:
            data = None
        status = resp.status_code
        if status < 400 and isinstance(data, dict):
            return data
        if status in (401,):
            # OUR credentials were rejected (wrong audience, SA not
            # allow-listed): a deploy problem, not something the speaker did.
            logger.warning("hangar-service POST %s -> 401: %s", path,
                           data.get("message") if isinstance(data, dict) else resp.text)
            return _unavailable("hangar-service rejected the voice sidecar's credentials")
        if status < 500 and isinstance(data, dict) and isinstance(data.get("error"), str):
            return data          # the service's own envelope, untouched
        if isinstance(data, dict) and isinstance(data.get("error"), str):
            return data          # 5xx with an envelope (`unavailable`)
        return _unavailable(f"hangar-service POST {path} returned HTTP {status}")

    async def aclose(self) -> None:
        await self._http.aclose()


def build_hangar_edit_client(config) -> HangarEditClient | None:
    """None unless HANGAR_EDITS_ENABLED (which requires HANGAR_API_URL)."""
    if not getattr(config, "hangar_edits_enabled", False) or not getattr(config, "hangar_api_url", None):
        return None
    tokens = IdTokenProvider(config.hangar_sa_key_path, config.hangar_api_url)
    return HangarEditClient(config.hangar_api_url, tokens)
