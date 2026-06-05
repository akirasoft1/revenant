"""OpenTelemetry exporter setup; no-op when no OTLP endpoint configured.

google-adk emits agent_run / call_llm / execute_tool spans via its module
tracer bound to the global TracerProvider, so installing this provider with an
OTLP exporter is all that's needed for the agent's reasoning loop to appear in
Dynatrace. We export over OTLP/HTTP to the in-cluster Dynatrace collector,
mirroring the bot (telemetry-ingest.dynatrace.svc:4318).
"""
import logging
import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.grpc import GrpcAioInstrumentorServer
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from .config import Config

log = logging.getLogger(__name__)

_DEFAULT_SERVICE_NAME = "discord-article-bot-agent"


def _traces_url(base: str) -> str:
    """Append the OTLP/HTTP traces signal path to a base endpoint, idempotently.

    The HTTP exporter (unlike env-based config) does NOT auto-append the signal
    path when given an explicit endpoint, so we do it here. `config.otlp_endpoint`
    is the base OTEL_EXPORTER_OTLP_ENDPOINT (e.g. http://host:4318).
    """
    base = base.rstrip("/")
    return base if base.endswith("/v1/traces") else base + "/v1/traces"


def _build_exporter(endpoint: str | None):
    """OTLP/HTTP span exporter for `endpoint`, or None when unset (no-op export)."""
    if not endpoint:
        return None
    return OTLPSpanExporter(endpoint=_traces_url(endpoint))


def _build_resource() -> Resource:
    service_name = os.environ.get("OTEL_SERVICE_NAME") or _DEFAULT_SERVICE_NAME
    return Resource.create({"service.name": service_name})


def _build_provider(config: Config) -> TracerProvider:
    provider = TracerProvider(resource=_build_resource())
    exporter = _build_exporter(config.otlp_endpoint)
    if exporter is not None:
        provider.add_span_processor(BatchSpanProcessor(exporter))
    return provider


def setup(config: Config) -> None:
    """Install the global TracerProvider. Best-effort: never crash startup."""
    try:
        trace.set_tracer_provider(_build_provider(config))
        if config.otlp_endpoint:
            # Extract the W3C traceparent from the bot's incoming gRPC Chat call
            # so the agent's spans nest under the bot's Agent/Chat span (one
            # unified trace). Must run before grpc.aio.server() is created in
            # server.serve(), which it is (setup is called first).
            GrpcAioInstrumentorServer().instrument()
            log.info("OTLP tracing enabled -> %s", config.otlp_endpoint)
    except Exception:  # noqa: BLE001
        log.warning("tracing setup failed; continuing without traces", exc_info=True)
