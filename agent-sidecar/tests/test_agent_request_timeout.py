"""Per-request Gemini timeout + env-wired SDK retry.

Incident 2026-10-23 ~16:00 UTC: one Gemini request on Vertex `global` hung
~534s, then returned 429; with no per-request bound it consumed the whole 540s
turn budget, the turn was killed and the bot fell back to OpenAI. Now each
model request is bounded (AGENT_REQUEST_TIMEOUT_SECONDS, default 300) and a
request that times out before producing a response is retried
(AGENT_REQUEST_TIMEOUT_RETRIES, default 1).

In production google-genai sends async requests over aiohttp, whose total
timeout raises a plain TimeoutError that the SDK's own retry predicate does NOT
cover (it retries APIError status codes and httpx errors only) — hence the
model-level retry in TimeoutRetryingGemini rather than relying on the SDK.

Also: the AGENT_RETRY_* ConfigMap knobs were never read (the retry options
were hardcoded); they are wired through Config now, with code defaults equal
to the old hardcoded values.
"""
import asyncio

import pytest
from google.adk.models.google_llm import Gemini

import src.config as config_mod
from src import agent
from src.agent import TimeoutRetryingGemini, _build_generate_content_config, _build_model


@pytest.fixture(autouse=True)
def base_env(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("SANDBOX_BASE_IMAGE", "test:latest")
    for k in ("AGENT_REQUEST_TIMEOUT_SECONDS", "AGENT_REQUEST_TIMEOUT_RETRIES",
              "AGENT_RETRY_ATTEMPTS", "AGENT_RETRY_INITIAL_DELAY", "AGENT_RETRY_MAX_DELAY",
              "AGENT_RETRY_EXP_BASE", "AGENT_RETRY_JITTER", "AGENT_RETRY_STATUS_CODES"):
        monkeypatch.delenv(k, raising=False)


# ---------- config ----------

def test_defaults():
    cfg = config_mod.load()
    assert cfg.agent_request_timeout_seconds == 300.0
    assert cfg.agent_request_timeout_retries == 1
    # Code defaults equal the previously hardcoded retry options.
    assert cfg.agent_retry_attempts == 4
    assert cfg.agent_retry_initial_delay == 0.5
    assert cfg.agent_retry_max_delay == 8.0
    assert cfg.agent_retry_exp_base == 2.0
    assert cfg.agent_retry_jitter == 0.3
    assert cfg.agent_retry_status_codes == (429, 500, 502, 503, 504)


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("AGENT_REQUEST_TIMEOUT_SECONDS", "120")
    monkeypatch.setenv("AGENT_REQUEST_TIMEOUT_RETRIES", "2")
    monkeypatch.setenv("AGENT_RETRY_ATTEMPTS", "5")
    monkeypatch.setenv("AGENT_RETRY_INITIAL_DELAY", "0.5")
    monkeypatch.setenv("AGENT_RETRY_MAX_DELAY", "15")
    monkeypatch.setenv("AGENT_RETRY_EXP_BASE", "2")
    monkeypatch.setenv("AGENT_RETRY_JITTER", "1.0")
    monkeypatch.setenv("AGENT_RETRY_STATUS_CODES", "429, 500,503")
    cfg = config_mod.load()
    assert cfg.agent_request_timeout_seconds == 120.0
    assert cfg.agent_request_timeout_retries == 2
    assert cfg.agent_retry_attempts == 5
    assert cfg.agent_retry_max_delay == 15.0
    assert cfg.agent_retry_jitter == 1.0
    assert cfg.agent_retry_status_codes == (429, 500, 503)


@pytest.mark.parametrize("raw", ["0", "-5", "off", ""])
def test_timeout_disabled_by_zero_negative_or_non_numeric(monkeypatch, raw):
    monkeypatch.setenv("AGENT_REQUEST_TIMEOUT_SECONDS", raw)
    assert config_mod.load().agent_request_timeout_seconds is None


@pytest.mark.parametrize("raw", ["-1", "x"])
def test_bad_timeout_retries_fall_back_to_default(monkeypatch, raw):
    monkeypatch.setenv("AGENT_REQUEST_TIMEOUT_RETRIES", raw)
    assert config_mod.load().agent_request_timeout_retries == 1


def test_bad_status_codes_fall_back_to_default(monkeypatch):
    monkeypatch.setenv("AGENT_RETRY_STATUS_CODES", "nope")
    assert config_mod.load().agent_retry_status_codes == (429, 500, 502, 503, 504)


# ---------- request config / model build ----------

def test_generate_content_config_carries_timeout_in_ms_and_keeps_safety():
    gcc = _build_generate_content_config(request_timeout_seconds=300)
    assert gcc.http_options.timeout == 300_000
    assert len(gcc.safety_settings) == 4


def test_generate_content_config_without_timeout_has_no_http_options():
    gcc = _build_generate_content_config()
    assert gcc.http_options is None


def test_build_model_uses_config_retry_and_timeout_retries(monkeypatch):
    monkeypatch.setenv("AGENT_RETRY_ATTEMPTS", "5")
    monkeypatch.setenv("AGENT_RETRY_MAX_DELAY", "15")
    monkeypatch.setenv("AGENT_REQUEST_TIMEOUT_RETRIES", "2")
    cfg = config_mod.load()
    m = _build_model("gemini-3.8-flash", cfg)
    assert isinstance(m, TimeoutRetryingGemini)
    assert m.timeout_retries == 2
    assert m.retry_options.attempts == 5
    assert m.retry_options.max_delay == 15.0
    assert m.retry_options.http_status_codes == [429, 500, 502, 503, 504]


def test_build_model_without_config_keeps_old_defaults():
    m = _build_model("gemini-3.8-flash")
    assert isinstance(m, TimeoutRetryingGemini)
    assert m.retry_options.attempts == 4
    assert m.retry_options.max_delay == 8.0


# ---------- TimeoutRetryingGemini ----------

def _fake_parent(monkeypatch, script):
    """Replace Gemini.generate_content_async with a scripted async generator.
    Each call pops the next step: an exception class/instance to raise, or a
    list of responses to yield (optionally ending in an exception)."""
    calls = []

    async def fake(self, llm_request, stream=False):
        calls.append(stream)
        step = script.pop(0)
        if isinstance(step, BaseException) or (isinstance(step, type) and issubclass(step, BaseException)):
            raise step
        for item in step:
            if isinstance(item, BaseException):
                raise item
            yield item

    monkeypatch.setattr(Gemini, "generate_content_async", fake)
    return calls


async def _collect(model):
    return [r async for r in model.generate_content_async(object())]


async def test_timeout_before_any_response_is_retried(monkeypatch):
    calls = _fake_parent(monkeypatch, [TimeoutError(), ["answer"]])
    m = TimeoutRetryingGemini(model="gemini-3.8-flash", timeout_retries=1)
    assert await _collect(m) == ["answer"]
    assert len(calls) == 2


async def test_timeout_retries_exhausted_raises(monkeypatch):
    calls = _fake_parent(monkeypatch, [TimeoutError(), TimeoutError()])
    m = TimeoutRetryingGemini(model="gemini-3.8-flash", timeout_retries=1)
    with pytest.raises(TimeoutError):
        await _collect(m)
    assert len(calls) == 2


async def test_zero_timeout_retries_never_retries(monkeypatch):
    calls = _fake_parent(monkeypatch, [TimeoutError(), ["unused"]])
    m = TimeoutRetryingGemini(model="gemini-3.8-flash", timeout_retries=0)
    with pytest.raises(TimeoutError):
        await _collect(m)
    assert len(calls) == 1


async def test_timeout_after_a_response_was_yielded_is_not_retried(monkeypatch):
    # A partial stream already reached the caller; replaying would duplicate it.
    calls = _fake_parent(monkeypatch, [["partial", TimeoutError()], ["unused"]])
    m = TimeoutRetryingGemini(model="gemini-3.8-flash", timeout_retries=1)
    got = []
    with pytest.raises(TimeoutError):
        async for r in m.generate_content_async(object()):
            got.append(r)
    assert got == ["partial"]
    assert len(calls) == 1


async def test_cancellation_is_never_retried(monkeypatch):
    # The sidecar's 540s turn timeout cancels the turn; that must propagate.
    calls = _fake_parent(monkeypatch, [asyncio.CancelledError(), ["unused"]])
    m = TimeoutRetryingGemini(model="gemini-3.8-flash", timeout_retries=1)
    with pytest.raises(asyncio.CancelledError):
        await _collect(m)
    assert len(calls) == 1


async def test_other_errors_are_not_retried_here(monkeypatch):
    calls = _fake_parent(monkeypatch, [ValueError("bad request"), ["unused"]])
    m = TimeoutRetryingGemini(model="gemini-3.8-flash", timeout_retries=1)
    with pytest.raises(ValueError):
        await _collect(m)
    assert len(calls) == 1


def test_agent_build_passes_request_timeout(monkeypatch):
    """The per-turn Agent gets the configured timeout on its content config."""
    seen = {}
    real = agent._build_generate_content_config

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(agent, "_build_generate_content_config", spy)
    import inspect
    src = inspect.getsource(agent)
    assert "_build_generate_content_config(request_timeout_seconds=self._config.agent_request_timeout_seconds)" in src
    assert "_build_model(self._config.agent_model, self._config)" in src
