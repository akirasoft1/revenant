import asyncio
import json
import os
import socket
from contextlib import asynccontextmanager

import httpx
import pytest
import uvicorn

from src.config import load
from src.server import _patch_note, build_app
from tests.conftest import fixture_transport

EXPECTED = {"sc_find_item", "sc_compare_components", "sc_faction_missions",
            "sc_trade_routes", "sc_commodity_prices", "sc_org_guides", "sc_location_shops",
            "sc_member_hangar", "sc_member_fit_check"}

GUIDES_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "guides")


def _free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


@asynccontextmanager
async def _running(app):
    """Serve `app` on an in-process uvicorn server; yield its base URL."""
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    try:
        while not server.started:
            await asyncio.sleep(0.05)
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


def _malformed_game_versions_transport() -> httpx.MockTransport:
    """UEX `/2.0/game_versions` responds 200 with `data` as a list instead of
    a dict -- `.get("live")` on it raises AttributeError, not UpstreamError."""
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.startswith("/2.0/game_versions"):
            return httpx.Response(200, json={"status": "ok", "data": [1, 2]})
        return httpx.Response(404, json={"status": "not_found"})
    return httpx.MockTransport(handler)


def _connect_error_transport() -> httpx.MockTransport:
    """Every request raises httpx.ConnectError -- deterministic stand-in for
    "UEX is unreachable", instead of depending on the real network."""
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=req)
    return httpx.MockTransport(handler)


@pytest.fixture
async def server_url():
    app = build_app(load(),
        uex_transport=fixture_transport({"/2.0/terminals": "uex_terminals.json",
                                         "/2.0/commodities_routes": "uex_routes_mic_l5.json",
                                         "/2.0/commodities": "uex_commodities.json",
                                         "/2.0/game_versions": "uex_game_versions.json"}),
        wiki_transport=fixture_transport({"/api/v2/items/V801-12": "wiki_item_v801_12.json",
                                          "/api/vehicle-items": "wiki_vehicle_items_shield_s2.json",
                                          "/api/missions": "wiki_missions_foxwell.json",
                                          "/api/factions": "wiki_factions.json"}),
        guides_dir=GUIDES_DIR)
    async with _running(app) as url:
        yield url


async def test_lists_exactly_the_nine_tools(server_url):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    async with streamable_http_client(f"{server_url}/mcp") as streams:
        async with ClientSession(streams[0], streams[1]) as s:
            await s.initialize()
            names = {t.name for t in (await s.list_tools()).tools}
    assert names == EXPECTED


async def test_call_find_item_round_trip(server_url):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    async with streamable_http_client(f"{server_url}/mcp") as streams:
        async with ClientSession(streams[0], streams[1]) as s:
            await s.initialize()
            res = await s.call_tool("sc_find_item", {"name": "V801-12"})
    assert not res.is_error
    data = res.structured_content or json.loads(res.content[0].text)
    data = data.get("result", data)
    assert data["where_to_buy"][0]["price_auec"] == 352000


async def test_call_org_guides_no_top_level_game_version(server_url):
    """Controller ruling: sc_org_guides carries no top-level game_version --
    per-section `version` instead. The patch-note merge must never attach a
    note_patch (or fail the call) when the tool's own dict has no
    game_version key at all."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    async with streamable_http_client(f"{server_url}/mcp") as streams:
        async with ClientSession(streams[0], streams[1]) as s:
            await s.initialize()
            res = await s.call_tool("sc_org_guides", {"query": "resource signature"})
    assert not res.is_error
    data = res.structured_content or json.loads(res.content[0].text)
    data = data.get("result", data)
    assert "game_version" not in data
    assert "note_patch" not in data
    assert data["sections"]


async def test_call_compare_components_maps_component_class(server_url):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    async with streamable_http_client(f"{server_url}/mcp") as streams:
        async with ClientSession(streams[0], streams[1]) as s:
            await s.initialize()
            res = await s.call_tool(
                "sc_compare_components",
                {"type": "shield", "size": 2, "component_class": "Military"})
    assert not res.is_error
    data = res.structured_content or json.loads(res.content[0].text)
    data = data.get("result", data)
    assert data["type"] == "shield"


async def test_unexpected_exception_never_raises_across_mcp(server_url, monkeypatch):
    """Every tool body is wrapped so an unexpected exception returns
    error('internal', repr(e)) instead of propagating."""
    from src.tools_items import ItemTools

    async def _boom(self, *a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(ItemTools, "find_item", _boom)

    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    async with streamable_http_client(f"{server_url}/mcp") as streams:
        async with ClientSession(streams[0], streams[1]) as s:
            await s.initialize()
            res = await s.call_tool("sc_find_item", {"name": "anything"})
    assert not res.is_error
    data = res.structured_content or json.loads(res.content[0].text)
    data = data.get("result", data)
    assert data["error"] == "internal"
    assert "boom" in data["detail"]


async def test_healthz(server_url):
    import httpx
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{server_url}/healthz")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert "version" in r.json() and "game_version" in r.json()


async def test_healthz_ok_even_when_uex_unreachable():
    app = build_app(load(), uex_transport=_connect_error_transport(), guides_dir=GUIDES_DIR)
    async with _running(app) as url:
        async with httpx.AsyncClient() as c:
            r = await c.get(f"{url}/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["game_version"] is None


async def test_healthz_ok_with_game_version_null_when_game_versions_malformed():
    """A non-dict `data` in a 200 UEX response (AttributeError on `.get`, not
    an UpstreamError) must not turn /healthz non-200 -- that would restart-loop
    the pod over upstream data, not a process failure."""
    app = build_app(load(), uex_transport=_malformed_game_versions_transport(), guides_dir=GUIDES_DIR)
    async with _running(app) as url:
        async with httpx.AsyncClient() as c:
            r = await c.get(f"{url}/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["game_version"] is None


async def test_tool_call_succeeds_without_note_patch_when_game_versions_malformed():
    """Same malformed-UEX-response scenario, but through a tool call: the
    AttributeError inside `_live_game_version` must not escape `_guarded`,
    and no note_patch is attached since the live version is unknown."""
    app = build_app(load(),
        uex_transport=_malformed_game_versions_transport(),
        wiki_transport=fixture_transport({"/api/v2/items/V801-12": "wiki_item_v801_12.json"}),
        guides_dir=GUIDES_DIR)
    async with _running(app) as url:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
        async with streamable_http_client(f"{url}/mcp") as streams:
            async with ClientSession(streams[0], streams[1]) as s:
                await s.initialize()
                res = await s.call_tool("sc_find_item", {"name": "V801-12"})
    assert not res.is_error
    data = res.structured_content or json.loads(res.content[0].text)
    data = data.get("result", data)
    assert "note_patch" not in data
    assert data["where_to_buy"][0]["price_auec"] == 352000


# --- _patch_note (pure comparison helper) -----------------------------------

def test_patch_note_equal_versions_returns_empty():
    assert _patch_note("4.10.1-LIVE.12660092", "4.10.1") == {}


def test_patch_note_differing_versions_returns_note():
    note = _patch_note("4.9.0-LIVE.999", "4.10.1")
    assert note["note_patch"] == (
        "Data is from 4.9.0-LIVE.999 but the live game is 4.10.1; stats may have changed.")


def test_patch_note_unknown_result_version_returns_empty():
    assert _patch_note(None, "4.10.1") == {}


def test_patch_note_unknown_live_version_returns_empty():
    assert _patch_note("4.10.1", None) == {}


def test_patch_note_both_unknown_returns_empty():
    assert _patch_note(None, None) == {}


# --- C1: DNS-rebinding Host allow-list ------------------------------------------

_INIT_BODY = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                         "clientInfo": {"name": "host-test", "version": "0"}}}
_MCP_HEADERS = {"Content-Type": "application/json",
                "Accept": "application/json, text/event-stream"}


async def _post_initialize(url: str, host: str) -> httpx.Response:
    async with httpx.AsyncClient() as c:
        return await c.post(f"{url}/mcp", json=_INIT_BODY,
                            headers={**_MCP_HEADERS, "Host": host})


@pytest.mark.parametrize("host", [
    "sc-knowledge.discord-article-bot.svc.cluster.local:8080",
    "sc-knowledge.discord-article-bot.svc:8080",
    "sc-knowledge.discord-article-bot:8080",
    "sc-knowledge:8080",
    "localhost:8080",
    "127.0.0.1:8080",
])
async def test_in_cluster_host_headers_are_accepted(server_url, host):
    """mcp 2.2's streamable_http_app defaults host="127.0.0.1", which turns on
    DNS-rebinding protection allowing only localhost Host headers -- every
    in-cluster call got `421 Invalid Host header`."""
    r = await _post_initialize(server_url, host)
    assert r.status_code == 200, r.text
    assert r.json()["result"]["serverInfo"]["name"] == "sc-knowledge"


async def test_foreign_host_header_is_rejected(server_url):
    r = await _post_initialize(server_url, "evil.example:8080")
    assert r.status_code == 421


async def test_allowed_hosts_configurable_via_env(monkeypatch):
    monkeypatch.setenv("SC_ALLOWED_HOSTS", "custom.example:*, other.example:9000")
    app = build_app(load(), uex_transport=_connect_error_transport(), guides_dir=GUIDES_DIR)
    async with _running(app) as url:
        ok = await _post_initialize(url, "custom.example:8080")
        exact = await _post_initialize(url, "other.example:9000")
        default_gone = await _post_initialize(url, "sc-knowledge:8080")
    assert ok.status_code == 200
    assert exact.status_code == 200
    assert default_gone.status_code == 421


async def test_healthz_is_not_host_guarded(server_url):
    """kubelet probes send Host `<podIP>:8080` -- the allow-list only guards
    /mcp, never the liveness/readiness endpoint."""
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{server_url}/healthz", headers={"Host": "10.42.0.17:8080"})
    assert r.status_code == 200


# --- I1: /healthz and the patch note never wait on UEX -----------------------------

def _hanging_game_versions_transport(hits: list | None = None) -> httpx.MockTransport:
    """UEX `/2.0/game_versions` accepts and never answers (a MockTransport is
    not subject to httpx timeouts, so this hangs until cancelled) -- the
    worst-case upstream for a liveness probe. Everything else 404s."""
    async def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.startswith("/2.0/game_versions"):
            if hits is not None:
                hits.append(req.url.path)
            await asyncio.Event().wait()
        return httpx.Response(404, json={"status": "not_found"})
    return httpx.MockTransport(handler)


async def test_healthz_returns_fast_when_game_versions_hangs():
    hits: list = []
    app = build_app(load(), uex_transport=_hanging_game_versions_transport(hits),
                    guides_dir=GUIDES_DIR)
    async with _running(app) as url:
        async with httpx.AsyncClient() as c:
            loop = asyncio.get_running_loop()
            t0 = loop.time()
            responses = [await c.get(f"{url}/healthz", timeout=2.0) for _ in range(5)]
            elapsed = loop.time() - t0
        await asyncio.sleep(0.1)
    assert all(r.status_code == 200 for r in responses)
    assert all(r.json()["game_version"] is None for r in responses)
    assert elapsed < 1.0
    # five probes, ONE background refresh in flight -- not five
    assert len(hits) == 1


async def test_healthz_reports_cached_game_version_after_background_refresh(server_url):
    async with httpx.AsyncClient() as c:
        first = await c.get(f"{server_url}/healthz")
        assert first.status_code == 200
        for _ in range(40):
            r = await c.get(f"{server_url}/healthz")
            if r.json()["game_version"]:
                break
            await asyncio.sleep(0.05)
    assert r.json()["game_version"]


async def test_tool_call_returns_fast_without_note_patch_when_game_versions_hangs():
    app = build_app(load(),
        uex_transport=_hanging_game_versions_transport(),
        wiki_transport=fixture_transport({"/api/v2/items/V801-12": "wiki_item_v801_12.json"}),
        guides_dir=GUIDES_DIR)
    async with _running(app) as url:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
        async with streamable_http_client(f"{url}/mcp") as streams:
            async with ClientSession(streams[0], streams[1]) as s:
                await s.initialize()
                loop = asyncio.get_running_loop()
                t0 = loop.time()
                res = await s.call_tool("sc_find_item", {"name": "V801-12"})
                elapsed = loop.time() - t0
    assert not res.is_error
    data = res.structured_content or json.loads(res.content[0].text)
    data = data.get("result", data)
    assert "note_patch" not in data
    assert data["where_to_buy"][0]["price_auec"] == 352000
    assert elapsed < 1.2


async def test_call_location_shops_round_trip():
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    from tests.test_tools_shops import _transport
    app = build_app(load(), uex_transport=_transport(), guides_dir=GUIDES_DIR)
    async with _running(app) as url:
        async with streamable_http_client(f"{url}/mcp") as streams:
            async with ClientSession(streams[0], streams[1]) as s:
                await s.initialize()
                res = await s.call_tool("sc_location_shops",
                                        {"location": "Levski", "exclusive_only": True})
    assert not res.is_error
    data = res.structured_content or json.loads(res.content[0].text)
    data = data.get("result", data)
    assert data["location"] == "Levski"
    assert data["items"] and all(i["exclusive"] for i in data["items"])


async def test_startup_warms_shop_data_in_background():
    """The voice path bounds a tool call at 6s; items_prices_all is ~6 MB, so
    startup must prefetch it (plus categories and terminals) into the cache
    without blocking the server from starting."""
    from tests.test_tools_shops import _transport
    calls: list = []
    app = build_app(load(), uex_transport=_transport(calls=calls), guides_dir=GUIDES_DIR)
    async with _running(app):
        for _ in range(100):
            if {"/2.0/items_prices_all", "/2.0/categories", "/2.0/terminals"} <= set(calls):
                break
            await asyncio.sleep(0.05)
    assert {"/2.0/items_prices_all", "/2.0/categories", "/2.0/terminals"} <= set(calls)


async def _call(url, tool, args):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    async with streamable_http_client(f"{url}/mcp") as streams:
        async with ClientSession(streams[0], streams[1]) as s:
            await s.initialize()
            res = await s.call_tool(tool, args)
    assert not res.is_error
    data = res.structured_content or json.loads(res.content[0].text)
    return data.get("result", data)


async def test_hangar_tools_unavailable_when_hangar_url_unset(server_url, monkeypatch):
    # server_url's app was built from load() with no HANGAR_API_URL in the env.
    data = await _call(server_url, "sc_member_hangar", {"member_id": "111"})
    assert data["error"] == "unavailable"
    data = await _call(server_url, "sc_member_fit_check", {"member_id": "111", "item": "V801-12"})
    assert data["error"] == "unavailable"


class _FakeHangarClient:
    def __init__(self):
        self.closed = False

    async def get_hangar(self, member_id):
        return {"member": member_id, "ships": [{
            "shipId": "s1", "vehicleUuid": "v1", "vehicleName": "Constellation Taurus",
            "vehicleClassName": "RSI_Constellation_Taurus", "nickname": None, "fitted": {},
            "loadout": [{"slot": "hardpoint_radar", "type": "Radar", "sizeMin": 1, "sizeMax": 2,
                         "item": None, "source": "stock"}], "loadoutError": None}]}

    async def aclose(self):
        self.closed = True


async def test_hangar_tools_round_trip_with_client():
    fake = _FakeHangarClient()
    app = build_app(load(),
        uex_transport=fixture_transport({"/2.0/game_versions": "uex_game_versions.json"}),
        wiki_transport=fixture_transport({"/api/v2/items/V801-12": "wiki_item_v801_12.json"}),
        guides_dir=GUIDES_DIR, hangar_client=fake)
    async with _running(app) as url:
        data = await _call(url, "sc_member_hangar", {"member_id": "111", "ship": "Connie"})
        assert data["ship"]["vehicle"] == "Constellation Taurus"
        data = await _call(url, "sc_member_fit_check", {"member_id": "222", "item": "V801-12"})
        assert data["member"] == "222"
        assert data["ships"][0]["slots"][0]["verdict"] == "upgrade"  # empty radar slot
    assert fake.closed


async def test_compare_components_purchasable_only_over_mcp(server_url):
    data = await _call(server_url, "sc_compare_components",
                       {"type": "shield", "size": 2, "purchasable_only": True, "limit": 20})
    assert data["purchasable_only"] is True
    assert all(r["cheapest"] for r in data["results"])


async def test_hangar_tool_docstrings_scope_and_member_id():
    app = build_app(load(), guides_dir=GUIDES_DIR)
    async with _running(app) as url:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
        async with streamable_http_client(f"{url}/mcp") as streams:
            async with ClientSession(streams[0], streams[1]) as s:
                await s.initialize()
                tools = {t.name: t for t in (await s.list_tools()).tools}
    for name in ("sc_member_hangar", "sc_member_fit_check"):
        d = " ".join(tools[name].description.split())
        assert "ONLY" in d and "numeric Discord ID" in d and '"my"' in d and "sandbox" in d
    assert "purchasable_only" in tools["sc_compare_components"].description
