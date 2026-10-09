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

def test_live_model_default_stays_on_2_5_flash(monkeypatch):
    # Deliberately NOT upgraded (2026-09-26): gemini-3.8-live 404s on our GEAP
    # project in `global`, and 3.8-live lacks session resumption + context-window
    # compression, which this sidecar depends on. See the note in src/config.py.
    monkeypatch.delenv("VOICE_LIVE_MODEL", raising=False)
    assert cfg.load().voice_live_model == "gemini-live-2.5-flash"

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


def test_sc_knowledge_defaults(monkeypatch):
    monkeypatch.delenv("SC_KNOWLEDGE_ENABLED", raising=False)
    monkeypatch.delenv("SC_KNOWLEDGE_URL", raising=False)
    c = cfg.load()
    assert c.sc_knowledge_enabled is False
    assert c.sc_knowledge_url == "http://sc-knowledge.discord-article-bot.svc.cluster.local:8080/mcp"


def test_sc_knowledge_enabled_from_env(monkeypatch):
    for value in ("true", "TRUE", "1", "yes"):
        monkeypatch.setenv("SC_KNOWLEDGE_ENABLED", value)
        assert cfg.load().sc_knowledge_enabled is True, value
    for value in ("false", "0", "no", ""):
        monkeypatch.setenv("SC_KNOWLEDGE_ENABLED", value)
        assert cfg.load().sc_knowledge_enabled is False, value
    monkeypatch.setenv("SC_KNOWLEDGE_URL", "http://other:1/mcp")
    assert cfg.load().sc_knowledge_url == "http://other:1/mcp"


def test_control_tools_enabled_by_default(monkeypatch):
    monkeypatch.delenv("VOICE_CONTROL_TOOLS_ENABLED", raising=False)
    assert cfg.load().control_tools_enabled is True


def test_control_tools_flag_falsey_spellings(monkeypatch):
    for value in ("false", "False", "0", "no", "OFF"):
        monkeypatch.setenv("VOICE_CONTROL_TOOLS_ENABLED", value)
        assert cfg.load().control_tools_enabled is False, value
    for value in ("true", "1", "yes", "on"):
        monkeypatch.setenv("VOICE_CONTROL_TOOLS_ENABLED", value)
        assert cfg.load().control_tools_enabled is True, value


HANGAR_URL = "https://hangar-service-hvmf2jpuca-uc.a.run.app"


def _clear_hangar_env(monkeypatch):
    for k in ("HANGAR_API_URL", "HANGAR_SA_KEY_PATH", "HANGAR_EDITS_ENABLED"):
        monkeypatch.delenv(k, raising=False)


def test_hangar_edits_off_without_url(monkeypatch):
    _clear_hangar_env(monkeypatch)
    c = cfg.load()
    assert c.hangar_api_url is None
    assert c.hangar_sa_key_path == "/var/secrets/hangar/key.json"
    assert c.hangar_edits_enabled is False
    # the flag alone can't enable edits with nowhere to send them
    monkeypatch.setenv("HANGAR_EDITS_ENABLED", "true")
    assert cfg.load().hangar_edits_enabled is False


def test_hangar_edits_default_on_when_url_set(monkeypatch):
    _clear_hangar_env(monkeypatch)
    monkeypatch.setenv("HANGAR_API_URL", HANGAR_URL + "/  ")
    c = cfg.load()
    assert c.hangar_api_url == HANGAR_URL      # exact token audience: no trailing slash
    assert c.hangar_edits_enabled is True


def test_hangar_edits_flag_can_disable(monkeypatch):
    _clear_hangar_env(monkeypatch)
    monkeypatch.setenv("HANGAR_API_URL", HANGAR_URL)
    for v in ("false", "0", "no", "off", "FALSE"):
        monkeypatch.setenv("HANGAR_EDITS_ENABLED", v)
        assert cfg.load().hangar_edits_enabled is False, v


def test_hangar_key_path_from_env(monkeypatch):
    _clear_hangar_env(monkeypatch)
    monkeypatch.setenv("HANGAR_SA_KEY_PATH", "/tmp/k.json")
    assert cfg.load().hangar_sa_key_path == "/tmp/k.json"
