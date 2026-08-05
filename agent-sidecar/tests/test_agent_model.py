"""Tests for agent._build_model — the dispatch layer between config's
AGENT_MODEL string and what ADK's Agent(model=…) actually expects."""
from src import agent
from src.agent import _build_model


def test_backend_enterprise_when_vertex_flag_set(monkeypatch):
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    assert agent.active_genai_backend() == "enterprise"


def test_backend_enterprise_when_enterprise_flag_set(monkeypatch):
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    monkeypatch.setenv("GOOGLE_GENAI_USE_ENTERPRISE", "1")
    assert agent.active_genai_backend() == "enterprise"


def test_backend_developer_api_by_default(monkeypatch):
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    monkeypatch.delenv("GOOGLE_GENAI_USE_ENTERPRISE", raising=False)
    assert agent.active_genai_backend() == "developer-api"


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
