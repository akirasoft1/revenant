"""sc-knowledge (Star Citizen data MCP server) client for Gemini Live function
calling (spec §7).

The server is the single source of truth for the tool surface: `refresh()`
turns its MCP `list_tools` into Gemini `FunctionDeclaration`s, and `call()`
runs one MCP `call_tool` per Live function call, bounded so a slow or dead
sc-knowledge can never leave the Live model waiting on silence -- every path
returns a dict the bridge can hand straight back as a `FunctionResponse`.
"""
import asyncio
import contextlib
import json
import logging

import httpx2
from google.genai import types
from mcp import ClientSession
# mcp 2.x transport: timeouts live on a caller-supplied httpx2.AsyncClient
# (the 1.x `streamablehttp_client(url, timeout=...)` form is gone).
from mcp.client.streamable_http import streamable_http_client

logger = logging.getLogger(__name__)

TOOL_PREFIX = "sc_"

# Short HTTP bounds: a voice turn is waiting on the answer. `call()`'s
# `asyncio.wait_for(timeout_s)` is the real overall bound; these just keep a
# half-open socket from outliving it inside the transport.
_CONNECT_TIMEOUT_S = 3.0
_READ_TIMEOUT_S = 6.0


def _default_session_factory(url: str, **http_kwargs):
    """`http_kwargs` go to httpx2.AsyncClient -- tests pass an ASGI
    `transport=` to drive the real MCP client stack in-process."""
    @contextlib.asynccontextmanager
    async def open_session():
        # streamable_http_client does NOT close a caller-supplied client, so
        # this context manager owns its lifecycle.
        async with httpx2.AsyncClient(
                timeout=httpx2.Timeout(_READ_TIMEOUT_S, connect=_CONNECT_TIMEOUT_S),
                **http_kwargs) as http:
            async with streamable_http_client(url, http_client=http) as streams:
                async with ClientSession(streams[0], streams[1]) as session:
                    await session.initialize()
                    yield session
    return open_session


def _input_schema(tool):
    # mcp 2.x renamed the camelCase attributes to snake_case (`input_schema`,
    # like CallToolResult's `structured_content`/`is_error`); accept the 1.x
    # spelling too so a hand-built/older Tool shape still converts.
    schema = getattr(tool, "input_schema", None)
    if schema is None:
        schema = getattr(tool, "inputSchema", None)
    return schema


def _result_to_dict(res) -> dict:
    """CallToolResult -> the dict handed to the model. FastMCP wraps a
    non-dict return as {"result": ...}; unwrap only that exact shape so a
    real payload that happens to carry a `result` key is left alone."""
    if getattr(res, "is_error", False):
        texts = [getattr(c, "text", "") for c in (getattr(res, "content", None) or [])]
        detail = " ".join(t for t in texts if t) or "tool reported an error"
        return {"error": "tool_failed", "detail": detail}
    data = getattr(res, "structured_content", None)
    if data is None:
        content = getattr(res, "content", None) or []
        text = getattr(content[0], "text", None) if content else None
        if text is None:
            return {"error": "tool_failed", "detail": "tool returned no content"}
        try:
            data = json.loads(text)
        except ValueError:
            return {"result": text}
    if isinstance(data, dict) and set(data) == {"result"}:
        data = data["result"]
    if not isinstance(data, dict):
        # FunctionResponse.response must be an object.
        return {"result": data}
    return data


class ScToolExecutor:
    def __init__(self, url: str, timeout_s: float = 6.0, session_factory=None):
        self._url = url
        self._timeout_s = timeout_s
        # A zero-arg callable returning an async context manager that yields an
        # INITIALISED MCP ClientSession. Tests inject a fake.
        self._session_factory = session_factory or _default_session_factory(url)
        self.declarations: list[types.FunctionDeclaration] = []

    async def refresh(self) -> bool:
        """Re-read the tool list. On failure keep the previous declarations
        (a flaky sc-knowledge must not strip tools from new sessions)."""
        try:
            async def _list():
                async with self._session_factory() as session:
                    return await session.list_tools()
            listed = await asyncio.wait_for(_list(), self._timeout_s)
            decls = [
                types.FunctionDeclaration(
                    name=t.name,
                    description=t.description or "",
                    parameters_json_schema=_input_schema(t),
                )
                for t in listed.tools
                if (t.name or "").startswith(TOOL_PREFIX)
            ]
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "sc_knowledge: list_tools failed against %s (%s: %s); keeping %d previous declaration(s)",
                self._url, type(e).__name__, e, len(self.declarations))
            return False
        self.declarations = decls
        logger.info("sc_knowledge: %d tool declaration(s) loaded: %s",
                    len(decls), ", ".join(d.name for d in decls))
        return True

    async def call(self, name: str, args: dict) -> dict:
        """One MCP call_tool, bounded by timeout_s. Never raises (except
        CancelledError): errors come back as {"error": code, "detail": ...}."""
        try:
            async def _call():
                async with self._session_factory() as session:
                    return await session.call_tool(name, args)
            res = await asyncio.wait_for(_call(), self._timeout_s)
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            return {"error": "timeout",
                    "detail": f"no answer from Star Citizen data within {self._timeout_s:g}s"}
        except Exception as e:  # noqa: BLE001
            return {"error": "tool_failed", "detail": f"{type(e).__name__}: {e}"}
        try:
            return _result_to_dict(res)
        except Exception as e:  # noqa: BLE001
            return {"error": "tool_failed", "detail": f"unreadable tool result: {type(e).__name__}: {e}"}
