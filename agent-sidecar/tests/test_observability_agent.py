import asyncio
from unittest.mock import patch, MagicMock
from src.observability_agent import ObservabilityAgent, ObserveResult
from tests.test_mcp_registry import _cfg  # reuse the Config factory

def test_observe_returns_error_when_no_toolsets():
    agent = ObservabilityAgent(_cfg())  # no DT env -> no toolsets
    result = asyncio.run(agent.observe(user_id="u1", question="how many errors?"))
    assert isinstance(result, ObserveResult)
    assert result.error != ""
    assert result.answer_text == ""

def test_observe_builds_agent_with_mcp_tools_and_no_sandbox():
    cfg = _cfg(dt_mcp_url="https://x/mcp", dt_platform_token="tok", agent_model="gemini-3-flash-preview")
    fake_toolset = MagicMock()
    with patch("src.observability_agent.build_mcp_toolsets", return_value=[fake_toolset]), \
         patch("src.observability_agent.Agent") as MockAgent, \
         patch("src.observability_agent.InMemoryRunner") as MockRunner:
        runner = MockRunner.return_value
        runner.session_service.create_session = _async_return(None)
        runner.run_async = _fake_run_async("3 errors in the last hour")
        runner.close = _async_return(None)
        result = asyncio.run(ObservabilityAgent(cfg).observe(user_id="u1", question="errors?"))
    # sandbox tool must never be present
    _, kwargs = MockAgent.call_args
    assert kwargs["tools"] == [fake_toolset]
    assert result.answer_text == "3 errors in the last hour"
    assert result.error == ""

# --- async test helpers ---
def _async_return(value):
    async def _f(*a, **k):
        return value
    return _f

def _fake_run_async(final_text):
    async def _gen(*a, **k):
        class _Part:  # minimal event.content.parts[i].text shape
            text = final_text
        class _Content:
            parts = [_Part()]
        class _Event:
            content = _Content()
        yield _Event()
    return _gen
