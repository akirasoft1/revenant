"""Environment-driven configuration for the voice sidecar."""
import os
from dataclasses import dataclass

# Same default as the agent sidecar (agent-sidecar/src/config.py).
DEFAULT_SC_KNOWLEDGE_URL = "http://sc-knowledge.discord-article-bot.svc.cluster.local:8080/mcp"

DEFAULT_HANGAR_SA_KEY_PATH = "/var/secrets/hangar/key.json"


def _hangar_url(raw: str | None) -> str | None:
    url = (raw or "").strip().rstrip("/")
    return url or None


@dataclass(frozen=True)
class Config:
    grpc_listen_addr: str
    voice_live_model: str
    default_voice_name: str
    otlp_endpoint: str | None
    google_cloud_project: str | None
    google_cloud_location: str | None
    context_compression_trigger_tokens: int
    session_resumption_enabled: bool
    max_session_reconnects: int
    # sc-knowledge (Star Citizen data MCP server) function calling. Off by
    # default: off = today's search-only Live config, byte-identical.
    sc_knowledge_enabled: bool = False
    sc_knowledge_url: str = DEFAULT_SC_KNOWLEDGE_URL
    # Local voice control tools (end_conversation / go_quiet) declared to the
    # Live model and answered in-sidecar (never MCP). On by default; off =
    # today's Live config, byte-identical.
    control_tools_enabled: bool = True
    # Hangar chat edits (hangar_fit / hangar_add_ship / hangar_reset), local
    # tools answered in-sidecar against hangar-service. HANGAR_API_URL is also
    # the ID-token audience, so it must match the service URL byte for byte
    # (no trailing slash). Enabled by default only when the URL is set.
    hangar_api_url: str | None = None
    hangar_sa_key_path: str = DEFAULT_HANGAR_SA_KEY_PATH
    hangar_edits_enabled: bool = False


def load() -> Config:
    return Config(
        grpc_listen_addr=os.environ.get("GRPC_LISTEN_ADDR", "0.0.0.0:50051"),
        # gemini-3.8-live since 2026-10-10. On our GEAP project
        # (revenant-discord-bot-2) it serves ONLY in us-central1 -- the
        # 2026-09-26 "404" came from probing `global` (also 404 in us-east4 and
        # europe-west4) -- so the voice sidecar MUST set
        # GOOGLE_CLOUD_LOCATION=us-central1 (the agent sidecar stays `global`).
        # It supports session resumption + context-window compression, which
        # live_bridge._live_config depends on. Spike vs gemini-live-2.5-flash:
        # 0 [SPEAKER:] marker leaks (2.5: 2/3 runs), 0 spoken citation brackets
        # (2.5: ~150), end_conversation 6/6 (2.5: never), one sc_* call per
        # question (2.5: two). Pinned by tests/test_config.py.
        voice_live_model=os.environ.get("VOICE_LIVE_MODEL", "gemini-3.8-live"),
        default_voice_name=os.environ.get("VOICE_DEFAULT_VOICE", "Puck"),
        otlp_endpoint=os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"),
        google_cloud_project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
        google_cloud_location=os.environ.get("GOOGLE_CLOUD_LOCATION"),
        # Sliding-window context compression: without it, audio-only Live
        # sessions die at ~15 min (audio accrues ~25 tokens/s). With it the
        # session is unbounded; the window trims oldest context past the trigger.
        context_compression_trigger_tokens=int(
            os.environ.get("VOICE_CONTEXT_COMPRESSION_TRIGGER_TOKENS", "25000")),
        # Session resumption: the server hands us a handle; on a dropped/GoAway
        # connection we reconnect with it and keep the conversation's context.
        # Accept the usual falsey spellings (case-insensitive), not just the
        # literal "false" -- config toggles set via k8s/env tooling commonly
        # use "0"/"no"/"off" too.
        session_resumption_enabled=os.environ.get(
            "VOICE_SESSION_RESUMPTION_ENABLED", "true").strip().lower()
        not in ("false", "0", "no", "off"),
        max_session_reconnects=int(os.environ.get("VOICE_MAX_SESSION_RECONNECTS", "5")),
        sc_knowledge_enabled=os.environ.get("SC_KNOWLEDGE_ENABLED", "false").strip().lower()
        in ("true", "1", "yes"),
        sc_knowledge_url=os.environ.get("SC_KNOWLEDGE_URL", DEFAULT_SC_KNOWLEDGE_URL),
        control_tools_enabled=os.environ.get(
            "VOICE_CONTROL_TOOLS_ENABLED", "true").strip().lower()
        not in ("false", "0", "no", "off"),
        hangar_api_url=_hangar_url(os.environ.get("HANGAR_API_URL")),
        hangar_sa_key_path=os.environ.get("HANGAR_SA_KEY_PATH") or DEFAULT_HANGAR_SA_KEY_PATH,
        # Default on when the URL is set; the flag can only turn it off (it
        # cannot enable edits with nowhere to send them).
        hangar_edits_enabled=bool(_hangar_url(os.environ.get("HANGAR_API_URL")))
        and os.environ.get("HANGAR_EDITS_ENABLED", "true").strip().lower()
        not in ("false", "0", "no", "off"),
    )
