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


def test_context_block_includes_memory_and_history():
    ag = _agent()
    block = ag._compose_context_block(memory_context="## Memory Context\nX", history=[{"role": "user", "content": "hey"}, {"role": "assistant", "content": "hi"}])
    assert "## Memory Context" in block and "hey" in block and "hi" in block
