"""Environment-driven configuration for hangar-service."""
import os
from dataclasses import dataclass, field
from typing import Mapping
from urllib.parse import urlsplit

from .catalog import DEFAULT_WIKI_BASE

DEFAULT_ALLOWED_CALLER = "hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com"
STORAGE_BACKENDS = ("firestore", "memory")
DEFAULT_PUBLIC_ORIGIN = "https://hangar.aklabs.io"
CALLBACK_PATH = "/api/auth/callback"
SESSION_KEY_MIN_LEN = 32


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
    # ----- browser auth (web editor). Missing/invalid -> browser auth off
    # (auth routes 503, no session resolver); service callers are unaffected.
    public_origin: str = DEFAULT_PUBLIC_ORIGIN   # scheme://host[:port], no trailing slash
    discord_client_id: str = ""
    discord_client_secret: str = field(default="", repr=False)
    session_key: str = field(default="", repr=False)

    @property
    def redirect_uri(self) -> str:
        return self.public_origin + CALLBACK_PATH

    def browser_auth_problem(self) -> str | None:
        """Why browser (Discord) login is disabled, or None when it is enabled."""
        missing = [name for name, value in (("DISCORD_CLIENT_ID", self.discord_client_id),
                                            ("DISCORD_CLIENT_SECRET", self.discord_client_secret),
                                            ("HANGAR_SESSION_KEY", self.session_key)) if not value]
        if missing:
            return f"{', '.join(missing)} not set"
        if len(self.session_key) < SESSION_KEY_MIN_LEN:
            return f"HANGAR_SESSION_KEY is shorter than {SESSION_KEY_MIN_LEN} characters"
        parts = urlsplit(self.public_origin)
        if parts.scheme not in ("http", "https") or not parts.netloc or parts.path or parts.query \
                or parts.fragment:
            return f"HANGAR_PUBLIC_ORIGIN {self.public_origin!r} is not a scheme://host[:port] origin"
        return None

    @property
    def browser_auth_enabled(self) -> bool:
        return self.browser_auth_problem() is None


def load(env: Mapping[str, str] | None = None) -> Config:
    env = os.environ if env is None else env
    storage = (env.get("HANGAR_STORAGE") or "firestore").strip().lower()
    if storage not in STORAGE_BACKENDS:
        raise ValueError(f"HANGAR_STORAGE must be one of {STORAGE_BACKENDS}, got {storage!r}")
    if storage == "memory" and env.get("K_SERVICE"):
        # K_SERVICE is set by Cloud Run: never run the non-persistent store there.
        raise ValueError("HANGAR_STORAGE=memory is for local dev only and is refused on Cloud Run (K_SERVICE set)")
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
        public_origin=(env.get("HANGAR_PUBLIC_ORIGIN") or "").strip().rstrip("/") or DEFAULT_PUBLIC_ORIGIN,
        discord_client_id=(env.get("DISCORD_CLIENT_ID") or "").strip(),
        discord_client_secret=(env.get("DISCORD_CLIENT_SECRET") or "").strip(),
        session_key=(env.get("HANGAR_SESSION_KEY") or "").strip(),
    )
