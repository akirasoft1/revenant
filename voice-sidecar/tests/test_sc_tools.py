import asyncio
import json
from types import SimpleNamespace

import pytest
from google.genai import types

from src.sc_tools import ScToolExecutor


class FakeTool:
    def __init__(self, name):
        self.name = name
        self.description = f"desc {name}"
        self.inputSchema = {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}


class FakeResult:
    def __init__(self, data, is_error=False):
        self.structured_content = data
        self.is_error = is_error
        self.content = []


class FakeSession:
    def __init__(self, delay=0.0):
        self.delay = delay
    async def list_tools(self):
        class R: tools = [FakeTool("sc_find_item"), FakeTool("sc_trade_routes"), FakeTool("other")]
        return R()
    async def call_tool(self, name, args):
        await asyncio.sleep(self.delay)
        return FakeResult({"echo": name, "args": args})


def _factory(delay=0.0):
    class Ctx:
        async def __aenter__(self): return FakeSession(delay)
        async def __aexit__(self, *a): return False
    return lambda: Ctx()


async def test_refresh_keeps_only_sc_tools_as_declarations():
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory())
    assert await ex.refresh()
    assert [d.name for d in ex.declarations] == ["sc_find_item", "sc_trade_routes"]


async def test_call_returns_structured_dict():
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory())
    assert await ex.call("sc_find_item", {"name": "V801-12"}) == {"echo": "sc_find_item", "args": {"name": "V801-12"}}


async def test_call_timeout_returns_error_not_raise():
    ex = ScToolExecutor("http://x/mcp", timeout_s=0.05, session_factory=_factory(delay=1.0))
    r = await ex.call("sc_find_item", {"name": "x"})
    assert r["error"] == "timeout"


async def test_refresh_failure_keeps_previous_declarations():
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory())
    await ex.refresh()
    def boom():
        raise OSError("down")
    ex._session_factory = boom
    assert await ex.refresh() is False
    assert len(ex.declarations) == 2


# ---- beyond the brief's minimum -------------------------------------------

def _factory_returning(result):
    class S:
        async def call_tool(self, name, args):
            return result
    class Ctx:
        async def __aenter__(self): return S()
        async def __aexit__(self, *a): return False
    return lambda: Ctx()


def test_declarations_empty_before_refresh():
    assert ScToolExecutor("http://x/mcp", session_factory=_factory()).declarations == []


async def test_declarations_carry_raw_json_schema_and_description():
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory())
    await ex.refresh()
    d = ex.declarations[0]
    assert isinstance(d, types.FunctionDeclaration)
    assert d.description == "desc sc_find_item"
    assert d.parameters_json_schema == FakeTool("x").inputSchema
    assert d.parameters is None


async def test_timeout_detail_names_the_bound():
    ex = ScToolExecutor("http://x/mcp", timeout_s=0.05, session_factory=_factory(delay=1.0))
    r = await ex.call("sc_find_item", {"name": "x"})
    assert r == {"error": "timeout", "detail": "no answer from Star Citizen data within 0.05s"}


async def test_call_unwraps_fastmcp_result_wrapper():
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory_returning(
        FakeResult({"result": {"items": [1, 2]}})))
    assert await ex.call("sc_find_item", {}) == {"items": [1, 2]}


async def test_call_keeps_result_key_when_not_the_only_key():
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory_returning(
        FakeResult({"result": 1, "source": "uex"})))
    assert await ex.call("sc_find_item", {}) == {"result": 1, "source": "uex"}


async def test_call_falls_back_to_json_text_content():
    res = SimpleNamespace(structured_content=None, is_error=False,
                          content=[SimpleNamespace(text=json.dumps({"a": 1}))])
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory_returning(res))
    assert await ex.call("sc_find_item", {}) == {"a": 1}


async def test_call_passes_through_sc_error_envelope():
    env = {"error": "not_found", "detail": "no item", "stale_fallback": False}
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory_returning(FakeResult(env)))
    assert await ex.call("sc_find_item", {}) == env


async def test_call_is_error_becomes_tool_failed():
    res = SimpleNamespace(structured_content=None, is_error=True,
                          content=[SimpleNamespace(text="boom in tool")])
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory_returning(res))
    r = await ex.call("sc_find_item", {})
    assert r["error"] == "tool_failed" and "boom in tool" in r["detail"]


async def test_call_connection_failure_becomes_tool_failed():
    def boom():
        raise OSError("connection refused")
    ex = ScToolExecutor("http://x/mcp", session_factory=boom)
    r = await ex.call("sc_find_item", {})
    assert r["error"] == "tool_failed" and "connection refused" in r["detail"]


async def test_call_never_swallows_cancellation():
    ex = ScToolExecutor("http://x/mcp", timeout_s=5, session_factory=_factory(delay=5))
    t = asyncio.create_task(ex.call("sc_find_item", {}))
    await asyncio.sleep(0.02)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t


def test_default_session_factory_uses_mcp2_streamable_http():
    from mcp.client.streamable_http import streamable_http_client
    from src import sc_tools
    assert sc_tools.streamable_http_client is streamable_http_client
    ex = ScToolExecutor("http://x/mcp")
    assert callable(ex._session_factory)


# ---- real mcp 2.x transport, in-process (no network) ----------------------

def _real_mcp_app():
    from typing import Any
    from mcp.server.mcpserver import MCPServer

    server = MCPServer("fake-sc-knowledge")

    @server.tool(name="sc_find_item", structured_output=True)
    def sc_find_item(name: str) -> dict[str, Any]:
        """Find an item."""
        return {"name": name, "source": "fixture", "game_version": "4.3"}

    @server.tool(name="not_sc")
    def not_sc() -> str:
        return "x"

    return server, server.streamable_http_app(stateless_http=True, json_response=True)


async def test_default_factory_round_trip_over_real_mcp2_transport():
    import httpx2
    from src.sc_tools import _default_session_factory

    server, app = _real_mcp_app()
    ex = ScToolExecutor("http://127.0.0.1:8080/mcp", session_factory=_default_session_factory(
        "http://127.0.0.1:8080/mcp", transport=httpx2.ASGITransport(app=app)))
    async with server.session_manager.run():
        assert await ex.refresh()
        assert [d.name for d in ex.declarations] == ["sc_find_item"]
        schema = ex.declarations[0].parameters_json_schema
        assert schema["properties"]["name"]["type"] == "string"
        assert await ex.call("sc_find_item", {"name": "V801-12"}) == {
            "name": "V801-12", "source": "fixture", "game_version": "4.3"}


async def test_timeout_bound_holds_over_real_mcp2_transport():
    # The 6s bound must actually cut through the anyio-based MCP transport,
    # not just a fake's asyncio.sleep.
    import time
    from typing import Any

    import httpx2
    from mcp.server.mcpserver import MCPServer
    from src.sc_tools import _default_session_factory

    server = MCPServer("slow-sc-knowledge")

    @server.tool(name="sc_find_item", structured_output=True)
    async def sc_find_item(name: str) -> dict[str, Any]:
        await asyncio.sleep(5)
        return {"name": name}

    app = server.streamable_http_app(stateless_http=True, json_response=True)
    ex = ScToolExecutor("http://127.0.0.1:8080/mcp", timeout_s=0.3, session_factory=_default_session_factory(
        "http://127.0.0.1:8080/mcp", transport=httpx2.ASGITransport(app=app)))
    async with server.session_manager.run():
        t0 = time.monotonic()
        r = await ex.call("sc_find_item", {"name": "x"})
        assert time.monotonic() - t0 < 2.0
    assert r["error"] == "timeout"
