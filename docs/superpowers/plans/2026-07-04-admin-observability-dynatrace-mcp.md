# Admin Observability via Dynatrace MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Discord admins an `/obs` command that answers observability questions about the bot's own telemetry through the Dynatrace remote MCP server, driven by an isolated agent path in the Gemini sidecar.

**Architecture:** A new, isolated path in the Python agent sidecar — `Observe` (NL) and `RunDql` (deterministic) gRPC RPCs backed by an `ObservabilityAgent` that binds the Dynatrace MCP toolset and has *no* code sandbox. The Node bot reaches it via new `AgentClient` methods and an `adminOnly` `/obs` slash command. Channel-voice chat is untouched. MCP wiring lives in a reusable `mcp_registry` seam.

**Tech Stack:** Python `google-adk` 1.31.1 (`MCPToolset`), the `mcp` client package, grpcio; Node `@grpc/grpc-js`, `discord.js`; Dynatrace remote MCP (platform-token bearer auth); Kubernetes manifests.

## Global Constraints

- Dynatrace access is **read-only**: token scopes limited to `mcp-gateway:servers:invoke`, `mcp-gateway:servers:read`, `storage:*:read`, `davis-copilot:nl2dql:execute`, `davis-copilot:dql2nl:execute`. No write/automation/settings scopes.
- Remote MCP URL: `https://qgv89709.apps.dynatrace.com/platform-reserved/mcp-gateway/v0.1/servers/dynatrace-mcp/mcp`. Auth header: `Authorization: Bearer <DT_PLATFORM_TOKEN>`. OAuth client is NOT supported for the remote MCP.
- Admin gating is enforced at the Discord layer via the existing `BOT_ADMIN_USER_IDS` allowlist (`config.discord.adminUserIds`). No per-user Dynatrace auth.
- The observability agent MUST NOT include the `run_in_sandbox` tool.
- The `Chat` RPC / channel-voice path (`ChatService.chat`, `ChannelVoiceAgent`) MUST NOT be modified.
- The `.proto` exists in TWO locations that must stay identical: `agent-sidecar/proto/agent.proto` and `revenant/proto/agent.proto`. Regenerate `_pb2` stubs after any change.
- Image tags pinned to git short-SHA (no `:latest`). Deploy to namespace `discord-article-bot`, sidecar container/deployment `discord-article-bot-agent`. Deployed overlay `k8s/overlays/deployed/` is gitignored (real secrets).
- Follow TDD. Commit after each green step. Do NOT deploy until the user authorizes.

---

### Task 1: MCP connectivity spike — confirm transport and discover tool names

This resolves the spec's open validation items before any code is built on assumptions. It is a throwaway script; nothing here ships.

**Prerequisite (user action):** mint a Dynatrace **platform token** in tenant `qgv89709` with the Global-Constraints scopes, long expiry. Export it locally as `DT_PLATFORM_TOKEN` for this task only.

**Files:**
- Create (throwaway): `/tmp/mcp_probe.py`

**Interfaces:**
- Produces (recorded in the task's commit message / notes, consumed by Tasks 4–6): the working transport class (`StreamableHTTPConnectionParams` vs `SseConnectionParams`) and the **exact tool names** for "execute DQL" and "generate DQL from natural language".

- [ ] **Step 1: Write the probe script**

```python
# /tmp/mcp_probe.py — throwaway. Lists tools exposed by the Dynatrace remote MCP.
import asyncio, os
from mcp.client.streamable_http import streamablehttp_client
from mcp import ClientSession

URL = "https://qgv89709.apps.dynatrace.com/platform-reserved/mcp-gateway/v0.1/servers/dynatrace-mcp/mcp"
HEADERS = {"Authorization": f"Bearer {os.environ['DT_PLATFORM_TOKEN']}"}

async def main():
    async with streamablehttp_client(URL, headers=HEADERS) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            for t in tools.tools:
                print(t.name, "::", (t.description or "")[:80])

asyncio.run(main())
```

- [ ] **Step 2: Run it**

Run: `python /tmp/mcp_probe.py`
Expected: a list of tool names printed. If `streamable_http` fails to connect, retry with `from mcp.client.sse import sse_client` (SSE transport). Record which transport worked.

- [ ] **Step 3: Record findings**

Note in the plan file (edit Task 4/6 below if names differ from assumptions): the working transport, the exact execute-DQL tool name (assumed `execute_dql`), and the NL→DQL tool name (assumed `generate_dql`). No commit (throwaway file).

---

### Task 2: Add Observe and RunDql RPCs to the proto and regenerate stubs

**Files:**
- Modify: `agent-sidecar/proto/agent.proto`
- Modify: `revenant/proto/agent.proto`
- Regenerate: `agent-sidecar/src/agent_pb2.py`, `agent-sidecar/src/agent_pb2_grpc.py`

**Interfaces:**
- Produces: `ObserveRequest{user_id, user_tag, question}`, `ObserveResponse{answer_text, dql_used, error}`, `RunDqlRequest{user_id, query}`, `RunDqlResponse{rows_json, columns, error}`, and `Agent.Observe` / `Agent.RunDql` RPCs. Consumed by Tasks 7, 8.

- [ ] **Step 1: Add the RPCs and messages to BOTH proto files**

Append to the `service Agent { ... }` block (both files):

```proto
service Agent {
  rpc Chat(ChatRequest) returns (ChatResponse);
  rpc Health(HealthRequest) returns (HealthResponse);
  rpc Observe(ObserveRequest) returns (ObserveResponse);
  rpc RunDql(RunDqlRequest) returns (RunDqlResponse);
}
```

Add these messages (both files):

```proto
message ObserveRequest {
  string user_id  = 1;
  string user_tag = 2;
  string question = 3;
}
message ObserveResponse {
  string answer_text = 1;
  string dql_used    = 2;
  string error       = 3;
}
message RunDqlRequest {
  string user_id = 1;
  string query   = 2;
}
message RunDqlResponse {
  string rows_json = 1;  // JSON array of row objects
  string columns   = 2;  // JSON array of column names
  string error     = 3;
}
```

- [ ] **Step 2: Regenerate the Python stubs**

Run: `cd agent-sidecar && make proto` (or, if no such target, `python -m grpc_tools.protoc -I proto --python_out=src --grpc_python_out=src proto/agent.proto` — check the Makefile first).
Expected: `agent_pb2.py` / `agent_pb2_grpc.py` updated with `Observe`, `RunDql`, and the new message classes.

- [ ] **Step 3: Verify the two proto files are identical**

Run: `diff agent-sidecar/proto/agent.proto proto/agent.proto`
Expected: no output (identical).

- [ ] **Step 4: Run existing sidecar tests to confirm nothing broke**

Run: `cd agent-sidecar && python -m pytest -q`
Expected: existing tests still PASS (stubs are backward-compatible).

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/proto/agent.proto proto/agent.proto agent-sidecar/src/agent_pb2.py agent-sidecar/src/agent_pb2_grpc.py
git commit -m "feat(sidecar): add Observe and RunDql RPCs to agent proto"
```

---

### Task 3: Add Dynatrace MCP config to the sidecar

**Files:**
- Modify: `agent-sidecar/src/config.py`
- Test: `agent-sidecar/tests/test_config.py` (create if absent)

**Interfaces:**
- Produces: `Config.dt_mcp_url: str | None`, `Config.dt_platform_token: str | None`. Consumed by Tasks 4, 7.

- [ ] **Step 1: Write the failing test**

```python
# agent-sidecar/tests/test_config.py
import os
from src.config import load

def test_load_reads_dynatrace_mcp_env(monkeypatch):
    monkeypatch.setenv("SANDBOX_BASE_IMAGE", "img")
    monkeypatch.setenv("MONGO_URI", "mongodb://x/db")
    monkeypatch.setenv("DT_MCP_URL", "https://qgv89709.apps.dynatrace.com/.../mcp")
    monkeypatch.setenv("DT_PLATFORM_TOKEN", "dt0s16.ABC")
    cfg = load()
    assert cfg.dt_mcp_url == "https://qgv89709.apps.dynatrace.com/.../mcp"
    assert cfg.dt_platform_token == "dt0s16.ABC"

def test_load_dynatrace_env_optional(monkeypatch):
    monkeypatch.setenv("SANDBOX_BASE_IMAGE", "img")
    monkeypatch.setenv("MONGO_URI", "mongodb://x/db")
    monkeypatch.delenv("DT_MCP_URL", raising=False)
    monkeypatch.delenv("DT_PLATFORM_TOKEN", raising=False)
    cfg = load()
    assert cfg.dt_mcp_url is None
    assert cfg.dt_platform_token is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-sidecar && python -m pytest tests/test_config.py -q`
Expected: FAIL with `AttributeError: ... 'Config' object has no attribute 'dt_mcp_url'`.

- [ ] **Step 3: Add the fields**

In `config.py`, add to the `Config` dataclass (after the OTel block):

```python
    # Dynatrace remote MCP (observability admin path). Both optional: absent =
    # /obs reports "observability backend unavailable" instead of crashing.
    dt_mcp_url: str | None
    dt_platform_token: str | None
```

In `load()`, add to the `Config(...)` call:

```python
        dt_mcp_url=os.environ.get("DT_MCP_URL"),
        dt_platform_token=os.environ.get("DT_PLATFORM_TOKEN"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-sidecar && python -m pytest tests/test_config.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/config.py agent-sidecar/tests/test_config.py
git commit -m "feat(sidecar): load DT_MCP_URL and DT_PLATFORM_TOKEN config"
```

---

### Task 4: Reusable MCP toolset registry

**Files:**
- Create: `agent-sidecar/src/mcp_registry.py`
- Test: `agent-sidecar/tests/test_mcp_registry.py`

**Interfaces:**
- Consumes: `Config.dt_mcp_url`, `Config.dt_platform_token` (Task 3).
- Produces: `build_mcp_toolsets(profile: str, config: Config) -> list`. Returns a list of `MCPToolset` instances for the profile (empty list if the profile's required env is missing). Consumed by Task 5.

> If Task 1 found SSE transport instead of streamable-HTTP, swap `StreamableHTTPConnectionParams` for `SseConnectionParams` below.

- [ ] **Step 1: Write the failing test**

```python
# agent-sidecar/tests/test_mcp_registry.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-sidecar && python -m pytest tests/test_mcp_registry.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.mcp_registry'`.

- [ ] **Step 3: Write the registry**

```python
# agent-sidecar/src/mcp_registry.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-sidecar && python -m pytest tests/test_mcp_registry.py -q`
Expected: PASS. (If import of the ADK MCP classes fails, correct the import path per the installed `google-adk` — verify with `python -c "from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset"`.)

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/mcp_registry.py agent-sidecar/tests/test_mcp_registry.py
git commit -m "feat(sidecar): reusable MCP toolset registry"
```

---

### Task 5: ObservabilityAgent (NL path)

**Files:**
- Create: `agent-sidecar/src/observability_agent.py`
- Test: `agent-sidecar/tests/test_observability_agent.py`

**Interfaces:**
- Consumes: `Config` (Task 3), `build_mcp_toolsets` (Task 4), `_build_model` / `_build_generate_content_config` (existing, imported from `.agent`).
- Produces: `ObservabilityAgent(config).observe(user_id, question) -> ObserveResult(answer_text: str, dql_used: str, error: str)`. Consumed by Task 7.

- [ ] **Step 1: Write the failing test**

```python
# agent-sidecar/tests/test_observability_agent.py
import asyncio
from unittest.mock import patch, MagicMock
from src.observability_agent import ObservabilityAgent, ObserveResult
from tests.test_mcp_registry import _cfg  # reuse the Config factory

def test_observe_returns_error_when_no_toolsets():
    agent = ObservabilityAgent(_cfg())  # no DT env -> no toolsets
    result = asyncio.run(agent.observe(user_id="u1", question="how many errors?"))
    assert isinstance(result, ObserveResult)
    assert result.error != ""
    assert result.answer_text == ""

def test_observe_builds_agent_with_mcp_tools_and_no_sandbox():
    cfg = _cfg(dt_mcp_url="https://x/mcp", dt_platform_token="tok", agent_model="gemini-3-flash-preview")
    fake_toolset = MagicMock()
    with patch("src.observability_agent.build_mcp_toolsets", return_value=[fake_toolset]), \
         patch("src.observability_agent.Agent") as MockAgent, \
         patch("src.observability_agent.InMemoryRunner") as MockRunner:
        runner = MockRunner.return_value
        runner.session_service.create_session = _async_return(None)
        runner.run_async = _fake_run_async("3 errors in the last hour")
        runner.close = _async_return(None)
        result = asyncio.run(ObservabilityAgent(cfg).observe(user_id="u1", question="errors?"))
    # sandbox tool must never be present
    _, kwargs = MockAgent.call_args
    assert kwargs["tools"] == [fake_toolset]
    assert result.answer_text == "3 errors in the last hour"
    assert result.error == ""

# --- async test helpers ---
def _async_return(value):
    async def _f(*a, **k):
        return value
    return _f

def _fake_run_async(final_text):
    async def _gen(*a, **k):
        class _Part:  # minimal event.content.parts[i].text shape
            text = final_text
        class _Content:
            parts = [_Part()]
        class _Event:
            content = _Content()
        yield _Event()
    return _gen
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-sidecar && python -m pytest tests/test_observability_agent.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.observability_agent'`.

- [ ] **Step 3: Write the ObservabilityAgent**

```python
# agent-sidecar/src/observability_agent.py
"""Isolated observability agent: answers read-only Dynatrace questions via the
Dynatrace MCP toolset. Deliberately has NO run_in_sandbox tool. Separate from
ChannelVoiceAgent so channel-voice is never affected."""
import logging
from dataclasses import dataclass

from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from google.genai import types

from .agent import _build_model, _build_generate_content_config, _summarize_llm_error
from .config import Config
from .mcp_registry import build_mcp_toolsets

log = logging.getLogger(__name__)

_APP_NAME = "discord-article-bot-obs"

_OBS_INSTRUCTION = """
You answer read-only observability questions about a Discord bot deployed on
Kubernetes. The relevant services are `discord-article-bot` (the Node bot) and
`discord-article-bot-agent` (this Python sidecar), in namespace
`discord-article-bot`. Use the Dynatrace tools to generate and execute DQL,
inspect problems, logs, spans, and metrics. Prefer recent timeframes unless the
user specifies otherwise. This is READ-ONLY: never attempt writes, config
changes, or automation. Summarize findings concisely for a Discord message
(plain text, no personality header). If a tool errors, say so plainly.
""".strip()


@dataclass
class ObserveResult:
    answer_text: str
    dql_used: str
    error: str


class ObservabilityAgent:
    def __init__(self, config: Config) -> None:
        self._config = config

    async def observe(self, *, user_id: str, question: str) -> ObserveResult:
        toolsets = build_mcp_toolsets("observability", self._config)
        if not toolsets:
            return ObserveResult("", "", "observability backend not configured")

        agent = Agent(
            name="observability",
            description="Read-only Dynatrace observability agent.",
            instruction=_OBS_INSTRUCTION,
            tools=toolsets,
            model=_build_model(self._config.agent_model),
            generate_content_config=_build_generate_content_config(),
        )
        runner = InMemoryRunner(agent=agent, app_name=_APP_NAME)
        await runner.session_service.create_session(
            app_name=_APP_NAME, user_id=user_id, session_id=user_id,
        )
        new_message = types.Content(role="user", parts=[types.Part(text=question)])
        message_text = ""
        try:
            async for event in runner.run_async(
                user_id=user_id, session_id=user_id, new_message=new_message,
            ):
                content = getattr(event, "content", None)
                if content is None:
                    continue
                for part in (getattr(content, "parts", None) or []):
                    text = getattr(part, "text", None)
                    if text:
                        message_text = text
        except Exception as e:  # noqa: BLE001
            summary = _summarize_llm_error(e, self._config.agent_model)
            log.error("Observe LLM call failed: %s", summary)
            return ObserveResult("", "", summary)
        finally:
            try:
                await runner.close()
            except Exception:  # noqa: BLE001
                log.debug("runner.close() failed", exc_info=True)

        return ObserveResult(message_text, "", "")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-sidecar && python -m pytest tests/test_observability_agent.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/observability_agent.py agent-sidecar/tests/test_observability_agent.py
git commit -m "feat(sidecar): ObservabilityAgent NL path over Dynatrace MCP"
```

---

### Task 6: RunDql — deterministic direct execute-DQL (no LLM)

**Files:**
- Create: `agent-sidecar/src/dql_runner.py`
- Test: `agent-sidecar/tests/test_dql_runner.py`

**Interfaces:**
- Consumes: `Config.dt_mcp_url`, `Config.dt_platform_token`.
- Produces: `async run_dql(config, query) -> RunDqlResult(rows_json: str, columns: str, error: str)`. Calls the MCP execute-DQL tool by name via a raw `mcp` client session (no ADK, no LLM). Consumed by Task 7.

> Replace `_EXECUTE_DQL_TOOL = "execute_dql"` with the exact name recorded in Task 1 if different.

- [ ] **Step 1: Write the failing test**

```python
# agent-sidecar/tests/test_dql_runner.py
import asyncio, json
from unittest.mock import patch, AsyncMock, MagicMock
from src.dql_runner import run_dql, RunDqlResult
from tests.test_mcp_registry import _cfg

def test_error_when_not_configured():
    result = asyncio.run(run_dql(_cfg(), "fetch spans | limit 1"))
    assert result.error != ""

def test_calls_execute_dql_tool_verbatim():
    cfg = _cfg(dt_mcp_url="https://x/mcp", dt_platform_token="tok")
    tool_result = MagicMock()
    tool_result.content = [MagicMock(text=json.dumps({"records": [{"c": 1}]}))]
    fake_session = AsyncMock()
    fake_session.call_tool.return_value = tool_result
    with patch("src.dql_runner._open_session") as open_session:
        open_session.return_value.__aenter__.return_value = fake_session
        result = asyncio.run(run_dql(cfg, "fetch spans | limit 1"))
    fake_session.call_tool.assert_awaited_once()
    name, args = fake_session.call_tool.call_args.args[0], fake_session.call_tool.call_args.args[1]
    assert "fetch spans | limit 1" in json.dumps(args)
    assert result.error == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-sidecar && python -m pytest tests/test_dql_runner.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.dql_runner'`.

- [ ] **Step 3: Write the runner**

```python
# agent-sidecar/src/dql_runner.py
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
        records = parsed.get("records", parsed if isinstance(parsed, list) else [])
        columns = list(records[0].keys()) if records and isinstance(records[0], dict) else []
        return RunDqlResult(json.dumps(records), json.dumps(columns), "")
    except Exception as e:  # noqa: BLE001
        log.error("run_dql failed: %s", e)
        return RunDqlResult("", "", f"{type(e).__name__}: {e}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-sidecar && python -m pytest tests/test_dql_runner.py -q`
Expected: PASS. (If the execute-DQL tool takes a differently-named arg than `dql`, adjust per Task 1 findings.)

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/dql_runner.py agent-sidecar/tests/test_dql_runner.py
git commit -m "feat(sidecar): deterministic RunDql via Dynatrace MCP execute-DQL tool"
```

---

### Task 7: Wire Observe + RunDql into the gRPC servicer

**Files:**
- Modify: `agent-sidecar/src/server.py`
- Test: `agent-sidecar/tests/test_server_observe.py`

**Interfaces:**
- Consumes: `ObservabilityAgent.observe` (Task 5), `run_dql` (Task 6), the new proto messages (Task 2).
- Produces: `Agent.Observe` and `Agent.RunDql` gRPC handlers. Consumed by Task 8 (Node client).

- [ ] **Step 1: Write the failing test**

```python
# agent-sidecar/tests/test_server_observe.py
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from src import server, agent_pb2
from src.observability_agent import ObserveResult
from src.dql_runner import RunDqlResult

class _Ctx:
    async def abort(self, *a, **k):
        raise AssertionError(f"unexpected abort: {a}")

def test_observe_maps_result():
    obs = MagicMock()
    obs.observe = AsyncMock(return_value=ObserveResult("2 errors", "fetch spans", ""))
    servicer = server.AgentServicer(channel_voice_agent=None, observability_agent=obs, config=MagicMock())
    req = agent_pb2.ObserveRequest(user_id="u1", question="errors?")
    resp = asyncio.run(servicer.Observe(req, _Ctx()))
    assert resp.answer_text == "2 errors"
    assert resp.dql_used == "fetch spans"
    assert resp.error == ""

def test_rundql_maps_result():
    servicer = server.AgentServicer(channel_voice_agent=None, observability_agent=None, config=MagicMock())
    with patch("src.server.run_dql", AsyncMock(return_value=RunDqlResult('[{"c":1}]', '["c"]', ""))):
        req = agent_pb2.RunDqlRequest(user_id="u1", query="fetch spans | limit 1")
        resp = asyncio.run(servicer.RunDql(req, _Ctx()))
    assert resp.rows_json == '[{"c":1}]'
    assert resp.columns == '["c"]'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-sidecar && python -m pytest tests/test_server_observe.py -q`
Expected: FAIL (`AgentServicer.__init__` doesn't accept `observability_agent`/`config`; no `Observe`/`RunDql` methods).

- [ ] **Step 3: Extend the servicer**

In `server.py`, update the imports and `AgentServicer`:

```python
from .dql_runner import run_dql
```

```python
    def __init__(self, channel_voice_agent=None, observability_agent=None, config=None) -> None:
        self._agent = channel_voice_agent
        self._obs_agent = observability_agent
        self._config = config

    async def Observe(self, request, context):  # noqa: N802
        if self._obs_agent is None:
            return agent_pb2.ObserveResponse(error="observability agent not configured")
        try:
            result = await self._obs_agent.observe(
                user_id=request.user_id, question=request.question,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("Observe handler failed")
            return agent_pb2.ObserveResponse(error=str(e))
        return agent_pb2.ObserveResponse(
            answer_text=result.answer_text, dql_used=result.dql_used, error=result.error,
        )

    async def RunDql(self, request, context):  # noqa: N802
        if self._config is None:
            return agent_pb2.RunDqlResponse(error="observability backend not configured")
        try:
            result = await run_dql(self._config, request.query)
        except Exception as e:  # noqa: BLE001
            log.exception("RunDql handler failed")
            return agent_pb2.RunDqlResponse(error=str(e))
        return agent_pb2.RunDqlResponse(
            rows_json=result.rows_json, columns=result.columns, error=result.error,
        )
```

In `serve()`, construct the observability agent and pass the new args (after the existing `agent = ChannelVoiceAgent(...)` block):

```python
    from .observability_agent import ObservabilityAgent
    obs_agent = ObservabilityAgent(config=config)
```

and change the servicer registration line:

```python
        agent_pb2_grpc.add_AgentServicer_to_server(
            AgentServicer(channel_voice_agent=agent, observability_agent=obs_agent, config=config),
            server,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-sidecar && python -m pytest tests/test_server_observe.py -q`
Expected: PASS.

- [ ] **Step 5: Run the full sidecar suite**

Run: `cd agent-sidecar && python -m pytest -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add agent-sidecar/src/server.py agent-sidecar/tests/test_server_observe.py
git commit -m "feat(sidecar): Observe and RunDql gRPC handlers"
```

---

### Task 8: Node AgentClient — adminObserve + runDql

**Files:**
- Modify: `services/AgentClient.js`
- Test: `__tests__/services/AgentClient.test.js` (create if absent)

**Interfaces:**
- Consumes: the `Observe`/`RunDql` RPCs (Task 2 proto, loaded by the existing proto loader).
- Produces: `agentClient.adminObserve({userId, userTag, question}) -> Promise<{answerText, dqlUsed, error}>` and `agentClient.runDql({userId, query}) -> Promise<{rowsJson, columns, error}>`. Consumed by Task 9.

- [ ] **Step 1: Write the failing test**

```javascript
// __tests__/services/AgentClient.test.js
const path = require('path');
const AgentClient = require('../../services/AgentClient');

function makeClient() {
  const client = new AgentClient({
    address: 'localhost:1',
    protoPath: path.join(__dirname, '../../proto/agent.proto'),
  });
  client._lastHealthyAt = Date.now(); // force healthy
  return client;
}

describe('AgentClient.adminObserve', () => {
  it('maps snake_case response to camelCase', async () => {
    const client = makeClient();
    client._stub.Observe = (req, opts, cb) =>
      cb(null, { answer_text: '2 errors', dql_used: 'fetch spans', error: '' });
    const res = await client.adminObserve({ userId: 'u1', userTag: 't#1', question: 'errors?' });
    expect(res).toEqual({ answerText: '2 errors', dqlUsed: 'fetch spans', error: '' });
    client.close();
  });

  it('rejects when unhealthy', async () => {
    const client = makeClient();
    client._lastHealthyAt = 0;
    await expect(client.adminObserve({ userId: 'u1', question: 'x' })).rejects.toThrow('unhealthy');
    client.close();
  });
});

describe('AgentClient.runDql', () => {
  it('maps rows_json/columns', async () => {
    const client = makeClient();
    client._stub.RunDql = (req, opts, cb) =>
      cb(null, { rows_json: '[{"c":1}]', columns: '["c"]', error: '' });
    const res = await client.runDql({ userId: 'u1', query: 'fetch spans | limit 1' });
    expect(res).toEqual({ rowsJson: '[{"c":1}]', columns: '["c"]', error: '' });
    client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns="AgentClient"`
Expected: FAIL (`client.adminObserve is not a function`).

- [ ] **Step 3: Add the methods**

In `AgentClient.js`, after `chat(req)` (before `close()`):

```javascript
  adminObserve(req) {
    return new Promise((resolve, reject) => {
      if (!this.isHealthy()) {
        reject(new Error('sidecar unhealthy'));
        return;
      }
      const deadline = new Date(Date.now() + this.chatDeadlineMs);
      this._stub.Observe(
        { user_id: req.userId, user_tag: req.userTag || '', question: req.question },
        { deadline },
        (err, resp) => {
          if (err) {
            logger.warn(`AgentClient.adminObserve failed: ${err.message}`);
            return reject(err);
          }
          resolve({
            answerText: resp.answer_text || '',
            dqlUsed: resp.dql_used || '',
            error: resp.error || '',
          });
        },
      );
    });
  }

  runDql(req) {
    return new Promise((resolve, reject) => {
      if (!this.isHealthy()) {
        reject(new Error('sidecar unhealthy'));
        return;
      }
      const deadline = new Date(Date.now() + this.chatDeadlineMs);
      this._stub.RunDql(
        { user_id: req.userId, query: req.query },
        { deadline },
        (err, resp) => {
          if (err) {
            logger.warn(`AgentClient.runDql failed: ${err.message}`);
            return reject(err);
          }
          resolve({
            rowsJson: resp.rows_json || '',
            columns: resp.columns || '',
            error: resp.error || '',
          });
        },
      );
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns="AgentClient"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/AgentClient.js __tests__/services/AgentClient.test.js
git commit -m "feat(bot): AgentClient.adminObserve and runDql"
```

---

### Task 9: `/obs` slash command + registration

**Files:**
- Create: `commands/slash/ObserveCommand.js`
- Modify: `commands/slash/index.js`
- Modify: `bot.js` (import + register)
- Test: `__tests__/commands/ObserveCommand.test.js`

**Interfaces:**
- Consumes: `agentClient.adminObserve`, `agentClient.runDql` (Task 8); `BaseSlashCommand` (`adminOnly`, `deferReply`, `sendReply`, `sendLongResponse`, `logExecution`).
- Produces: the `/obs ask` and `/obs dql` command surface.

- [ ] **Step 1: Write the failing test**

```javascript
// __tests__/commands/ObserveCommand.test.js
const ObserveCommand = require('../../commands/slash/ObserveCommand');

function makeInteraction(sub, opts) {
  return {
    options: {
      getSubcommand: () => sub,
      getString: (n) => opts[n],
    },
    user: { id: 'admin1', tag: 'admin#1' },
    deferReply: jest.fn().mockResolvedValue(),
    editReply: jest.fn().mockResolvedValue(),
    replied: false,
    deferred: true,
  };
}

describe('ObserveCommand', () => {
  it('is admin-only', () => {
    const cmd = new ObserveCommand({});
    expect(cmd.adminOnly).toBe(true);
  });

  it('ask subcommand calls adminObserve and replies with the answer', async () => {
    const agentClient = { adminObserve: jest.fn().mockResolvedValue({ answerText: '2 errors', dqlUsed: '', error: '' }) };
    const cmd = new ObserveCommand(agentClient);
    const interaction = makeInteraction('ask', { question: 'errors?' });
    await cmd.execute(interaction, { config: {} });
    expect(agentClient.adminObserve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin1', question: 'errors?' }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('2 errors'));
  });

  it('dql subcommand calls runDql and formats rows', async () => {
    const agentClient = { runDql: jest.fn().mockResolvedValue({ rowsJson: '[{"c":1}]', columns: '["c"]', error: '' }) };
    const cmd = new ObserveCommand(agentClient);
    const interaction = makeInteraction('dql', { query: 'fetch spans | limit 1' });
    await cmd.execute(interaction, { config: {} });
    expect(agentClient.runDql).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'fetch spans | limit 1' }),
    );
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it('surfaces backend error text', async () => {
    const agentClient = { adminObserve: jest.fn().mockResolvedValue({ answerText: '', dqlUsed: '', error: 'backend down' }) };
    const cmd = new ObserveCommand(agentClient);
    const interaction = makeInteraction('ask', { question: 'x' });
    await cmd.execute(interaction, { config: {} });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns="ObserveCommand"`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the command**

```javascript
// commands/slash/ObserveCommand.js
// Admin-only observability command. /obs ask (NL) and /obs dql (raw DQL) query
// Dynatrace via the agent sidecar's Observe/RunDql RPCs. Ephemeral, admin-gated.

const { SlashCommandBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');

const UNAVAILABLE = '⚠️ Observability backend is currently unavailable. Try again shortly.';

class ObserveSlashCommand extends BaseSlashCommand {
  constructor(agentClient) {
    super({
      data: new SlashCommandBuilder()
        .setName('obs')
        .setDescription('Query bot observability (admin only)')
        .addSubcommand(sub =>
          sub.setName('ask')
            .setDescription('Ask a natural-language observability question')
            .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true)))
        .addSubcommand(sub =>
          sub.setName('dql')
            .setDescription('Run a read-only DQL query verbatim')
            .addStringOption(o => o.setName('query').setDescription('DQL to execute').setRequired(true))),
      adminOnly: true,
      deferReply: true,
      ephemeral: true,
      cooldown: 5,
    });
    this.agentClient = agentClient;
  }

  async execute(interaction, context) {
    this.logExecution(interaction);
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'ask') {
        const question = interaction.options.getString('question');
        const res = await this.agentClient.adminObserve({
          userId: interaction.user.id, userTag: interaction.user.tag, question,
        });
        if (res.error) return this.sendLongResponse(interaction, UNAVAILABLE);
        const footer = res.dqlUsed ? `\n\n\`\`\`dql\n${res.dqlUsed}\n\`\`\`` : '';
        return this.sendLongResponse(interaction, `${res.answerText}${footer}`);
      }

      if (sub === 'dql') {
        const query = interaction.options.getString('query');
        const res = await this.agentClient.runDql({ userId: interaction.user.id, query });
        if (res.error) return this.sendLongResponse(interaction, `❌ ${res.error}`);
        const rows = JSON.parse(res.rowsJson || '[]');
        if (rows.length === 0) return this.sendLongResponse(interaction, '(no rows)');
        const formatted = '```json\n' + JSON.stringify(rows, null, 2) + '\n```';
        return this.sendLongResponse(interaction, formatted);
      }
    } catch (err) {
      return this.sendLongResponse(interaction, UNAVAILABLE);
    }
  }
}

module.exports = ObserveSlashCommand;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns="ObserveCommand"`
Expected: PASS. (If `sendLongResponse`'s signature differs, align the calls to `BaseSlashCommand.js:115`.)

- [ ] **Step 5: Register the command**

In `commands/slash/index.js`, add under Utility commands:

```javascript
  ChannelTrackSlashCommand: require('./ChannelTrackCommand'),
  ObserveSlashCommand: require('./ObserveCommand')
```

In `bot.js`, add to the destructure of `require('./commands/slash')` (near line 48-69):

```javascript
  ObserveSlashCommand,
```

and register it where the other admin commands register (near line 458), injecting the existing agent client:

```javascript
    this.slashCommandHandler.register(new ObserveSlashCommand(this.agentClient));
```

- [ ] **Step 6: Run the full bot suite + smoke the registration**

Run: `npx jest`
Expected: all PASS.
Run: `node -e "require('./commands/slash/index.js'); require('./commands/slash/ObserveCommand.js'); console.log('load OK')"`
Expected: `load OK`.

- [ ] **Step 7: Commit**

```bash
git add commands/slash/ObserveCommand.js commands/slash/index.js bot.js __tests__/commands/ObserveCommand.test.js
git commit -m "feat(bot): /obs admin observability slash command"
```

---

### Task 10: Kubernetes manifests — config, secret, network policy

**Files:**
- Modify: `k8s/sandbox/configmap-sandbox.yaml` (add `DT_MCP_URL`)
- Modify: `k8s/base/secret.yaml` (add `DT_PLATFORM_TOKEN` placeholder)
- Modify: `k8s/sandbox/` NetworkPolicy for the sidecar (allow egress to Dynatrace SaaS :443)
- Mirror into `k8s/overlays/deployed/` (gitignored — edit locally, do not commit real token)

**Interfaces:** none (config/manifests). Validated at deploy time (Task 11).

- [ ] **Step 1: Add `DT_MCP_URL` to the ConfigMap**

In `k8s/sandbox/configmap-sandbox.yaml`, add under `data:`:

```yaml
  DT_MCP_URL: "https://qgv89709.apps.dynatrace.com/platform-reserved/mcp-gateway/v0.1/servers/dynatrace-mcp/mcp"
```

- [ ] **Step 2: Add `DT_PLATFORM_TOKEN` to the base Secret (placeholder only in git)**

In `k8s/base/secret.yaml`, add under `stringData:`:

```yaml
  DT_PLATFORM_TOKEN: "REPLACE_ME"
```

The real token goes only into the gitignored `k8s/overlays/deployed/secret.yaml`.

- [ ] **Step 3: Allow sidecar egress to Dynatrace SaaS**

Find the sidecar's NetworkPolicy under `k8s/sandbox/` (the one selecting `discord-article-bot-agent`). Add an egress rule allowing TCP :443 to public internet (Dynatrace SaaS resolves to public IPs; the existing policy blocks RFC1918 but public egress may already be allowed — inspect first). If a DNS/CIDR allow is needed, add:

```yaml
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
      ports:
        - protocol: TCP
          port: 443
```

(Keep the DNS :53 egress rule that already exists.)

- [ ] **Step 4: Verify manifests parse**

Run: `kubectl apply --dry-run=client -f k8s/sandbox/configmap-sandbox.yaml -f k8s/base/secret.yaml`
Expected: `configured (dry run)` with no schema errors.

- [ ] **Step 5: Commit (tracked manifests only — never the real token)**

```bash
git add k8s/sandbox/configmap-sandbox.yaml k8s/base/secret.yaml k8s/sandbox/*networkpolicy*.yaml
git commit -m "feat(k8s): DT_MCP_URL config, DT_PLATFORM_TOKEN secret, sidecar egress"
```

---

### Task 11: Deploy and verify (requires user authorization)

**Files:** none (operational). Do NOT run until the user says deploy.

- [ ] **Step 1: Put the real token in the deployed overlay (gitignored)**

Edit `k8s/overlays/deployed/secret.yaml` → set `DT_PLATFORM_TOKEN` to the real value. Add `DT_MCP_URL` to `k8s/overlays/deployed/configmap-sandbox.yaml`.

- [ ] **Step 2: Build + push both images (git short-SHA tag)**

```bash
SHA=$(git rev-parse --short HEAD)
docker build -t mvilliger/discord-article-bot:$SHA .
docker build -t mvilliger/discord-article-bot-agent:$SHA -f agent-sidecar/Dockerfile agent-sidecar
docker push mvilliger/discord-article-bot:$SHA
docker push mvilliger/discord-article-bot-agent:$SHA
```

- [ ] **Step 3: Apply config/secret, then roll both deployments**

```bash
kubectl apply -f k8s/overlays/deployed/configmap-sandbox.yaml -f k8s/overlays/deployed/secret.yaml -n discord-article-bot
kubectl set image deployment/discord-article-bot-agent agent=mvilliger/discord-article-bot-agent:$SHA -n discord-article-bot
kubectl set image deployment/discord-article-bot bot=mvilliger/discord-article-bot:$SHA -n discord-article-bot
kubectl rollout status deployment/discord-article-bot-agent -n discord-article-bot --timeout=180s
kubectl rollout status deployment/discord-article-bot -n discord-article-bot --timeout=180s
```

- [ ] **Step 4: Live smoke test the direct DQL path**

```bash
kubectl exec -n discord-article-bot deploy/discord-article-bot-agent -- \
  python -c "import asyncio; from src.config import load; from src.dql_runner import run_dql; \
print(asyncio.run(run_dql(load(), 'fetch spans, from:now()-1h | filter service.name==\"discord-article-bot\" | summarize c=count()')))"
```

Expected: `RunDqlResult(rows_json='[{\"c\": ...}]', columns='[\"c\"]', error='')` — proves the token, scopes, network egress, and the execute-DQL tool name all work end to end. If `error` is populated, diagnose (token scopes / NetworkPolicy / tool name) before registering commands in Discord.

- [ ] **Step 5: Register slash commands + verify in Discord**

Run `node scripts/registerCommands.js` (or per project convention), then in Discord run `/obs dql query: fetch spans, from:now()-1h | limit 3` as an admin.
Expected: rows returned; a non-admin gets "requires administrator permissions".

---

## Self-Review

**Spec coverage:** `/obs ask` (Tasks 5, 7, 8, 9) · `/obs dql` deterministic (Tasks 6, 7, 8, 9) · reusable MCP layer (Task 4) · isolated agent, no sandbox (Task 5) · read-only token scopes (Global Constraints, Task 10) · admin gating (Task 9, existing allowlist) · channel-voice untouched (no task modifies `ChatService`/`ChannelVoiceAgent`) · secrets/network (Task 10) · open validation items — transport + tool names (Task 1), NetworkPolicy egress (Task 10 Step 3), Davis Copilot enablement (surfaces at Task 11 Step 4) · testing (every task) · rollout (Task 11). All spec sections mapped.

**Placeholder scan:** No TBD/TODO in shippable steps. `REPLACE_ME` in Task 10 Step 2 is an intentional git placeholder (real token only in the gitignored overlay). `_EXECUTE_DQL_TOOL`/transport are concrete defaults with an explicit Task 1 verification gate.

**Type consistency:** `ObserveResult(answer_text, dql_used, error)` (Task 5) → servicer maps to `ObserveResponse` (Task 7) → `adminObserve` returns `{answerText, dqlUsed, error}` (Task 8) → command reads those (Task 9). `RunDqlResult(rows_json, columns, error)` (Task 6) → `RunDqlResponse` (Task 7) → `{rowsJson, columns, error}` (Task 8) → command (Task 9). `build_mcp_toolsets(profile, config)` signature consistent across Tasks 4, 5. Consistent.
