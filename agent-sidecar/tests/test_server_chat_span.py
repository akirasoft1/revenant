import asyncio

import grpc
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from src import server as srv
from src import agent_pb2, agent_pb2_grpc
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


# --- M1 review fix: sc.tools.available must land on the span for EVERY
# Chat outcome (timeout / exception / cancel / empty-text success), not
# only a clean successful turn. -----------------------------------------


class _FakeAgentWithScState:
    """An agent stand-in that reports a Star Citizen tools state via
    sc_tools_state() (as ChannelVoiceAgent does) independently of what
    process_chat itself does."""

    def __init__(self, sc_state: str, outcome: str):
        self._sc_state = sc_state
        self._outcome = outcome  # "raise" | "hang" | "empty" | "success"

    async def sc_tools_state(self) -> str:
        return self._sc_state

    async def process_chat(self, **kw):
        if self._outcome == "raise":
            raise RuntimeError("boom")
        if self._outcome == "hang":
            await asyncio.Event().wait()
        if self._outcome == "empty":
            return AgentChatResult(
                message_text="   ", execution_ids=[], any_failed=False, sc_state=self._sc_state,
            )
        return AgentChatResult(
            message_text="ok", execution_ids=[], any_failed=False, sc_state=self._sc_state,
        )


class _AbortingCtx:
    """Stands in for the exception grpc.aio's context.abort() raises, so a
    direct (non-wire) servicer call can be driven to completion."""

    class _Aborted(Exception):
        pass

    async def abort(self, code, details):
        raise self._Aborted(details)


def _run_chat_direct(agent):
    _EXPORTER.clear()
    servicer = srv.AgentServicer(channel_voice_agent=agent, chat_timeout_seconds=0.05)
    ctx = _AbortingCtx()
    try:
        asyncio.run(servicer.Chat(agent_pb2.ChatRequest(user_id="u", user_message="hi"), ctx))
    except _AbortingCtx._Aborted:
        pass
    return [x for x in _EXPORTER.get_finished_spans() if x.name == "agent.chat"][0]


def test_chat_span_records_sc_tools_available_on_the_exception_path():
    s = _run_chat_direct(_FakeAgentWithScState("available", "raise"))
    assert s.attributes["sc.tools.available"] is True


def test_chat_span_records_sc_tools_available_on_the_timeout_path():
    s = _run_chat_direct(_FakeAgentWithScState("unavailable", "hang"))
    assert s.attributes["sc.tools.available"] is False


def test_chat_span_records_sc_tools_available_on_an_empty_text_success():
    s = _run_chat_direct(_FakeAgentWithScState("available", "empty"))
    assert s.attributes["sc.tools.available"] is True


async def test_chat_span_records_sc_tools_available_on_the_cancelled_path():
    # Real gRPC, real client-deadline cancellation — the same shape as the
    # ChatCircuitBreaker's flagship cancellation test — because the point is
    # that the attribute must survive a CancelledError blowing through the
    # `with span:` block, not just an ordinary early return inside it.
    _EXPORTER.clear()
    agent = _FakeAgentWithScState("available", "hang")
    servicer = srv.AgentServicer(channel_voice_agent=agent)
    server = grpc.aio.server()
    agent_pb2_grpc.add_AgentServicer_to_server(servicer, server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            stub = agent_pb2_grpc.AgentStub(channel)
            with pytest.raises(grpc.aio.AioRpcError):
                await stub.Chat(
                    agent_pb2.ChatRequest(user_id="u", user_message="hi"), timeout=0.2,
                )
        spans = []
        for _ in range(100):
            spans = [x for x in _EXPORTER.get_finished_spans() if x.name == "agent.chat"]
            if spans:
                break
            await asyncio.sleep(0.05)
    finally:
        await server.stop(grace=0)
    assert spans, "agent.chat span was never recorded for the cancelled call"
    assert spans[0].attributes["sc.tools.available"] is True


# --- web search observability ----------------------------------------------


class _FakeAgentWithSearch:
    def __init__(self, queries):
        self._q = queries

    async def process_chat(self, **kw):
        return AgentChatResult(
            message_text="ok", execution_ids=[], any_failed=False, web_search_queries=self._q,
        )


def test_chat_span_records_web_search_queries():
    s = _run_chat_direct(_FakeAgentWithSearch(4))
    assert s.attributes["web_search.queries"] == 4


def test_chat_span_records_zero_web_search_queries():
    s = _run_chat(0)
    assert s.attributes["web_search.queries"] == 0


# --- hangar chat edits observability ------------------------------------------


class _FakeAgentWithEdits:
    def __init__(self, n):
        self._n = n

    async def process_chat(self, **kw):
        return AgentChatResult(
            message_text="ok", execution_ids=[], any_failed=False, hangar_edits=self._n,
        )


def test_chat_span_records_hangar_edits():
    s = _run_chat_direct(_FakeAgentWithEdits(2))
    assert s.attributes["hangar.edits"] == 2


def test_chat_span_records_zero_hangar_edits():
    s = _run_chat(0)
    assert s.attributes["hangar.edits"] == 0
