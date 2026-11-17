"""OpenTelemetry exporter setup; no-op when no OTLP endpoint configured."""
import os
from collections.abc import MutableMapping

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from .config import Config

_SEMCONV_OPT_IN = "OTEL_SEMCONV_STABILITY_OPT_IN"
_GENAI_OPT_IN_TOKEN = "gen_ai_latest_experimental"
_CAPTURE_CONTENT = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"


def apply_genai_content_defaults(environ: MutableMapping[str, str]) -> None:
    """Default ADK onto standard GenAI span attributes with message content.

    Without both opt-ins ADK 2.10 keeps prompts/responses only in its private
    ``gcp.vertex.agent.llm_request``/``llm_response`` attributes, so
    Dynatrace's ``gen_ai.input.messages``/``gen_ai.output.messages`` queries
    see nothing. Explicit env values win: an operator can set
    ``OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT``.
    SPAN_ONLY, not ``true``: ADK maps a legacy truthy value to EVENT_ONLY,
    which keeps content off the span.
    """
    opt_ins = [t.strip() for t in environ.get(_SEMCONV_OPT_IN, "").split(",") if t.strip()]
    if _GENAI_OPT_IN_TOKEN not in opt_ins:
        environ[_SEMCONV_OPT_IN] = ",".join([*opt_ins, _GENAI_OPT_IN_TOKEN])
    environ.setdefault(_CAPTURE_CONTENT, "SPAN_ONLY")


def setup(config: Config) -> None:
    # Before ADK is imported or builds its telemetry config (server.serve()
    # imports .agent only after this runs).
    apply_genai_content_defaults(os.environ)
    resource = Resource.create({"service.name": "discord-article-bot-agent"})
    provider = TracerProvider(resource=resource)
    if config.otlp_endpoint:
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=config.otlp_endpoint))
        )
    trace.set_tracer_provider(provider)
