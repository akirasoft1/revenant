"""ADK GenAI content-capture defaults.

ADK 2.10 only writes prompt/response content to the standard
``gen_ai.input.messages`` / ``gen_ai.output.messages`` span attributes when
BOTH opt-ins are set; otherwise prompts live only in its private
``gcp.vertex.agent.llm_request`` attribute, invisible to Dynatrace's GenAI
queries. tracing.setup() defaults them on (overlay env still wins).
"""
import os
from types import SimpleNamespace

from src import tracing

SEMCONV = "OTEL_SEMCONV_STABILITY_OPT_IN"
CAPTURE = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"


def test_defaults_applied_to_empty_env():
    env = {}
    tracing.apply_genai_content_defaults(env)
    assert env[SEMCONV] == "gen_ai_latest_experimental"
    # SPAN_ONLY, not "true": ADK maps a legacy truthy value to EVENT_ONLY,
    # which keeps content OFF the span.
    assert env[CAPTURE] == "SPAN_ONLY"


def test_explicit_values_are_not_overwritten():
    env = {CAPTURE: "NO_CONTENT", SEMCONV: "gen_ai_latest_experimental,http"}
    tracing.apply_genai_content_defaults(env)
    assert env[CAPTURE] == "NO_CONTENT"
    assert env[SEMCONV] == "gen_ai_latest_experimental,http"


def test_existing_semconv_opt_in_gets_genai_token_appended():
    # Another OTel opt-in (e.g. "http") must not silently block the GenAI one.
    env = {SEMCONV: "http"}
    tracing.apply_genai_content_defaults(env)
    assert env[SEMCONV] == "http,gen_ai_latest_experimental"


def test_setup_applies_defaults_to_process_env(monkeypatch):
    # setenv first so monkeypatch restores the original (absent) state.
    for key in (SEMCONV, CAPTURE):
        monkeypatch.setenv(key, "x")
        monkeypatch.delenv(key)
    tracing.setup(SimpleNamespace(otlp_endpoint=None))
    assert os.environ[SEMCONV] == "gen_ai_latest_experimental"
    assert os.environ[CAPTURE] == "SPAN_ONLY"
