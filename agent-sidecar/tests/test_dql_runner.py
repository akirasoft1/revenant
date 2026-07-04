import asyncio, json
from unittest.mock import patch, AsyncMock, MagicMock
from src.dql_runner import run_dql, RunDqlResult
from tests.test_mcp_registry import _cfg

def test_error_when_not_configured():
    result = asyncio.run(run_dql(_cfg(), "fetch spans | limit 1"))
    assert result.error != ""

def test_calls_execute_dql_tool_verbatim():
    cfg = _cfg(dt_mcp_url="https://x/mcp", dt_platform_token="tok")
    tool_result = MagicMock()
    tool_result.content = [MagicMock(text=json.dumps({"records": [{"c": 1}]}))]
    fake_session = AsyncMock()
    fake_session.call_tool.return_value = tool_result
    with patch("src.dql_runner._open_session") as open_session:
        open_session.return_value.__aenter__.return_value = fake_session
        result = asyncio.run(run_dql(cfg, "fetch spans | limit 1"))
    fake_session.call_tool.assert_awaited_once()
    name, args = fake_session.call_tool.call_args.args[0], fake_session.call_tool.call_args.args[1]
    assert "fetch spans | limit 1" in json.dumps(args)
    assert result.error == ""
