"""gRPC server entrypoint for the agent sidecar."""
import asyncio
import logging
import os
import signal
import time

import grpc
from opentelemetry import trace

from . import agent_pb2, agent_pb2_grpc
from .config import load as load_config
from .dql_runner import run_dql
from .tracing import setup as setup_tracing

log = logging.getLogger(__name__)

_BASE_PROMPT_PATH = "/app/prompt/base.txt"
_DEFAULT_BASE_PROMPT = "You are a helpful assistant."

_DEFAULT_HEALTH_FAILURE_THRESHOLD = 3
_DEFAULT_HEALTH_COOLDOWN_SECONDS = 60.0


class ChatCircuitBreaker:
    """Consecutive-failure circuit breaker over the Chat RPC, feeding Health.

    Why this exists: the bot's AgentClient treats Health as its ONLY circuit
    breaker for the agent path, and Health used to be a hardcoded
    `healthy=True`. That answers "is the gRPC server accepting connections",
    which stays true while the thing that actually matters — can this sidecar
    complete a Chat turn — is broken (expired/revoked Vertex-GEAP credentials,
    an IAM or billing change, Mongo unreachable). Every channel-voice message
    then gets routed into a call guaranteed to fail, each paying up to the
    bot's 600s chat deadline when the failure is a hang rather than a clean
    error, and nothing ever falls back to direct OpenAI.

    So health is derived from observed Chat outcomes. No I/O happens in the
    health path (the servicer docstring's "Health stays sync (no I/O)" stays
    true) — Health only reads state that Chat already recorded.

    States (the half-open is the load-bearing part):
      CLOSED     — healthy. Consecutive failures are counted; reaching
                   `failure_threshold` trips to OPEN.
      OPEN       — unhealthy. The bot sees this and STOPS sending Chat, which
                   means no success can ever arrive on its own; a naive
                   consecutive-failure breaker would therefore latch unhealthy
                   forever and permanently disable the agent path. After
                   `cooldown_seconds` the breaker moves to HALF_OPEN.
      HALF_OPEN  — reports healthy again so the bot sends a trial Chat. One
                   success closes the breaker; one failure goes straight back
                   to OPEN and restarts the cooldown (it does NOT need to
                   re-accumulate `failure_threshold` failures).

    Mirrors the 60s-cooldown breaker idiom already in the repo
    (services/LocalLlmService.js) so there is one breaker shape, not two.

    `clock` is injectable so tests exercise the cooldown without real sleeps.
    """

    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

    def __init__(
        self,
        *,
        failure_threshold: int = _DEFAULT_HEALTH_FAILURE_THRESHOLD,
        cooldown_seconds: float = _DEFAULT_HEALTH_COOLDOWN_SECONDS,
        clock=time.monotonic,
    ) -> None:
        self._threshold = max(1, int(failure_threshold))
        self._cooldown = float(cooldown_seconds)
        self._clock = clock
        self._failures = 0
        self._state = self.CLOSED
        self._opened_at = 0.0

    @property
    def state(self) -> str:
        return self._state

    @property
    def consecutive_failures(self) -> int:
        return self._failures

    def record_success(self) -> None:
        """A Chat turn completed and produced a reply."""
        if self._state != self.CLOSED or self._failures:
            log.info(
                "agent Chat succeeded; circuit breaker CLOSED (was state=%s after %d consecutive failures)",
                self._state,
                self._failures,
            )
        self._failures = 0
        self._state = self.CLOSED

    def record_failure(self, reason: str) -> None:
        """A Chat turn failed. `reason` is logged verbatim (never truncated).

        Every Chat failure is counted, including ones a bad user request could
        in principle cause: we cannot cleanly tell "the backend is broken" from
        "this particular request was rejected" at this layer, and over-counting
        fails in the safe direction (the bot falls back to direct OpenAI and
        keeps answering), whereas under-counting reproduces the bug this
        breaker exists to fix.
        """
        self._failures += 1
        if self._state == self.HALF_OPEN:
            # The trial call failed — straight back to unhealthy, cooldown restarted.
            self._trip(reason, trial=True)
        elif self._failures >= self._threshold:
            self._trip(reason, trial=False)
        else:
            log.warning(
                "agent Chat failed (%d/%d consecutive; circuit breaker still CLOSED): %s",
                self._failures,
                self._threshold,
                reason,
            )

    def _trip(self, reason: str, *, trial: bool) -> None:
        self._state = self.OPEN
        self._opened_at = self._clock()
        log.error(
            "agent Chat circuit breaker OPEN (%s; %d consecutive failures): reporting healthy=false "
            "for the next %.0fs so the bot falls back to direct OpenAI instead of routing turns into "
            "a call that cannot succeed. Cause: %s",
            "trial call after cooldown failed" if trial else f"threshold {self._threshold} reached",
            self._failures,
            self._cooldown,
            reason,
        )

    def healthy(self) -> bool:
        """What the Health RPC reports. Read-only apart from the OPEN ->
        HALF_OPEN cooldown transition, which has to happen somewhere and can
        only happen here: while OPEN, Health is the sole thing still being
        called."""
        if self._state in (self.CLOSED, self.HALF_OPEN):
            return True
        if self._clock() - self._opened_at >= self._cooldown:
            self._state = self.HALF_OPEN
            log.warning(
                "agent Chat circuit breaker HALF-OPEN after the %.0fs cooldown: reporting healthy=true "
                "to admit a trial Chat. A success closes the breaker; a failure re-opens it immediately.",
                self._cooldown,
            )
            return True
        return False


class AgentServicer(agent_pb2_grpc.AgentServicer):
    """gRPC servicer. Health stays sync (no I/O); Chat is async and delegates
    to the injected ChannelVoiceAgent. The agent dependency is optional so the
    Health endpoint can be served before agent assembly is wired in.

    Health is not a liveness rubber-stamp: it reports the ChatCircuitBreaker's
    view of whether Chat is currently working (see ChatCircuitBreaker)."""

    def __init__(
        self, channel_voice_agent=None, observability_agent=None, config=None, breaker=None,
    ) -> None:
        self._agent = channel_voice_agent
        self._obs_agent = observability_agent
        self._config = config
        self._breaker = breaker or ChatCircuitBreaker(
            failure_threshold=getattr(
                config, "agent_health_failure_threshold", _DEFAULT_HEALTH_FAILURE_THRESHOLD,
            ),
            cooldown_seconds=getattr(
                config, "agent_health_cooldown_seconds", _DEFAULT_HEALTH_COOLDOWN_SECONDS,
            ),
        )

    async def Health(self, request, context):  # noqa: N802
        return agent_pb2.HealthResponse(healthy=self._breaker.healthy())

    async def Chat(self, request, context):  # noqa: N802
        if self._agent is None:
            # Not a transient blip: this sidecar cannot serve Chat at all, so it
            # must stop advertising itself as healthy rather than absorbing every
            # channel-voice turn into an UNIMPLEMENTED.
            self._breaker.record_failure("Chat agent not configured")
            await context.abort(grpc.StatusCode.UNIMPLEMENTED, "Chat agent not configured")
            return agent_pb2.ChatResponse()
        with trace.get_tracer(__name__).start_as_current_span("agent.chat") as span:
            try:
                result = await self._agent.process_chat(
                    user_id=request.user_id,
                    user_message=request.user_message,
                    system_prompt=request.system_prompt,
                    memory_context=request.memory_context,
                    history=[{"role": t.role, "content": t.content} for t in request.history],
                )
            except Exception as e:  # noqa: BLE001
                log.exception("Chat handler failed")
                self._breaker.record_failure(f"{type(e).__name__}: {e}")
                await context.abort(grpc.StatusCode.INTERNAL, str(e))
                return agent_pb2.ChatResponse()
            # Surface the sandbox-invocation decision for Dynatrace so the
            # per-turn invocation rate is queryable (sandbox-invocation tuning).
            n = len(result.execution_ids)
            span.set_attribute("sandbox.invoked", n > 0)
            span.set_attribute("sandbox.call_count", n)

        # A turn that returns no text is a failed turn, not a successful one:
        # the bot already rejects it and falls through to direct OpenAI
        # (ChatService.chat), so if it happens persistently the agent path is
        # broken from the user's point of view and health must say so.
        if not (result.message_text or "").strip():
            self._breaker.record_failure("agent turn produced no text (empty message_text)")
        else:
            self._breaker.record_success()

        summary = agent_pb2.ExecutionSummary(
            execution_count=len(result.execution_ids),
            any_failed=result.any_failed,
            execution_ids=result.execution_ids,
        )
        return agent_pb2.ChatResponse(
            message_text=result.message_text,
            summary=summary,
            # Was this reply degraded? True when the turn ran on the sidecar's
            # generic base prompt because the bot supplied no system_prompt —
            # no learned channel-voice personality, and (in the case that
            # causes it) no memory or history either. The bot renders a notice
            # from this instead of pretending the reply was normal.
            fallback_occurred=result.fallback_occurred,
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
