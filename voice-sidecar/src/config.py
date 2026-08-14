"""Environment-driven configuration for the voice sidecar."""
import os
from dataclasses import dataclass


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


def load() -> Config:
    return Config(
        grpc_listen_addr=os.environ.get("GRPC_LISTEN_ADDR", "0.0.0.0:50051"),
        # Placeholder default; a later human step swaps in the id validated by
        # the Task 1 live GEAP probe.
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
        session_resumption_enabled=os.environ.get(
            "VOICE_SESSION_RESUMPTION_ENABLED", "true").lower() != "false",
        max_session_reconnects=int(os.environ.get("VOICE_MAX_SESSION_RECONNECTS", "5")),
    )
