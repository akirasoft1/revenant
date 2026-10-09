"""Authentication and the write-permission rule.

Shape: a request is authenticated by a CHAIN of credential resolvers
(``Authenticator``). Each resolver looks at the request and either

- returns ``None`` -- "no credential of my kind here", try the next one;
- returns a ``Principal`` -- authenticated;
- raises ``AuthError`` -- a credential of its kind WAS presented and is bad.
  The chain stops: a bad token is never silently retried as another kind.

Resolvers, in chain order:

1. ``GoogleIdTokenResolver`` -- service callers (the bot and sc-knowledge,
   holding a Google-signed ID token for SA ``hangar-api@``) ->
   ``Principal(kind="service", acting_member=<X-Acting-Member header>)``.
2. ``DiscordSessionResolver`` (only when browser auth is configured) -- the web
   editor's signed ``__Host-hangar_session`` cookie ->
   ``Principal(kind="session", subject=<discordId>, acting_member=<discordId>, user=...)``.
   ``X-Acting-Member`` is IGNORED for sessions: a browser acts only as itself.

A valid Bearer token therefore always wins over a cookie; a bad Bearer token
is a 401 even with a valid cookie (the chain stops on a bad credential).

Write rule (``authorize_write``): the principal's acting member must equal the
path member, or be in ``HANGAR_ADMIN_IDS``. Service callers state the acting
member in ``X-Acting-Member``; reads need none. Session principals' writes
must additionally be same-origin (``check_same_origin``) -- CSRF protection on
top of the ``SameSite=Lax`` cookie.
"""
import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Protocol
from urllib.parse import urlsplit

from google.auth import exceptions as gexc
from google.oauth2 import id_token

from starlette.requests import Request

from .session import SESSION_COOKIE, InvalidSession, SessionCodec, SessionUser

log = logging.getLogger(__name__)

ACTING_MEMBER_HEADER = "X-Acting-Member"
CERTS_CACHE_TTL_S = 3600.0


class AuthError(Exception):
    """Missing or invalid credentials -> 401 ``unauthenticated``."""


class AuthUnavailable(Exception):
    """Credentials could not be checked (Google certs unreachable) -> 503 ``unavailable``."""


class Forbidden(Exception):
    """Authenticated, but not allowed to do this -> 403 ``forbidden``."""


@dataclass(frozen=True)
class Principal:
    kind: str                  # "service" (Google ID token) | "session" (Discord browser session)
    subject: str               # caller SA email, or the Discord ID of a session
    acting_member: str | None  # the Discord member the request acts as (writes)
    user: SessionUser | None = field(default=None, compare=False)   # session principals only


class CredentialResolver(Protocol):
    async def resolve(self, request: Request) -> Principal | None: ...


# A TokenVerifier checks a raw ID token for an audience and returns its claims,
# raising AuthError (bad token) or AuthUnavailable (could not check). It is
# synchronous (google-auth is); the resolver runs it in a worker thread.
TokenVerifier = Callable[[str, str], Mapping[str, Any]]


class _CachedResponse:
    def __init__(self, status: int, headers: Mapping, data: bytes) -> None:
        self.status = status
        self.headers = headers
        self.data = data


class CachingRequest:
    """``google.auth.transport.Request`` wrapper that caches successful GETs
    (Google's public signing certs) for ``ttl_s``. google-auth refetches the
    certs on EVERY verification otherwise. Google publishes new signing keys
    well ahead of using them, so a 1h cache never misses a live key."""

    def __init__(self, inner: Any = None, ttl_s: float = CERTS_CACHE_TTL_S,
                 clock: Callable[[], float] = time.monotonic) -> None:
        if inner is None:
            import google.auth.transport.requests as gtr
            inner = gtr.Request()
        self._inner = inner
        self._ttl = ttl_s
        self._clock = clock
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, _CachedResponse]] = {}

    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs):
        if method != "GET" or body is not None:
            return self._inner(url, method=method, body=body, headers=headers, timeout=timeout, **kwargs)
        with self._lock:
            hit = self._cache.get(url)
            if hit is not None and self._clock() - hit[0] < self._ttl:
                return hit[1]
        resp = self._inner(url, method="GET", headers=headers, timeout=timeout or 5, **kwargs)
        if resp.status == 200:
            cached = _CachedResponse(resp.status, dict(resp.headers or {}), resp.data)
            with self._lock:
                self._cache[url] = (self._clock(), cached)
            return cached
        return resp


def _scrub_token(text: str, token: str) -> str:
    """Remove the raw token, and each of its dot-separated segments, from ``text``."""
    for piece in sorted({token, *token.split(".")}, key=len, reverse=True):
        if len(piece) >= 4:
            text = text.replace(piece, "<token>")
    return text


class GoogleIdTokenVerifier:
    """The production ``TokenVerifier``: ``google.oauth2.id_token.verify_oauth2_token``
    (signature against Google's certs, expiry, issuer ``accounts.google.com``,
    audience)."""

    def __init__(self, request: Any = None, clock_skew_s: int = 10) -> None:
        self._request = request if request is not None else CachingRequest()
        self._skew = clock_skew_s

    def __call__(self, token: str, audience: str) -> Mapping[str, Any]:
        if not audience:
            # verify_oauth2_token(audience=None) skips the audience check.
            raise AuthError("server has no HANGAR_AUDIENCE configured; refusing all tokens")
        try:
            return id_token.verify_oauth2_token(token, self._request, audience=audience,
                                                clock_skew_in_seconds=self._skew)
        except gexc.TransportError as e:
            raise AuthUnavailable(f"could not fetch Google signing certs: {e}") from e
        except (ValueError, gexc.GoogleAuthError) as e:
            # google-auth messages can quote the token (e.g. "Wrong number of
            # segments in token: b'...'"): log the reason with the token
            # scrubbed, and never echo it to the caller.
            log.warning("hangar: invalid ID token (%s): %s", type(e).__name__, _scrub_token(str(e), token))
            raise AuthError("invalid ID token") from None


class GoogleIdTokenResolver:
    """``Authorization: Bearer <Google ID token>`` -> service Principal.

    Requires the token to verify for ``audience`` AND ``email_verified`` AND
    the email to be in ``allowed_callers`` (case-insensitive)."""

    def __init__(self, audience: str, allowed_callers: Iterable[str], verifier: TokenVerifier) -> None:
        self._audience = audience
        self._allowed = frozenset(e.lower() for e in allowed_callers)
        self._verify = verifier

    async def resolve(self, request: Request) -> Principal | None:
        header = request.headers.get("authorization") or ""
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer":
            return None
        token = token.strip()
        if not token:
            raise AuthError("empty bearer token")
        if not self._audience:
            # Fail closed whatever the verifier does with an empty audience.
            raise AuthError("server has no HANGAR_AUDIENCE configured; refusing all tokens")
        claims = await asyncio.to_thread(self._verify, token, self._audience)
        if claims.get("aud") != self._audience:   # belt and braces over the verifier
            raise AuthError(f"token audience {claims.get('aud')!r} is not this service")
        if claims.get("email_verified") is not True:
            raise AuthError(f"token email {claims.get('email')!r} is not verified")
        email = (claims.get("email") or "").lower()
        if not email or email not in self._allowed:
            raise AuthError(f"caller {claims.get('email')!r} is not in HANGAR_ALLOWED_CALLERS")
        acting = (request.headers.get(ACTING_MEMBER_HEADER) or "").strip() or None
        return Principal(kind="service", subject=email, acting_member=acting)


class DiscordSessionResolver:
    """``__Host-hangar_session`` cookie -> session Principal. No cookie -> not
    applicable; a cookie that fails verification (tampered / expired /
    signed with another key) -> 401."""

    def __init__(self, codec: SessionCodec) -> None:
        self._codec = codec

    async def resolve(self, request: Request) -> Principal | None:
        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            return None
        try:
            user = self._codec.verify_session(token)
        except InvalidSession as e:
            raise AuthError(f"browser session invalid or expired: {e}") from None
        return Principal(kind="session", subject=user.discord_id, acting_member=user.discord_id,
                         user=user)


def check_same_origin(request: Request, public_origin: str) -> None:
    """CSRF guard for session-principal writes: ``Origin`` must equal the
    editor's public origin; without an ``Origin`` header, ``Referer`` must be
    on that origin. Raises ``Forbidden`` otherwise (incl. neither header)."""
    origin = request.headers.get("origin")
    if origin is not None:
        if origin == public_origin:
            return
        raise Forbidden(f"cross-origin write refused (Origin {origin!r} is not {public_origin})")
    referer = request.headers.get("referer")
    if referer:
        parts = urlsplit(referer)
        if f"{parts.scheme}://{parts.netloc}" == public_origin:
            return
        raise Forbidden(f"cross-origin write refused (Referer is not on {public_origin})")
    raise Forbidden("browser writes must carry an Origin or Referer header (same-origin check)")


class Authenticator:
    """Runs credential resolvers in order; the first non-None result wins."""

    def __init__(self, resolvers: list[CredentialResolver]) -> None:
        self._resolvers = list(resolvers)

    async def authenticate(self, request: Request) -> Principal:
        for r in self._resolvers:
            principal = await r.resolve(request)
            if principal is not None:
                return principal
        raise AuthError("no credentials (expected Authorization: Bearer <Google ID token> "
                        "or a __Host-hangar_session login cookie)")


def authorize_write(principal: Principal, member_id: str, admin_ids: frozenset[str]) -> None:
    """Raise ``Forbidden`` unless the principal may modify ``member_id``'s hangar."""
    acting = principal.acting_member
    if not acting:
        raise Forbidden(f"{ACTING_MEMBER_HEADER} header is required on writes")
    if acting == member_id or acting in admin_ids:
        return
    raise Forbidden(f"member {acting} may not modify member {member_id}'s hangar")
