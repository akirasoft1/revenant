"""FastMCP (mcp 2.x `MCPServer`) streamable-HTTP server exposing the sc_* tools
over `/mcp`, plus a `GET /healthz` liveness endpoint.

mcp 2.x renamed `mcp.server.fastmcp.FastMCP` to `mcp.server.mcpserver.MCPServer`
(see that module's ModuleNotFoundError message for the migration note) --
`MCPServer.streamable_http_app(streamable_http_path="/mcp", json_response=True,
stateless_http=True)` returns a ready-to-serve `starlette.applications.Starlette`
whose lifespan already runs the MCP `StreamableHTTPSessionManager`; `custom_route`
adds arbitrary Starlette routes (used here for `/healthz`) into that same app.
"""
import asyncio
import logging
import re
from contextlib import asynccontextmanager

import httpx
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse

from opentelemetry import trace

from . import tracing
from .cache import TTLCache
from .config import Config, load
from .envelope import error
from .tools_guides import GuideStore, GuideTools
from .tools_items import ItemTools
from .tools_missions import MissionTools
from .tools_shops import ShopTools
from .tools_trade import TradeTools
from .uex import build_uex
from .wiki import build_wiki

logger = logging.getLogger("sc_knowledge.server")
_tracer = trace.get_tracer("sc-knowledge")

_GAME_VERSIONS_TTL = 21600
_GAME_VERSIONS_KEY = "uex:game_versions"
# Upper bound a tool call waits on the live-game-version lookup for its
# patch note. The note is advisory; a Wiki-only answer must never wait on UEX
# (the voice sidecar bounds a whole tool call at 6s).
_PATCH_NOTE_WAIT_S = 0.5
_VERSION_PREFIX_RE = re.compile(r"(\d+\.\d+\.\d+)")


def _version_prefix(v: str | None) -> str | None:
    if not v:
        return None
    m = _VERSION_PREFIX_RE.search(str(v))
    return m.group(1) if m else None


def _patch_note(result_game_version: str | None, live_game_version: str | None) -> dict:
    """Spec §5 patch awareness: compare the major.minor.patch prefix of a
    tool result's game_version against the live game version. A missing/None
    value on either side (upstream down, or a tool -- like sc_org_guides --
    that carries no top-level game_version at all) means "unknown": never a
    note, never a failure."""
    rp, lp = _version_prefix(result_game_version), _version_prefix(live_game_version)
    if rp is None or lp is None or rp == lp:
        return {}
    return {"note_patch": f"Data is from {result_game_version} but the live game is "
                          f"{live_game_version}; stats may have changed."}


def build_app(config: Config, uex_transport: httpx.AsyncBaseTransport | None = None,
              wiki_transport: httpx.AsyncBaseTransport | None = None,
              guides_dir: str | None = None) -> Starlette:
    cache = TTLCache()
    uex = build_uex(config, uex_transport)
    wiki = build_wiki(config, wiki_transport)

    item_tools = ItemTools(wiki, cache, uex=uex)
    mission_tools = MissionTools(wiki, cache)
    trade_tools = TradeTools(uex, cache)
    guide_tools = GuideTools(GuideStore(guides_dir or config.guides_dir))
    # spawn resolves lazily: _spawn is defined below, and routing the shop
    # tool's background refreshes through it means the lifespan cancels them.
    shop_tools = ShopTools(uex, cache, spawn=lambda coro: _spawn(coro))

    async def _live_game_version() -> str | None:
        # Broad `except Exception` deliberately, not just UpstreamError: this
        # feeds the patch-note merge inside `_guarded` (which must never let a
        # tool call escape the MCP boundary) and the /healthz background
        # refresh. A malformed-but-200 upstream response (e.g. `data` coming
        # back as a list instead of a dict) raises AttributeError on `.get`,
        # not UpstreamError -- that must be swallowed here too.
        # `CancelledError` is a BaseException, not an Exception, so it still
        # propagates.
        try:
            res = await cache.get_or_fetch(_GAME_VERSIONS_KEY, _GAME_VERSIONS_TTL, uex.game_versions)
            return (res.value or {}).get("live")
        except Exception:
            logger.warning("game_versions lookup failed", exc_info=True)
            return None

    def _cached_game_version() -> tuple[str | None, bool]:
        """(cached live version or None, is_fresh). Never fetches."""
        peeked = cache.peek(_GAME_VERSIONS_KEY, _GAME_VERSIONS_TTL)
        if peeked is None:
            return None, False
        try:
            return (peeked.value or {}).get("live"), peeked.status == "hit"
        except Exception:  # malformed cached payload -- treat as unknown
            return None, peeked.status == "hit"

    # asyncio only holds a *weak* reference to a task scheduled via
    # create_task -- without a strong reference kept somewhere a background
    # task can be garbage-collected mid-flight. Keep them here; each task's
    # done-callback drops it, and the lifespan cancels any left at shutdown.
    _background_tasks: set[asyncio.Task] = set()
    _version_refresh: dict[str, asyncio.Task | None] = {"task": None}

    def _spawn(coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
        return task

    def _game_version_refresh() -> asyncio.Task:
        """The single in-flight game-version refresh (started if none is).
        Single-flight so a burst of probes/tool calls during a UEX outage
        starts ONE upstream fetch, not one per caller."""
        task = _version_refresh["task"]
        if task is None or task.done():
            task = _spawn(_live_game_version())
            _version_refresh["task"] = task
        return task

    async def _live_game_version_bounded() -> str | None:
        """Live version for the patch note, waiting at most
        _PATCH_NOTE_WAIT_S. A fresh cached value is used directly; otherwise
        the shared refresh is awaited under `shield`, so a timeout abandons
        the WAIT, not the fetch -- the refresh completes in the background
        and populates the cache for the next call."""
        cached, fresh = _cached_game_version()
        if fresh:
            return cached
        try:
            return await asyncio.wait_for(asyncio.shield(_game_version_refresh()),
                                          _PATCH_NOTE_WAIT_S)
        except TimeoutError:
            return cached  # last known value (possibly None) -- never fail the call
        except Exception:
            return cached

    async def _guarded(name: str, call) -> dict:
        with _tracer.start_as_current_span("sc.tool") as span:
            span.set_attribute("sc.tool.name", name)
            try:
                result = await call()
                if not isinstance(result, dict):
                    result = error("internal", f"non-dict tool result: {result!r}")
            except Exception as e:  # tools never raise across the MCP boundary
                # `name` is already the full tool name (e.g. "sc_find_item") --
                # a "sc_%s" format here doubled the prefix to "sc_sc_find_item".
                logger.exception("%s raised unexpectedly", name)
                result = error("internal", repr(e))

            if "error" in result:
                span.set_attribute("sc.result", result["error"])
            else:
                span.set_attribute("sc.result", "ok")
                if "game_version" in result:
                    live = await _live_game_version_bounded()
                    note = _patch_note(result.get("game_version"), live)
                    if note:
                        result = {**result, **note}
            if result.get("stale"):
                span.set_attribute("sc.cache", "stale")
            return result

    mcp = MCPServer("sc-knowledge")

    @mcp.tool(name="sc_find_item")
    async def sc_find_item(name: str) -> dict:
        """Look up a single Star Citizen item/component OR ship/vehicle by
        name (fuzzy match on partial or slightly-misspelled names, e.g.
        "V801-12", "greatsword cannon", or a ship like "Scorpius") and return
        its stats plus every player-reported shop/dealer selling it, cheapest
        first, with location and report date. Tolerant of voice/ASR noise: a
        misheard letter next to a digit (e.g. "v8o1-12") or a trailing
        category word tacked onto the name (e.g. "V801-12 radar") is retried
        automatically, and the result notes when this happened. Numbers
        (prices, stats) are pre-computed from live game data -- prefer this
        over memory, and mention the data's age; the game changes every
        patch. Do NOT compute this yourself or use the sandbox."""
        return await _guarded("sc_find_item", lambda: item_tools.find_item(name))

    @mcp.tool(name="sc_compare_components")
    async def sc_compare_components(type: str, size: int, rank_by: str | None = None,
                                    grade: str | None = None, component_class: str | None = None,
                                    limit: int = 5) -> dict:
        """Rank Star Citizen ship components of one type and size (shield,
        power_plant, cooler, quantum_drive, radar, weapon, missile) against
        each other by their real in-game stats, best first, optionally
        filtered by grade (A/B/C) and class (e.g. "Military", "Competition")
        and ranked by a specific stat via rank_by. Both type and rank_by
        tolerate spoken/typed synonyms (e.g. type="shield generator",
        rank_by="most powerful" or "shield_hp") -- an unrecognised rank_by
        never fails the call, it falls back to the type's default stat and
        the result explains the substitution. Returns each component's
        key stats and cheapest known shop price. Numbers are pre-computed
        from live game data -- prefer this over memory; component balance
        changes every patch. Do NOT compute rankings yourself or use the
        sandbox."""
        return await _guarded("sc_compare_components", lambda: item_tools.compare_components(
            type=type, size=size, rank_by=rank_by, grade=grade, class_=component_class, limit=limit))

    @mcp.tool(name="sc_faction_missions")
    async def sc_faction_missions(faction: str, current_rank: str | None = None,
                                  system: str | None = None, limit: int = 10) -> dict:
        """Look up Star Citizen missions offered by a faction (fuzzy name
        match), ranked by reputation gained per estimated minute so the best
        rep-grinding missions surface first, optionally filtered by the
        player's current reputation rank and star system. Numbers (rep
        amounts, tiers) are pre-computed from live game data -- prefer this
        over memory; mission rewards and availability change every patch. Do
        NOT compute this yourself or use the sandbox."""
        return await _guarded("sc_faction_missions", lambda: mission_tools.faction_missions(
            faction, current_rank=current_rank, system=system, limit=limit))

    @mcp.tool(name="sc_trade_routes")
    async def sc_trade_routes(origin: str, destination: str | None = None,
                              commodity: str | None = None, cargo_scu: int | None = None,
                              budget_auec: int | None = None, limit: int = 5) -> dict:
        """Profitable Star Citizen commodity trade routes starting at a
        terminal, station, city, planet or system (fuzzy names like
        "MIC-L5" work). Returns routes already ranked by total profit, with
        profit per SCU, ROI, and total profit capped by cargo_scu and
        budget_auec when given; flags lawless (Pyro) endpoints and the date
        each price was reported. Prices are player-reported to UEX and
        change constantly -- prefer this over memory, and mention the data
        age. Do NOT compute routes yourself or use the sandbox."""
        return await _guarded("sc_trade_routes", lambda: trade_tools.trade_routes(
            origin, destination=destination, commodity=commodity, cargo_scu=cargo_scu,
            budget_auec=budget_auec, limit=limit))

    @mcp.tool(name="sc_commodity_prices")
    async def sc_commodity_prices(commodity: str, location: str | None = None,
                                  side: str = "sell", limit: int = 5) -> dict:
        """Current Star Citizen commodity buy/sell prices at player-reported
        UEX terminals (fuzzy commodity + optional location match), sorted
        best price first for the given side ("buy" or "sell"). Returns each
        terminal's price, stock/demand, and report date. Prices are
        player-reported and change constantly -- prefer this over memory,
        and mention the data age. Do NOT compute this yourself or use the
        sandbox."""
        return await _guarded("sc_commodity_prices", lambda: trade_tools.commodity_prices(
            commodity, location=location, side=side, limit=limit))

    @mcp.tool(name="sc_location_shops")
    async def sc_location_shops(location: str, category: str | None = None,
                                exclusive_only: bool = False, limit: int = 40) -> dict:
        """What's sold at a Star Citizen place -- a city, station, outpost,
        planet/moon, system or a specific shop (e.g. "Levski", "Area 18",
        "Teach's Levski") -- and which of those items are UNIQUE to it
        (sold at no other live shop). Use for "what's sold at <place>",
        "anything unique to <place>", "what can I only buy at <place>".
        Optional category narrows the list: a section or category name
        ("helmets", "vehicle weapons", "coolers") or the aliases "ship parts"
        / "ship components" and "fps gear" / "fps equipment" (several may be
        joined with "or"); an unrecognised category is ignored with a note.
        exclusive_only=true keeps only the items unique to that place.
        Each item lists its section, category, the shops there and their
        buy prices; exclusive items sort first. Data is player-reported to
        UEX (crowd-sourced) and may miss shops -- say so, and mention the
        data age. Prefer this over memory -- locations and shop stock change
        every patch; do NOT use the sandbox."""
        return await _guarded("sc_location_shops", lambda: shop_tools.location_shops(
            location, category=category, exclusive_only=exclusive_only, limit=limit))

    @mcp.tool(name="sc_org_guides")
    async def sc_org_guides(query: str, limit: int = 3) -> dict:
        """Search curated org guides for mechanics/strategy know-how -- mining
        scan signatures, salvage contracts, trading risk, and similar
        organization-authored tips that don't come from a live API. Live
        data from the other sc_ tools wins for prices/stats when the two
        disagree; cite the guide when you use it."""
        async def _call() -> dict:
            return guide_tools.org_guides(query, limit=limit)  # sync method, no upstream I/O
        return await _guarded("sc_org_guides", _call)

    @mcp.custom_route("/healthz", methods=["GET"])
    async def healthz(request: Request) -> JSONResponse:
        # Health means "process serving"; upstream outages are reported per
        # tool call, not here -- a down UEX must never flip readiness/liveness.
        # So /healthz NEVER fetches: it reports the cached game version (None
        # when cold) and, if that is missing or expired, kicks off one
        # background refresh. Awaiting UEX here (3 attempts x 8s read) blew
        # the kubelet probe timeout during a UEX outage -> restart loop.
        game_version, fresh = _cached_game_version()
        if not fresh:
            _game_version_refresh()
        return JSONResponse({"ok": True, "version": config.version, "game_version": game_version})

    # mcp 2.2's streamable_http_app defaults `host="127.0.0.1"`, which enables
    # DNS-rebinding protection with a loopback-only Host allow-list -- every
    # in-cluster call (Host `sc-knowledge.discord-article-bot.svc...:8080`)
    # was rejected with `421 Invalid Host header`. Keep the protection on,
    # but allow the Service's in-cluster names (SC_ALLOWED_HOSTS overrides).
    # allowed_origins stays empty: server-to-server MCP clients send no
    # Origin header, and an absent Origin always passes.
    transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=list(config.allowed_hosts),
    )
    base_app = mcp.streamable_http_app(streamable_http_path="/mcp", json_response=True,
                                       stateless_http=True,
                                       transport_security=transport_security)

    mcp_lifespan = base_app.router.lifespan_context

    async def _warmup() -> None:
        # Through the cache (terminals, categories, items_prices_all), so the
        # first sc_location_shops call after startup doesn't pay the ~6 MB
        # items_prices_all fetch inside the voice path's 6s tool bound.
        await shop_tools.warm()
        for label, coro in (
            ("commodities", uex.commodities),
            ("factions", wiki.factions),
        ):
            try:
                await coro()
            except Exception:  # best-effort prefetch; never fatal
                logger.warning("warmup prefetch of %s failed", label, exc_info=True)

    @asynccontextmanager
    async def _lifespan(app):
        async with mcp_lifespan(app):
            _spawn(_warmup())
            try:
                yield
            finally:
                for task in list(_background_tasks):
                    task.cancel()
                if _background_tasks:
                    await asyncio.gather(*_background_tasks, return_exceptions=True)

    base_app.router.lifespan_context = _lifespan
    return base_app


def main() -> None:
    config = load()
    tracing.setup(config)
    app = build_app(config)
    uvicorn.run(app, host=config.listen_host, port=config.listen_port)


if __name__ == "__main__":
    main()
