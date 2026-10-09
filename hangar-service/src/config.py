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
DEFAULT_MAX_SHIPS_PER_MEMBER = 200
_DEFAULT_PORTS = {"http": 80, "https": 443}


def normalize_origin(raw: str) -> str | None:
    """``scheme://host[:port]`` with lower-cased scheme/host and the default
    port dropped, or None if ``raw`` is not a bare http(s) origin (a path other
    than a single ``/``, a query, fragment, userinfo or bad port is rejected)."""
    try:
        parts = urlsplit((raw or "").strip())
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if scheme not in _DEFAULT_PORTS or not host or parts.path not in ("", "/") or parts.query \
            or parts.fragment or "@" in parts.netloc:
        return None
    if ":" in host:                      # IPv6 literal
        host = f"[{host}]"
    if port is None or port == _DEFAULT_PORTS[scheme]:
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


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
    session_key_previous: str = field(default="", repr=False)   # still verifies, never signs
    session_not_before_raw: str = ""     # unix seconds; sessions with an older iat are rejected
    max_ships_per_member: int = DEFAULT_MAX_SHIPS_PER_MEMBER
    # Only members of these Discord servers may sign in. Empty = browser login
    # OFF (fail closed) -- never "allow everyone".
    allowed_guild_ids: frozenset[str] = frozenset()

    @property
    def session_not_before(self) -> int | None:
        raw = self.session_not_before_raw
        return int(raw) if raw.isdigit() else None

    @property
    def redirect_uri(self) -> str:
        return self.public_origin + CALLBACK_PATH

    def browser_auth_problem(self) -> str | None:
        """Why browser (Discord) login is disabled, or None when it is enabled."""
        missing = [name for name, value in (("DISCORD_CLIENT_ID", self.discord_client_id),
                                            ("DISCORD_CLIENT_SECRET", self.discord_client_secret),
                                            ("HANGAR_SESSION_KEY", self.session_key),
                                            ("HANGAR_ALLOWED_GUILD_IDS", self.allowed_guild_ids))
                   if not value]
        if missing:
            return f"{', '.join(missing)} not set"
        bad_guilds = sorted(g for g in self.allowed_guild_ids if not g.isdigit() or len(g) > 32)
        if bad_guilds:
            return f"HANGAR_ALLOWED_GUILD_IDS has non-snowflake entries {bad_guilds}"
        if len(self.session_key) < SESSION_KEY_MIN_LEN:
            return f"HANGAR_SESSION_KEY is shorter than {SESSION_KEY_MIN_LEN} characters"
        if self.session_key_previous and len(self.session_key_previous) < SESSION_KEY_MIN_LEN:
            return f"HANGAR_SESSION_KEY_PREVIOUS is shorter than {SESSION_KEY_MIN_LEN} characters"
        if self.session_not_before_raw and self.session_not_before is None:
            return (f"HANGAR_SESSION_NOT_BEFORE {self.session_not_before_raw!r} is not a "
                    f"non-negative integer (unix seconds)")
        if normalize_origin(self.public_origin) != self.public_origin:
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
        public_origin=_origin(env.get("HANGAR_PUBLIC_ORIGIN")),
        discord_client_id=(env.get("DISCORD_CLIENT_ID") or "").strip(),
        discord_client_secret=(env.get("DISCORD_CLIENT_SECRET") or "").strip(),
        session_key=(env.get("HANGAR_SESSION_KEY") or "").strip(),
        session_key_previous=(env.get("HANGAR_SESSION_KEY_PREVIOUS") or "").strip(),
        session_not_before_raw=(env.get("HANGAR_SESSION_NOT_BEFORE") or "").strip(),
        allowed_guild_ids=_csv(env.get("HANGAR_ALLOWED_GUILD_IDS")),
        max_ships_per_member=_positive_int(env, "HANGAR_MAX_SHIPS_PER_MEMBER", DEFAULT_MAX_SHIPS_PER_MEMBER),
    )


def _origin(raw: str | None) -> str:
    """Normalized origin; an invalid value is kept as given (stripped) so
    ``browser_auth_problem`` reports it -- browser login off, service unaffected."""
    raw = (raw or "").strip()
    if not raw:
        return DEFAULT_PUBLIC_ORIGIN
    return normalize_origin(raw) or raw


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    if not raw.isdigit() or int(raw) < 1:
        raise ValueError(f"{name} must be a positive integer, got {raw!r}")
    return int(raw)
