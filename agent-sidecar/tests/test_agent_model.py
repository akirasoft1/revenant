"""Tests for agent._build_model — the dispatch layer between config's
AGENT_MODEL string and what ADK's Agent(model=…) actually expects."""
from src.agent import _build_model


def test_native_gemini_returns_gemini_model():
    assert _build_model("gemini-3-flash-preview").model == "gemini-3-flash-preview"


def test_gemini_prefix_stripped():
    assert _build_model("gemini/gemini-3-flash-preview").model == "gemini-3-flash-preview"


def test_empty_falls_back_to_default():
    assert _build_model("").model == "gemini-3-flash-preview"
    assert _build_model("   ").model == "gemini-3-flash-preview"


def test_bare_model_with_no_slash_treated_as_native():
    # A bare model name (no provider prefix) is assumed Gemini-native.
    assert _build_model("gemini-3.1-flash-lite-preview").model == "gemini-3.1-flash-lite-preview"


def test_native_gemini_configures_exponential_retry_on_503():
    # Gemini-native path must attach SDK-level retry so transient 503
    # "model overloaded" spikes are absorbed before the bot falls through
    # to the OpenAI fallback.
    m = _build_model("gemini-3.5-flash")
    assert getattr(m, "model", None) == "gemini-3.5-flash"
    ro = m.retry_options
    assert ro is not None
    assert 503 in ro.http_status_codes
    assert 429 in ro.http_status_codes
    assert ro.attempts >= 3
    assert ro.exp_base > 1  # exponential, not linear


def test_retry_options_from_config_maps_fields():
    from src.agent import _retry_options_from_config

    class _Cfg:
        agent_retry_attempts = 7
        agent_retry_initial_delay = 0.25
        agent_retry_max_delay = 12.0
        agent_retry_exp_base = 3.0
        agent_retry_jitter = 0.5
        agent_retry_status_codes = [503, 429]

    ro = _retry_options_from_config(_Cfg())
    assert ro.attempts == 7
    assert ro.initial_delay == 0.25
    assert ro.max_delay == 12.0
    assert ro.exp_base == 3.0
    assert ro.http_status_codes == [503, 429]


def test_run_config_from_config_sets_max_llm_calls():
    from src.agent import _run_config_from_config

    class _Cfg:
        agent_max_llm_calls = 12

    rc = _run_config_from_config(_Cfg())
    assert rc.max_llm_calls == 12


def test_build_model_uses_passed_retry_options():
    from google.genai import types
    ro = types.HttpRetryOptions(attempts=2, http_status_codes=[503])
    m = _build_model("gemini-3.5-flash", retry_options=ro)
    assert m.retry_options is ro


def test_litellm_path_has_no_genai_retry_options():
    # Non-Gemini providers go through LiteLlm, which has no genai retry_options.
    m = _build_model("openai/gpt-5.1")
    assert not hasattr(m, "retry_options")


def test_openai_uses_litellm_wrapper():
    from google.adk.models.lite_llm import LiteLlm
    m = _build_model("openai/gpt-5.1")
    assert isinstance(m, LiteLlm)
    assert m.model == "openai/gpt-5.1"


def test_anthropic_uses_litellm_wrapper():
    from google.adk.models.lite_llm import LiteLlm
    m = _build_model("anthropic/claude-opus-4-7")
    assert isinstance(m, LiteLlm)
    assert m.model == "anthropic/claude-opus-4-7"
