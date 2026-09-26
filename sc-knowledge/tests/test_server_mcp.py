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
            "sc_trade_routes", "sc_commodity_prices", "sc_org_guides"}

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


async def test_lists_exactly_the_six_tools(server_url):
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
