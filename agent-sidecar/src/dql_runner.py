"""Deterministic read-only DQL execution: calls the Dynatrace MCP execute-DQL
tool directly (no ADK agent, no LLM) so /obs dql runs the user's query verbatim.
Establishes the direct-tool seam for future universal-MCP subcommands."""
import contextlib
import json
import logging
from dataclasses import dataclass

import httpx2
from mcp import ClientSession
# mcp 2.x API. 2.0 removed the 1.x `streamablehttp_client(url, headers=...)`:
# headers/timeouts now live on a caller-supplied httpx2.AsyncClient, and the
# transport yields a 2-tuple (read, write) with no get_session_id callback.
# Result attributes are snake_case too (`is_error`, `structured_content`).
# Pinned by tests/test_mcp_v2_compat.py against a real in-process MCP server.
from mcp.client.streamable_http import streamable_http_client

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

    Primary source is MCP structuredContent (a dict with a "records" list),
    which mcp 2.x exposes as the snake_case `structured_content` attribute.
    Fallback parses the "Query result records:" text part in case a response
    arrives without structuredContent."""
    structured = getattr(resp, "structured_content", None)
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


def _make_http_client(token: str, **kwargs) -> httpx2.AsyncClient:
    """The HTTP client carrying the Dynatrace bearer token.

    Timeouts mirror mcp's own `create_mcp_http_client` defaults (30s
    connect/write/pool, 300s read for held-open response streams). Built
    directly rather than via that helper so tests can inject an ASGI
    `transport=` and drive the real MCP client stack in-process."""
    return httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {token}"},
        timeout=httpx2.Timeout(30.0, read=300.0),
        **kwargs,
    )


@contextlib.asynccontextmanager
async def _open_session(url: str, token: str):
    # streamable_http_client does NOT close a caller-supplied client, so this
    # function owns its lifecycle.
    async with _make_http_client(token) as http_client:
        async with streamable_http_client(url, http_client=http_client) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session


async def run_dql(config: Config, query: str) -> RunDqlResult:
    if not config.dt_mcp_url or not config.dt_platform_token:
        return RunDqlResult("", "", "observability backend not configured")
    try:
        async with _open_session(config.dt_mcp_url, config.dt_platform_token) as session:
            resp = await session.call_tool(_EXECUTE_DQL_TOOL, {_DQL_ARG: query})
        if getattr(resp, "is_error", False):
            msg = _join_text(resp.content) or "execute-dql returned an error"
            return RunDqlResult("", "", msg[:500])
        records = _extract_records(resp)
        columns = list(records[0].keys()) if records and isinstance(records[0], dict) else []
        return RunDqlResult(json.dumps(records), json.dumps(columns), "")
    except Exception as e:  # noqa: BLE001
        log.error("run_dql failed: %s", e)
        return RunDqlResult("", "", f"{type(e).__name__}: {e}")
