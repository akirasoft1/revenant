import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock
from src.dql_runner import run_dql
from tests.test_mcp_registry import _cfg


def _result(*, structured=None, texts=None, is_error=False):
    """Build a fake MCP tool result. Uses SimpleNamespace (not MagicMock) so
    unset attributes are genuinely absent/None rather than truthy mocks —
    critical for isError/structuredContent checks in run_dql."""
    content = [SimpleNamespace(text=t) for t in (texts or [])]
    return SimpleNamespace(structuredContent=structured, content=content, isError=is_error)


def _run_with(cfg, query, result):
    fake_session = AsyncMock()
    fake_session.call_tool.return_value = result
    with patch("src.dql_runner._open_session") as open_session:
        open_session.return_value.__aenter__.return_value = fake_session
        out = asyncio.run(run_dql(cfg, query))
    return out, fake_session


CFG = dict(dt_mcp_url="https://x/mcp", dt_platform_token="tok")


def test_error_when_not_configured():
    result = asyncio.run(run_dql(_cfg(), "fetch spans | limit 1"))
    assert result.error != ""


def test_calls_execute_dql_tool_with_correct_name_and_arg():
    cfg = _cfg(**CFG)
    result = _result(structured={"records": []})
    _out, session = _run_with(cfg, "fetch spans | limit 1", result)
    session.call_tool.assert_awaited_once()
    name = session.call_tool.call_args.args[0]
    args = session.call_tool.call_args.args[1]
    assert name == "execute-dql"
    assert args == {"dqlQueryString": "fetch spans | limit 1"}


def test_parses_structured_content_records():
    cfg = _cfg(**CFG)
    records = [{"span.name": "GET", "c": "953"}, {"span.name": "POST", "c": "12"}]
    result = _result(structured={"records": records, "metadata": {"grail": {}}})
    out, _ = _run_with(cfg, "fetch spans", result)
    assert out.error == ""
    assert json.loads(out.rows_json) == records
    assert json.loads(out.columns) == ["span.name", "c"]


def test_parses_records_from_text_fallback_when_no_structured_content():
    cfg = _cfg(**CFG)
    records = [{"c": "1"}]
    text = "Query result records:\n" + json.dumps(records)
    result = _result(structured=None, texts=["Query metadata:\n{}", text])
    out, _ = _run_with(cfg, "fetch spans", result)
    assert out.error == ""
    assert json.loads(out.rows_json) == records
    assert json.loads(out.columns) == ["c"]


def test_empty_records_is_not_an_error():
    cfg = _cfg(**CFG)
    result = _result(structured={"records": []})
    out, _ = _run_with(cfg, "fetch spans | limit 0", result)
    assert out.error == ""
    assert json.loads(out.rows_json) == []
    assert json.loads(out.columns) == []


def test_surfaces_tool_error():
    cfg = _cfg(**CFG)
    result = _result(texts=["invalid DQL: syntax error at line 1"], is_error=True)
    out, _ = _run_with(cfg, "fetch bogus", result)
    assert out.rows_json == ""
    assert "syntax error" in out.error


def test_exception_is_caught_not_raised():
    cfg = _cfg(**CFG)
    fake_session = AsyncMock()
    fake_session.call_tool.side_effect = RuntimeError("connection reset")
    with patch("src.dql_runner._open_session") as open_session:
        open_session.return_value.__aenter__.return_value = fake_session
        out = asyncio.run(run_dql(cfg, "fetch spans"))
    assert out.rows_json == ""
    assert "connection reset" in out.error
