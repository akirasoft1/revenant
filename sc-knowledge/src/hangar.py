"""READ-ONLY client for hangar-service (members' Star Citizen ship loadouts).

Read-only is a security property, not a convenience: hangar-service trusts
any allow-listed service caller's acting-member header on writes, and this
client is driven by a language model's tool calls. So it exposes GETs only --
no write route is reachable from here, and tests pin that (no write-shaped
method, no write verb or acting-member header anywhere in this module).

Auth: Cloud Run invoker IAM is on, so EVERY call (even /health) carries a
Google-signed ID token minted from the mounted service-account key with
`target_audience` = HANGAR_API_URL. Minting is blocking (google-auth +
requests), so it runs in a thread, single-flight, and the token is cached
until 5 minutes before it expires.

Bounds: one call (token + request) is capped at `timeout_s` (3s -- the voice
sidecar bounds a whole tool call at 6s). Successful responses are cached 30s.
"""
import asyncio
import logging
import time
from datetime import timezone
from typing import Any, Callable

import httpx

from .config import Config

logger = logging.getLogger("sc_knowledge.hangar")

_TOKEN_REFRESH_MARGIN_S = 300.0
_RESPONSE_TTL_S = 30.0
_DEFAULT_TIMEOUT_S = 3.0


class HangarUnavailable(Exception):
    """hangar-service can't answer (unreachable, timed out, 5xx, or our own
    credentials rejected). Tools map this to error("unavailable", ...)."""


class HangarError(Exception):
    """A definite answer from hangar-service that isn't a success (e.g.
    400 invalid_request, 404 not_found) -- carries its stable error code."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"hangar-service {status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message


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
        self._refresh: asyncio.Task | None = None

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
            logger.warning("hangar ID-token mint failed (key %s, audience %s): %s: %s",
                           self._key_path, self._audience, type(e).__name__, e, exc_info=True)
            raise HangarUnavailable(
                f"could not mint an ID token from {self._key_path} for {self._audience}: "
                f"{type(e).__name__}: {e}") from e
        self._token, self._expires_at = token, expires_at
        return token

    async def token(self) -> str:
        if self._fresh():
            return self._token  # type: ignore[return-value]
        # Single-flight: concurrent callers share one mint. shield() so a
        # caller's timeout abandons its WAIT, not the mint -- the token still
        # lands in the cache for the next call.
        if self._refresh is None or self._refresh.done():
            self._refresh = asyncio.ensure_future(self._do_refresh())
        return await asyncio.shield(self._refresh)


class HangarClient:
    """GET-only hangar-service client with a 30s response cache."""

    def __init__(self, base_url: str, tokens, *, transport: httpx.AsyncBaseTransport | None = None,
                 timeout_s: float = _DEFAULT_TIMEOUT_S,
                 clock: Callable[[], float] = time.monotonic,
                 cache_ttl_s: float = _RESPONSE_TTL_S) -> None:
        self._base = base_url.rstrip("/")
        self._tokens = tokens
        self._timeout = timeout_s
        self._clock = clock
        self._ttl = cache_ttl_s
        self._cache: dict[str, tuple[float, Any]] = {}
        self._http = httpx.AsyncClient(base_url=self._base, timeout=httpx.Timeout(timeout_s),
                                       transport=transport,
                                       headers={"Accept": "application/json"})

    async def _get(self, path: str) -> Any:
        now = self._clock()
        hit = self._cache.get(path)
        if hit is not None and now - hit[0] < self._ttl:
            return hit[1]
        try:
            async with asyncio.timeout(self._timeout):
                token = await self._tokens.token()
                resp = await self._http.request(
                    "GET", path, headers={"Authorization": f"Bearer {token}"})
        except TimeoutError:
            raise HangarUnavailable(
                f"hangar-service GET {path} timed out after {self._timeout}s") from None
        except httpx.HTTPError as e:
            raise HangarUnavailable(
                f"hangar-service GET {path} failed: {type(e).__name__}: {e}") from e
        try:
            body = resp.json()
        except ValueError:
            body = None
        if resp.status_code < 400:
            if body is None:
                raise HangarUnavailable(
                    f"hangar-service GET {path} returned non-JSON {resp.status_code}: {resp.text}")
            self._cache[path] = (self._clock(), body)
            return body
        code = body.get("error") if isinstance(body, dict) else None
        message = (body.get("message") if isinstance(body, dict) else None) or resp.text
        # 5xx: the service is down. 401/403: OUR credentials are rejected
        # (wrong audience, SA not allow-listed) -- a deploy problem, which to
        # the model is the same thing: the hangar can't be read right now.
        if resp.status_code >= 500 or resp.status_code in (401, 403):
            logger.warning("hangar-service GET %s -> %s %s: %s", path, resp.status_code, code, message)
            raise HangarUnavailable(
                f"hangar-service GET {path} -> {resp.status_code} {code}: {message}")
        raise HangarError(resp.status_code, code or "error", message)

    async def get_hangar(self, member_id: str) -> dict:
        """`GET /v1/members/{id}/hangar` -> {member, ships: [Ship]}."""
        return await self._get(f"/v1/members/{member_id}/hangar")

    async def aclose(self) -> None:
        await self._http.aclose()


def build_hangar_client(config: Config) -> HangarClient | None:
    """None when HANGAR_API_URL is unset -- the hangar tools then answer
    error("unavailable") instead of failing startup."""
    if not config.hangar_api_url:
        return None
    tokens = IdTokenProvider(config.hangar_sa_key_path, config.hangar_api_url)
    return HangarClient(config.hangar_api_url, tokens)
