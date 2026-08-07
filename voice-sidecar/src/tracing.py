"""OpenTelemetry exporter setup; no-op when no OTLP endpoint configured."""
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from .config import Config


def setup(config: Config) -> None:
    resource = Resource.create({"service.name": "discord-article-bot-voice"})
    provider = TracerProvider(resource=resource)
    if config.otlp_endpoint:
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=config.otlp_endpoint))
        )
    trace.set_tracer_provider(provider)
