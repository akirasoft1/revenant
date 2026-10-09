"""hangar-service HTTP API (FastAPI).

Routes (spec: docs/superpowers/specs/2026-10-09-member-hangar-design.md):

    GET    /health, /healthz                                (unauthenticated, no upstream calls;
                                                             Cloud Run 404s /healthz -- use /health)
    GET    /v1/members/{discordId}/hangar
    POST   /v1/members/{discordId}/ships                    {vehicle, nickname?}
    PATCH  /v1/members/{discordId}/ships/{shipId}           {nickname}
    DELETE /v1/members/{discordId}/ships/{shipId}
    PUT    /v1/members/{discordId}/ships/{shipId}/slots/{slot}   {item}
    DELETE /v1/members/{discordId}/ships/{shipId}/slots/{slot}
    POST   /v1/members/{discordId}/fit                      {ship, item, slot?}   chat edits:
    POST   /v1/members/{discordId}/ships/{shipRef}/reset    {slot?}               free-text ship /
                                                             item / slot, resolved server side
    GET    /v1/catalog/vehicles?q=&limit=
    GET    /v1/catalog/vehicles/{uuid}/slots
    GET    /v1/catalog/items?type=&size=&q=
    GET    /v1/members                                      member directory (>= 1 ship)
    GET    /v1/catalog/slot-options?vehicle=<uuid>&slot=<id> compatible items for one slot
                                                             (+ keyStat, cheapestPrice?)
    POST   /v1/import/spviewer/preview[?member=]            {file: <spviewer export array>}
    POST   /v1/import/spviewer/apply[?member=]              {rows: [{rowIndex, mode, shipId?, nickname?}], file}

Every ``/v1/...`` route is ALSO served at ``/api/v1/...`` (same handler): service
callers use ``/v1`` on the run.app URL, the browser editor uses ``/api/v1``
through the load balancer. Browser-only routes (web editor, Discord login):

    GET    /api/auth/login?next=/path      302 -> Discord authorize (sets hangar_oauth_state)
    GET    /api/auth/callback?code&state   302 -> next (sets hangar_session) | /?login_error=<code>
    POST   /api/auth/logout                204, clears hangar_session
    GET    /api/me                         {discordId, username, globalName, avatarUrl, isAdmin} | 401

The built web editor (HANGAR_STATIC_DIR, see src/static_site.py) is served
for every other GET: ``/assets/*`` long-cached, root files short-cached, and
any non-reserved path (not /api, /v1, /health, /healthz, /assets) ->
index.html (no-cache, with the SPA CSP). ``GET /version.txt`` = HANGAR_VERSION.

Browser login is configured by DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET /
HANGAR_SESSION_KEY; without them the login routes and /api/me answer 503
``unavailable`` and session cookies are not a credential (service callers are
unaffected). Session-principal writes must be same-origin (Origin/Referer ==
HANGAR_PUBLIC_ORIGIN) and ignore X-Acting-Member.

Every error is ``{"error": <code>, "message": <text>, ...}`` with a stable code:
``unauthenticated`` 401, ``forbidden`` 403, ``not_found`` 404, ``ambiguous``
409 (+ ``candidates``), ``incompatible`` 422, ``invalid_request`` 400,
``unavailable`` 503 (Wiki / Firestore / Google certs down), ``limit`` 409
(ship cap), ``too_large`` 413 (import upload over 2 MB), ``choose_slot`` 409
(chat edits: several slots fit, + ``slots``).
"""
import asyncio
import contextlib
import dataclasses
import hmac
import json
import logging
import re
import secrets
import time
from typing import Any, Awaitable, Callable

import httpx
from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import (
    AuthError, AuthUnavailable, Authenticator, CredentialResolver, DiscordSessionResolver, Forbidden,
    GoogleIdTokenResolver, GoogleIdTokenVerifier, Principal, TokenVerifier, authorize_write,
    check_same_origin,
)
from .discord_oauth import DiscordOAuth, DiscordOAuthError
from .session import (OAUTH_STATE_COOKIE, OAUTH_STATE_MAX_AGE_S, SESSION_COOKIE, SESSION_MAX_AGE_S,
                      InvalidSession, SessionCodec, SessionUser)
from .catalog import UnknownItemType, build_catalog
from .config import Config
from .http import UpstreamError
from .loadout import check_compatible, effective_loadout
from .options import slot_options
from .repository import InMemoryShipRepository, RepositoryError, ShipRepository
from .ship_resolve import resolve_ship, ship_labels
from .slot_hint import ALL_WORDS, match_slots
from .static_site import NO_CACHE, StaticSite, build_csp
from .spviewer import MAX_ROWS, MAX_UPLOAD_BYTES, DecodeBudget, RowResult, analyze_row

log = logging.getLogger(__name__)

MEMBER_ID_RE = re.compile(r"^[0-9]{1,32}$")          # Discord snowflake
SHIP_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NICKNAME_MAX = 64
SLOT_MAX = 300
FREE_TEXT_MAX = 200
API_PREFIXES = ("/v1", "/api/v1")     # service callers, browser editor
MEMBER_DIRECTORY_TTL_S = 60.0
# The spviewer file is capped at 2 MB; the JSON envelope ({file, rows}) may add a little.
IMPORT_BODY_MAX = MAX_UPLOAD_BYTES + 64 * 1024
IMPORT_MODES = ("new", "existing")
# Concurrent import requests per instance (each may hold a 2 MB body, its
# parsed JSON and up to 16 MB of decoded loadouts). Full -> 503 ``busy``.
IMPORT_CONCURRENCY = 2

# On EVERY response (incl. errors and 500s). Task 4's static SPA serving adds
# its own Cache-Control for assets; these stay.
SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}
# API responses (authenticated / per-user data): never cached by a browser or
# shared cache, and keyed on the cookie if anything does cache them.
API_PATH_PREFIXES = ("/v1/", "/api/")

# A login gate decides, after Discord has identified the user, whether they may
# sign in: returns a login_error code (refused), a SessionUser (allowed, possibly
# enriched -- e.g. with guildId/nick) or None (allowed unchanged). Receives the
# user's Discord access token for membership lookups (never log it). May raise
# DiscordOAuthError (its code becomes the login_error).
LoginGate = Callable[[SessionUser, str], Awaitable["SessionUser | str | None"]]


def guild_login_gate(oauth: DiscordOAuth, allowed_guild_ids: frozenset[str]) -> LoginGate:
    """Only members of an allowed Discord server may sign in. Guilds are tried
    in sorted order; the first membership wins (recorded as ``guildId``, with
    the server nickname as a display-name candidate after globalName). If no
    guild confirms membership and any lookup was unavailable (429/5xx/network)
    -> ``discord_unavailable``; otherwise ``not_member``."""
    async def gate(user: SessionUser, access_token: str):
        unavailable: DiscordOAuthError | None = None
        for gid in sorted(allowed_guild_ids):
            try:
                member = await oauth.guild_member(access_token, gid)
            except DiscordOAuthError as e:
                if e.code != "discord_unavailable":
                    raise
                log.warning("hangar: guild membership check for member %s: %s", user.discord_id, e)
                unavailable = e
                continue
            if member is not None and member.get("pending") is True:
                # Membership screening not passed yet: not (yet) a member.
                log.info("hangar: member %s is pending membership screening in guild %s",
                         user.discord_id, gid)
                continue
            if member is not None:
                nick = member.get("nick")
                return dataclasses.replace(user, guild_id=gid,
                                           nick=nick if isinstance(nick, str) and nick else None)
        if unavailable is not None:
            raise unavailable
        return "not_member"
    return gate


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


def _err(status: int, code: str, message: str, headers: dict | None = None, **extra) -> JSONResponse:
    return JSONResponse({"error": code, "message": message, **extra}, status_code=status, headers=headers)


def _not_found(message: str) -> ApiError:
    return ApiError(404, "not_found", message)


def _bad(message: str) -> ApiError:
    return ApiError(400, "invalid_request", message)


# ---------- request helpers ----------

async def _json_object(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise _bad("request body must be valid JSON") from None
    if not isinstance(body, dict):
        raise _bad("request body must be a JSON object")
    return body


async def _capped_json_object(request: Request, limit: int) -> dict:
    """The JSON object body, refused with 413 ``too_large`` past ``limit``
    bytes (checked on Content-Length AND while streaming)."""
    declared = request.headers.get("content-length") or ""
    if re.fullmatch(r"[0-9]+", declared) and int(declared) > limit:
        raise ApiError(413, "too_large", f"request body is over the {limit // 1024} KiB import limit")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise ApiError(413, "too_large", f"request body is over the {limit // 1024} KiB import limit")
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks))
    except (ValueError, RecursionError):      # RecursionError: absurdly deep nesting
        raise _bad("request body must be valid JSON") from None
    if not isinstance(body, dict):
        raise _bad("request body must be a JSON object")
    return body


def _export_rows(body: dict) -> list:
    rows = body.get("file")
    if not isinstance(rows, list):
        raise _bad("'file' must be the spviewer export: a JSON array of saved loadouts")
    if len(rows) > MAX_ROWS:
        raise ApiError(413, "too_large",
                       f"the export has {len(rows)} loadouts; at most {MAX_ROWS} can be imported at once")
    return rows


def _import_member(principal: Principal, member: str | None) -> str:
    """Target hangar: ``?member=`` (admins: someone else's) or the acting member."""
    target = member if member not in (None, "") else principal.acting_member
    if not target:
        raise _bad("no target member: pass ?member=<discordId> (or X-Acting-Member as a service caller)")
    return _check_member(target)


def _ship_label(ship: dict) -> str:
    nick, name = ship.get("nickname"), ship.get("vehicleName") or "ship"
    return f"{nick} ({name})" if nick else name


def _nickname(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _bad("nickname must be a string or null")
    value = value.strip()
    if len(value) > NICKNAME_MAX:
        raise _bad(f"nickname must be at most {NICKNAME_MAX} characters")
    return value or None


def _required_text(body: dict, key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        raise _bad(f"'{key}' is required and must be a non-empty string")
    value = value.strip()
    if len(value) > FREE_TEXT_MAX:
        raise _bad(f"'{key}' must be at most {FREE_TEXT_MAX} characters")
    return value


def _optional_text(body: dict, key: str) -> str | None:
    value = body.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _bad(f"'{key}' must be a string")
    value = value.strip()
    if len(value) > FREE_TEXT_MAX:
        raise _bad(f"'{key}' must be at most {FREE_TEXT_MAX} characters")
    return value or None


def _size_label(lo: int | None, hi: int | None) -> str:
    """Compact size for chat replies: S2, S1-2, any size."""
    if lo is None and hi is None:
        return "any size"
    if lo == hi or hi is None:
        return f"S{lo}"
    if lo is None:
        return f"S{hi}"
    return f"S{lo}-{hi}"


def _ref(item: dict | None) -> dict:
    item = item or {}
    return {"name": item.get("name"), "uuid": item.get("uuid")}


def _check_member(member_id: str) -> str:
    if not MEMBER_ID_RE.match(member_id):
        raise _bad(f"member id {member_id!r} is not a Discord ID")
    return member_id


def _check_ship_id(ship_id: str) -> str:
    if not SHIP_ID_RE.match(ship_id):
        raise _not_found(f"no ship {ship_id!r}")
    return ship_id


# ---------- dependencies ----------

async def get_principal(request: Request) -> Principal:
    return await request.app.state.authenticator.authenticate(request)


async def read_member(discordId: str, principal: Principal = Depends(get_principal)) -> str:
    return _check_member(discordId)


def authorize_browser_write(request: Request, principal: Principal) -> None:
    """CSRF: a session principal's write must come from the editor's own origin.
    Service (Bearer) callers are unaffected. Every write route must call this
    (``write_member`` does)."""
    if principal.kind == "session":
        check_same_origin(request, request.app.state.config.public_origin)


async def write_member(request: Request, discordId: str,
                       principal: Principal = Depends(get_principal)) -> Principal:
    _check_member(discordId)
    authorize_browser_write(request, principal)
    authorize_write(principal, discordId, request.app.state.config.admin_ids)
    return principal


async def ensure_ship_capacity(repository: ShipRepository, member_id: str, *, adding: int,
                               limit: int) -> None:
    """409 ``limit`` unless ``member_id`` can take ``adding`` more ships under
    ``HANGAR_MAX_SHIPS_PER_MEMBER``. Every ship-creating route (add, import
    apply) must call this before writing."""
    have = len(await repository.list_ships(member_id))
    if have + adding > limit:
        raise ApiError(409, "limit", f"member {member_id} has {have} ships; adding {adding} would exceed "
                                     f"the limit of {limit} ships per member", limit=limit, shipCount=have)


class MemberDirectoryCache:
    """In-process 60s cache of the member directory. Ship create/delete
    invalidate it (``invalidate_member_directory``); renames and fits can be up
    to 60s stale in display names, which is fine."""

    def __init__(self, ttl_s: float, monotonic: Callable[[], float]) -> None:
        self._ttl = ttl_s
        self._now = monotonic
        self._value: list | None = None
        self._at = 0.0

    def get(self) -> list | None:
        if self._value is not None and self._now() - self._at < self._ttl:
            return self._value
        return None

    def put(self, value: list) -> None:
        self._value, self._at = value, self._now()

    def invalidate(self) -> None:
        self._value = None


def invalidate_member_directory(app: FastAPI) -> None:
    app.state.member_directory.invalidate()


class SecurityHeadersMiddleware:
    """Pure ASGI: adds ``SECURITY_HEADERS`` to every response, plus
    ``Cache-Control: no-store`` (unless set) and ``Vary: Cookie`` on API paths."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        is_api = scope.get("path", "").startswith(API_PATH_PREFIXES)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                apply_security_headers(message.setdefault("headers", []), is_api)
            await send(message)
        await self.app(scope, receive, send_wrapper)


def apply_security_headers(raw: list, is_api: bool) -> None:
    """Mutates an ASGI raw header list in place."""
    present = {k.lower() for k, _ in raw}
    for k, v in SECURITY_HEADERS.items():
        if k.lower().encode() not in present:
            raw.append((k.lower().encode(), v.encode()))
    if is_api:
        if b"cache-control" not in present:
            raw.append((b"cache-control", b"no-store"))
        vary = [i for i, (k, _) in enumerate(raw) if k.lower() == b"vary"]
        if vary:
            i = vary[0]
            values = [x.strip().lower() for x in raw[i][1].decode().split(",")]
            if "cookie" not in values:
                raw[i] = (b"vary", raw[i][1] + b", Cookie")
        else:
            raw.append((b"vary", b"Cookie"))


def owner_name_for(principal: Principal, member_id: str) -> str | None:
    """The ``ownerName`` to store on a ship write: the session user's display
    name when a member edits THEIR OWN hangar in the browser; None otherwise
    (service writes, and admins editing someone else's hangar, leave it alone)."""
    if principal.kind == "session" and principal.user is not None and principal.acting_member == member_id:
        return principal.user.display_name
    return None


# ---------- views ----------

async def ship_view(catalog, ship: dict) -> dict:
    """A stored ship plus its effective loadout. Catalog trouble degrades THIS
    ship (``loadout: null`` + ``loadoutError``), never the whole response."""
    loadout, error = None, None
    try:
        slots = await catalog.slots(ship["vehicleUuid"])
    except UpstreamError as e:
        log.warning("hangar: catalog unavailable for vehicle %s (ship %s): %s",
                    ship["vehicleUuid"], ship["shipId"], e)
        error = "unavailable"
    else:
        if slots is None:
            log.warning("hangar: vehicle %s (ship %s) is not in the catalog",
                        ship["vehicleUuid"], ship["shipId"])
            error = "not_found"
        else:
            loadout = effective_loadout(slots, ship.get("fitted"))
    return {**ship, "loadout": loadout, "loadoutError": error}


# ---------- app ----------

def create_app(config: Config, *, catalog: Any = None, repository: ShipRepository | None = None,
               verifier: TokenVerifier | None = None,
               resolvers: list[CredentialResolver] | None = None,
               warm: bool = True,
               discord_transport: httpx.AsyncBaseTransport | None = None,
               clock: Callable[[], float] | None = None,
               monotonic: Callable[[], float] = time.monotonic,
               login_gate: LoginGate | None = None) -> FastAPI:
    owns_catalog = catalog is None
    if catalog is None:
        catalog = build_catalog(config.wiki_base, version=config.version)
    browser_problem = config.browser_auth_problem()
    codec: SessionCodec | None = None
    oauth: DiscordOAuth | None = None
    if browser_problem is None:
        codec = SessionCodec(config.session_key, clock=clock or time.time,
                             previous_keys=[config.session_key_previous] if config.session_key_previous else [],
                             not_before=config.session_not_before,
                             allowed_guild_ids=config.allowed_guild_ids)
        oauth = DiscordOAuth(config.discord_client_id, config.discord_client_secret,
                             config.redirect_uri, transport=discord_transport)
        if login_gate is None:
            login_gate = guild_login_gate(oauth, config.allowed_guild_ids)
    if resolvers is None:
        resolvers = [GoogleIdTokenResolver(config.audience, config.allowed_callers,
                                           verifier or GoogleIdTokenVerifier())]
        if codec is not None:
            resolvers.append(DiscordSessionResolver(codec))

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        if not config.audience:
            log.error("hangar: HANGAR_AUDIENCE is not set -- every authenticated request will be "
                      "rejected (401) until it is set to this service's URL")
        if app.state.repository is None:
            app.state.repository = _build_repository(config)
        warm_task = asyncio.create_task(catalog.warm()) if warm else None
        log.info("hangar-service %s ready (storage=%s, wiki=%s, allowed callers=%s, admins=%d)",
                 config.version, config.storage, config.wiki_base,
                 sorted(config.allowed_callers), len(config.admin_ids))
        if browser_problem is None:
            log.info("hangar: browser login enabled (origin %s, redirect %s)",
                     config.public_origin, config.redirect_uri)
        else:
            log.warning("hangar: browser login DISABLED (%s) -- /api/auth/* and /api/me answer 503; "
                        "service callers are unaffected", browser_problem)
        try:
            yield
        finally:
            if warm_task is not None and not warm_task.done():
                warm_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await warm_task
            if owns_catalog:
                await catalog.aclose()

    app = FastAPI(title="hangar-service", version=config.version, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.config = config
    app.state.catalog = catalog
    app.state.repository = repository
    app.state.authenticator = Authenticator(resolvers)
    app.state.session_codec = codec
    app.state.member_directory = MemberDirectoryCache(MEMBER_DIRECTORY_TTL_S, monotonic)
    app.add_middleware(SecurityHeadersMiddleware)
    for bad in config.rum_origin_problems:
        log.warning("hangar: HANGAR_RUM_ORIGINS entry %r is not an https origin -- ignored", bad)
    site = StaticSite(config.static_dir, build_csp(config.rum_origins))
    app.state.static_site = site
    router = APIRouter()

    # ----- error envelopes -----

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, e: ApiError):
        return _err(e.status, e.code, e.message, **e.extra)

    @app.exception_handler(AuthError)
    async def _auth_error(request: Request, e: AuthError):
        log.warning("hangar: 401 %s %s: %s", request.method, request.url.path, e)
        return _err(401, "unauthenticated", str(e), headers={"WWW-Authenticate": "Bearer"})

    @app.exception_handler(AuthUnavailable)
    async def _auth_unavailable(request: Request, e: AuthUnavailable):
        log.error("hangar: 503 %s %s: %s", request.method, request.url.path, e)
        return _err(503, "unavailable", str(e))

    @app.exception_handler(Forbidden)
    async def _forbidden(request: Request, e: Forbidden):
        log.warning("hangar: 403 %s %s: %s", request.method, request.url.path, e)
        return _err(403, "forbidden", str(e))

    @app.exception_handler(UpstreamError)
    async def _upstream(request: Request, e: UpstreamError):
        log.error("hangar: 503 %s %s: Wiki unavailable: %s", request.method, request.url.path, e)
        return _err(503, "unavailable", f"game catalog unavailable: {e}")

    @app.exception_handler(RepositoryError)
    async def _repo(request: Request, e: RepositoryError):
        log.error("hangar: 503 %s %s: storage unavailable: %s", request.method, request.url.path, e,
                  exc_info=e)
        return _err(503, "unavailable", f"hangar storage unavailable: {e}")

    @app.exception_handler(UnknownItemType)
    async def _unknown_type(request: Request, e: UnknownItemType):
        return _err(400, "invalid_request", str(e))

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, e: RequestValidationError):
        return _err(400, "invalid_request", str(e.errors()))

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, e: Exception):
        log.error("hangar: 500 %s %s: unexpected %s: %s", request.method, request.url.path,
                  type(e).__name__, e, exc_info=e)
        # Detail stays in the log. This handler runs in ServerErrorMiddleware,
        # OUTSIDE SecurityHeadersMiddleware, so it applies the headers itself.
        resp = _err(500, "unavailable", "internal error (details are in the server log)")
        apply_security_headers(resp.raw_headers, request.url.path.startswith(API_PATH_PREFIXES))
        return resp

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, e: StarletteHTTPException):
        # The web editor: a GET/HEAD no API route matched is a static file or
        # a client route (-> index.html). Reserved prefixes keep the JSON 404.
        if e.status_code == 404 and request.method in ("GET", "HEAD"):
            resp = site.response(request.url.path)
            if resp is not None:
                return resp
        code = {404: "not_found", 401: "unauthenticated", 403: "forbidden"}.get(e.status_code, "invalid_request")
        return _err(e.status_code, code, str(e.detail), headers=getattr(e, "headers", None))

    # ----- health -----

    # Cloud Run's front end reserves paths ending in "z" (/healthz returns
    # Google's own 404 in production), so /health is the real probe path;
    # /healthz stays for local / in-cluster parity. Same handler, no upstream calls.
    @app.get("/health")
    @app.get("/healthz")
    async def healthz():
        cached = getattr(app.state.catalog, "vehicle_index_cached", lambda: False)()
        return {"status": "ok", "version": config.version, "vehicleIndexCached": bool(cached)}

    # Build identity (the git short SHA in the image; HANGAR_VERSION).
    @app.get("/version.txt")
    async def version_txt():
        return Response(config.version + "\n", media_type="text/plain; charset=utf-8",
                        headers={"Cache-Control": NO_CACHE})

    # ----- members -----

    @router.get("/members/{discordId}/hangar")
    async def get_hangar(member: str = Depends(read_member)):
        ships = await app.state.repository.list_ships(member)
        views = await asyncio.gather(*(ship_view(app.state.catalog, s) for s in ships))
        return {"member": member, "ships": list(views)}

    @router.post("/members/{discordId}/ships", status_code=201)
    async def add_ship(request: Request, discordId: str, principal: Principal = Depends(write_member)):
        body = await _json_object(request)
        vehicle = _required_text(body, "vehicle")
        nickname = _nickname(body.get("nickname"))
        res = await app.state.catalog.resolve_vehicle(vehicle)
        if res.status == "ambiguous":
            labels = ", ".join(c.get("label") or c.get("name") or "?" for c in res.candidates)
            raise ApiError(409, "ambiguous", f"{vehicle!r} matches several vehicles: {labels}",
                           candidates=res.candidates)
        if res.status != "match":
            raise _not_found(f"no vehicle matches {vehicle!r}")
        v = res.match
        await ensure_ship_capacity(app.state.repository, discordId, adding=1,
                                   limit=config.max_ships_per_member)
        ship = await app.state.repository.create_ship(
            discordId, vehicle_uuid=v["uuid"], vehicle_name=v["name"],
            vehicle_class_name=v.get("className"), nickname=nickname,
            updated_by=principal.acting_member, owner_name=owner_name_for(principal, discordId))
        invalidate_member_directory(app)
        log.info("hangar: member %s added %s (%s) as ship %s (by %s)",
                 discordId, v["name"], v["uuid"], ship["shipId"], principal.acting_member)
        return {"ship": await ship_view(app.state.catalog, ship)}

    @router.patch("/members/{discordId}/ships/{shipId}")
    async def rename_ship(request: Request, discordId: str, shipId: str,
                          principal: Principal = Depends(write_member)):
        _check_ship_id(shipId)
        body = await _json_object(request)
        if "nickname" not in body:
            raise _bad("'nickname' is required (null clears it)")
        ship = await app.state.repository.set_nickname(
            discordId, shipId, _nickname(body["nickname"]), updated_by=principal.acting_member,
            owner_name=owner_name_for(principal, discordId))
        if ship is None:
            raise _not_found(f"member {discordId} has no ship {shipId}")
        return {"ship": await ship_view(app.state.catalog, ship)}

    @router.delete("/members/{discordId}/ships/{shipId}")
    async def delete_ship(discordId: str, shipId: str, principal: Principal = Depends(write_member)):
        _check_ship_id(shipId)
        if not await app.state.repository.delete_ship(discordId, shipId):
            raise _not_found(f"member {discordId} has no ship {shipId}")
        invalidate_member_directory(app)
        log.info("hangar: member %s ship %s deleted (by %s)", discordId, shipId, principal.acting_member)
        return {"deleted": True, "shipId": shipId}

    @router.put("/members/{discordId}/ships/{shipId}/slots/{slot:path}")
    async def fit_slot(request: Request, discordId: str, shipId: str, slot: str,
                       principal: Principal = Depends(write_member)):
        _check_ship_id(shipId)
        body = await _json_object(request)
        item_ref = _required_text(body, "item")
        repo, catalog = app.state.repository, app.state.catalog
        ship = await repo.get_ship(discordId, shipId)
        if ship is None:
            raise _not_found(f"member {discordId} has no ship {shipId}")
        slots = await catalog.slots(ship["vehicleUuid"])
        if slots is None:
            raise _not_found(f"vehicle {ship['vehicleName']} ({ship['vehicleUuid']}) is no longer in the catalog")
        target = next((s for s in slots if s.name == slot), None) if len(slot) <= SLOT_MAX else None
        if target is None:
            raise _not_found(f"{ship['vehicleName']} has no component slot {slot!r}")
        item = await catalog.item(item_ref)
        if item is None:
            raise _not_found(f"no item {item_ref!r} (pass an item uuid or exact Wiki name; "
                             f"see /v1/catalog/items)")
        reason = check_compatible(target, item)
        if reason is not None:
            raise ApiError(422, "incompatible", reason)
        stock = target.stock_item
        if stock and stock.get("uuid") == item.get("uuid"):
            # `fitted` holds only changes from stock: fitting the stock item is a reset.
            updated = await repo.clear_slot(discordId, shipId, slot, updated_by=principal.acting_member,
                                            owner_name=owner_name_for(principal, discordId))
        else:
            updated = await repo.set_slot(discordId, shipId, slot, item_uuid=item["uuid"],
                                          item_name=item.get("name"), updated_by=principal.acting_member,
                                          owner_name=owner_name_for(principal, discordId))
        if updated is None:
            raise _not_found(f"member {discordId} has no ship {shipId}")
        log.info("hangar: member %s ship %s slot %s <- %s (%s) (by %s)", discordId, shipId, slot,
                 item.get("name"), item.get("uuid"), principal.acting_member)
        return {"ship": await ship_view(catalog, updated)}

    @router.delete("/members/{discordId}/ships/{shipId}/slots/{slot:path}")
    async def reset_slot(discordId: str, shipId: str, slot: str,
                         principal: Principal = Depends(write_member)):
        # No catalog check: a slot renamed by a patch must still be clearable.
        _check_ship_id(shipId)
        if len(slot) > SLOT_MAX:
            raise _not_found(f"no slot {slot!r}")
        updated = await app.state.repository.clear_slot(discordId, shipId, slot,
                                                        updated_by=principal.acting_member,
                                                        owner_name=owner_name_for(principal, discordId))
        if updated is None:
            raise _not_found(f"member {discordId} has no ship {shipId}")
        return {"ship": await ship_view(app.state.catalog, updated)}

    # ----- chat edits (free text resolved server side) -----
    #
    # The bot's agent / voice sidecars call these for "I put the Hemera in my
    # Connie" with the speaker as X-Acting-Member. Every resolution error
    # (ship, item, slot) is raised BEFORE the first write.

    async def _owned_ship(member: str, ref: str) -> tuple[dict, str]:
        """(ship, display label) for free text within ``member``'s hangar --
        the same resolver sc-knowledge's sc_member_hangar uses (see
        ship_resolve), plus an exact shipId."""
        ships = await app.state.repository.list_ships(member)
        labels = ship_labels(ships)
        owned = [{"shipId": s["shipId"], "label": labels[s["shipId"]]} for s in ships]
        exact = next((s for s in ships if s["shipId"] == ref), None)
        if exact is not None:
            return exact, labels[exact["shipId"]]
        status, hits, _tier = resolve_ship(ref, ships)
        if status == "ambiguous":
            raise ApiError(409, "ambiguous", f"{ref!r} matches several of member {member}'s ships: "
                                             f"{', '.join(labels[s['shipId']] for s in hits)}",
                           candidates=[{"shipId": s["shipId"], "label": labels[s["shipId"]]} for s in hits])
        if status != "match":
            have = ", ".join(o["label"] for o in owned) or "none recorded"
            raise ApiError(404, "not_found", f"member {member} has no ship matching {ref!r} (owned: {have})",
                           owned=owned)
        return hits[0], labels[hits[0]["shipId"]]

    def _ship_ref(ship: dict, label: str) -> dict:
        return {"shipId": ship["shipId"], "label": label, "vehicle": ship.get("vehicleName")}

    def _choose_slot(message: str, ship: dict, label: str, entries: list[dict]) -> ApiError:
        return ApiError(409, "choose_slot", message, ship=_ship_ref(ship, label),
                        slots=[{"slot": e["slot"], "type": e["type"], "size": _size_label(e["sizeMin"], e["sizeMax"]),
                                "current": {"name": (e.get("item") or {}).get("name")}} for e in entries])

    async def _ship_slots(ship: dict):
        slots = await app.state.catalog.slots(ship["vehicleUuid"])
        if slots is None:
            raise _not_found(f"vehicle {ship['vehicleName']} ({ship['vehicleUuid']}) is no longer in the catalog")
        return slots

    @router.post("/members/{discordId}/fit")
    async def chat_fit(request: Request, discordId: str, principal: Principal = Depends(write_member)):
        body = await _json_object(request)
        ship_text = _required_text(body, "ship")
        item_text = _required_text(body, "item")
        hint = _optional_text(body, "slot")
        repo, catalog = app.state.repository, app.state.catalog
        ship, label = await _owned_ship(discordId, ship_text)
        slots = await _ship_slots(ship)
        item = await catalog.item(item_text)
        if item is None:
            raise _not_found(f"no item {item_text!r} in the game catalog (use the exact Wiki name, "
                             f"class name or uuid)")
        loadout = {e["slot"]: e for e in effective_loadout(slots, ship.get("fitted"))}
        visible = [s for s in slots if s.name in loadout]
        reasons = {s.name: check_compatible(s, item) for s in visible}
        fits = [s for s in visible if reasons[s.name] is None]
        # A mount of another type that also accepts the item (a Turret gimbal
        # accepting WeaponGun) is only a target when no fitting child is
        # visible -- the child is where the item goes (sc-knowledge's
        # fit-check applies the same rule).
        names = [s.name for s in fits]
        fits = [s for s in fits if s.type == item.get("type")
                or not any(n.startswith(s.name + "/") for n in names)]
        itype, iname, size = item.get("type"), item.get("name"), item.get("size")

        def takes_type(s) -> bool:
            return itype in ([c["type"] for c in s.compatible_types] or [s.type])

        def size_miss(s) -> bool:
            return (takes_type(s) and isinstance(size, int) and not isinstance(size, bool)
                    and ((s.size_min is not None and size < s.size_min)
                         or (s.size_max is not None and size > s.size_max)))

        if hint is not None:
            exact = next((s for s in visible if s.name.casefold() == hint.casefold()), None)
            if exact is not None and reasons[exact.name] is not None:
                raise ApiError(422, "incompatible", reasons[exact.name],
                               reason="size_mismatch" if size_miss(exact) else "no_slot",
                               ship=_ship_ref(ship, label))
        if not fits:
            typed = [s for s in visible if takes_type(s)]
            sized = [s for s in typed if size_miss(s)]
            if sized:
                takes = ", ".join(sorted({_size_label(s.size_min, s.size_max) for s in sized}))
                raise ApiError(422, "incompatible",
                               f"{iname} is size {size}, but the {ship.get('vehicleName')}'s {itype} slots "
                               f"take {takes}", reason="size_mismatch", ship=_ship_ref(ship, label),
                               slots=[{"slot": s.name, "type": s.type, "size": _size_label(s.size_min, s.size_max),
                                       "current": {"name": (loadout[s.name].get("item") or {}).get("name")}}
                                      for s in sized])
            detail = reasons[typed[0].name] if typed else f"the {ship.get('vehicleName')} has no {itype} slot"
            raise ApiError(422, "incompatible", f"{iname} doesn't fit {label}: {detail}", reason="no_slot",
                           ship=_ship_ref(ship, label))
        fit_entries = [loadout[s.name] for s in fits]
        if hint is None:
            if len(fits) > 1:
                raise _choose_slot(f"{iname} fits {len(fits)} slots on {label}; say which (or 'all')",
                                   ship, label, fit_entries)
            targets = fits
        else:
            status, chosen = match_slots(hint, [(s.name, s.type) for s in fits])
            if status == "ambiguous":
                raise _choose_slot(f"{hint!r} matches {len(chosen)} slots on {label} that take {iname}; "
                                   f"say which (or 'all')", ship, label, [loadout[c] for c in chosen])
            if status != "match":
                raise _choose_slot(f"no slot on {label} that takes {iname} matches {hint!r}; say which "
                                   f"(or 'all')", ship, label, fit_entries)
            targets = [s for s in fits if s.name in chosen]

        changes = []
        updated = ship
        by, owner = principal.acting_member, owner_name_for(principal, discordId)
        for s in targets:
            current = loadout[s.name].get("item")
            if current and current.get("uuid") == item.get("uuid"):
                continue
            if s.stock_item and s.stock_item.get("uuid") == item.get("uuid"):
                updated = await repo.clear_slot(discordId, ship["shipId"], s.name, updated_by=by, owner_name=owner)
            else:
                updated = await repo.set_slot(discordId, ship["shipId"], s.name, item_uuid=item["uuid"],
                                              item_name=iname, updated_by=by, owner_name=owner)
            if updated is None:
                raise _not_found(f"member {discordId} has no ship {ship['shipId']}")
            changes.append({"slot": s.name, "from": _ref(current), "to": _ref(item)})
            log.info("hangar: chat fit: member %s ship %s (%s) slot %s: %s -> %s (%s) (by %s)",
                     discordId, ship["shipId"], label, s.name, (current or {}).get("name") or "empty",
                     iname, item.get("uuid"), by)
        if not changes:
            log.info("hangar: chat fit: member %s ship %s (%s): %s already fitted in %s -- no change (by %s)",
                     discordId, ship["shipId"], label, iname, ", ".join(s.name for s in targets), by)
        return {"member": discordId, "ship": _ship_ref(ship, label),
                "item": {"uuid": item.get("uuid"), "name": iname, "type": itype, "size": item.get("size")},
                "changes": changes, "unchanged": not changes}

    @router.post("/members/{discordId}/ships/{shipRef}/reset")
    async def chat_reset(request: Request, discordId: str, shipRef: str,
                         principal: Principal = Depends(write_member)):
        body = await _json_object(request) if (await request.body()).strip() else {}
        hint = _optional_text(body, "slot")
        if len(shipRef) > FREE_TEXT_MAX:
            raise _bad(f"ship must be at most {FREE_TEXT_MAX} characters")
        repo = app.state.repository
        ship, label = await _owned_ship(discordId, shipRef.strip())
        fitted = ship.get("fitted") or {}
        slots = await _ship_slots(ship) if fitted else []
        stock = {s.name: s.stock_item for s in slots}
        entries = effective_loadout(slots, fitted)
        known = {e["slot"] for e in entries}
        # Fitted slots the catalog no longer has (renamed by a patch) stay resettable by exact id.
        entries += [{"slot": k, "type": None, "sizeMin": None, "sizeMax": None,
                     "item": {"uuid": v.get("itemUuid"), "name": v.get("itemName")}}
                    for k, v in fitted.items() if k not in known]
        by_slot = {e["slot"]: e for e in entries}
        refitted = [e for e in entries if e["slot"] in fitted]
        if not fitted:
            targets = []
        elif hint is None:
            if len(refitted) > 1:
                raise _choose_slot(f"{label} has {len(refitted)} non-stock slots; say which to reset (or 'all')",
                                   ship, label, refitted)
            targets = [e["slot"] for e in refitted]
        elif hint.casefold() in ALL_WORDS:
            targets = [e["slot"] for e in refitted]
        else:
            status, chosen = match_slots(hint, [(e["slot"], e["type"]) for e in entries])
            if status == "none":
                raise _choose_slot(f"no slot on {label} matches {hint!r}; its non-stock slots are listed "
                                   f"(or say 'all')", ship, label, refitted)
            chosen_fitted = [c for c in chosen if c in fitted]
            if status == "ambiguous" and len(chosen_fitted) > 1:
                raise _choose_slot(f"{hint!r} matches {len(chosen_fitted)} non-stock slots on {label}; say which "
                                   f"(or 'all')", ship, label, [by_slot[c] for c in chosen_fitted])
            targets = chosen_fitted

        by, owner = principal.acting_member, owner_name_for(principal, discordId)
        changes = [{"slot": t, "from": _ref(by_slot[t]["item"]), "to": _ref(stock.get(t))} for t in targets]
        if targets:
            if set(targets) == set(fitted):
                updated = await repo.replace_fitted(discordId, ship["shipId"], {}, updated_by=by, owner_name=owner)
                if updated is None:
                    raise _not_found(f"member {discordId} has no ship {ship['shipId']}")
            else:
                for t in targets:
                    if await repo.clear_slot(discordId, ship["shipId"], t, updated_by=by, owner_name=owner) is None:
                        raise _not_found(f"member {discordId} has no ship {ship['shipId']}")
            for c in changes:
                log.info("hangar: chat reset: member %s ship %s (%s) slot %s: %s -> %s (stock) (by %s)",
                         discordId, ship["shipId"], label, c["slot"], c["from"]["name"] or "empty",
                         c["to"]["name"] or "empty", by)
        else:
            log.info("hangar: chat reset: member %s ship %s (%s) slot %r: already stock -- no change (by %s)",
                     discordId, ship["shipId"], label, hint, by)
        return {"member": discordId, "ship": _ship_ref(ship, label), "changes": changes, "unchanged": not changes}

    # ----- catalog -----

    @router.get("/catalog/vehicles")
    async def search_vehicles(q: str = "", limit: str = "25", principal: Principal = Depends(get_principal)):
        try:
            n = int(limit)
        except ValueError:
            raise _bad("limit must be an integer") from None
        return {"vehicles": await app.state.catalog.search_vehicles(q[:FREE_TEXT_MAX], limit=n)}

    @router.get("/catalog/vehicles/{uuid}/slots")
    async def vehicle_slots(uuid: str, principal: Principal = Depends(get_principal)):
        catalog = app.state.catalog
        vehicle = await catalog.vehicle(uuid)
        slots = await catalog.slots(uuid) if vehicle is not None else None
        if vehicle is None or slots is None:
            raise _not_found(f"no vehicle {uuid!r}")
        return {"vehicle": vehicle, "slots": [s.to_dict() for s in slots]}

    @router.get("/catalog/items")
    async def list_items(type: str | None = None, size: str | None = None, q: str | None = None,
                         principal: Principal = Depends(get_principal)):
        if not type:
            raise _bad("'type' is required (e.g. QuantumDrive, Shield, PowerPlant, Cooler)")
        size_n = None
        if size not in (None, ""):
            try:
                size_n = int(size)
            except ValueError:
                raise _bad("size must be a non-negative integer") from None
            if size_n < 0:
                raise _bad("size must be a non-negative integer")
        items = await app.state.catalog.items(type, size=size_n, q=(q or "")[:FREE_TEXT_MAX] or None)
        return {"items": items}

    @router.get("/catalog/slot-options")
    async def catalog_slot_options(vehicle: str | None = None, slot: str | None = None,
                                   principal: Principal = Depends(get_principal)):
        if not vehicle or not slot:
            raise _bad("'vehicle' (uuid) and 'slot' (slot id) are required")
        catalog = app.state.catalog
        slots = await catalog.slots(vehicle) if len(vehicle) <= FREE_TEXT_MAX else None
        if slots is None:
            raise _not_found(f"no vehicle {vehicle!r}")
        target = next((s for s in slots if s.name == slot), None) if len(slot) <= SLOT_MAX else None
        if target is None:
            raise _not_found(f"vehicle {vehicle} has no component slot {slot!r}")
        return {"items": await slot_options(catalog, target)}

    # ----- spviewer import -----

    import_slots = asyncio.Semaphore(IMPORT_CONCURRENCY)
    app.state.import_slots = import_slots

    @contextlib.asynccontextmanager
    async def import_slot():
        # Non-blocking: a full semaphore answers 503 at once instead of queueing
        # (the fast path of acquire() does not yield when a slot is free).
        if import_slots.locked():
            raise ApiError(503, "busy", "the server is busy with other imports; try again in a moment")
        await import_slots.acquire()
        try:
            yield
        finally:
            import_slots.release()

    async def _analyze(rows: list, indexes) -> dict[int, RowResult]:
        budget = DecodeBudget()
        out: dict[int, RowResult] = {}
        for i in indexes:
            out[i] = await analyze_row(app.state.catalog, i, rows[i], budget=budget)
        return out

    @router.post("/import/spviewer/preview")
    async def import_preview(request: Request, member: str | None = None,
                             principal: Principal = Depends(get_principal)):
        # Read-only (nothing is stored), so no CSRF / write check: any
        # authenticated caller may preview against any member's ships.
        target = _import_member(principal, member)
        # Body first (capped), THEN the slot: a slow upload must not hold one.
        body = await _capped_json_object(request, IMPORT_BODY_MAX)
        async with import_slot():
            rows = _export_rows(body)
            results = await _analyze(rows, range(len(rows)))
        ships = await app.state.repository.list_ships(target)
        out = []
        for i in range(len(rows)):
            r = results[i]
            view = r.to_preview()
            vuuid = r.vehicle["uuid"] if r.vehicle else None
            view["matchingShips"] = [{"shipId": s["shipId"], "label": _ship_label(s)}
                                     for s in ships if vuuid and s.get("vehicleUuid") == vuuid]
            out.append(view)
        log.info("hangar: spviewer preview for member %s by %s: %d rows, %d changes, %d skipped",
                 target, principal.acting_member or principal.subject, len(out),
                 sum(len(v["changes"]) for v in out), sum(len(v["skipped"]) for v in out))
        return {"rows": out}

    @router.post("/import/spviewer/apply")
    async def import_apply(request: Request, member: str | None = None,
                           principal: Principal = Depends(get_principal)):
        target = _import_member(principal, member)
        authorize_browser_write(request, principal)
        authorize_write(principal, target, config.admin_ids)
        # Body first (capped), THEN the slot: a slow upload must not hold one.
        body = await _capped_json_object(request, IMPORT_BODY_MAX)
        async with import_slot():
            return await _apply(principal, target, body)

    async def _apply(principal: Principal, target: str, body: dict) -> dict:
        rows = _export_rows(body)
        wanted = body.get("rows")
        if not isinstance(wanted, list) or not wanted:
            raise _bad("'rows' must be a non-empty array of {rowIndex, mode, shipId?, nickname?}")
        if len(wanted) > MAX_ROWS:
            raise _bad(f"at most {MAX_ROWS} rows can be applied at once")
        reqs, seen = [], set()
        for w in wanted:
            if not isinstance(w, dict):
                raise _bad("each entry of 'rows' must be an object")
            idx = w.get("rowIndex")
            if not isinstance(idx, int) or isinstance(idx, bool) or not 0 <= idx < len(rows):
                raise _bad(f"rowIndex {idx!r} is not a row of the uploaded file (0..{len(rows) - 1})")
            if idx in seen:
                raise _bad(f"rowIndex {idx} is listed twice")
            seen.add(idx)
            mode = w.get("mode")
            if mode not in IMPORT_MODES:
                raise _bad(f"row {idx}: mode must be one of {list(IMPORT_MODES)}")
            ship_id = None
            if mode == "existing":
                ship_id = w.get("shipId")
                if not isinstance(ship_id, str) or not SHIP_ID_RE.match(ship_id):
                    raise _bad(f"row {idx}: mode 'existing' needs a valid shipId")
            nickname = _nickname(w.get("nickname")) if mode == "new" else None
            reqs.append({"rowIndex": idx, "mode": mode, "shipId": ship_id, "nickname": nickname})

        # Re-decode server side: client-sent changes are never trusted.
        results = await _analyze(rows, [r["rowIndex"] for r in reqs])
        repo = app.state.repository
        owned = {s["shipId"]: s for s in await repo.list_ships(target)}
        errors, plan = [], []
        for r in reqs:
            res = results[r["rowIndex"]]
            # Apply is authoritative: an incompletely analysed row (row-level
            # failure, over the lookup budget, unknown selection category)
            # would reset its unresolved slots to stock -- never write it.
            blocked = res.blocking()
            if blocked is not None:
                errors.append({"rowIndex": r["rowIndex"], "error": blocked[0], "message": blocked[1]})
                continue
            if r["mode"] == "existing":
                ship = owned.get(r["shipId"])
                if ship is None:
                    errors.append({"rowIndex": r["rowIndex"], "error": "not_found",
                                   "message": f"member {target} has no ship {r['shipId']}"})
                    continue
                if ship.get("vehicleUuid") != res.vehicle["uuid"]:
                    errors.append({"rowIndex": r["rowIndex"], "error": "vehicle_mismatch",
                                   "message": f"ship {r['shipId']} is a {ship.get('vehicleName')}, but the "
                                              f"loadout is for a {res.vehicle['name']}"})
                    continue
            plan.append((r, res))
        adding = sum(1 for r, _ in plan if r["mode"] == "new")
        if adding:
            await ensure_ship_capacity(repo, target, adding=adding, limit=config.max_ships_per_member)
        owner_name = owner_name_for(principal, target)
        by = principal.acting_member or principal.subject
        updated_ships = []
        for r, res in plan:
            ship_id = r["shipId"]
            if r["mode"] == "new":
                nickname = r["nickname"] or ((res.loadout_name or "").strip()[:NICKNAME_MAX].strip() or None)
                v = res.vehicle
                created = await repo.create_ship(target, vehicle_uuid=v["uuid"], vehicle_name=v["name"],
                                                 vehicle_class_name=v.get("className"), nickname=nickname,
                                                 updated_by=by, owner_name=owner_name)
                ship_id = created["shipId"]
            updated = await repo.replace_fitted(target, ship_id, res.fitted, updated_by=by,
                                                owner_name=owner_name)
            if updated is None:          # deleted concurrently
                errors.append({"rowIndex": r["rowIndex"], "error": "not_found",
                               "message": f"member {target} has no ship {ship_id}"})
                continue
            log.info("hangar: member %s ship %s %s from spviewer loadout %r (row %d): %d fitted, "
                     "%d skipped (by %s)", target, ship_id,
                     "created" if r["mode"] == "new" else "replaced", res.loadout_name, r["rowIndex"],
                     len(res.fitted), len(res.skipped), by)
            updated_ships.append(updated)
        if adding:
            invalidate_member_directory(app)
        for e in errors:
            log.warning("hangar: spviewer import row %s for member %s not applied: %s: %s",
                        e["rowIndex"], target, e["error"], e["message"])
        views = await asyncio.gather(*(ship_view(app.state.catalog, s) for s in updated_ships))
        return {"ships": list(views), "errors": errors}

    # ----- member directory -----

    @router.get("/members")
    async def list_members(principal: Principal = Depends(get_principal)):
        cached = app.state.member_directory.get()
        if cached is not None:
            return {"members": cached}
        out = []
        for m in await app.state.repository.list_members():
            entry = {"discordId": m["discordId"], "shipCount": m["shipCount"]}
            if m.get("ownerName"):
                entry["displayName"] = m["ownerName"]
            out.append(entry)
        out.sort(key=lambda e: ((e.get("displayName") or e["discordId"]).casefold(), e["discordId"]))
        app.state.member_directory.put(out)
        return {"members": out}

    # Every API route is served under both prefixes (same handlers).
    for prefix in API_PREFIXES:
        app.include_router(router, prefix=prefix)

    # ----- browser login (web editor) -----

    def require_browser_auth() -> tuple[SessionCodec, DiscordOAuth]:
        if codec is None or oauth is None:
            raise ApiError(503, "unavailable",
                           f"browser login is not configured on this server ({browser_problem})")
        return codec, oauth

    # __Host- cookies: Secure, Path=/, no Domain (the browser enforces all three).
    COOKIE_KWARGS = {"path": "/", "secure": True, "httponly": True, "samesite": "lax"}

    def no_store(resp: Response) -> Response:
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/api/auth/login")
    async def auth_login(next: str | None = None):
        c, o = require_browser_auth()
        state = secrets.token_urlsafe(32)
        resp = RedirectResponse(o.authorize_url(state), status_code=302)
        resp.set_cookie(OAUTH_STATE_COOKIE, c.sign_state(state, next or "/"),
                        max_age=OAUTH_STATE_MAX_AGE_S, **COOKIE_KWARGS)
        return no_store(resp)

    @app.get("/api/auth/callback")
    async def auth_callback(request: Request, code: str | None = None, state: str | None = None,
                            error: str | None = None):
        c, o = require_browser_auth()

        def fail(reason: str, detail: str) -> Response:
            log.warning("hangar: discord login failed (%s): %s", reason, detail)
            resp = RedirectResponse(f"/?login_error={reason}", status_code=302)
            resp.delete_cookie(OAUTH_STATE_COOKIE, **COOKIE_KWARGS)
            return no_store(resp)

        try:
            expected, next_path = c.verify_state(request.cookies.get(OAUTH_STATE_COOKIE))
        except InvalidSession as e:
            return fail("state_mismatch", f"state cookie: {e}")
        if not state or not hmac.compare_digest(state.encode(), expected.encode()):
            return fail("state_mismatch", "state parameter does not match the state cookie")
        if error:
            return fail("denied", f"Discord returned error={error!r}")
        if not code:
            return fail("missing_code", "callback carried no authorization code")
        try:
            access_token = await o.exchange_code(code)
            user = await o.fetch_user(access_token)
            # Who may sign in at all (e.g. guild membership) is decided here,
            # after Discord identified the user and before any session exists.
            if login_gate is not None:
                verdict = await login_gate(user, access_token)
                if isinstance(verdict, str):
                    return fail(verdict, f"member {user.discord_id} ({user.username}) refused by login gate")
                if isinstance(verdict, SessionUser):
                    user = verdict
        except DiscordOAuthError as e:
            return fail(e.code, str(e))
        except Exception as e:     # never a stack trace to the browser
            log.error("hangar: discord login crashed: %s", type(e).__name__, exc_info=e)
            return fail("server_error", f"unexpected {type(e).__name__}")
        resp = RedirectResponse(next_path, status_code=302)
        resp.set_cookie(SESSION_COOKIE, c.sign_session(user), max_age=SESSION_MAX_AGE_S,
                        **COOKIE_KWARGS)
        resp.delete_cookie(OAUTH_STATE_COOKIE, **COOKIE_KWARGS)
        log.info("hangar: member %s (%s) logged in to the web editor (guild %s)",
                 user.discord_id, user.username, user.guild_id)
        return no_store(resp)

    @app.post("/api/auth/logout", status_code=204)
    async def auth_logout(request: Request):
        # Same-origin only (no forced cross-site logouts); no session needed.
        check_same_origin(request, config.public_origin)
        resp = Response(status_code=204)
        resp.delete_cookie(SESSION_COOKIE, **COOKIE_KWARGS)
        return no_store(resp)

    @app.get("/api/me")
    async def me(request: Request):
        c, _ = require_browser_auth()
        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            raise AuthError("not logged in")
        try:
            user = c.verify_session(token)
        except InvalidSession as e:
            raise AuthError(f"browser session invalid or expired: {e}") from None
        return no_store(JSONResponse({
            "discordId": user.discord_id, "username": user.username, "globalName": user.global_name,
            "avatarUrl": user.avatar_url, "isAdmin": user.discord_id in config.admin_ids}))

    return app


def _build_repository(config: Config) -> ShipRepository:
    if config.storage == "memory":
        log.warning("hangar: HANGAR_STORAGE=memory -- ships are NOT persisted (local dev only)")
        return InMemoryShipRepository()
    from google.cloud import firestore
    from .repository import FirestoreShipRepository
    return FirestoreShipRepository(firestore.AsyncClient(project=config.project))
