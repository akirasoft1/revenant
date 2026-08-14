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


def test_session_longevity_defaults(monkeypatch):
    for k in ("VOICE_CONTEXT_COMPRESSION_TRIGGER_TOKENS", "VOICE_SESSION_RESUMPTION_ENABLED",
              "VOICE_MAX_SESSION_RECONNECTS"):
        monkeypatch.delenv(k, raising=False)
    c = cfg.load()
    assert c.context_compression_trigger_tokens == 25000
    assert c.session_resumption_enabled is True
    assert c.max_session_reconnects == 5


def test_session_resumption_can_be_disabled(monkeypatch):
    monkeypatch.setenv("VOICE_SESSION_RESUMPTION_ENABLED", "false")
    assert cfg.load().session_resumption_enabled is False


def test_session_resumption_disabled_accepts_common_falsey_spellings(monkeypatch):
    # FIX M8: don't require the literal "false" -- accept the usual falsey
    # spellings config tooling commonly uses, case-insensitively.
    for value in ("0", "No", "OFF", "false", "False"):
        monkeypatch.setenv("VOICE_SESSION_RESUMPTION_ENABLED", value)
        assert cfg.load().session_resumption_enabled is False, value


def test_session_resumption_enabled_for_other_truthy_values(monkeypatch):
    for value in ("true", "1", "yes", "on", "anything-else"):
        monkeypatch.setenv("VOICE_SESSION_RESUMPTION_ENABLED", value)
        assert cfg.load().session_resumption_enabled is True, value
