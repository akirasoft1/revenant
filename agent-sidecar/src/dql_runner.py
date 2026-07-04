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

# Confirmed via live MCP probe (Task 1): the Dynatrace MCP execute-DQL tool is
# named "execute-dql" (hyphen) and takes a "dqlQueryString" argument. Its result
# is delivered as MCP structuredContent ({"records": [...], "metadata": {...}})
# plus three human-readable text parts — the whole concatenated text is NOT a
# single JSON document, so we read records from structuredContent (with a text
# fallback), never json.loads() over the full text.
_EXECUTE_DQL_TOOL = "execute-dql"
_DQL_ARG = "dqlQueryString"
_RECORDS_TEXT_MARKER = "Query result records:"


@dataclass
class RunDqlResult:
    rows_json: str
    columns: str
    error: str


def _join_text(content) -> str:
    return "".join(getattr(c, "text", "") or "" for c in (content or []))


def _extract_records(resp) -> list:
    """Pull the record list from an execute-dql tool result.

    Primary source is MCP structuredContent (a dict with a "records" list).
    Fallback parses the "Query result records:" text part in case a response
    arrives without structuredContent."""
    structured = getattr(resp, "structuredContent", None)
    if isinstance(structured, dict) and isinstance(structured.get("records"), list):
        return structured["records"]
    for c in (resp.content or []):
        text = getattr(c, "text", "") or ""
        if _RECORDS_TEXT_MARKER in text:
            payload = text.split(_RECORDS_TEXT_MARKER, 1)[1].strip()
            try:
                parsed = json.loads(payload)
            except (ValueError, TypeError):
                return []
            return parsed if isinstance(parsed, list) else []
    return []


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
            resp = await session.call_tool(_EXECUTE_DQL_TOOL, {_DQL_ARG: query})
        if getattr(resp, "isError", False):
            msg = _join_text(resp.content) or "execute-dql returned an error"
            return RunDqlResult("", "", msg[:500])
        records = _extract_records(resp)
        columns = list(records[0].keys()) if records and isinstance(records[0], dict) else []
        return RunDqlResult(json.dumps(records), json.dumps(columns), "")
    except Exception as e:  # noqa: BLE001
        log.error("run_dql failed: %s", e)
        return RunDqlResult("", "", f"{type(e).__name__}: {e}")
