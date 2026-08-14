import asyncio
from dataclasses import dataclass
from unittest.mock import AsyncMock

import grpc
import pytest

from src import agent_pb2, agent_pb2_grpc
from src.server import AgentServicer, ChatCircuitBreaker


@dataclass
class _FakeResult:
    message_text: str = "ok"
    execution_ids: list = None
    any_failed: bool = False
    fallback_occurred: bool = False

    def __post_init__(self):
        if self.execution_ids is None:
            self.execution_ids = []


class _FakeClock:
    """Injected clock so the breaker's cooldown is exercised without sleeping."""

    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class _Aborted(Exception):
    """Stands in for the exception grpc.aio's context.abort() raises."""


class _Ctx:
    def __init__(self):
        self.aborted_with = None

    async def abort(self, code, details):
        self.aborted_with = (code, details)
        raise _Aborted(details)


async def _chat(servicer, message="hi"):
    ctx = _Ctx()
    try:
        return await servicer.Chat(
            agent_pb2.ChatRequest(user_id="u", user_message=message), ctx,
        )
    except _Aborted:
        return None


def _agent_returning(result):
    fake = AsyncMock()
    fake.process_chat = AsyncMock(return_value=result)
    return fake


def _agent_raising(exc):
    fake = AsyncMock()
    fake.process_chat = AsyncMock(side_effect=exc)
    return fake


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


async def test_health_reports_healthy_while_chat_has_not_failed(health_server):
    # Health is no longer a hardcoded True: it reports the Chat circuit
    # breaker's state, which starts closed.
    port = health_server
    async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
        stub = agent_pb2_grpc.AgentStub(channel)
        resp = await stub.Health(agent_pb2.HealthRequest())
    assert resp.healthy is True


async def test_health_goes_unhealthy_over_the_wire_after_repeated_chat_failures():
    # End-to-end through real gRPC: the bot's only signal is this RPC, so it
    # has to change over the wire, not just in the breaker object.
    servicer = AgentServicer(
        channel_voice_agent=_agent_raising(RuntimeError("GEAP 403: credentials revoked")),
        breaker=ChatCircuitBreaker(failure_threshold=3, cooldown_seconds=60),
    )
    server, port = await _start_server(servicer)
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            stub = agent_pb2_grpc.AgentStub(channel)
            assert (await stub.Health(agent_pb2.HealthRequest())).healthy is True
            for _ in range(3):
                with pytest.raises(grpc.aio.AioRpcError):
                    await stub.Chat(agent_pb2.ChatRequest(user_id="u", user_message="hi"))
            resp = await stub.Health(agent_pb2.HealthRequest())
        assert resp.healthy is False
    finally:
        await server.stop(grace=0)


async def test_chat_unimplemented_when_agent_not_configured(health_server):
    port = health_server
    async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
        stub = agent_pb2_grpc.AgentStub(channel)
        with pytest.raises(grpc.aio.AioRpcError) as exc:
            await stub.Chat(agent_pb2.ChatRequest(user_id="u", user_message="hi"))
    assert exc.value.code() == grpc.StatusCode.UNIMPLEMENTED


async def test_chat_returns_message_text_and_summary():
    fake_agent = _agent_returning(
        _FakeResult(
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
        fake_agent.process_chat.assert_awaited_once_with(
            user_id="u", user_message="hi", system_prompt="", memory_context="", history=[],
        )
    finally:
        await server.stop(grace=0)


async def test_chat_returns_internal_when_agent_raises():
    fake_agent = _agent_raising(RuntimeError("boom"))
    server, port = await _start_server(AgentServicer(fake_agent))
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            stub = agent_pb2_grpc.AgentStub(channel)
            with pytest.raises(grpc.aio.AioRpcError) as exc:
                await stub.Chat(agent_pb2.ChatRequest(user_id="u", user_message="hi"))
        assert exc.value.code() == grpc.StatusCode.INTERNAL
    finally:
        await server.stop(grace=0)


async def test_chat_propagates_fallback_occurred_from_the_agent_result():
    # The field used to be a hardcoded False. It now carries whether the turn
    # ran on the sidecar's generic base prompt instead of the bot's learned
    # channel-voice personality.
    servicer = AgentServicer(_agent_returning(_FakeResult(fallback_occurred=True)))
    resp = await _chat(servicer)
    assert resp.fallback_occurred is True


# --- Servicer <-> breaker wiring -------------------------------------------


async def test_health_trips_after_threshold_chat_failures_and_recovers_on_success():
    clock = _FakeClock()
    breaker = ChatCircuitBreaker(failure_threshold=3, cooldown_seconds=60, clock=clock)
    servicer = AgentServicer(_agent_raising(RuntimeError("GEAP 403")), breaker=breaker)

    await _chat(servicer)
    await _chat(servicer)
    assert (await servicer.Health(agent_pb2.HealthRequest(), None)).healthy is True
    await _chat(servicer)
    assert (await servicer.Health(agent_pb2.HealthRequest(), None)).healthy is False

    # A working Chat closes it again.
    servicer._agent = _agent_returning(_FakeResult(message_text="back"))
    clock.advance(60)  # cooldown -> half-open admits the trial call
    assert (await servicer.Health(agent_pb2.HealthRequest(), None)).healthy is True
    await _chat(servicer)
    assert (await servicer.Health(agent_pb2.HealthRequest(), None)).healthy is True
    assert breaker.state == ChatCircuitBreaker.CLOSED


async def test_chat_with_no_agent_configured_counts_as_a_failure():
    # A sidecar that cannot serve Chat at all must stop advertising itself as
    # healthy rather than absorbing every turn into an UNIMPLEMENTED.
    breaker = ChatCircuitBreaker(failure_threshold=2, cooldown_seconds=60, clock=_FakeClock())
    servicer = AgentServicer(breaker=breaker)
    await _chat(servicer)
    await _chat(servicer)
    assert (await servicer.Health(agent_pb2.HealthRequest(), None)).healthy is False


async def test_empty_agent_turn_counts_as_a_failure():
    # The bot rejects an empty turn and falls through to direct OpenAI, so a
    # sidecar producing only empty turns is broken from the user's point of view.
    breaker = ChatCircuitBreaker(failure_threshold=2, cooldown_seconds=60, clock=_FakeClock())
    servicer = AgentServicer(_agent_returning(_FakeResult(message_text="   ")), breaker=breaker)
    await _chat(servicer)
    assert (await servicer.Health(agent_pb2.HealthRequest(), None)).healthy is True
    await _chat(servicer)
    assert (await servicer.Health(agent_pb2.HealthRequest(), None)).healthy is False


async def test_servicer_honours_the_breaker_settings_from_config():
    # Proves the env-tunable config actually reaches the breaker; with the
    # default threshold of 3 a single failure would leave it healthy.
    from src.config import Config

    cfg = Config(
        grpc_listen_addr="x", agent_model="m", openai_api_key=None, openai_model="m",
        mongo_uri="mongodb://x", sandbox_inline_output_chars=1, sandbox_wall_clock_seconds=1,
        sandbox_per_user_concurrency=1, sandbox_global_concurrency=1, sandbox_memory_limit="1Gi",
        sandbox_cpu_limit="1", sandbox_base_image="img", sandbox_trace_retention_per_user=1,
        sandbox_agent_turn_call_budget=1, k8s_namespace="ns", otlp_endpoint=None,
        otlp_headers=None, dt_mcp_url=None, dt_platform_token=None,
        agent_health_failure_threshold=1, agent_health_cooldown_seconds=5.0,
    )
    servicer = AgentServicer(_agent_raising(RuntimeError("boom")), config=cfg)
    await _chat(servicer)
    assert (await servicer.Health(agent_pb2.HealthRequest(), None)).healthy is False


# --- The breaker itself ------------------------------------------------------


def test_breaker_stays_closed_below_the_threshold():
    b = ChatCircuitBreaker(failure_threshold=3, cooldown_seconds=60, clock=_FakeClock())
    b.record_failure("boom")
    b.record_failure("boom")
    assert b.healthy() is True
    assert b.state == ChatCircuitBreaker.CLOSED


def test_breaker_trips_at_the_threshold():
    b = ChatCircuitBreaker(failure_threshold=3, cooldown_seconds=60, clock=_FakeClock())
    for _ in range(3):
        b.record_failure("boom")
    assert b.healthy() is False
    assert b.state == ChatCircuitBreaker.OPEN


def test_breaker_success_resets_the_consecutive_count():
    b = ChatCircuitBreaker(failure_threshold=3, cooldown_seconds=60, clock=_FakeClock())
    b.record_failure("boom")
    b.record_failure("boom")
    b.record_success()
    assert b.consecutive_failures == 0
    b.record_failure("boom")
    b.record_failure("boom")
    # Would already be 4 failures without the reset; still closed.
    assert b.healthy() is True


def test_breaker_stays_unhealthy_until_the_cooldown_elapses():
    clock = _FakeClock()
    b = ChatCircuitBreaker(failure_threshold=2, cooldown_seconds=60, clock=clock)
    b.record_failure("boom")
    b.record_failure("boom")
    assert b.healthy() is False
    clock.advance(59)
    assert b.healthy() is False
    clock.advance(1)
    assert b.healthy() is True  # half-open: admits a trial Chat
    assert b.state == ChatCircuitBreaker.HALF_OPEN


def test_breaker_half_open_recovers_on_a_successful_trial_call():
    # The load-bearing case: while unhealthy the bot stops sending Chat, so no
    # success can arrive unless the breaker first re-reports healthy. Without
    # this transition the agent path would be disabled until a pod restart.
    clock = _FakeClock()
    b = ChatCircuitBreaker(failure_threshold=2, cooldown_seconds=60, clock=clock)
    b.record_failure("boom")
    b.record_failure("boom")
    clock.advance(60)
    assert b.healthy() is True
    b.record_success()
    assert b.state == ChatCircuitBreaker.CLOSED
    assert b.healthy() is True


def test_breaker_half_open_retrips_immediately_when_the_trial_call_fails():
    clock = _FakeClock()
    b = ChatCircuitBreaker(failure_threshold=3, cooldown_seconds=60, clock=clock)
    for _ in range(3):
        b.record_failure("boom")
    clock.advance(60)
    assert b.healthy() is True  # half-open
    b.record_failure("still broken")
    # Straight back to unhealthy — it must NOT need another 3 failures.
    assert b.healthy() is False
    assert b.state == ChatCircuitBreaker.OPEN
    # ...and the cooldown restarted from the moment of the failed trial.
    clock.advance(59)
    assert b.healthy() is False
    clock.advance(1)
    assert b.healthy() is True


def test_breaker_never_latches_unhealthy_forever():
    clock = _FakeClock()
    b = ChatCircuitBreaker(failure_threshold=2, cooldown_seconds=60, clock=clock)
    b.record_failure("boom")
    b.record_failure("boom")
    # Simulate the bot doing exactly what it does when unhealthy: nothing but
    # Health polls, for a long time. It must eventually offer a trial window.
    for _ in range(120):
        clock.advance(5)
        if b.healthy():
            break
    else:
        pytest.fail("breaker latched unhealthy with no traffic — agent path permanently disabled")


def test_breaker_threshold_of_zero_is_clamped_to_one():
    b = ChatCircuitBreaker(failure_threshold=0, cooldown_seconds=60, clock=_FakeClock())
    assert b.healthy() is True
    b.record_failure("boom")
    assert b.healthy() is False


def test_asyncio_marker_smoke():
    # Guard: several tests above are coroutines; if the asyncio plugin ever
    # stops applying, they would silently pass without running.
    assert asyncio.iscoroutinefunction(test_health_trips_after_threshold_chat_failures_and_recovers_on_success)
