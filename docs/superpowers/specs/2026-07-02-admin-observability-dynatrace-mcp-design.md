# Admin Observability via Dynatrace MCP — Design

**Date:** 2026-07-02
**Status:** Draft (pending user review)
**Branch:** `feat/admin-observability-mcp`

## Summary

Give Discord bot admins a way to ask observability questions about the bot's own
telemetry and get answers back in Discord. The bot reaches Dynatrace through the
**Dynatrace remote MCP server**, driven by the existing Gemini agent sidecar. A
new, isolated agent path (separate RPC + separate agent, no code sandbox) handles
these queries; the channel-voice chat path is untouched.

The MCP integration is built as a **reusable, config-driven layer** so future
"universal MCP" work (connecting the sidecar to other MCP servers) is a config
addition, not a rewrite. Dynatrace observability is the first consumer.

## Goals

- Admins can run `/obs ask question:"<natural language>"` and get a summarized,
  Dynatrace-backed answer in Discord.
- Admins can run `/obs dql query:"<DQL>"` to execute read-only DQL verbatim and
  get a formatted result — deterministic, no LLM in the loop.
- The Dynatrace path is **read-only** and **admin-gated**.
- The channel-voice chat path and its sandbox agent are **unaffected**.
- The MCP-connection seam is generic enough to add more MCP servers later.

## Non-Goals

- No write/automation/settings operations against Dynatrace (read-only token).
- No per-user Dynatrace auth — a single bot-owned platform token is used
  (server-to-server). Admin identity is enforced at the Discord layer only.
- No dynamic auto-generation of subcommands from the MCP tool catalog (brittle;
  tool names are discovered at connect time and can change).
- Not touching `ChatService.chat` / channel-voice routing.

## Approach (chosen)

Option B from brainstorming: **Dynatrace remote MCP as a tool inside the Gemini
sidecar.** Rejected alternatives: (A) bot-native NL→DQL via Davis Copilot +
direct Grail — simpler but doesn't advance the universal-MCP direction; (C) bot's
own LLM writes raw DQL — higher hallucination risk. The A2A agent in
`dynatrace-for-gemini-enterprise` was ruled out earlier: it only accepts a
per-user Dynatrace SSO auth-code bearer token (no service-account path), so a
headless bot cannot use it without driving interactive OAuth per admin.

The remote MCP supports **platform-token bearer auth** (OAuth client is explicitly
*not* supported for the remote MCP), which fits a headless service cleanly.

## Architecture & Data Flow

```
Discord admin
  └─ /obs ask question:"why did image gen fail earlier?"   (adminOnly, deferred, ephemeral)
       └─ bot: AgentClient.adminObserve({ userId, userTag, question })  ──gRPC──▶ sidecar
             └─ sidecar Observe RPC → ObservabilityAgent
                   model: Gemini (existing AGENT_MODEL)
                   tools: build_mcp_toolsets("observability")   # Dynatrace MCP; NO run_in_sandbox
                   loop: LLM → MCP tools (generate/execute DQL, get problems, …) → summarize
             ◀── ObserveResponse { answer_text, dql_used, error } ──
       └─ bot posts answer to Discord (sendLongResponse, ephemeral)

  └─ /obs dql query:"fetch spans | ... | limit 20"          (adminOnly, deferred, ephemeral)
       └─ bot: AgentClient.runDql({ userId, query })  ──gRPC──▶ sidecar
             └─ sidecar RunDql RPC → invokes the MCP execute-DQL tool DIRECTLY (no LLM)
             ◀── RunDqlResponse { rows_json, columns, error } ──
       └─ bot posts a formatted table (sendLongResponse, ephemeral)
```

The channel-voice path (`ChatService.chat` → `Chat` RPC → sandbox agent) is a
completely separate code path and is not modified.

## Components

### 1. Sidecar — reusable MCP layer (`agent-sidecar/src/mcp_registry.py`, new)

`build_mcp_toolsets(profile: str) -> list[MCPToolset]`. Internally a dict keyed by
profile name:

```
_PROFILES = {
  "observability": {
    "servers": [
      { "name": "dynatrace",
        "url_env": "DT_MCP_URL",
        "token_env": "DT_PLATFORM_TOKEN",
        "enabled": True },
    ],
  },
}
```

For each enabled server it constructs a `google.adk.tools.mcp_tool.MCPToolset`
pointing at the URL with header `Authorization: Bearer <token>`. v1 has exactly one
server; adding another later is a dict entry. If a profile's required env vars are
missing, the toolset is skipped and a warning logged (the feature degrades to
"unavailable" rather than crashing the sidecar).

**Open impl detail:** MCP transport (SSE vs streamable-HTTP) against the gateway
URL — determined during implementation; ADK `MCPToolset` supports both.

### 2. Sidecar — `ObservabilityAgent` (`agent-sidecar/src/agent.py`, new class)

Parallel to `ChannelVoiceAgent`. Per-turn builds an ADK `Agent` with:
- `model = _build_model(config.agent_model)` (reuse existing).
- `tools = build_mcp_toolsets("observability")` — **no `run_in_sandbox`**.
- `instruction`: scoped system prompt — "You answer read-only observability
  questions about the `discord-article-bot` and `discord-article-bot-agent`
  services (k8s namespace `discord-article-bot`) using the Dynatrace tools. Prefer
  recent timeframes. Summarize concisely for Discord. Never attempt writes."
- Reuses the existing `InMemoryRunner` drive loop; bounded by a tool/turn budget
  (reuse the sandbox agent's budget concept) to cap runaway loops.
- Returns `ObserveResult(answer_text, dql_used, error)`. `dql_used` is best-effort:
  if the MCP surfaces the executed DQL in tool results, echo it for transparency.

### 3. Sidecar — new RPCs (`proto/agent.proto` ×2, `server.py`)

Add to **both** `agent-sidecar/proto/agent.proto` and `revenant/proto/agent.proto`,
regenerate `_pb2`/`_pb2_grpc`:

```proto
rpc Observe(ObserveRequest) returns (ObserveResponse);
rpc RunDql(RunDqlRequest) returns (RunDqlResponse);

message ObserveRequest  { string user_id = 1; string user_tag = 2; string question = 3; }
message ObserveResponse { string answer_text = 1; string dql_used = 2; string error = 3; }

message RunDqlRequest   { string user_id = 1; string query = 2; }
message RunDqlResponse  { string rows_json = 1; string columns = 2; string error = 3; }
```

`AgentServicer.Observe` delegates to `ObservabilityAgent`. `AgentServicer.RunDql`
invokes the MCP **execute-DQL tool directly** (no agent/LLM) via the observability
toolset's MCP session, returning rows as JSON. Errors map to a populated `error`
field (not a gRPC error) so the bot can show a friendly message.

**Decision to confirm on review:** `/obs dql` uses a *direct-tool* path (new
`RunDql` RPC, deterministic, no LLM) rather than routing through `Observe` with a
"run verbatim" prompt. Rationale: silently letting an LLM alter a user's raw DQL is
a bad surprise, and the direct-tool path seeds the "map MCP tools to subcommands"
seam the user wants for universal MCP. Lower-effort alternative (single RPC, NL
preset) is available if preferred — this would drop `RunDql` and make `/obs dql`
a templated `Observe` call.

### 4. Bot — `AgentClient` methods (`services/AgentClient.js`)

Add `adminObserve(req)` and `runDql(req)` mirroring `chat()`: health-gated,
camelCase→snake_case field mapping, promise-wrapped unary calls. Reuse the existing
`chatDeadlineMs` (10 min) for `adminObserve` (MCP loop can be slow); a shorter
deadline for `runDql`.

### 5. Bot — `/obs` command (`commands/slash/ObserveCommand.js`, new)

Subcommand group, `adminOnly: true`, `deferReply: true`, ephemeral responses:
- `/obs ask question:<text>` → `agentClient.adminObserve(...)` → `sendLongResponse`
  with the answer (+ a `dql_used` footer when present).
- `/obs dql query:<DQL>` → `agentClient.runDql(...)` → formatted table via
  `sendLongResponse`.

Registered in `commands/slash/index.js` + `bot.js`. Built as a group so
`/obs problems`, `/obs trace <id>`, etc. are trivial fast-follows later.

**v1 scope decision (proceeded on recommendation while user was away):**
`/obs ask` + `/obs dql`. Broader preset set deferred.

## Auth, Secrets, Network, Scopes

- `DT_MCP_URL` (non-secret) → `k8s/sandbox/configmap-sandbox.yaml` + deployed
  overlay. Value:
  `https://qgv89709.apps.dynatrace.com/platform-reserved/mcp-gateway/v0.1/servers/dynatrace-mcp/mcp`
- `DT_PLATFORM_TOKEN` (secret) → `k8s/base/secret.yaml` + `k8s/overlays/deployed/secret.yaml`,
  injected via the sidecar's existing `secretRef`. Read in `agent-sidecar/src/config.py`.
- **Read-only, least-privilege token scopes:** `mcp-gateway:servers:invoke`,
  `mcp-gateway:servers:read`, `storage:*:read` (spans/logs/metrics/events/bizevents/entities),
  `davis-copilot:nl2dql:execute`, `davis-copilot:dql2nl:execute`. **No** write /
  automation / settings scopes.
- **NetworkPolicy:** the **sidecar** deployment must be allowed egress to
  `qgv89709.apps.dynatrace.com:443` (public SaaS). Verify/extend the sandbox
  namespace policy during implementation.
- **Token lifetime:** platform tokens have **no auto-refresh**. Use a long-lived
  platform token with an explicit expiry; document rotation. Expiry surfaces as a
  clean "observability backend unavailable" to admins.

## Guardrails & Failure Modes

- Admin allowlist (`BOT_ADMIN_USER_IDS`) enforced at the Discord layer.
- Read-only token; observability agent has **no** sandbox and **no** write tools.
- Per-call gRPC deadline; ADK loop bounded by a tool/turn budget.
- MCP unreachable / token expired → populated `error` → command replies
  "observability backend unavailable" (mirrors channel-voice fallback ethos). No
  silent failure.
- Sidecar keeps running if `DT_*` env is absent — `/obs` simply reports unavailable.

## Testing (TDD)

- **Python:** `build_mcp_toolsets` builds/skips per config; `ObservabilityAgent`
  constructs with a mocked `MCPToolset` and returns text; `Observe`/`RunDql`
  handlers map result + error paths; `RunDql` calls the execute-DQL tool with the
  verbatim query.
- **Node:** `adminObserve()` / `runDql()` client methods (health-gated, field
  mapping); `ObserveCommand` with mocked `agentClient` — admin vs non-admin gating,
  `ask` and `dql` subcommands, long-response splitting.
- **Live smoke test:** once the token exists, `kubectl exec` the sidecar and call
  the MCP execute-DQL tool against a known query (the pattern in
  `reference_smoke_test_service_via_kubectl_exec`).

## Open Validation Items (implementation-time)

1. NetworkPolicy egress from the sidecar to the Dynatrace SaaS host.
2. ADK `MCPToolset` transport (SSE vs streamable-HTTP) against the gateway URL.
3. Davis Copilot enabled in tenant `qgv89709` (for the DQL-generation tools).
4. Exact discovered tool name for "execute DQL" (needed by the `RunDql` direct path).

## Future Direction (universal MCP)

The `mcp_registry` profile map and the direct-tool `RunDql` seam are the two
extension points. Additional MCP servers become new entries under a profile; new
deterministic tool-backed subcommands reuse the direct-invoke path. No new
plumbing is required to grow either axis.

## Rollout

Standard workflow (CLAUDE.md): TDD → full suite → build sidecar + bot images
(pinned to git short-SHA) → update deployed overlay + secret → deploy → verify
pod health + a live `/obs dql` smoke test. Feature is inert until `AGENT_ENABLED`
and the `DT_*` env are present.
