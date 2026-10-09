"""Environment-driven configuration for hangar-service."""
import os
from dataclasses import dataclass
from typing import Mapping

from .catalog import DEFAULT_WIKI_BASE

DEFAULT_ALLOWED_CALLER = "hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com"
STORAGE_BACKENDS = ("firestore", "memory")


def _csv(raw: str | None, *, lower: bool = False) -> frozenset[str]:
    items = (x.strip() for x in (raw or "").split(","))
    return frozenset((x.lower() if lower else x) for x in items if x)


@dataclass(frozen=True)
class Config:
    # Expected `aud` of caller ID tokens: the Cloud Run service URL. Empty =
    # every authenticated request is rejected (fail closed) -- an empty
    # audience would make google-auth skip the audience check entirely.
    audience: str
    allowed_callers: frozenset[str]   # lower-cased caller SA emails
    admin_ids: frozenset[str]         # Discord IDs allowed to write any member's hangar
    wiki_base: str
    project: str | None               # Firestore project (None = infer from ADC)
    version: str
    port: int
    storage: str                      # "firestore" (prod) | "memory" (local dev only)


def load(env: Mapping[str, str] | None = None) -> Config:
    env = os.environ if env is None else env
    storage = (env.get("HANGAR_STORAGE") or "firestore").strip().lower()
    if storage not in STORAGE_BACKENDS:
        raise ValueError(f"HANGAR_STORAGE must be one of {STORAGE_BACKENDS}, got {storage!r}")
    return Config(
        audience=(env.get("HANGAR_AUDIENCE") or "").strip(),
        allowed_callers=_csv(env.get("HANGAR_ALLOWED_CALLERS"), lower=True)
        or frozenset({DEFAULT_ALLOWED_CALLER}),
        admin_ids=_csv(env.get("HANGAR_ADMIN_IDS")),
        wiki_base=(env.get("WIKI_BASE") or "").strip() or DEFAULT_WIKI_BASE,
        project=(env.get("GOOGLE_CLOUD_PROJECT") or "").strip() or None,
        version=env.get("HANGAR_VERSION") or env.get("K_REVISION") or "dev",
        port=int(env.get("PORT") or "8080"),
        storage=storage,
    )
