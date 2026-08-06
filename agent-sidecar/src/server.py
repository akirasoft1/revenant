"""gRPC server entrypoint for the agent sidecar."""
import asyncio
import logging
import os
import signal

import grpc
from opentelemetry import trace

from . import agent_pb2, agent_pb2_grpc
from .config import load as load_config
from .dql_runner import run_dql
from .tracing import setup as setup_tracing

log = logging.getLogger(__name__)

_BASE_PROMPT_PATH = "/app/prompt/base.txt"
_DEFAULT_BASE_PROMPT = "You are a helpful assistant."


class AgentServicer(agent_pb2_grpc.AgentServicer):
    """gRPC servicer. Health stays sync (no I/O); Chat is async and delegates
    to the injected ChannelVoiceAgent. The agent dependency is optional so the
    Health endpoint can be served before agent assembly is wired in."""

    def __init__(self, channel_voice_agent=None, observability_agent=None, config=None) -> None:
        self._agent = channel_voice_agent
        self._obs_agent = observability_agent
        self._config = config

    async def Health(self, request, context):  # noqa: N802
        return agent_pb2.HealthResponse(healthy=True)

    async def Chat(self, request, context):  # noqa: N802
        if self._agent is None:
            await context.abort(grpc.StatusCode.UNIMPLEMENTED, "Chat agent not configured")
            return agent_pb2.ChatResponse()
        with trace.get_tracer(__name__).start_as_current_span("agent.chat") as span:
            try:
                result = await self._agent.process_chat(
                    user_id=request.user_id,
                    user_message=request.user_message,
                )
            except Exception as e:  # noqa: BLE001
                log.exception("Chat handler failed")
                await context.abort(grpc.StatusCode.INTERNAL, str(e))
                return agent_pb2.ChatResponse()
            # Surface the sandbox-invocation decision for Dynatrace so the
            # per-turn invocation rate is queryable (sandbox-invocation tuning).
            n = len(result.execution_ids)
            span.set_attribute("sandbox.invoked", n > 0)
            span.set_attribute("sandbox.call_count", n)

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

    async def Observe(self, request, context):  # noqa: N802
        if self._obs_agent is None:
            return agent_pb2.ObserveResponse(error="observability agent not configured")
        try:
            result = await self._obs_agent.observe(
                user_id=request.user_id, question=request.question,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("Observe handler failed")
            return agent_pb2.ObserveResponse(error=str(e))
        return agent_pb2.ObserveResponse(
            answer_text=result.answer_text, dql_used=result.dql_used, error=result.error,
        )

    async def RunDql(self, request, context):  # noqa: N802
        if self._config is None:
            return agent_pb2.RunDqlResponse(error="observability backend not configured")
        try:
            result = await run_dql(self._config, request.query)
        except Exception as e:  # noqa: BLE001
            log.exception("RunDql handler failed")
            return agent_pb2.RunDqlResponse(error=str(e))
        return agent_pb2.RunDqlResponse(
            rows_json=result.rows_json, columns=result.columns, error=result.error,
        )


def _load_base_prompt() -> str:
    if os.path.exists(_BASE_PROMPT_PATH):
        try:
            with open(_BASE_PROMPT_PATH, "r", encoding="utf-8") as f:
                return f.read()
        except OSError:
            log.warning("failed to read %s; using default base prompt", _BASE_PROMPT_PATH)
    return _DEFAULT_BASE_PROMPT


def serve() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = load_config()
    setup_tracing(config)

    # K8s, orchestrator, and agent assembly happen here. Imported lazily so unit
    # tests that import server.py don't pull google-adk or kubernetes.
    from kubernetes import config as kube_config, client as kube_client
    from pymongo import MongoClient
    from .agent import ChannelVoiceAgent, active_genai_backend
    from .concurrency import ConcurrencyGate
    from .egress_scraper import NoopEgressScraper
    from .k8s_client import LiveK8sClient
    from .orchestrator import SandboxOrchestrator
    from .retention import demote_old_traces

    kube_config.load_incluster_config()
    k8s_batch = kube_client.BatchV1Api()
    k8s_core = kube_client.CoreV1Api()
    mongo = MongoClient(config.mongo_uri)
    db = mongo.get_default_database()

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
    )
    log.info(
        "agent LLM resolved: AGENT_MODEL=%s genai_backend=%s project=%s location=%s",
        config.agent_model,
        active_genai_backend(),
        os.environ.get("GOOGLE_CLOUD_PROJECT", "-"),
        os.environ.get("GOOGLE_CLOUD_LOCATION", "-"),
    )

    from .observability_agent import ObservabilityAgent
    obs_agent = ObservabilityAgent(config=config)

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
        agent_pb2_grpc.add_AgentServicer_to_server(
            AgentServicer(channel_voice_agent=agent, observability_agent=obs_agent, config=config),
            server,
        )
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
