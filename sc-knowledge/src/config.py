"""Environment-driven configuration for the sc-knowledge MCP server."""
import os
from dataclasses import dataclass

# Host headers the MCP endpoint accepts (mcp's DNS-rebinding protection).
# Every in-cluster spelling of the Service, plus loopback for local runs and
# port-forwards. `name:*` means "that host, any port" (mcp's own syntax).
DEFAULT_ALLOWED_HOSTS: tuple[str, ...] = (
    "sc-knowledge:*",
    "sc-knowledge.discord-article-bot:*",
    "sc-knowledge.discord-article-bot.svc:*",
    "sc-knowledge.discord-article-bot.svc.cluster.local:*",
    "localhost:*",
    "127.0.0.1:*",
    "[::1]:*",
)


def _allowed_hosts(raw: str | None) -> tuple[str, ...]:
    if not raw or not raw.strip():
        return DEFAULT_ALLOWED_HOSTS
    return tuple(h.strip() for h in raw.split(",") if h.strip())


@dataclass(frozen=True)
class Config:
    listen_host: str
    listen_port: int
    uex_base: str
    wiki_base: str
    uex_bearer: str | None
    version: str
    otlp_endpoint: str | None
    guides_dir: str
    allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS


def load() -> Config:
    return Config(
        listen_host=os.environ.get("SC_LISTEN_HOST", "0.0.0.0"),
        listen_port=int(os.environ.get("SC_LISTEN_PORT", "8080")),
        uex_base=os.environ.get("UEX_BASE_URL", "https://api.uexcorp.uk/2.0"),
        wiki_base=os.environ.get("WIKI_BASE_URL", "https://api.star-citizen.wiki/api"),
        uex_bearer=os.environ.get("UEXCORP_BEARER") or None,
        version=os.environ.get("SC_KNOWLEDGE_VERSION", "dev"),
        otlp_endpoint=os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or None,
        guides_dir=os.environ.get("SC_GUIDES_DIR", "/guides"),
        allowed_hosts=_allowed_hosts(os.environ.get("SC_ALLOWED_HOSTS")),
    )
