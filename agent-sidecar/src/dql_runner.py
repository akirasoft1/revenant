"""Deterministic read-only DQL execution: calls the Dynatrace MCP execute-DQL
tool directly (no ADK agent, no LLM) so /obs dql runs the user's query verbatim.
Establishes the direct-tool seam for future universal-MCP subcommands."""
import contextlib
import json
import logging
from dataclasses import dataclass

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from .config import Config

log = logging.getLogger(__name__)

_EXECUTE_DQL_TOOL = "execute_dql"  # confirm exact name via Task 1 probe


@dataclass
class RunDqlResult:
    rows_json: str
    columns: str
    error: str


@contextlib.asynccontextmanager
async def _open_session(url: str, token: str):
    headers = {"Authorization": f"Bearer {token}"}
    async with streamablehttp_client(url, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def run_dql(config: Config, query: str) -> RunDqlResult:
    if not config.dt_mcp_url or not config.dt_platform_token:
        return RunDqlResult("", "", "observability backend not configured")
    try:
        async with _open_session(config.dt_mcp_url, config.dt_platform_token) as session:
            resp = await session.call_tool(_EXECUTE_DQL_TOOL, {"dql": query})
        text = "".join(getattr(c, "text", "") for c in (resp.content or []))
        parsed = json.loads(text) if text else {}
        if isinstance(parsed, dict):
            records = parsed.get("records", [])
        elif isinstance(parsed, list):
            records = parsed
        else:
            records = []
        columns = list(records[0].keys()) if records and isinstance(records[0], dict) else []
        return RunDqlResult(json.dumps(records), json.dumps(columns), "")
    except Exception as e:  # noqa: BLE001
        log.error("run_dql failed: %s", e)
        return RunDqlResult("", "", f"{type(e).__name__}: {e}")
