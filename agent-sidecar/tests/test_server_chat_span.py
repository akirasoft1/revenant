import asyncio

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from src import server as srv
from src import agent_pb2
from src.agent import AgentChatResult

# OpenTelemetry only honors set_tracer_provider once per process, so set up a
# single provider + exporter at import and clear the exporter between cases.
_EXPORTER = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(_EXPORTER))
trace.set_tracer_provider(_provider)


class _FakeAgent:
    def __init__(self, n):
        self._n = n

    async def process_chat(self, *, user_id, user_message, system_prompt='', memory_context='', history=None):
        return AgentChatResult(
            message_text="ok",
            execution_ids=[f"e{i}" for i in range(self._n)],
            any_failed=False,
        )


class _Ctx:
    async def abort(self, *a, **k):
        raise AssertionError("should not abort")


def _run_chat(n_exec):
    _EXPORTER.clear()
    servicer = srv.AgentServicer(channel_voice_agent=_FakeAgent(n_exec))
    asyncio.run(
        servicer.Chat(agent_pb2.ChatRequest(user_id="u", user_message="hi"), _Ctx())
    )
    return [x for x in _EXPORTER.get_finished_spans() if x.name == "agent.chat"][0]


def test_chat_span_records_sandbox_invoked_true():
    s = _run_chat(2)
    assert s.attributes["sandbox.invoked"] is True
    assert s.attributes["sandbox.call_count"] == 2


def test_chat_span_records_sandbox_invoked_false():
    s = _run_chat(0)
    assert s.attributes["sandbox.invoked"] is False
    assert s.attributes["sandbox.call_count"] == 0
