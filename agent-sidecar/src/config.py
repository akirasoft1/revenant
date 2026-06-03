"""Environment-driven configuration for the agent sidecar."""
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


def _parse_status_codes(raw: str) -> list[int]:
    """Parse a comma-separated list of HTTP status codes (e.g. '429,503')."""
    return [int(c.strip()) for c in raw.split(",") if c.strip()]


@dataclass(frozen=True)
class Config:
    # gRPC
    grpc_listen_addr: str

    # The LLM the ADK Agent uses. Format follows LiteLlm-style spec:
    #   "gemini-3-flash"           -> native ADK Gemini (preferred default)
    #   "gemini/gemini-3-flash"    -> same; explicit prefix tolerated
    #   "openai/gpt-5.1"           -> OpenAI via LiteLlm wrapper
    #   "anthropic/claude-opus-..."-> Anthropic via LiteLlm wrapper
    # Empty/unrecognized values fall back to the default ("gemini-3-flash").
    agent_model: str

    # OpenAI key/model are still loaded for backwards compat with anyone
    # setting AGENT_MODEL=openai/...; they aren't consumed when the agent
    # runs on Gemini.
    openai_api_key: str | None
    openai_model: str

    # Transient-error retry for the Gemini-native path (SDK-level backoff).
    # ConfigMap-tunable so retry aggressiveness can be dialed live without a
    # rebuild — useful when a preview model is spiking 503s.
    agent_retry_attempts: int
    agent_retry_initial_delay: float
    agent_retry_max_delay: float
    agent_retry_exp_base: float
    agent_retry_jitter: float
    agent_retry_status_codes: list[int]

    # Upper bound on LLM calls per agent turn (ADK RunConfig). Guards against a
    # runaway tool/reasoning loop hammering the model (ADK default is 500).
    agent_max_llm_calls: int

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


def load() -> Config:
    return Config(
        grpc_listen_addr=os.environ.get("GRPC_LISTEN_ADDR", "0.0.0.0:50051"),
        agent_model=os.environ.get("AGENT_MODEL", "gemini-3-flash-preview"),
        openai_api_key=os.environ.get("OPENAI_API_KEY"),
        openai_model=os.environ.get("OPENAI_MODEL", "gpt-5.1"),
        agent_retry_attempts=int(os.environ.get("AGENT_RETRY_ATTEMPTS", "5")),
        agent_retry_initial_delay=float(os.environ.get("AGENT_RETRY_INITIAL_DELAY", "0.5")),
        agent_retry_max_delay=float(os.environ.get("AGENT_RETRY_MAX_DELAY", "15")),
        agent_retry_exp_base=float(os.environ.get("AGENT_RETRY_EXP_BASE", "2")),
        agent_retry_jitter=float(os.environ.get("AGENT_RETRY_JITTER", "1.0")),
        agent_retry_status_codes=_parse_status_codes(
            os.environ.get("AGENT_RETRY_STATUS_CODES", "429,500,502,503,504")
        ),
        agent_max_llm_calls=int(os.environ.get("AGENT_MAX_LLM_CALLS", "15")),
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
    )
