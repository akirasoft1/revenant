import asyncio
import logging
from dataclasses import dataclass
from unittest.mock import AsyncMock

import grpc
import pytest

from src import agent_pb2, agent_pb2_grpc
from src.server import AgentServicer


@dataclass
class _FakeResult:
    message_text: str = "ok"
    execution_ids: list = None
    any_failed: bool = False

    def __post_init__(self):
        if self.execution_ids is None:
            self.execution_ids = []


async def _start_server(servicer):
    server = grpc.aio.server()
    agent_pb2_grpc.add_AgentServicer_to_server(servicer, server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    return server, port


@pytest.fixture
async def health_server():
    server, port = await _start_server(AgentServicer())
    try:
        yield port
    finally:
        await server.stop(grace=0)


async def test_health_returns_healthy(health_server):
    port = health_server
    async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
        stub = agent_pb2_grpc.AgentStub(channel)
        resp = await stub.Health(agent_pb2.HealthRequest())
    assert resp.healthy is True


async def test_chat_unimplemented_when_agent_not_configured(health_server):
    port = health_server
    async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
        stub = agent_pb2_grpc.AgentStub(channel)
        with pytest.raises(grpc.aio.AioRpcError) as exc:
            await stub.Chat(agent_pb2.ChatRequest(user_id="u", user_message="hi"))
    assert exc.value.code() == grpc.StatusCode.UNIMPLEMENTED


async def test_chat_returns_message_text_and_summary():
    fake_agent = AsyncMock()
    fake_agent.process_chat = AsyncMock(
        return_value=_FakeResult(
            message_text="hello back",
            execution_ids=["exec-1", "exec-2"],
            any_failed=False,
        )
    )
    server, port = await _start_server(AgentServicer(fake_agent))
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            stub = agent_pb2_grpc.AgentStub(channel)
            resp = await stub.Chat(agent_pb2.ChatRequest(user_id="u", user_message="hi"))
        assert resp.message_text == "hello back"
        assert resp.summary.execution_count == 2
        assert list(resp.summary.execution_ids) == ["exec-1", "exec-2"]
        assert resp.summary.any_failed is False
        assert resp.fallback_occurred is False
        fake_agent.process_chat.assert_awaited_once_with(user_id="u", user_message="hi")
    finally:
        await server.stop(grace=0)


async def test_chat_returns_internal_when_agent_raises():
    fake_agent = AsyncMock()
    fake_agent.process_chat = AsyncMock(side_effect=RuntimeError("boom"))
    server, port = await _start_server(AgentServicer(fake_agent))
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            stub = agent_pb2_grpc.AgentStub(channel)
            with pytest.raises(grpc.aio.AioRpcError) as exc:
                await stub.Chat(agent_pb2.ChatRequest(user_id="u", user_message="hi"))
        assert exc.value.code() == grpc.StatusCode.INTERNAL
    finally:
        await server.stop(grace=0)


async def test_chat_agentllmerror_logged_clean_without_traceback(caplog):
    # An AgentLLMError (e.g. a 503 after exhausting retries) is an EXPECTED,
    # handled condition: the bot falls through to direct OpenAI. The server
    # should log one clean WARNING line — no ERROR-level traceback noise.
    from src.agent import AgentLLMError

    fake_agent = AsyncMock()
    fake_agent.process_chat = AsyncMock(
        side_effect=AgentLLMError(
            "model=gemini-3.5-flash status=503 reason=UNAVAILABLE err=ServerError: 503"
        )
    )
    server, port = await _start_server(AgentServicer(fake_agent))
    try:
        with caplog.at_level(logging.INFO, logger="src.server"):
            async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
                stub = agent_pb2_grpc.AgentStub(channel)
                with pytest.raises(grpc.aio.AioRpcError) as exc:
                    await stub.Chat(agent_pb2.ChatRequest(user_id="u", user_message="hi"))
        assert exc.value.code() == grpc.StatusCode.INTERNAL
        server_records = [r for r in caplog.records if r.name == "src.server"]
        assert server_records, "expected a src.server log line"
        # No ERROR-or-worse, and no attached traceback.
        assert all(r.levelno <= logging.WARNING for r in server_records)
        assert not any(r.exc_info for r in server_records)
        assert any("503" in r.getMessage() for r in server_records)
    finally:
        await server.stop(grace=0)


def test_quiet_adk_node_tracebacks_raises_logger_levels():
    from src.server import _quiet_adk_node_tracebacks

    # Reset to NOTSET first so the test is meaningful.
    for name in (
        "google_adk.google.adk.workflow._node_runner",
        "google_adk.google.adk.runners",
    ):
        logging.getLogger(name).setLevel(logging.NOTSET)
    _quiet_adk_node_tracebacks()
    for name in (
        "google_adk.google.adk.workflow._node_runner",
        "google_adk.google.adk.runners",
    ):
        assert logging.getLogger(name).level == logging.CRITICAL
