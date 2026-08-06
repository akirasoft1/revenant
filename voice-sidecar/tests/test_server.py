import asyncio
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
