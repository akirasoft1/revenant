"""Reusable MCP toolset registry.

Maps a named "profile" to a set of remote MCP servers and turns each into an
ADK McpToolset. v1 has one profile ("observability" -> Dynatrace). Adding
another MCP server later is a dict entry here, not new plumbing elsewhere.
"""
import logging

from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

from .config import Config

log = logging.getLogger(__name__)

# profile -> list of servers. Each server names the Config attrs holding its
# URL and bearer token so credentials never live in this file. `token_attr`
# may be None for a server that takes no auth (e.g. sc-knowledge, an
# in-cluster-only server behind the NetworkPolicy rather than a bearer
# token); `enabled_attr`, when set, names a Config bool that gates the
# server entirely regardless of url/token.
#
# `timeout`/`sse_read_timeout` (seconds) are optional per-server overrides
# for StreamableHTTPConnectionParams. ADK's own defaults are timeout=5.0,
# sse_read_timeout=300.0 — a silent socket (accepts the connection, never
# responds) can then block a single tool call for up to 300s (plus any
# internal retry), which would overrun AGENT_CHAT_TIMEOUT_SECONDS (540s
# default) well before the sidecar's own turn bound ever gets a chance to
# fire, surfacing as a DEADLINE_EXCEEDED that trips the Chat circuit
# breaker. sc-knowledge is a same-cluster, low-latency server, so it gets a
# much tighter bound; the "observability" profile is left on ADK's defaults
# (unchanged behavior for Dynatrace).
_PROFILES = {
    "observability": [
        {"name": "dynatrace", "url_attr": "dt_mcp_url", "token_attr": "dt_platform_token"},
    ],
    "channel_voice": [
        {
            "name": "sc-knowledge",
            "url_attr": "sc_knowledge_url",
            "token_attr": None,
            "enabled_attr": "sc_knowledge_enabled",
            "timeout": 3.0,
            "sse_read_timeout": 15.0,
        },
        # Future: SC Trade Tools would be another entry here with its own
        # token_attr.
    ],
}


def build_mcp_toolsets(profile: str, config: Config) -> list:
    servers = _PROFILES.get(profile, [])
    toolsets = []
    for server in servers:
        enabled_attr = server.get("enabled_attr")
        if enabled_attr is not None and not getattr(config, enabled_attr, False):
            log.info(
                "MCP server %r in profile %r skipped: %s is disabled",
                server["name"], profile, enabled_attr,
            )
            continue
        url = getattr(config, server["url_attr"], None)
        token_attr = server.get("token_attr")
        token = getattr(config, token_attr, None) if token_attr is not None else None
        if not url or (token_attr is not None and not token):
            log.warning(
                "MCP server %r in profile %r skipped: missing url/token config",
                server["name"], profile,
            )
            continue
        headers = {"Authorization": f"Bearer {token}"} if token_attr is not None else None
        conn_kwargs = {"url": url, "headers": headers}
        if "timeout" in server:
            conn_kwargs["timeout"] = server["timeout"]
        if "sse_read_timeout" in server:
            conn_kwargs["sse_read_timeout"] = server["sse_read_timeout"]
        toolsets.append(
            McpToolset(
                connection_params=StreamableHTTPConnectionParams(**conn_kwargs),
            )
        )
    return toolsets
