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

        self.last_error = None

    async def refresh(self):
        self.attempts += 1
        if self.attempts <= self.fail_times:
            self.last_error = RuntimeError("Client error '421 Misdirected Request'")
            return False
        self.last_error = None
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
    assert ("sc_knowledge=unreachable or rejected at startup "
            "(RuntimeError: Client error '421 Misdirected Request'); "
            "voice runs search-only until refresh succeeds" in caplog.text)
    await asyncio.wait_for(task, 1.0)
    assert ex.attempts == 3 and ex.declarations == ["d"]


async def test_prime_sc_tools_failure_without_recorded_error_still_warns(caplog):
    """An executor that records no last_error (older/fake) still gets the
    warning, with an explicit 'unknown error' rather than a crash."""
    ex = _FlakyExecutor(1)
    ex.refresh_orig = ex.refresh

    async def _refresh_no_error():
        ok = await ex.refresh_orig()
        ex.last_error = None
        return ok
    ex.refresh = _refresh_no_error
    with caplog.at_level(logging.WARNING):
        task = await server_mod._prime_sc_tools(ex, retry_interval_s=0.01)
    assert "sc_knowledge=unreachable or rejected at startup (unknown error)" in caplog.text
    await asyncio.wait_for(task, 1.0)


async def test_prime_sc_tools_none_is_noop():
    assert await server_mod._prime_sc_tools(None) is None



class _EmptyExecutor:
    """Reachable, but the server exposes no sc_* tools."""
    def __init__(self):
        self.declarations = []
        self.attempts = 0

    async def refresh(self):
        self.attempts += 1
        return True


async def test_prime_sc_tools_reachable_but_no_tools_has_distinct_warning(caplog):
    ex = _EmptyExecutor()
    with caplog.at_level(logging.WARNING):
        task = await server_mod._prime_sc_tools(ex, retry_interval_s=0.01)
    try:
        assert "sc_knowledge reachable but exposed no sc_* tools" in caplog.text
        assert "unreachable" not in caplog.text
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


def test_describe_error_unwraps_exception_groups():
    inner = ValueError("Client error '421 Misdirected Request' for url 'http://sc/mcp'")
    grp = ExceptionGroup("unhandled errors in a TaskGroup", [ExceptionGroup("nested", [inner])])
    assert server_mod._describe_error(grp) == (
        "ValueError: Client error '421 Misdirected Request' for url 'http://sc/mcp'")
    assert server_mod._describe_error(OSError("refused")) == "OSError: refused"
    assert server_mod._describe_error(None) == "unknown error"


def test_build_bridge_passes_control_tools_flag(monkeypatch):
    from google import genai
    monkeypatch.setattr(genai, "Client", lambda *a, **k: SimpleNamespace())
    for flag in (True, False):
        c = SimpleNamespace(voice_live_model="m", default_voice_name="Puck",
                            context_compression_trigger_tokens=1, session_resumption_enabled=True,
                            max_session_reconnects=1, control_tools_enabled=flag)
        assert server_mod._build_bridge(c)._control_enabled is flag
