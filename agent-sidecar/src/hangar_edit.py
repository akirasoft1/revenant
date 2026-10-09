"""Hangar chat edits for the text agent (2026-10-09 hangar-chat-edits spec).

Three ADK function tools -- `hangar_fit(ship, item, slot=None)`,
`hangar_add_ship(vehicle, nickname=None)`, `hangar_reset(ship, slot)` -- that
record a change the SPEAKER made to their own Star Citizen hangar by calling
hangar-service.

The acting member is bound in code, never by the model: `HangarEditTools` is
built once per turn with the turn's `ChatRequest.user_id` (the Discord ID the
bot sends for the message's author), the same way `RunInSandboxTool` binds
`user_id`. No tool has a member parameter, so "put a Hemera in Micro's Titan"
can only ever touch the speaker's hangar (the ship text then fails to resolve
there). An empty or non-numeric user_id means we can't tell whose hangar it
is: every tool refuses with `unknown_speaker` without calling the service.

Auth: hangar-service is a Cloud Run service with invoker IAM on; every call
carries a Google ID token minted from the `hangar-api@` service-account key
(`HANGAR_SA_KEY_PATH`) with audience exactly `HANGAR_API_URL`, plus
`X-Acting-Member: <bound user_id>` -- the service only lets a member write
their own hangar. Minting is blocking (google-auth), so it runs in a thread,
single-flight, cached until 5 minutes before expiry (same pattern as
sc-knowledge/src/hangar.py, whose client is GET-only; this one writes).

Bounds: one call (token + request) is capped at 5s. Nothing here raises: a
service error envelope `{error, message, ...}` (choose_slot + slots,
ambiguous + field ("ship"|"item") + candidates, not_found + owned/suggestions, incompatible +
reason, forbidden, unavailable, invalid_request, ...) is handed back to the
model verbatim; transport failures, timeouts, non-JSON replies and token
problems become `{error: "unavailable", message}`.
"""
import asyncio
import logging
import re
import time
from datetime import timezone
from typing import Any, Callable
from urllib.parse import quote

import httpx

log = logging.getLogger(__name__)

EDIT_TOOL_NAMES = ("hangar_fit", "hangar_add_ship", "hangar_reset")

_TOKEN_REFRESH_MARGIN_S = 300.0
_DEFAULT_TIMEOUT_S = 5.0
_DISCORD_ID = re.compile(r"\d{1,32}")


class HangarTokenError(Exception):
    """Could not mint an ID token (missing/bad key, Google unreachable)."""


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
        # Worker thread: google-auth refresh is blocking I/O.
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
        except Exception as e:  # noqa: BLE001
            log.warning("hangar edit ID-token mint failed (key %s, audience %s): %s: %s",
                        self._key_path, self._audience, type(e).__name__, e)
            raise HangarTokenError(
                f"could not mint an ID token from {self._key_path} for {self._audience}: "
                f"{type(e).__name__}: {e}") from e
        self._token, self._expires_at = token, expires_at
        return token

    async def token(self) -> str:
        if self._fresh():
            return self._token  # type: ignore[return-value]
        # Single-flight; shield() so a caller's timeout abandons its wait,
        # not the mint -- the token still lands in the cache.
        if self._refresh is None or self._refresh.done():
            self._refresh = asyncio.ensure_future(self._do_refresh())
        return await asyncio.shield(self._refresh)


def _unavailable(message: str) -> dict:
    return {"error": "unavailable", "message": message}


class HangarEditClient:
    """POST-only hangar-service client for chat edits. Never raises."""

    def __init__(self, base_url: str, tokens, *, transport: httpx.AsyncBaseTransport | None = None,
                 timeout_s: float = _DEFAULT_TIMEOUT_S) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self._tokens = tokens
        self._http = httpx.AsyncClient(base_url=self.base_url, timeout=httpx.Timeout(timeout_s),
                                       transport=transport,
                                       headers={"Accept": "application/json"})

    @classmethod
    def from_config(cls, config) -> "HangarEditClient | None":
        """The production client when hangar edits are enabled, else None."""
        if not getattr(config, "hangar_edits_enabled", False) or not getattr(config, "hangar_api_url", None):
            return None
        url = config.hangar_api_url
        # The token audience must equal hangar-service's HANGAR_AUDIENCE byte
        # for byte: use HANGAR_API_URL exactly as configured.
        return cls(url, IdTokenProvider(config.hangar_sa_key_path, url))

    async def aclose(self) -> None:
        await self._http.aclose()

    async def post(self, path: str, member: str, body: dict) -> dict:
        """POST `body` as `member`; returns the JSON reply or an error envelope."""
        try:
            async with asyncio.timeout(self.timeout_s):
                token = await self._tokens.token()
                resp = await self._http.post(
                    path, json=body,
                    headers={"Authorization": f"Bearer {token}", "X-Acting-Member": member})
        except TimeoutError:
            return _unavailable(f"hangar-service POST {path} timed out after {self.timeout_s}s")
        except HangarTokenError as e:
            return _unavailable(str(e))
        except httpx.HTTPError as e:
            return _unavailable(f"hangar-service POST {path} failed: {type(e).__name__}: {e}")
        except Exception as e:  # noqa: BLE001 -- never raise into the agent turn
            return _unavailable(f"hangar-service POST {path} failed: {type(e).__name__}: {e}")
        try:
            data = resp.json()
        except ValueError:
            data = None
        if 200 <= resp.status_code < 300 and isinstance(data, dict):
            return data
        if isinstance(data, dict) and data.get("error"):
            return data
        return _unavailable(f"hangar-service POST {path} answered HTTP {resp.status_code} "
                            "without a usable JSON body")


def _result_code(out: dict) -> str:
    if out.get("error"):
        return str(out["error"])
    return "unchanged" if out.get("unchanged") is True else "ok"


def _changes_text(out: dict) -> str:
    changes = out.get("changes")
    if isinstance(changes, list) and changes:
        return "; ".join(
            f"{c.get('slot')}: {((c.get('from') or {}).get('name')) or 'empty'} -> "
            f"{((c.get('to') or {}).get('name')) or 'empty'}"
            for c in changes if isinstance(c, dict))
    ship = out.get("ship")
    if isinstance(ship, dict) and ship.get("shipId") and "changes" not in out:
        return f"added shipId {ship.get('shipId')} ({ship.get('vehicleName')})"
    return "-"


class HangarEditTools:
    """The three edit tools for ONE turn, bound to that turn's speaker."""

    def __init__(self, client: HangarEditClient, *, user_id: str | None) -> None:
        self._client = client
        uid = (user_id or "").strip()
        self._member = uid if _DISCORD_ID.fullmatch(uid) else None
        self._raw_user_id = user_id
        # Every call this turn: [{"name", "args", "result"}] (result = "ok",
        # "unchanged" or the error code). The eval scores on these.
        self.calls: list[dict] = []
        # Successful writes that changed something (2xx and not `unchanged`).
        self.edits = 0

    async def _call(self, name: str, args: dict, path_for: Callable[[str], str], body: dict,
                    local_error: dict | None = None) -> dict:
        if self._member is None:
            out = {"error": "unknown_speaker",
                   "message": "I can't tell whose hangar to edit (no Discord user id for this "
                              "message), so nothing was changed."}
        elif local_error is not None:
            out = local_error
        else:
            out = await self._client.post(path_for(self._member), self._member, body)
        code = _result_code(out)
        if code == "ok":
            self.edits += 1
        self.calls.append({"name": name, "args": dict(args), "result": code})
        log.info("hangar edit: tool=%s member=%s args=%s result=%s changes=%s message=%s",
                 name, self._member or f"<unknown speaker {self._raw_user_id!r}>", args, code,
                 _changes_text(out), out.get("message", "-") if code not in ("ok", "unchanged") else "-")
        return out

    def functions(self) -> list:
        async def hangar_fit(ship: str, item: str, slot: str | None = None) -> dict:
            """Record that the SPEAKER fitted an item to one of their OWN ships (writes their hangar).

            Call ONLY when the speaker says they already did it ("I put the Hemera in my Connie");
            never for "should I…" questions or advice. There is no member argument: this always
            edits the speaker's own hangar, never anyone else's.

            Args:
              ship: the speaker's ship as they named it (nickname or model, e.g. "Connie", "my Harbinger").
              item: the item as the speaker named it (e.g. "Hemera", "hemera qd", "lorica shields"); the
                service matches it and returns the canonical name in item.name (item.matchedBy says
                "exact" or "fuzzy") -- always say that canonical name back.
              slot: optional slot hint ("left", "nose", "2", "shields") or "all"; omit unless the speaker said one.

            Returns:
              {ship, item:{name, matchedBy}, changes:[{slot, from:{name}, to:{name}}], unchanged} on
              success, else {error, message, ...}: choose_slot (+slots) or ambiguous (+field "ship"|"item",
              +candidates) -> ask a short follow-up naming the options; not_found (+owned / suggestions)
              / incompatible (+reason) -> tell the speaker.
            """
            body = {"ship": ship, "item": item}
            if slot is not None:
                body["slot"] = slot
            return await self._call("hangar_fit", {"ship": ship, "item": item, "slot": slot},
                                    lambda m: f"/v1/members/{m}/fit", body)

        async def hangar_add_ship(vehicle: str, nickname: str | None = None) -> dict:
            """Record that the SPEAKER bought / acquired a ship: adds it to their OWN hangar.

            Call ONLY when the speaker says they already got it ("I just bought a Cutlass Black");
            never for plans or hypotheticals. There is no member argument: this always edits the
            speaker's own hangar.

            Args:
              vehicle: the ship model (e.g. "Cutlass Black", "Constellation Taurus").
              nickname: optional nickname the speaker gave it.

            Returns:
              {ship: {shipId, vehicleName, nickname, ...}} on success, else {error, message, ...}
              (ambiguous + candidates -> ask which model; not_found; limit).
            """
            body = {"vehicle": vehicle}
            if nickname is not None:
                body["nickname"] = nickname
            return await self._call("hangar_add_ship", {"vehicle": vehicle, "nickname": nickname},
                                    lambda m: f"/v1/members/{m}/ships", body)

        async def hangar_reset(ship: str, slot: str) -> dict:
            """Record that the SPEAKER put one of their OWN ship's slots (or the whole ship) back to stock.

            Call ONLY when the speaker says they did it ("I put my Harbinger's shields back to
            stock"). There is no member argument: this always edits the speaker's own hangar.

            Args:
              ship: the speaker's ship as they named it.
              slot: which slot(s) to reset: a slot hint ("shields", "left", "qd") or "all" for the
                whole ship. Required -- if the speaker didn't say which, ask before calling.

            Returns:
              {ship, changes:[{slot, from:{name}, to:{name}}], unchanged} on success, else
              {error, message, ...} (choose_slot + slots / ambiguous + candidates -> ask).
            """
            args = {"ship": ship, "slot": slot}
            local_error = None
            if "/" in (ship or ""):
                local_error = {"error": "invalid_request",
                               "message": "A ship name can't contain '/'; use the ship's nickname or model."}
            elif not (slot or "").strip():
                local_error = {"error": "invalid_request",
                               "message": "Say which slot to reset (e.g. 'shields', 'left') or 'all' for "
                                          "the whole ship -- ask the speaker which one."}
            return await self._call(
                "hangar_reset", args,
                lambda m: f"/v1/members/{m}/ships/{quote(ship, safe='')}/reset",
                {"slot": slot}, local_error=local_error)

        return [hangar_fit, hangar_add_ship, hangar_reset]
