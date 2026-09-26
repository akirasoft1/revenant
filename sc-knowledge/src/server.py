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
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse

from opentelemetry import trace

from . import tracing
from .cache import TTLCache
from .config import Config, load
from .envelope import error
from .http import UpstreamError
from .tools_guides import GuideStore, GuideTools
from .tools_items import ItemTools
from .tools_missions import MissionTools
from .tools_trade import TradeTools
from .uex import build_uex
from .wiki import build_wiki

logger = logging.getLogger("sc_knowledge.server")
_tracer = trace.get_tracer("sc-knowledge")

_GAME_VERSIONS_TTL = 21600
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

    item_tools = ItemTools(wiki, cache)
    mission_tools = MissionTools(wiki, cache)
    trade_tools = TradeTools(uex, cache)
    guide_tools = GuideTools(GuideStore(guides_dir or config.guides_dir))

    async def _live_game_version() -> str | None:
        try:
            res = await cache.get_or_fetch("uex:game_versions", _GAME_VERSIONS_TTL, uex.game_versions)
            return (res.value or {}).get("live")
        except UpstreamError as e:
            logger.warning("game_versions lookup failed: %s", e)
            return None

    async def _guarded(name: str, call) -> dict:
        with _tracer.start_as_current_span("sc.tool") as span:
            span.set_attribute("sc.tool.name", name)
            try:
                result = await call()
                if not isinstance(result, dict):
                    result = error("internal", f"non-dict tool result: {result!r}")
            except Exception as e:  # tools never raise across the MCP boundary
                logger.exception("sc_%s raised unexpectedly", name)
                result = error("internal", repr(e))

            if "error" in result:
                span.set_attribute("sc.result", result["error"])
            else:
                span.set_attribute("sc.result", "ok")
                if "game_version" in result:
                    live = await _live_game_version()
                    note = _patch_note(result.get("game_version"), live)
                    if note:
                        result = {**result, **note}
            if result.get("stale"):
                span.set_attribute("sc.cache", "stale")
            return result

    mcp = MCPServer("sc-knowledge")

    @mcp.tool(name="sc_find_item")
    async def sc_find_item(name: str) -> dict:
        """Look up a single Star Citizen item/component by name (fuzzy match
        on partial or slightly-misspelled names, e.g. "V801-12" or "greatsword
        cannon") and return its stats plus every player-reported shop selling
        it, cheapest first, with location and report date. Numbers (prices,
        stats) are pre-computed from live game data -- prefer this over
        memory, and mention the data's age; the game changes every patch. Do
        NOT compute this yourself or use the sandbox."""
        return await _guarded("sc_find_item", lambda: item_tools.find_item(name))

    @mcp.tool(name="sc_compare_components")
    async def sc_compare_components(type: str, size: int, rank_by: str | None = None,
                                    grade: str | None = None, component_class: str | None = None,
                                    limit: int = 5) -> dict:
        """Rank Star Citizen ship components of one type and size (shield,
        power_plant, cooler, quantum_drive, radar, weapon, missile) against
        each other by their real in-game stats, best first, optionally
        filtered by grade (A/B/C) and class (e.g. "Military", "Competition")
        and ranked by a specific stat via rank_by. Returns each component's
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
        game_version = await _live_game_version()
        return JSONResponse({"ok": True, "version": config.version, "game_version": game_version})

    base_app = mcp.streamable_http_app(streamable_http_path="/mcp", json_response=True,
                                       stateless_http=True)

    mcp_lifespan = base_app.router.lifespan_context
    # asyncio only holds a *weak* reference to a task scheduled via
    # create_task -- without a strong reference kept somewhere the warmup
    # task can be garbage-collected mid-flight. Keep it alive here and let
    # its done-callback drop it once it finishes.
    _background_tasks: set[asyncio.Task] = set()

    async def _warmup() -> None:
        for label, coro in (
            ("terminals", uex.terminals),
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
            task = asyncio.create_task(_warmup())
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)
            yield

    base_app.router.lifespan_context = _lifespan
    return base_app


def main() -> None:
    config = load()
    tracing.setup(config)
    app = build_app(config)
    uvicorn.run(app, host=config.listen_host, port=config.listen_port)


if __name__ == "__main__":
    main()
