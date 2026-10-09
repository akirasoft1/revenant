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
    GET    /v1/catalog/vehicles?q=&limit=
    GET    /v1/catalog/vehicles/{uuid}/slots
    GET    /v1/catalog/items?type=&size=&q=
    GET    /v1/members                                      member directory (>= 1 ship)

Every ``/v1/...`` route is ALSO served at ``/api/v1/...`` (same handler): service
callers use ``/v1`` on the run.app URL, the browser editor uses ``/api/v1``
through the load balancer. Browser-only routes (web editor, Discord login):

    GET    /api/auth/login?next=/path      302 -> Discord authorize (sets hangar_oauth_state)
    GET    /api/auth/callback?code&state   302 -> next (sets hangar_session) | /?login_error=<code>
    POST   /api/auth/logout                204, clears hangar_session
    GET    /api/me                         {discordId, username, globalName, avatarUrl, isAdmin} | 401

Browser login is configured by DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET /
HANGAR_SESSION_KEY; without them the login routes and /api/me answer 503
``unavailable`` and session cookies are not a credential (service callers are
unaffected). Session-principal writes must be same-origin (Origin/Referer ==
HANGAR_PUBLIC_ORIGIN) and ignore X-Acting-Member.

Every error is ``{"error": <code>, "message": <text>, ...}`` with a stable code:
``unauthenticated`` 401, ``forbidden`` 403, ``not_found`` 404, ``ambiguous``
409 (+ ``candidates``), ``incompatible`` 422, ``invalid_request`` 400,
``unavailable`` 503 (Wiki / Firestore / Google certs down).
"""
import asyncio
import contextlib
import hmac
import logging
import re
import secrets
import time
from typing import Any, Callable

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
                      InvalidSession, SessionCodec)
from .catalog import UnknownItemType, build_catalog
from .config import Config
from .http import UpstreamError
from .loadout import check_compatible, effective_loadout
from .repository import InMemoryShipRepository, RepositoryError, ShipRepository

log = logging.getLogger(__name__)

MEMBER_ID_RE = re.compile(r"^[0-9]{1,32}$")          # Discord snowflake
SHIP_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NICKNAME_MAX = 64
SLOT_MAX = 300
FREE_TEXT_MAX = 200
API_PREFIXES = ("/v1", "/api/v1")     # service callers, browser editor
STATE_COOKIE_PATH = "/api/auth"


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
               clock: Callable[[], float] | None = None) -> FastAPI:
    owns_catalog = catalog is None
    if catalog is None:
        catalog = build_catalog(config.wiki_base, version=config.version)
    browser_problem = config.browser_auth_problem()
    codec: SessionCodec | None = None
    oauth: DiscordOAuth | None = None
    if browser_problem is None:
        codec = SessionCodec(config.session_key, clock=clock or time.time)
        oauth = DiscordOAuth(config.discord_client_id, config.discord_client_secret,
                             config.redirect_uri, transport=discord_transport)
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
        return _err(500, "unavailable", f"internal error: {type(e).__name__}: {e}")

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, e: StarletteHTTPException):
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
        ship = await app.state.repository.create_ship(
            discordId, vehicle_uuid=v["uuid"], vehicle_name=v["name"],
            vehicle_class_name=v.get("className"), nickname=nickname,
            updated_by=principal.acting_member, owner_name=owner_name_for(principal, discordId))
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

    # ----- member directory -----

    @router.get("/members")
    async def list_members(principal: Principal = Depends(get_principal)):
        out = []
        for m in await app.state.repository.list_members():
            entry = {"discordId": m["discordId"], "shipCount": m["shipCount"]}
            if m.get("ownerName"):
                entry["displayName"] = m["ownerName"]
            out.append(entry)
        out.sort(key=lambda e: ((e.get("displayName") or e["discordId"]).casefold(), e["discordId"]))
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

    def cookie_kwargs(path: str) -> dict:
        return {"path": path, "secure": True, "httponly": True, "samesite": "lax"}

    def no_store(resp: Response) -> Response:
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/api/auth/login")
    async def auth_login(next: str | None = None):
        c, o = require_browser_auth()
        state = secrets.token_urlsafe(32)
        resp = RedirectResponse(o.authorize_url(state), status_code=302)
        resp.set_cookie(OAUTH_STATE_COOKIE, c.sign_state(state, next or "/"),
                        max_age=OAUTH_STATE_MAX_AGE_S, **cookie_kwargs(STATE_COOKIE_PATH))
        return no_store(resp)

    @app.get("/api/auth/callback")
    async def auth_callback(request: Request, code: str | None = None, state: str | None = None,
                            error: str | None = None):
        c, o = require_browser_auth()

        def fail(reason: str, detail: str) -> Response:
            log.warning("hangar: discord login failed (%s): %s", reason, detail)
            resp = RedirectResponse(f"/?login_error={reason}", status_code=302)
            resp.delete_cookie(OAUTH_STATE_COOKIE, **cookie_kwargs(STATE_COOKIE_PATH))
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
        except DiscordOAuthError as e:
            return fail(e.code, str(e))
        except Exception as e:     # never a stack trace to the browser
            log.error("hangar: discord login crashed: %s", type(e).__name__, exc_info=e)
            return fail("server_error", f"unexpected {type(e).__name__}")
        resp = RedirectResponse(next_path, status_code=302)
        resp.set_cookie(SESSION_COOKIE, c.sign_session(user), max_age=SESSION_MAX_AGE_S,
                        **cookie_kwargs("/"))
        resp.delete_cookie(OAUTH_STATE_COOKIE, **cookie_kwargs(STATE_COOKIE_PATH))
        log.info("hangar: member %s (%s) logged in to the web editor", user.discord_id, user.username)
        return no_store(resp)

    @app.post("/api/auth/logout", status_code=204)
    async def auth_logout():
        # No auth or origin check: clearing one's own cookie is always safe.
        resp = Response(status_code=204)
        resp.delete_cookie(SESSION_COOKIE, **cookie_kwargs("/"))
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
