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


def test_sc_prompts_with_outage_includes_uncovered_sc_prompts():
    recs = [
        ({"prompt": "u", "expect_tool": None, "uncovered_sc": True}, _result(sc_state="unavailable")),
        ({"prompt": "c", "expect_tool": None}, _result(sc_state="unavailable")),
    ]
    assert _sc_prompts_with_outage(recs) == ["u"]


def test_report_flags_uncovered_sc_runs_without_web_search(capsys, monkeypatch):
    import eval.eval_sc as E
    case = {"prompt": "what turret does the Anvil Spartan have", "expect_tool": None, "uncovered_sc": True}
    monkeypatch.setattr(E, "SC_EVAL_SET", [case])
    recs = [(case, AgentChatResult("x", [], False, sc_state="available", web_search_queries=0)),
            (case, AgentChatResult("x", [], False, sc_state="available", web_search_queries=2))]
    score = E.score_sc(recs)
    E._print_report(recs, 2, 0.9, score, [])
    out = capsys.readouterr().out
    assert "NO WEB SEARCH" in out and "1/2" in out


def test_sc_prompts_with_outage_includes_sc_dispute_prompts():
    recs = [
        ({"prompt": "d", "expect_tool": None, "sc_dispute": True}, _result(sc_state="unavailable")),
        ({"prompt": "c", "expect_tool": None}, _result(sc_state="unavailable")),
    ]
    assert _sc_prompts_with_outage(recs) == ["d"]


def test_report_flags_sc_dispute_runs_without_web_search(capsys, monkeypatch):
    import eval.eval_sc as E
    case = {"prompt": "that's not true, recheck your sources", "expect_tool": None, "sc_dispute": True,
            "history": [{"role": "user", "content": "q"}]}
    monkeypatch.setattr(E, "SC_EVAL_SET", [case])
    recs = [(case, AgentChatResult("x", [], False, sc_state="available", web_search_queries=0)),
            (case, AgentChatResult("x", [], False, sc_state="available", web_search_queries=0)),
            (case, AgentChatResult("x", [], False, sc_state="available", web_search_queries=1))]
    E._print_report(recs, 3, 0.9, E.score_sc(recs), [])
    out = capsys.readouterr().out
    assert "sc-dispute" in out
    assert "NO WEB SEARCH in 2/3 runs" in out
    assert "FALSE SC CALL" not in out


class _RecordingAgent:
    def __init__(self):
        self.calls = []

    async def process_chat(self, **kwargs):  # noqa: ANN003
        self.calls.append(kwargs)
        return _result()


async def test_run_forwards_case_history_to_process_chat(monkeypatch):
    import eval.eval_sc as eval_sc

    agent = _RecordingAgent()
    provider = _FakeProvider(enabled=True, available=True)
    history = [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]
    cases = [{"prompt": "plain", "expect_tool": None},
             {"prompt": "disputed", "expect_tool": None, "sc_dispute": True, "history": history}]
    monkeypatch.setattr(eval_sc, "SC_EVAL_SET", cases)
    monkeypatch.setattr(eval_sc, "_build", lambda: (agent, provider, "http://sc.test/mcp"))

    records = await _run(runs=2)
    assert len(records) == 4
    assert agent.calls[0] == {"user_id": "eval", "user_message": "plain"}
    assert agent.calls[2] == {"user_id": "eval", "user_message": "disputed", "history": history}
    assert agent.calls[3]["history"] is history
