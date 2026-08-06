"""gRPC server entrypoint for the voice sidecar."""
import asyncio
import logging
import signal

import grpc

from . import voice_pb2, voice_pb2_grpc
from .config import load as load_config
from .tracing import setup as setup_tracing

logger = logging.getLogger(__name__)


class VoiceServicer(voice_pb2_grpc.VoiceServicer):
    """gRPC servicer. Health stays trivial (no I/O); Converse delegates to the
    injected LiveBridge. The bridge dependency is optional so the Health
    endpoint can be served before the real LiveBridge is assembled."""

    def __init__(self, bridge=None) -> None:
        self._bridge = bridge

    async def Health(self, request, context):  # noqa: N802
        return voice_pb2.HealthResponse(healthy=True)

    async def Converse(self, request_iter, context):  # noqa: N802
        if self._bridge is None:
            await context.abort(grpc.StatusCode.UNIMPLEMENTED, "Voice bridge not configured")
            return
        queue: asyncio.Queue = asyncio.Queue()
        _DONE = object()

        async def emit(server_event) -> None:
            await queue.put(server_event)

        async def run() -> None:
            try:
                await self._bridge.converse(request_iter, emit)
            finally:
                await queue.put(_DONE)

        task = asyncio.create_task(run())
        try:
            while True:
                item = await queue.get()
                if item is _DONE:
                    break
                yield item
        finally:
            task.cancel()


def _build_bridge(config):
    from google import genai  # lazy: keep google-genai out of unit-test imports
    from .live_bridge import LiveBridge

    client = genai.Client()  # GOOGLE_GENAI_USE_VERTEXAI + ADC from env

    def session_factory(model, live_config):
        return client.aio.live.connect(model=model, config=live_config)

    return LiveBridge(session_factory, model=config.voice_live_model,
                       default_voice=config.default_voice_name)


def serve() -> None:
    logging.basicConfig(level=logging.INFO)
    config = load_config()
    setup_tracing(config)
    bridge = _build_bridge(config)

    async def _run() -> None:
        server = grpc.aio.server()
        voice_pb2_grpc.add_VoiceServicer_to_server(VoiceServicer(bridge=bridge), server)
        server.add_insecure_port(config.grpc_listen_addr)
        await server.start()
        logger.info("voice sidecar listening on %s", config.grpc_listen_addr)

        stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop_event.set)
        try:
            await stop_event.wait()
        finally:
            await server.stop(grace=10)

    asyncio.run(_run())


if __name__ == "__main__":
    serve()
