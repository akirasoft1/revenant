"""mcp 2.x compatibility pins for the direct-MCP (dql_runner) and ADK
McpToolset (mcp_registry) paths.

The old `mcp<2.0.0` cap existed because mcp 2.0 removed `streamablehttp_client`
(and its `headers=` kwarg / 3-tuple yield) and renamed CallToolResult's
camelCase attributes (`isError`, `structuredContent`) to snake_case. The
existing dql_runner tests patched `_open_session` and used SimpleNamespace
results, so none of that was ever exercised: the break was invisible to the
suite. These tests drive the REAL transport + ClientSession against a real
in-process MCP server (ASGI, no network), so the next SDK break fails here.
"""
import asyncio
import json
from typing import Any

import httpx2
import pytest
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from src import dql_runner, mcp_registry
from tests.test_mcp_registry import _cfg


def _fake_dynatrace_mcp(seen_auth: list):
    """A minimal stand-in for the Dynatrace MCP server: one `execute-dql`
    tool with the real argument name, returning structured records."""
    server = MCPServer("fake-dynatrace")

    @server.tool(name="execute-dql", structured_output=True)
    def execute_dql(dqlQueryString: str) -> dict[str, Any]:  # noqa: N803 - wire name
        if "bogus" in dqlQueryString:
            raise ToolError("invalid DQL: syntax error at line 1")
        return {"records": [{"q": dqlQueryString, "c": "7"}], "metadata": {}}

    app = server.streamable_http_app(stateless_http=True, json_response=True)

    async def recording_app(scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers") or [])
            seen_auth.append(headers.get(b"authorization", b"").decode())
        await app(scope, receive, send)

    return server, recording_app


def _run_against_fake(monkeypatch, query):
    seen_auth: list = []
    server, app = _fake_dynatrace_mcp(seen_auth)
    real_make = dql_runner._make_http_client

    def make_with_asgi(token):
        return real_make(token, transport=httpx2.ASGITransport(app=app))

    monkeypatch.setattr(dql_runner, "_make_http_client", make_with_asgi)
    cfg = _cfg(dt_mcp_url="http://127.0.0.1:8000/mcp", dt_platform_token="tok-123")

    async def go():
        async with server.session_manager.run():
            return await dql_runner.run_dql(cfg, query)

    return asyncio.run(go()), seen_auth


def test_dql_runner_uses_mcp2_transport_api():
    # Would have caught the 2.0 break at import/construct time: the module
    # must bind the 2.x transport, not the removed 1.x alias.
    from mcp.client.streamable_http import streamable_http_client
    assert dql_runner.streamable_http_client is streamable_http_client
    assert not hasattr(dql_runner, "streamablehttp_client")


def test_make_http_client_sets_bearer_header():
    client = dql_runner._make_http_client("tok-abc")
    try:
        assert isinstance(client, httpx2.AsyncClient)
        assert client.headers["Authorization"] == "Bearer tok-abc"
    finally:
        asyncio.run(client.aclose())


def test_run_dql_end_to_end_over_real_mcp2_transport(monkeypatch):
    out, seen_auth = _run_against_fake(monkeypatch, "fetch spans | limit 1")
    assert out.error == ""
    assert json.loads(out.rows_json) == [{"q": "fetch spans | limit 1", "c": "7"}]
    assert json.loads(out.columns) == ["q", "c"]
    assert seen_auth and all(a == "Bearer tok-123" for a in seen_auth)


def test_run_dql_surfaces_tool_error_over_real_mcp2_transport(monkeypatch):
    # mcp 2.x reports tool errors as `is_error` (snake_case); reading the old
    # camelCase `isError` silently returns None and the error is swallowed.
    out, _ = _run_against_fake(monkeypatch, "fetch bogus")
    assert out.rows_json == ""
    assert "syntax error" in out.error


def test_registry_builds_real_mcptoolset_with_bearer_header():
    # Unmocked construction against the installed google-adk + mcp 2.x.
    from google.adk.tools.mcp_tool.mcp_toolset import McpToolset

    cfg = _cfg(dt_mcp_url="https://x/mcp", dt_platform_token="tok")
    toolsets = mcp_registry.build_mcp_toolsets("observability", cfg)
    assert len(toolsets) == 1
    # Exact type: ADK 2.x keeps `MCPToolset` only as a deprecated subclass.
    assert type(toolsets[0]) is McpToolset
    params = toolsets[0]._connection_params
    assert params.url == "https://x/mcp"
    assert params.headers == {"Authorization": "Bearer tok"}


@pytest.mark.parametrize("attr", ["is_error", "structured_content"])
def test_mcp2_call_tool_result_uses_snake_case(attr):
    import mcp.types as t
    r = t.CallToolResult.model_validate(
        {"content": [], "isError": False, "structuredContent": {"records": []}}
    )
    assert hasattr(r, attr)
