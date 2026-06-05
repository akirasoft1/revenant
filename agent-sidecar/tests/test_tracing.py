from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider

from src.tracing import (
    _traces_url,
    _build_exporter,
    _build_resource,
    _build_provider,
    setup,
)


class _Cfg:
    """Minimal stand-in for Config: _build_provider only reads otlp_endpoint."""
    def __init__(self, endpoint):
        self.otlp_endpoint = endpoint


def test_traces_url_appends_signal_path():
    assert _traces_url("http://c:4318") == "http://c:4318/v1/traces"


def test_traces_url_idempotent_and_strips_trailing_slash():
    assert _traces_url("http://c:4318/") == "http://c:4318/v1/traces"
    assert _traces_url("http://c:4318/v1/traces") == "http://c:4318/v1/traces"


def test_build_exporter_none_when_no_endpoint():
    assert _build_exporter(None) is None
    assert _build_exporter("") is None


def test_build_exporter_http_when_endpoint_set():
    assert isinstance(_build_exporter("http://c:4318"), OTLPSpanExporter)


def test_build_resource_default_service_name(monkeypatch):
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    assert _build_resource().attributes["service.name"] == "discord-article-bot-agent"


def test_build_resource_honors_env(monkeypatch):
    monkeypatch.setenv("OTEL_SERVICE_NAME", "custom-agent")
    assert _build_resource().attributes["service.name"] == "custom-agent"


def test_build_provider_no_exporter_when_no_endpoint():
    p = _build_provider(_Cfg(None))
    assert isinstance(p, TracerProvider)
    assert len(p._active_span_processor._span_processors) == 0


def test_build_provider_attaches_exporter_when_endpoint_set():
    p = _build_provider(_Cfg("http://c:4318"))
    assert len(p._active_span_processor._span_processors) == 1


def test_setup_no_endpoint_does_not_raise():
    setup(_Cfg(None))
