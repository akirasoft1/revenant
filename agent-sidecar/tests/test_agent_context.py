import asyncio
from src.agent import ChannelVoiceAgent, AgentChatResult


class _FakeOrch:
    async def run(self, *a, **k):
        class R: exit_code=0; stdout=""; stderr=""; execution_id="e1"; duration_ms=1
        return R()


def _agent():
    from src.config import load
    import os
    for k, v in {"MONGO_URI": "mongodb://x", "SANDBOX_BASE_IMAGE": "img", "AGENT_MODEL": "gemini-3.6-flash"}.items():
        os.environ.setdefault(k, v)
    return ChannelVoiceAgent(config=load(), orchestrator=_FakeOrch(), base_system_prompt="FALLBACK")


def test_uses_supplied_system_prompt_over_fallback(monkeypatch):
    captured = {}
    import src.agent as A
    def fake_agent(**kw): captured.update(kw)
    # capture the instruction the Agent is built with (monkeypatch ADK Agent + runner)
    monkeypatch.setattr(A, "_run_turn", lambda *a, **k: AgentChatResult("ok", [], False), raising=False)
    ag = _agent()
    instr = ag._compose_instruction(system_prompt="VOICEPROMPT")
    assert instr.startswith("VOICEPROMPT")
    assert "FALLBACK" not in instr
    assert "run_in_sandbox" in instr or "sandbox" in instr.lower()  # preamble retained


def test_empty_system_prompt_falls_back():
    ag = _agent()
    instr = ag._compose_instruction(system_prompt="")
    assert instr.startswith("FALLBACK")


class _FakePart:
    def __init__(self, text):
        self.text = text


class _FakeContent:
    def __init__(self, text):
        self.parts = [_FakePart(text)]


class _FakeEvent:
    def __init__(self, text):
        self.content = _FakeContent(text)


class _FakeSessionService:
    async def create_session(self, **kw):
        return None


class _FakeRunner:
    """Stands in for ADK's InMemoryRunner so process_chat can be driven
    without a real model."""

    def __init__(self, *, agent, app_name):
        self.session_service = _FakeSessionService()

    async def run_async(self, **kw):
        for e in (_FakeEvent("the reply"),):
            yield e

    async def close(self):
        return None


def _patch_adk(monkeypatch):
    import src.agent as A
    monkeypatch.setattr(A, "InMemoryRunner", _FakeRunner)
    monkeypatch.setattr(A, "Agent", lambda **kw: object())
    monkeypatch.setattr(A, "_build_model", lambda spec: object())
    monkeypatch.setattr(A, "_build_generate_content_config", lambda: None)


def test_process_chat_flags_fallback_when_no_system_prompt_supplied(monkeypatch):
    # The bot sends system_prompt="" when building the turn context failed, so
    # the turn runs on the sidecar's generic base prompt with no personality,
    # memory or history. That degradation has to be reported, not hidden.
    _patch_adk(monkeypatch)
    ag = _agent()
    res = asyncio.run(ag.process_chat(user_id="u", user_message="hi", system_prompt=""))
    assert res.message_text == "the reply"
    assert res.fallback_occurred is True


def test_process_chat_does_not_flag_fallback_for_a_normal_turn(monkeypatch):
    _patch_adk(monkeypatch)
    ag = _agent()
    res = asyncio.run(
        ag.process_chat(user_id="u", user_message="hi", system_prompt="CHANNEL VOICE PROMPT")
    )
    assert res.fallback_occurred is False


def test_context_block_includes_memory_and_history():
    ag = _agent()
    block = ag._compose_context_block(memory_context="## Memory Context\nX", history=[{"role": "user", "content": "hey"}, {"role": "assistant", "content": "hi"}])
    assert "## Memory Context" in block and "hey" in block and "hi" in block
