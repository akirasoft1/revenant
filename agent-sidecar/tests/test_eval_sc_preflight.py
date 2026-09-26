import pytest

from eval.eval_sc import _preflight, _run, _sc_prompts_with_outage
from src.agent import AgentChatResult


class _FakeProvider:
    """Stands in for ScToolsProvider without touching real config/network."""

    def __init__(self, enabled: bool, available: bool):
        self.enabled = enabled
        self._available = available
        self.available_calls = 0

    async def available(self) -> bool:
        self.available_calls += 1
        return self._available


async def test_preflight_exits_2_when_probe_fails():
    provider = _FakeProvider(enabled=True, available=False)
    with pytest.raises(SystemExit) as exc:
        await _preflight(provider, "http://sc.test/mcp")
    assert exc.value.code == 2
    assert provider.available_calls == 1


async def test_preflight_exits_2_when_disabled_without_probing():
    # enabled=False must fail BEFORE ever calling available() -- there's
    # nothing to probe if no toolsets were built / SC_KNOWLEDGE_ENABLED is
    # not true.
    provider = _FakeProvider(enabled=False, available=True)
    with pytest.raises(SystemExit) as exc:
        await _preflight(provider, "http://sc.test/mcp")
    assert exc.value.code == 2
    assert provider.available_calls == 0


async def test_preflight_passes_when_available():
    provider = _FakeProvider(enabled=True, available=True)
    await _preflight(provider, "http://sc.test/mcp")  # must not raise


class _NeverCalledAgent:
    """If _run() calls process_chat despite a failed preflight, this fails
    loudly instead of silently returning fake data."""

    async def process_chat(self, **kwargs):  # noqa: ANN003
        pytest.fail("process_chat was called despite a failed preflight probe")


async def test_run_exits_2_before_any_process_chat_when_probe_fails(monkeypatch):
    import eval.eval_sc as eval_sc

    provider = _FakeProvider(enabled=True, available=False)
    monkeypatch.setattr(eval_sc, "_build", lambda: (_NeverCalledAgent(), provider, "http://sc.test/mcp"))

    with pytest.raises(SystemExit) as exc:
        await _run(runs=1)
    assert exc.value.code == 2


def _result(sc_state="available", tools=None):
    return AgentChatResult(
        message_text="x", execution_ids=[], any_failed=False, fallback_occurred=False,
        sc_tool_names=tools or [], sandbox_attempts=0, sc_state=sc_state,
    )


def test_sc_prompts_with_outage_flags_unavailable_sc_prompts_only():
    recs = [
        ({"prompt": "a", "expect_tool": "sc_find_item"}, _result(sc_state="available")),
        ({"prompt": "b", "expect_tool": "sc_trade_routes"}, _result(sc_state="unavailable")),
        ({"prompt": "c", "expect_tool": None}, _result(sc_state="unavailable")),
    ]
    assert _sc_prompts_with_outage(recs) == ["b"]
