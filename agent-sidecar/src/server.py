"""gRPC server entrypoint for the agent sidecar."""
import asyncio
import logging
import os
import signal

import grpc

from . import agent_pb2, agent_pb2_grpc
from .config import load as load_config
from .tracing import setup as setup_tracing

log = logging.getLogger(__name__)

_BASE_PROMPT_PATH = "/app/prompt/base.txt"
_DEFAULT_BASE_PROMPT = "You are a helpful assistant."


class AgentServicer(agent_pb2_grpc.AgentServicer):
    """gRPC servicer. Health stays sync (no I/O); Chat is async and delegates
    to the injected ChannelVoiceAgent. The agent dependency is optional so the
    Health endpoint can be served before agent assembly is wired in."""

    def __init__(self, channel_voice_agent=None) -> None:
        self._agent = channel_voice_agent

    async def Health(self, request, context):  # noqa: N802
        return agent_pb2.HealthResponse(healthy=True)

    async def Chat(self, request, context):  # noqa: N802
        if self._agent is None:
            await context.abort(grpc.StatusCode.UNIMPLEMENTED, "Chat agent not configured")
            return agent_pb2.ChatResponse()
        try:
            result = await self._agent.process_chat(
                user_id=request.user_id,
                user_message=request.user_message,
                user_tag=request.user_tag,
                channel_id=request.channel_id,
                guild_id=request.guild_id,
                interaction_id=request.interaction_id,
            )
        except Exception as e:  # noqa: BLE001
            # AgentLLMError is an EXPECTED, handled condition (e.g. a 503
            # after exhausting retries): the bot's AgentClient catches the
            # gRPC INTERNAL and falls through to direct OpenAI. Log one clean
            # line — no traceback. Only genuinely unexpected failures get a
            # full stack trace. Imported lazily so importing server.py stays
            # free of the google-adk dependency.
            from .agent import AgentLLMError
            if isinstance(e, AgentLLMError):
                log.warning("Chat agent LLM error (bot will fall back): %s", e)
            else:
                log.exception("Chat handler failed")
            await context.abort(grpc.StatusCode.INTERNAL, str(e))
            return agent_pb2.ChatResponse()

        summary = agent_pb2.ExecutionSummary(
            execution_count=len(result.execution_ids),
            any_failed=result.any_failed,
            execution_ids=result.execution_ids,
        )
        return agent_pb2.ChatResponse(
            message_text=result.message_text,
            summary=summary,
            fallback_occurred=False,
        )


def _load_base_prompt() -> str:
    if os.path.exists(_BASE_PROMPT_PATH):
        try:
            with open(_BASE_PROMPT_PATH, "r", encoding="utf-8") as f:
                return f.read()
        except OSError:
            log.warning("failed to read %s; using default base prompt", _BASE_PROMPT_PATH)
    return _DEFAULT_BASE_PROMPT


def _quiet_adk_node_tracebacks() -> None:
    """Suppress ADK's redundant full-traceback ERROR logs on a handled model
    failure. When the LLM call raises (e.g. a transient 503), ADK's node
    runner and root runner each dump the wrapped ~60-line stack trace at
    ERROR — even though we catch the error, translate it to a one-line
    AgentLLMError, and the bot falls back. Raise just those two child loggers
    to CRITICAL so the noise is gone; our clean summary remains and other
    loggers are untouched."""
    for name in (
        "google_adk.google.adk.workflow._node_runner",
        "google_adk.google.adk.runners",
    ):
        logging.getLogger(name).setLevel(logging.CRITICAL)


def serve() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    _quiet_adk_node_tracebacks()
    config = load_config()
    setup_tracing(config)

    # K8s, orchestrator, and agent assembly happen here. Imported lazily so unit
    # tests that import server.py don't pull google-adk or kubernetes.
    from kubernetes import config as kube_config, client as kube_client
    from pymongo import MongoClient
    from .agent import ChannelVoiceAgent
    from .concurrency import ConcurrencyGate
    from .egress_scraper import NoopEgressScraper
    from .k8s_client import LiveK8sClient
    from .orchestrator import SandboxOrchestrator
    from .retention import demote_old_traces
    from .trace_store import TraceStore

    kube_config.load_incluster_config()
    k8s_batch = kube_client.BatchV1Api()
    k8s_core = kube_client.CoreV1Api()
    mongo = MongoClient(config.mongo_uri)
    db = mongo.get_default_database()
    trace_store = TraceStore(db)
    trace_store.ensure_indexes()

    gate = ConcurrencyGate(
        per_user=config.sandbox_per_user_concurrency,
        global_=config.sandbox_global_concurrency,
    )
    k8s = LiveK8sClient(batch=k8s_batch, core=k8s_core, namespace=config.k8s_namespace)
    orch = SandboxOrchestrator(
        k8s=k8s,
        gate=gate,
        egress=NoopEgressScraper(),
        namespace=config.k8s_namespace,
        sandbox_image=config.sandbox_base_image,
        wall_clock_seconds=config.sandbox_wall_clock_seconds,
        cpu_limit=config.sandbox_cpu_limit,
        memory_limit=config.sandbox_memory_limit,
    )

    agent = ChannelVoiceAgent(
        config=config, orchestrator=orch, base_system_prompt=_load_base_prompt(),
        trace_store=trace_store,
    )
    log.info("agent LLM resolved: AGENT_MODEL=%s", config.agent_model)

    async def _retention_loop(stop_event: asyncio.Event) -> None:
        # Run once at startup so freshly-deployed sidecars catch up immediately,
        # then every 24h. Wrapped in try/except so a single bad iteration cannot
        # tear down the gRPC server.
        while not stop_event.is_set():
            try:
                demoted = demote_old_traces(
                    db, retention_per_user=config.sandbox_trace_retention_per_user,
                )
                if demoted:
                    log.info("retention pass demoted %d traces", demoted)
            except Exception:  # noqa: BLE001
                log.exception("retention loop iteration failed")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=24 * 3600)
            except asyncio.TimeoutError:
                continue

    async def _run() -> None:
        server = grpc.aio.server()
        agent_pb2_grpc.add_AgentServicer_to_server(AgentServicer(agent), server)
        server.add_insecure_port(config.grpc_listen_addr)
        await server.start()
        log.info("agent sidecar listening on %s", config.grpc_listen_addr)

        loop = asyncio.get_running_loop()
        stop_event = asyncio.Event()
        retention_task = asyncio.create_task(_retention_loop(stop_event))

        def _request_stop(signum: int) -> None:
            log.info("shutting down (signal %s)", signum)
            stop_event.set()

        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, _request_stop, sig)

        try:
            await stop_event.wait()
        finally:
            retention_task.cancel()
            try:
                await retention_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            await server.stop(grace=10)

    asyncio.run(_run())


if __name__ == "__main__":
    serve()
