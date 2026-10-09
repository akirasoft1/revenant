"""Environment-driven configuration for the agent sidecar."""
import logging
import os
from dataclasses import dataclass


def _resolve_mongo_uri() -> str:
    """Resolve MONGO_URI, performing the same `${MONGO_PASSWORD}` substitution
    the Node bot's config.js does. The deployed Secret stores the URI with a
    literal `${MONGO_PASSWORD}` placeholder so the password rotates
    independently of the connection string; without this substitution PyMongo
    sees the literal placeholder as the password and authentication fails."""
    uri = os.environ["MONGO_URI"]
    pw = os.environ.get("MONGO_PASSWORD")
    if pw and "${MONGO_PASSWORD}" in uri:
        uri = uri.replace("${MONGO_PASSWORD}", pw)
    return uri


@dataclass(frozen=True)
class Config:
    # gRPC
    grpc_listen_addr: str

    # The LLM the ADK Agent uses. Format follows LiteLlm-style spec:
    #   "gemini-3.8-flash"         -> native ADK Gemini (preferred default)
    #   "gemini/gemini-3.8-flash"  -> same; explicit prefix tolerated
    #   "openai/gpt-6-luna"        -> OpenAI via LiteLlm wrapper
    #   "anthropic/claude-opus-..."-> Anthropic via LiteLlm wrapper
    # Empty/unrecognized values fall back to the default ("gemini-3.8-flash").
    agent_model: str

    # OpenAI key/model are still loaded for backwards compat with anyone
    # setting AGENT_MODEL=openai/...; they aren't consumed when the agent
    # runs on Gemini.
    openai_api_key: str | None
    openai_model: str

    # MongoDB
    mongo_uri: str

    # Sandbox knobs (mirror the spec's ConfigMap)
    sandbox_inline_output_chars: int
    sandbox_wall_clock_seconds: int
    sandbox_per_user_concurrency: int
    sandbox_global_concurrency: int
    sandbox_memory_limit: str
    sandbox_cpu_limit: str
    sandbox_base_image: str
    sandbox_trace_retention_per_user: int
    sandbox_agent_turn_call_budget: int

    # K8s
    k8s_namespace: str

    # OTel
    otlp_endpoint: str | None
    otlp_headers: str | None

    # Dynatrace remote MCP (observability admin path). Both optional: absent =
    # /obs reports "observability backend unavailable" instead of crashing.
    dt_mcp_url: str | None
    dt_platform_token: str | None

    # Star Citizen knowledge MCP (sc-knowledge). Disabled by default so a
    # sidecar deployed before sc-knowledge exists behaves exactly as before.
    sc_knowledge_enabled: bool = False
    sc_knowledge_url: str = "http://sc-knowledge.discord-article-bot.svc.cluster.local:8080/mcp"

    # Chat circuit breaker behind the Health RPC (see server.ChatCircuitBreaker).
    # Health reports unhealthy after this many consecutive Chat failures, then
    # re-reports healthy after the cooldown to admit one trial Chat. Defaulted
    # (and last) so existing call sites that build a Config explicitly keep
    # working without restating them.
    agent_health_failure_threshold: int = 3
    agent_health_cooldown_seconds: float = 60.0

    # Hard ceiling on one Chat turn, set under the bot's 600s chatDeadlineMs so
    # the sidecar gives up before the bot does (see server._DEFAULT_CHAT_TIMEOUT_SECONDS).
    agent_chat_timeout_seconds: float = 540.0

    # ADK's native google_search built-in on the text agent. Only attached
    # when the model is Gemini-native (LiteLlm models never get it). The
    # stock `google_search` instance is used deliberately: the
    # GoogleSearchTool(bypass_multi_tools_limit=True) variant crashes in
    # google-adk 2.10 (PydanticSerializationError / MockValSer).
    agent_web_search_enabled: bool = True

    # Hangar chat edits (2026-10-09 hangar-chat-edits spec): hangar_fit /
    # hangar_add_ship / hangar_reset, bound per turn to ChatRequest.user_id.
    # HANGAR_API_URL is also the ID-token audience, so it is kept exactly as
    # configured (whitespace stripped only). Edits default ON when the URL is
    # set and can never be on without it.
    hangar_api_url: str | None = None
    hangar_sa_key_path: str = "/var/secrets/hangar/key.json"
    hangar_edits_enabled: bool = False


def _hangar_settings() -> dict:
    raw = (os.environ.get("HANGAR_API_URL") or "").strip()
    url = raw.rstrip("/") or None
    if url and url != raw:
        # One normalized form is both the ID-token audience and the request
        # base; a trailing slash would otherwise make the audience mismatch.
        logging.getLogger(__name__).warning(
            "HANGAR_API_URL %r has a trailing '/'; using %r (audience + request base)", raw, url)
    default = "true" if url else "false"
    flag = os.environ.get("HANGAR_EDITS_ENABLED", default).strip().lower() in ("true", "1", "yes")
    return {
        "hangar_api_url": url,
        "hangar_sa_key_path": os.environ.get("HANGAR_SA_KEY_PATH", "/var/secrets/hangar/key.json"),
        "hangar_edits_enabled": bool(url) and flag,
    }


def load() -> Config:
    return Config(
        **_hangar_settings(),
        grpc_listen_addr=os.environ.get("GRPC_LISTEN_ADDR", "0.0.0.0:50051"),
        agent_model=os.environ.get("AGENT_MODEL", "gemini-3.8-flash"),
        openai_api_key=os.environ.get("OPENAI_API_KEY"),
        openai_model=os.environ.get("OPENAI_MODEL", "gpt-6-luna"),
        agent_health_failure_threshold=int(os.environ.get("AGENT_HEALTH_FAILURE_THRESHOLD", "3")),
        agent_health_cooldown_seconds=float(os.environ.get("AGENT_HEALTH_COOLDOWN_SECONDS", "60")),
        agent_chat_timeout_seconds=float(os.environ.get("AGENT_CHAT_TIMEOUT_SECONDS", "540")),
        agent_web_search_enabled=os.environ.get("AGENT_WEB_SEARCH_ENABLED", "true").strip().lower() in ("true", "1", "yes"),
        mongo_uri=_resolve_mongo_uri(),
        sandbox_inline_output_chars=int(os.environ.get("SANDBOX_INLINE_OUTPUT_CHARS", "750")),
        sandbox_wall_clock_seconds=int(os.environ.get("SANDBOX_WALL_CLOCK_SECONDS", "300")),
        sandbox_per_user_concurrency=int(os.environ.get("SANDBOX_PER_USER_CONCURRENCY", "2")),
        sandbox_global_concurrency=int(os.environ.get("SANDBOX_GLOBAL_CONCURRENCY", "15")),
        sandbox_memory_limit=os.environ.get("SANDBOX_MEMORY_LIMIT", "2Gi"),
        sandbox_cpu_limit=os.environ.get("SANDBOX_CPU_LIMIT", "2"),
        sandbox_base_image=os.environ["SANDBOX_BASE_IMAGE"],
        sandbox_trace_retention_per_user=int(os.environ.get("SANDBOX_TRACE_RETENTION_PER_USER", "50")),
        sandbox_agent_turn_call_budget=int(os.environ.get("SANDBOX_AGENT_TURN_CALL_BUDGET", "8")),
        k8s_namespace=os.environ.get("K8S_NAMESPACE", "discord-article-bot"),
        otlp_endpoint=os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"),
        otlp_headers=os.environ.get("OTEL_EXPORTER_OTLP_HEADERS"),
        dt_mcp_url=os.environ.get("DT_MCP_URL"),
        dt_platform_token=os.environ.get("DT_PLATFORM_TOKEN"),
        sc_knowledge_enabled=os.environ.get("SC_KNOWLEDGE_ENABLED", "false").strip().lower() in ("true", "1", "yes"),
        sc_knowledge_url=os.environ.get(
            "SC_KNOWLEDGE_URL", "http://sc-knowledge.discord-article-bot.svc.cluster.local:8080/mcp",
        ),
    )
