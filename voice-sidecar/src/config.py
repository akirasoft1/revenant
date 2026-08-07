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
    )
