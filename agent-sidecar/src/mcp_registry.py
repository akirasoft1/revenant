"""Reusable MCP toolset registry.

Maps a named "profile" to a set of remote MCP servers and turns each into an
ADK MCPToolset. v1 has one profile ("observability" -> Dynatrace). Adding
another MCP server later is a dict entry here, not new plumbing elsewhere.
"""
import logging

from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

from .config import Config

log = logging.getLogger(__name__)

# profile -> list of servers. Each server names the Config attrs holding its
# URL and bearer token so credentials never live in this file.
_PROFILES = {
    "observability": [
        {"name": "dynatrace", "url_attr": "dt_mcp_url", "token_attr": "dt_platform_token"},
    ],
}


def build_mcp_toolsets(profile: str, config: Config) -> list:
    servers = _PROFILES.get(profile, [])
    toolsets = []
    for server in servers:
        url = getattr(config, server["url_attr"], None)
        token = getattr(config, server["token_attr"], None)
        if not url or not token:
            log.warning(
                "MCP server %r in profile %r skipped: missing url/token config",
                server["name"], profile,
            )
            continue
        toolsets.append(
            MCPToolset(
                connection_params=StreamableHTTPConnectionParams(
                    url=url,
                    headers={"Authorization": f"Bearer {token}"},
                ),
            )
        )
    return toolsets
