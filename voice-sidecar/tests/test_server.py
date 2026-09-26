import asyncio
import logging

import grpc
import pytest

from src import voice_pb2, voice_pb2_grpc
from src.server import VoiceServicer


async def _start(servicer):
    server = grpc.aio.server()
    voice_pb2_grpc.add_VoiceServicer_to_server(servicer, server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    return server, port


async def test_health_ok():
    server, port = await _start(VoiceServicer())
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as ch:
            stub = voice_pb2_grpc.VoiceStub(ch)
            resp = await stub.Health(voice_pb2.HealthRequest())
            assert resp.healthy is True
    finally:
        await server.stop(grace=0)


class _EchoBridge:
    async def converse(self, request_iter, emit):
        async for ev in request_iter:
            if ev.WhichOneof("event") == "session_start":
                await emit(voice_pb2.VoiceServerEvent(
                    output_transcript=voice_pb2.Transcript(text="started")))
                return


async def test_converse_streams_from_bridge():
    server, port = await _start(VoiceServicer(bridge=_EchoBridge()))
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as ch:
            stub = voice_pb2_grpc.VoiceStub(ch)
            call = stub.Converse(iter([voice_pb2.VoiceClientEvent(
                session_start=voice_pb2.SessionStart(user_id="u"))]))
            got = [ev async for ev in call]
            assert any(e.WhichOneof("event") == "output_transcript" for e in got)
    finally:
        await server.stop(grace=0)


async def test_converse_unimplemented_without_bridge():
    server, port = await _start(VoiceServicer())
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as ch:
            stub = voice_pb2_grpc.VoiceStub(ch)
            call = stub.Converse(iter([voice_pb2.VoiceClientEvent(
                session_start=voice_pb2.SessionStart(user_id="u"))]))
            with pytest.raises(grpc.aio.AioRpcError) as exc_info:
                async for _ in call:
                    pass
            assert exc_info.value.code() == grpc.StatusCode.UNIMPLEMENTED
    finally:
        await server.stop(grace=0)


class _RaisingBridge:
    async def converse(self, request_iter, emit):
        async for ev in request_iter:
            if ev.WhichOneof("event") == "session_start":
                await emit(voice_pb2.VoiceServerEvent(
                    output_transcript=voice_pb2.Transcript(text="before-boom")))
                raise RuntimeError("boom")


async def test_converse_bridge_exception_is_logged_not_dropped(caplog):
    # Proves the bridge-task exception is retrieved (awaited) and logged by
    # the servicer itself, rather than being silently dropped or surfacing
    # only via asyncio's default "Task exception was never retrieved"
    # handler. We install our own loop exception handler to detect the
    # latter — it must never fire.
    loop = asyncio.get_running_loop()
    handler_calls = []

    def _handler(loop, context):
        handler_calls.append(context)

    previous_handler = loop.get_exception_handler()
    loop.set_exception_handler(_handler)
    try:
        server, port = await _start(VoiceServicer(bridge=_RaisingBridge()))
        try:
            with caplog.at_level(logging.ERROR, logger="src.server"):
                async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as ch:
                    stub = voice_pb2_grpc.VoiceStub(ch)
                    call = stub.Converse(iter([voice_pb2.VoiceClientEvent(
                        session_start=voice_pb2.SessionStart(user_id="u"))]))
                    got = [ev async for ev in call]
        finally:
            await server.stop(grace=0)
        # Give any late loop callbacks (e.g. GC-triggered) a chance to fire
        # before asserting none did.
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(previous_handler)

    assert any(e.WhichOneof("event") == "output_transcript" for e in got)
    assert any("voice bridge task failed" in r.message for r in caplog.records)
    assert handler_calls == []


# ---- sc-knowledge startup wiring -----------------------------------------

from types import SimpleNamespace  # noqa: E402

from src import server as server_mod  # noqa: E402


def _cfg(enabled):
    return SimpleNamespace(sc_knowledge_enabled=enabled,
                           sc_knowledge_url="http://sc:8080/mcp")


def test_build_sc_executor_respects_flag():
    assert server_mod._build_sc_executor(_cfg(False)) is None
    ex = server_mod._build_sc_executor(_cfg(True))
    assert ex is not None and ex._url == "http://sc:8080/mcp"


class _FlakyExecutor:
    def __init__(self, fail_times):
        self.fail_times = fail_times
        self.attempts = 0
        self.declarations = []

    async def refresh(self):
        self.attempts += 1
        if self.attempts <= self.fail_times:
            return False
        self.declarations = ["d"]
        return True


async def test_prime_sc_tools_success_needs_no_retry():
    ex = _FlakyExecutor(0)
    assert await server_mod._prime_sc_tools(ex, retry_interval_s=0.01) is None
    assert ex.attempts == 1


async def test_prime_sc_tools_failure_warns_and_retries_in_background(caplog):
    ex = _FlakyExecutor(2)
    with caplog.at_level(logging.WARNING):
        task = await server_mod._prime_sc_tools(ex, retry_interval_s=0.01)
    assert task is not None
    assert ("sc_knowledge=unreachable at startup; voice runs search-only until refresh succeeds"
            in caplog.text)
    await asyncio.wait_for(task, 1.0)
    assert ex.attempts == 3 and ex.declarations == ["d"]


async def test_prime_sc_tools_none_is_noop():
    assert await server_mod._prime_sc_tools(None) is None
