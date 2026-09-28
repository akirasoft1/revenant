"""Environment-driven configuration for the voice sidecar."""
import os
from dataclasses import dataclass

# Same default as the agent sidecar (agent-sidecar/src/config.py).
DEFAULT_SC_KNOWLEDGE_URL = "http://sc-knowledge.discord-article-bot.svc.cluster.local:8080/mcp"


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


def load() -> Config:
    return Config(
        grpc_listen_addr=os.environ.get("GRPC_LISTEN_ADDR", "0.0.0.0:50051"),
        # DO NOT "upgrade" blindly (2026-09-26): gemini-3.8-live returns 404 on
        # our GEAP project (revenant-discord-bot-2) in `global`, and 3.8-live
        # does not support session resumption or context-window compression,
        # both of which this sidecar depends on (see live_bridge._live_config).
        # The [SPEAKER: ...] markers also need send_client_content with
        # turn_complete=False, which is restricted on Gemini 3.x Live.
        # Pinned by tests/test_config.py::test_live_model_default_stays_on_2_5_flash.
        voice_live_model=os.environ.get("VOICE_LIVE_MODEL", "gemini-live-2.5-flash"),
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
    )
