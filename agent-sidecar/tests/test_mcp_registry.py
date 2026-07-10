from unittest.mock import patch
from src.config import Config
from src import mcp_registry


def _cfg(**kw):
    base = dict(
        grpc_listen_addr="", agent_model="", openai_api_key=None, openai_model="",
        mongo_uri="", sandbox_inline_output_chars=0, sandbox_wall_clock_seconds=0,
        sandbox_per_user_concurrency=0, sandbox_global_concurrency=0,
        sandbox_memory_limit="", sandbox_cpu_limit="", sandbox_base_image="",
        sandbox_trace_retention_per_user=0, sandbox_agent_turn_call_budget=0,
        k8s_namespace="", otlp_endpoint=None, otlp_headers=None,
        dt_mcp_url=None, dt_platform_token=None,
    )
    base.update(kw)
    return Config(**base)


def test_returns_empty_when_dt_env_missing():
    assert mcp_registry.build_mcp_toolsets("observability", _cfg()) == []


def test_builds_one_toolset_when_configured():
    cfg = _cfg(dt_mcp_url="https://x/mcp", dt_platform_token="tok")
    with patch.object(mcp_registry, "MCPToolset") as MockToolset:
        result = mcp_registry.build_mcp_toolsets("observability", cfg)
    assert len(result) == 1
    MockToolset.assert_called_once()


def test_unknown_profile_returns_empty():
    cfg = _cfg(dt_mcp_url="https://x/mcp", dt_platform_token="tok")
    assert mcp_registry.build_mcp_toolsets("nope", cfg) == []
