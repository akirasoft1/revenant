"""OpenTelemetry exporter setup; no-op when no OTLP endpoint configured."""
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from .config import Config


def setup(config: Config) -> None:
    resource = Resource.create({"service.name": "discord-article-bot-agent"})
    provider = TracerProvider(resource=resource)
    if config.otlp_endpoint:
        # OTLP/HTTP-protobuf to :4318 (matches the Node bot). The prior gRPC
        # exporter was aimed at :4318 — the HTTP port, not gRPC's 4317 — so it
        # never exported (continuous StatusCode.UNAVAILABLE, 0 spans ingested).
        # The HTTP exporter needs the full signal URL, so append /v1/traces.
        endpoint = config.otlp_endpoint.rstrip("/") + "/v1/traces"
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint))
        )
    trace.set_tracer_provider(provider)
