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


async def test_refresh_records_last_error_and_clears_it_on_success():
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory())
    assert ex.last_error is None
    good = ex._session_factory
    def boom():
        raise OSError("down")
    ex._session_factory = boom
    assert await ex.refresh() is False
    assert isinstance(ex.last_error, OSError) and str(ex.last_error) == "down"
    ex._session_factory = good
    assert await ex.refresh() is True
    assert ex.last_error is None


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


# ---- schema sanitising (fix round 1) --------------------------------------

import os  # noqa: E402

from src.sc_tools import _sanitize_schema  # noqa: E402

# Captured from the REAL sc-knowledge server (build_app + list_tools over
# streamable HTTP, 2026-09-26). FastMCP renders Optional params as
# anyOf[{type: X}, {type: null}] with default/title noise.
_FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "sc_knowledge_input_schemas.json")


def _walk_keywords(schema, path="$"):
    """Yield (path, keyword) for every keyword in schema position (property
    NAMES under `properties` are not keywords)."""
    if isinstance(schema, dict):
        for k, v in schema.items():
            yield path, k
            if k == "properties" and isinstance(v, dict):
                for pname, sub in v.items():
                    yield from _walk_keywords(sub, f"{path}.properties.{pname}")
            elif isinstance(v, (dict, list)):
                yield from _walk_keywords(v, f"{path}.{k}")
    elif isinstance(schema, list):
        for i, v in enumerate(schema):
            yield from _walk_keywords(v, f"{path}[{i}]")


def test_actual_sc_knowledge_schemas_are_sanitised():
    with open(_FIXTURE) as f:
        raw = json.load(f)
    assert set(raw) == {"sc_find_item", "sc_compare_components", "sc_faction_missions",
                        "sc_trade_routes", "sc_commodity_prices", "sc_org_guides"}
    assert any("anyOf" in json.dumps(s) for s in raw.values()), "fixture must exercise anyOf"
    for name, schema in raw.items():
        clean = _sanitize_schema(schema)
        bad = [(p, k) for p, k in _walk_keywords(clean)
               if k in ("anyOf", "oneOf", "title", "default", "$schema", "additionalProperties")]
        assert bad == [], (name, bad)
        assert clean["type"] == "object"
        assert clean["required"] == schema["required"], name
        assert set(clean["properties"]) == set(schema["properties"]), name
    tr = _sanitize_schema(raw["sc_trade_routes"])
    assert tr["properties"]["destination"] == {"type": "string"}
    assert tr["properties"]["cargo_scu"] == {"type": "integer"}
    assert tr["properties"]["limit"] == {"type": "integer"}
    assert tr["properties"]["origin"] == {"type": "string"}


def test_sanitize_keeps_property_names_that_look_like_keywords():
    schema = {"type": "object", "title": "fArguments",
              "properties": {"title": {"type": "string", "title": "Title"},
                             "default": {"type": "integer", "default": 1}},
              "required": ["title"]}
    assert _sanitize_schema(schema) == {
        "type": "object",
        "properties": {"title": {"type": "string"}, "default": {"type": "integer"}},
        "required": ["title"]}


def test_sanitize_collapse_keeps_sibling_keywords_and_nests():
    schema = {"type": "object", "properties": {
        "tags": {"anyOf": [{"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "null"}]}},
                           {"type": "null"}], "description": "d", "default": None},
        "mode": {"oneOf": [{"type": "null"}, {"type": "string", "enum": ["a", "b"]}]},
        "either": {"anyOf": [{"type": "string"}, {"type": "integer"}]},
        "listy": {"type": ["string", "null"]},
    }}
    out = _sanitize_schema(schema)["properties"]
    assert out["tags"] == {"type": "array", "items": {"type": "string"}, "description": "d"}
    assert out["mode"] == {"type": "string", "enum": ["a", "b"]}
    # not "exactly one type + null": left as-is (other keywords untouched)
    assert out["either"] == {"anyOf": [{"type": "string"}, {"type": "integer"}]}
    assert out["listy"] == {"type": "string"}


def test_sanitize_does_not_mutate_input():
    with open(_FIXTURE) as f:
        raw = json.load(f)
    before = json.dumps(raw, sort_keys=True)
    for s in raw.values():
        _sanitize_schema(s)
    assert json.dumps(raw, sort_keys=True) == before


async def test_refresh_sanitises_declarations():
    class T:
        name = "sc_trade_routes"
        description = "d"
        input_schema = {"type": "object", "title": "X", "properties": {
            "commodity": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None, "title": "C"}},
            "required": []}

    class S:
        async def list_tools(self):
            return SimpleNamespace(tools=[T()])

    class Ctx:
        async def __aenter__(self): return S()
        async def __aexit__(self, *a): return False

    ex = ScToolExecutor("http://x/mcp", session_factory=lambda: Ctx())
    assert await ex.refresh()
    assert ex.declarations[0].parameters_json_schema == {
        "type": "object", "properties": {"commodity": {"type": "string"}}, "required": []}
