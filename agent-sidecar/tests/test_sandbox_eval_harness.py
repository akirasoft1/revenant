import asyncio
from dataclasses import asdict

from eval import eval_sandbox_invocation as esi
from eval.harness import FakeOrchestrator, score
from eval.sandbox_eval_set import EVAL_SET
from src.agent import AgentChatResult


def test_fake_orchestrator_returns_valid_result_and_records():
    fo = FakeOrchestrator()
    r = asyncio.run(fo.run(user_id="u", language="bash", code="echo hi", stdin=None, env={}))
    assert r.exit_code == 0 and r.execution_id
    assert asdict(r)  # dataclass, asdict works (the real tool does this)
    assert fo.calls == 1


def test_score_perfect():
    recs = [("direct", False), ("direct", False), ("sandbox", True), ("sandbox", True)]
    s = score(recs)
    assert s.false_invocation_rate == 0.0
    assert s.false_omission_rate == 0.0
    assert s.n_direct == 2 and s.n_sandbox == 2


def test_score_all_wrong():
    recs = [("direct", True), ("sandbox", False)]
    s = score(recs)
    assert s.false_invocation_rate == 1.0
    assert s.false_omission_rate == 1.0


def test_score_mixed():
    recs = [("direct", True), ("direct", False), ("direct", False), ("sandbox", True)]
    s = score(recs)
    assert abs(s.false_invocation_rate - 1 / 3) < 1e-9
    assert s.false_omission_rate == 0.0


# --- Task 9: document/authoring + context-dependent classes carry context ---

_NEW_CLASS_PROMPTS = {
    "based on our earlier discussion of the Friday no-work rule, draft section 2(a).",
    "craft a short doc from scratch summarizing our nmap tips.",
    "write up a quick onboarding note for new members.",
}


def test_eval_set_has_new_document_and_context_dependent_cases():
    found = {item["prompt"] for item in EVAL_SET if item["prompt"] in _NEW_CLASS_PROMPTS}
    assert found == _NEW_CLASS_PROMPTS


def test_new_cases_expect_direct_and_carry_representative_context():
    for item in EVAL_SET:
        if item["prompt"] not in _NEW_CLASS_PROMPTS:
            continue
        assert item["expect"] == "direct"
        assert item["manual"] is True
        ctx = item.get("context")
        assert ctx is not None, f"missing context for: {item['prompt']}"
        assert set(ctx.keys()) == {"system_prompt", "memory_context", "history"}
        assert isinstance(ctx["history"], list)


# --- Task 9: _invoked_once threads a case's context through process_chat ---

class _FakeContextCapturingAgent:
    """Stands in for ChannelVoiceAgent: records the kwargs process_chat
    receives instead of touching ADK/the model, so this stays deterministic
    and offline."""

    last_call: dict | None = None

    def __init__(self, *args, **kwargs):
        pass

    async def process_chat(self, *, user_id, user_message, system_prompt='', memory_context='', history=None):
        _FakeContextCapturingAgent.last_call = dict(
            user_id=user_id, user_message=user_message,
            system_prompt=system_prompt, memory_context=memory_context, history=history,
        )
        execution_ids = ["e1"] if user_message == "needs sandbox" else []
        return AgentChatResult(message_text="ok", execution_ids=execution_ids, any_failed=False)


def test_invoked_once_threads_case_context_to_process_chat(monkeypatch):
    monkeypatch.setattr(esi, "ChannelVoiceAgent", _FakeContextCapturingAgent)
    case = {
        "prompt": "draft it",
        "expect": "direct",
        "context": {
            "system_prompt": "sp",
            "memory_context": "mc",
            "history": [{"role": "user", "content": "hi"}],
        },
    }

    invoked = asyncio.run(esi._invoked_once(case))

    assert invoked is False
    call = _FakeContextCapturingAgent.last_call
    assert call["user_message"] == "draft it"
    assert call["system_prompt"] == "sp"
    assert call["memory_context"] == "mc"
    assert call["history"] == [{"role": "user", "content": "hi"}]


def test_invoked_once_defaults_missing_context_to_empty(monkeypatch):
    monkeypatch.setattr(esi, "ChannelVoiceAgent", _FakeContextCapturingAgent)
    case = {"prompt": "needs sandbox", "expect": "sandbox"}  # no "context" key at all

    invoked = asyncio.run(esi._invoked_once(case))

    assert invoked is True
    call = _FakeContextCapturingAgent.last_call
    assert call["system_prompt"] == ""
    assert call["memory_context"] == ""
    assert call["history"] == []
