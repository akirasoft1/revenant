import os
from src import config as cfg

def test_load_defaults(monkeypatch):
    for k in ["GRPC_LISTEN_ADDR", "VOICE_LIVE_MODEL", "VOICE_DEFAULT_VOICE",
              "OTEL_EXPORTER_OTLP_ENDPOINT", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]:
        monkeypatch.delenv(k, raising=False)
    c = cfg.load()
    assert c.grpc_listen_addr == "0.0.0.0:50051"
    assert c.voice_live_model  # non-empty default
    assert c.default_voice_name  # non-empty default
    assert c.otlp_endpoint is None

def test_load_reads_env(monkeypatch):
    monkeypatch.setenv("VOICE_LIVE_MODEL", "gemini-live-x")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    c = cfg.load()
    assert c.voice_live_model == "gemini-live-x"
    assert c.otlp_endpoint == "http://collector:4318"
