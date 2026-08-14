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


def test_load_reads_dynatrace_mcp_env(monkeypatch):
    monkeypatch.setenv("SANDBOX_BASE_IMAGE", "img")
    monkeypatch.setenv("MONGO_URI", "mongodb://x/db")
    monkeypatch.setenv("DT_MCP_URL", "https://qgv89709.apps.dynatrace.com/.../mcp")
    monkeypatch.setenv("DT_PLATFORM_TOKEN", "dt0s16.ABC")
    cfg = config_mod.load()
    assert cfg.dt_mcp_url == "https://qgv89709.apps.dynatrace.com/.../mcp"
    assert cfg.dt_platform_token == "dt0s16.ABC"


def test_load_dynatrace_env_optional(monkeypatch):
    monkeypatch.setenv("SANDBOX_BASE_IMAGE", "img")
    monkeypatch.setenv("MONGO_URI", "mongodb://x/db")
    monkeypatch.delenv("DT_MCP_URL", raising=False)
    monkeypatch.delenv("DT_PLATFORM_TOKEN", raising=False)
    cfg = config_mod.load()
    assert cfg.dt_mcp_url is None
    assert cfg.dt_platform_token is None


def test_agent_health_breaker_defaults(monkeypatch):
    monkeypatch.setenv("MONGO_URI", "mongodb://x")
    monkeypatch.delenv("AGENT_HEALTH_FAILURE_THRESHOLD", raising=False)
    monkeypatch.delenv("AGENT_HEALTH_COOLDOWN_SECONDS", raising=False)
    cfg = config_mod.load()
    assert cfg.agent_health_failure_threshold == 3
    assert cfg.agent_health_cooldown_seconds == 60.0


def test_agent_health_breaker_env_overrides(monkeypatch):
    monkeypatch.setenv("MONGO_URI", "mongodb://x")
    monkeypatch.setenv("AGENT_HEALTH_FAILURE_THRESHOLD", "5")
    monkeypatch.setenv("AGENT_HEALTH_COOLDOWN_SECONDS", "12.5")
    cfg = config_mod.load()
    assert cfg.agent_health_failure_threshold == 5
    assert cfg.agent_health_cooldown_seconds == 12.5
