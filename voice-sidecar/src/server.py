"""gRPC server entrypoint for the voice sidecar."""
import asyncio
import logging
import signal

import grpc
from opentelemetry import trace

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
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
                logger.exception("voice bridge task failed")


SC_REFRESH_RETRY_INTERVAL_S = 60.0


def _build_sc_executor(config):
    """ScToolExecutor when SC_KNOWLEDGE_ENABLED, else None (search-only)."""
    if not getattr(config, "sc_knowledge_enabled", False):
        return None
    from .sc_tools import ScToolExecutor
    return ScToolExecutor(config.sc_knowledge_url)


def _describe_error(err: BaseException | None) -> str:
    """'<ExcClass>: <msg>' for the startup warning; an ExceptionGroup (anyio
    task groups in the MCP client wrap the real HTTP error) is unwrapped to
    its leaf exceptions so the 421/4xx itself is visible."""
    if err is None:
        return "unknown error"
    if isinstance(err, BaseExceptionGroup):
        leaves = []
        stack = list(err.exceptions)
        while stack:
            e = stack.pop(0)
            if isinstance(e, BaseExceptionGroup):
                stack.extend(e.exceptions)
            else:
                leaves.append(e)
        return "; ".join(f"{type(e).__name__}: {e}" for e in leaves) or f"{type(err).__name__}: {err}"
    return f"{type(err).__name__}: {err}"


async def _prime_sc_tools(executor, retry_interval_s: float = SC_REFRESH_RETRY_INTERVAL_S):
    """Load sc-knowledge declarations before serving. If sc-knowledge is
    unreachable, voice starts search-only and a background task retries every
    `retry_interval_s` until declarations exist; new Live sessions pick them
    up from then on (`_live_config` reads them per connect). Returns that
    retry task (caller owns cancelling it), or None."""
    if executor is None:
        return None
    reachable = await executor.refresh()
    if reachable and executor.declarations:
        return None
    if reachable:
        # Distinct from "unreachable": the server answered list_tools but
        # none of its tools start with sc_ -- a server/config problem, not a
        # network one, so the NetworkPolicy is not the thing to debug.
        logger.warning("sc_knowledge reachable but exposed no sc_* tools; voice runs search-only "
                       "until a refresh returns some")
    else:
        # "unreachable OR rejected", with the actual exception: a 421/4xx
        # (e.g. sc-knowledge's Host allow-list) is a server-side config
        # problem, and blaming it on the NetworkPolicy sends the operator
        # debugging the wrong layer.
        logger.warning("sc_knowledge=unreachable or rejected at startup (%s); voice runs search-only "
                       "until refresh succeeds", _describe_error(getattr(executor, "last_error", None)))

    async def _retry() -> None:
        while not executor.declarations:
            await asyncio.sleep(retry_interval_s)
            if await executor.refresh() and executor.declarations:
                logger.info("sc_knowledge: refresh succeeded; sc_* tools attach to new voice sessions")
                return

    return asyncio.create_task(_retry())


def _build_hangar_editor(config):
    """HangarEditClient when HANGAR_EDITS_ENABLED (needs HANGAR_API_URL), else None."""
    from .hangar_edit import build_hangar_edit_client
    client = build_hangar_edit_client(config)
    if client is None:
        logger.info("hangar chat edits off (HANGAR_EDITS_ENABLED false or HANGAR_API_URL unset)")
    else:
        logger.info("hangar chat edits enabled against %s (key %s)",
                    config.hangar_api_url, config.hangar_sa_key_path)
    return client


def _build_bridge(config, sc_executor=None, hangar_editor=None):
    from google import genai  # lazy: keep google-genai out of unit-test imports
    from .live_bridge import LiveBridge

    client = genai.Client()  # GOOGLE_GENAI_USE_VERTEXAI + ADC from env

    def session_factory(model, live_config):
        return client.aio.live.connect(model=model, config=live_config)

    return LiveBridge(session_factory, model=config.voice_live_model,
                       default_voice=config.default_voice_name,
                       compression_trigger_tokens=config.context_compression_trigger_tokens,
                       resumption_enabled=config.session_resumption_enabled,
                       max_reconnects=config.max_session_reconnects,
                       sc_executor=sc_executor,
                       control_tools_enabled=getattr(config, "control_tools_enabled", True),
                       hangar_editor=hangar_editor)


def serve() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    config = load_config()
    setup_tracing(config)
    sc_executor = _build_sc_executor(config)
    bridge = _build_bridge(config, sc_executor, _build_hangar_editor(config))

    async def _run() -> None:
        sc_retry = await _prime_sc_tools(sc_executor)
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
            if sc_retry is not None:
                sc_retry.cancel()
            await server.stop(grace=10)
            # Force-flush + shut down the tracer provider so spans buffered in the
            # BatchSpanProcessor are exported before the process exits on SIGTERM.
            # Safe/no-op when setup_tracing() installed a provider with no exporter
            # (config.otlp_endpoint unset).
            try:
                trace.get_tracer_provider().shutdown()
            except Exception:  # noqa: BLE001
                logger.exception("failed to flush/shutdown tracer provider")

    asyncio.run(_run())


if __name__ == "__main__":
    serve()
