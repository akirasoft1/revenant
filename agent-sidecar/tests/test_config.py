"""Tests for config-loading behavior, especially MONGO_URI substitution."""
import os
from unittest import mock

import pytest

import src.config as config_mod


@pytest.fixture(autouse=True)
def base_env(monkeypatch):
    # Minimum env to make load() succeed.
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("SANDBOX_BASE_IMAGE", "test:latest")


def test_resolve_mongo_uri_substitutes_password(monkeypatch):
    monkeypatch.setenv(
        "MONGO_URI",
        "mongodb://admin:${MONGO_PASSWORD}@mongodb:27017/discord-bot?authSource=admin",
    )
    monkeypatch.setenv("MONGO_PASSWORD", "s3cret-p4ssw0rd")
    cfg = config_mod.load()
    assert cfg.mongo_uri == "mongodb://admin:s3cret-p4ssw0rd@mongodb:27017/discord-bot?authSource=admin"


def test_resolve_mongo_uri_passes_through_when_no_placeholder(monkeypatch):
    monkeypatch.setenv("MONGO_URI", "mongodb://admin:literal-pw@mongodb:27017/discord-bot")
    monkeypatch.delenv("MONGO_PASSWORD", raising=False)
    cfg = config_mod.load()
    assert cfg.mongo_uri == "mongodb://admin:literal-pw@mongodb:27017/discord-bot"


def test_resolve_mongo_uri_leaves_placeholder_when_no_password_env(monkeypatch):
    # Defensive: if MONGO_PASSWORD isn't set, don't accidentally collapse the
    # placeholder to an empty string.
    monkeypatch.setenv("MONGO_URI", "mongodb://admin:${MONGO_PASSWORD}@mongodb/db")
    monkeypatch.delenv("MONGO_PASSWORD", raising=False)
    cfg = config_mod.load()
    assert "${MONGO_PASSWORD}" in cfg.mongo_uri


def test_agent_model_defaults_to_gemini_3_flash_preview(monkeypatch):
    monkeypatch.setenv("MONGO_URI", "mongodb://x")
    monkeypatch.delenv("AGENT_MODEL", raising=False)
    cfg = config_mod.load()
    assert cfg.agent_model == "gemini-3-flash-preview"


def test_retry_defaults(monkeypatch):
    monkeypatch.setenv("MONGO_URI", "mongodb://admin:pw@mongodb/db")
    cfg = config_mod.load()
    assert cfg.agent_retry_attempts == 5
    assert cfg.agent_retry_initial_delay == 0.5
    assert cfg.agent_retry_max_delay == 15.0
    assert cfg.agent_retry_exp_base == 2.0
    assert cfg.agent_retry_status_codes == [429, 500, 502, 503, 504]


def test_retry_env_overrides(monkeypatch):
    monkeypatch.setenv("MONGO_URI", "mongodb://admin:pw@mongodb/db")
    monkeypatch.setenv("AGENT_RETRY_ATTEMPTS", "9")
    monkeypatch.setenv("AGENT_RETRY_MAX_DELAY", "42.5")
    monkeypatch.setenv("AGENT_RETRY_STATUS_CODES", "503, 429")
    cfg = config_mod.load()
    assert cfg.agent_retry_attempts == 9
    assert cfg.agent_retry_max_delay == 42.5
    assert cfg.agent_retry_status_codes == [503, 429]


def test_max_llm_calls_default(monkeypatch):
    monkeypatch.setenv("MONGO_URI", "mongodb://admin:pw@mongodb/db")
    cfg = config_mod.load()
    assert cfg.agent_max_llm_calls == 15


def test_max_llm_calls_override(monkeypatch):
    monkeypatch.setenv("MONGO_URI", "mongodb://admin:pw@mongodb/db")
    monkeypatch.setenv("AGENT_MAX_LLM_CALLS", "30")
    cfg = config_mod.load()
    assert cfg.agent_max_llm_calls == 30


def test_agent_model_overridable(monkeypatch):
    monkeypatch.setenv("MONGO_URI", "mongodb://x")
    monkeypatch.setenv("AGENT_MODEL", "openai/gpt-5.1")
    cfg = config_mod.load()
    assert cfg.agent_model == "openai/gpt-5.1"


def test_openai_api_key_now_optional(monkeypatch):
    # Pre-Gemini, OPENAI_API_KEY was required. We're on Gemini by default
    # now, so config.load() must not crash if it's missing.
    monkeypatch.setenv("MONGO_URI", "mongodb://x")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    cfg = config_mod.load()
    assert cfg.openai_api_key is None
