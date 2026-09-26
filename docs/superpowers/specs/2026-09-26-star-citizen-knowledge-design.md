# Star Citizen Knowledge (text + voice) — Design

**Date:** 2026-09-26
**Status:** Approved (brainstorming, all six sections)
**Branch:** `feat/star-citizen-knowledge`

## 1. Goal

Let the bot answer Star Citizen questions — in text chat and in voice — from live, patch-current data instead of model memory:

| Class | Example | Data |
|---|---|---|
| Item location & price | "Where can we purchase a V801-12 radar?" | UEX shop prices |
| Component comparison | "What is the most powerful Size 2 shield generator?" | Per-patch game data |
| Reputation grinding | "What is an optimal way to grind Foxwell Enforcement reputation?" | Per-patch mission data + web search for community strategy |
| Trade | "What are currently profitable trade routes from MIC-L5?" | UEX crowd-sourced commodity prices/routes |

**Success criteria:** each example question answered correctly in text and voice; **zero sandbox spin-ups for Star Citizen questions** (hard requirement, measured offline and in production); a dead SC service never degrades general chat.

## 2. Decisions (from brainstorming)

- **Surfaces:** text and voice together.
- **Data:** public APIs only — **UEX Corp API v2** + **Star Citizen Wiki API** + the model's existing Google Search for community strategy. **No local `Data.p4k` extraction and no datap4k MCP**: research showed datap4k is immature (≈2 days old, no releases, stdio-only, extractor parser stubbed), extraction costs ≈174 GB/patch, and game files cannot answer shop/price questions at all. The community-extracted per-patch data (ScDataDumper → scunpacked-data) is exactly what the Wiki API serves, typically within days of a patch. The local install is build `12660092` = current `4.10.1-LIVE`.
- **Excluded sources:** erkul.games (ToS forbids automated/third-party access; data is encoded behind Cloudflare), Regolith (shut down), CStone/SCMDB scraping (no documented API; UEX + Wiki API cover them).
- **SC Trade Tools** (hosted MCP, Patreon token): not now; **design for it** so adding it later is a config entry.
- **Approach A:** one standalone `sc-knowledge` MCP server consumed by both sidecars.

## 3. Architecture

```
text  ─▶ bot ─gRPC─▶ agent sidecar (ADK, gemini-3.8-flash) ── McpToolset ──┐
voice ─▶ bot ─gRPC─▶ voice sidecar (Gemini Live) ── MCP client ───────────┤
                                                                          ▼
                                             sc-knowledge (NEW, :8080/mcp, streamable HTTP)
                                               ├─ TTL cache (in-process) + name index
                                               └─ HTTPS ─▶ UEX API v2, Star Citizen Wiki API
                                                          (SC Trade Tools MCP: later, config only)
```

- **`sc-knowledge/`** — new top-level dir. Python 3.14, official `mcp` 2.x SDK server (FastMCP), streamable HTTP at `:8080/mcp`, plus `GET /healthz`. Stateless; `Deployment` with `RollingUpdate`, 1 replica (scalable). Image `mvilliger/sc-knowledge:<git-short-sha>` (never `:latest`).
- **NetworkPolicy:** ingress only from the agent and voice sidecar pods on 8080; egress DNS + TCP 443.
- **No auth between sidecars and server** (cluster-internal, read-only public data; the NetworkPolicy is the guard).
- **Secret:** `UEXCORP_BEARER` (UEX app token, already registered; sent as `Authorization: Bearer`). Optional — reads work without it today — but used when present.
- **Agent sidecar:** `mcp_registry` gains a `channel_voice` profile (`sc-knowledge`; later `sc-trade-tools` with a token attr — the registry already skips servers with missing config).
- **Kill switch:** `SC_KNOWLEDGE_ENABLED` (agent sidecar env, voice sidecar env). Off = tools never attached = byte-identical to today. `SC_KNOWLEDGE_URL` (default `http://sc-knowledge.discord-article-bot.svc.cluster.local:8080/mcp`).

## 4. Tool surface

All tools accept fuzzy names; every result includes `game_version` and `source`; price data includes `reported_at` (and `stale`/`age_minutes` when served from stale cache). Small default limits (5–10) so results are voice-friendly. Tools **pre-compute** everything a model would otherwise want to run code for (sorting, ranking, profit/ROI, rep-per-minute) — this is the primary sandbox-avoidance lever.

| Tool | Inputs | Returns | Backend |
|---|---|---|---|
| `sc_find_item` | `name` | best match + ≤3 alternatives; type/sub_type/size/grade/class/manufacturer + type-relevant key stats; **where to buy**: shop, location path, price, reported date | Wiki API `v2/items/{name}` / `v2/items?filter[name]=` (item embeds `uex_prices.purchase[]` — the UEX shop prices, so no separate UEX call) |
| `sc_compare_components` | `type` (shield, power_plant, cooler, quantum_drive, radar, weapon, missile), `size`, optional `rank_by`, `grade`, `class`, `limit` | top N with type-relevant stats (shield: max_health + regen_rate; …), cheapest buy location each | Wiki API `vehicle-items?filter[type]=&filter[size]=` (+ embedded `uex_prices`) |
| `sc_faction_missions` | `faction`, optional `current_rank`, `system`, `limit` | rank ladder (name + min reputation); missions available at that rank **sorted by reputation per minute** (`reputation_gained / time_to_complete_minutes`) with reward, duration, prerequisites/chain, systems, cooldown | Wiki API `missions?filter[mission_giver]=` (+ factions) |
| `sc_trade_routes` | `origin` (terminal/station/planet/system), optional `destination`, `commodity`, `cargo_scu`, `budget_auec`, `limit` | routes: commodity, buy→sell terminal + location, prices, profit/SCU, **total profit capped by cargo and budget**, ROI, distance, data age, `lawless` flag for Pyro endpoints | UEX `commodities_routes?id_terminal_origin=` (resolve origin → terminal ids) |
| `sc_commodity_prices` | `commodity`, optional `location`, `side` (buy/sell) | best terminals to buy/sell with price, stock, data age | UEX `commodities_prices?id_commodity=` |
| `sc_org_guides` | `query`, optional `limit` (default 3) | top-matching sections from the org's curated guides: guide title, section heading, section text, `version` (e.g. `Alpha 4.10.1`), `source: "org guide"` | in-cluster ConfigMap text (see §4a) |

**Not tools:** community strategy (model uses Google Search alongside `sc_faction_missions`); raw API passthrough.

**Name resolution** (server-side): an index of terminals (`name`, `nickname`, `code`, `displayname`), commodities, factions, and a rolling set of item names, rebuilt every 6 h. Normalisation lowercases and strips punctuation/whitespace ("MIC-L5" = "micl5" = "Admin - MIC-L5"); fuzzy match via `rapidfuzz`. Ambiguity → candidates, never a silent guess.

## 4a. Org guides (curated, private)

The org's teammates maintain PDF guides (trading/logistics/risk, mining scan signatures, salvage contracts & yields — Alpha 4.10.1) in the untracked repo-root `OrgGuides/`. **The GitHub repo and the Docker Hub images are public**, so the guides are never committed and never baked into any image: `OrgGuides/` is added to `.gitignore` and `.dockerignore` (the bot image does `COPY . .`).

- `scripts/sync-org-guides.sh` extracts each PDF with `pdftotext -layout` to `<slug>.txt` and applies ConfigMap `sc-org-guides` (`kubectl create configmap ... --from-file ... --dry-run=client -o yaml | kubectl apply -f -`). Adding/updating a guide = drop the PDF in `OrgGuides/` and re-run; no rebuild or redeploy.
- sc-knowledge mounts the ConfigMap read-only at `/guides` (`optional: true`) and reloads when file mtimes change (checked at most every 60 s). Absent/empty → `sc_org_guides` returns `{"sections": [], "note": "no org guides loaded"}`.
- Sections: split on the guides' numbered/ALL-CAPS headings; ranked by BM25-style term scoring over heading (weighted ×2) + body. The first line of each file is its title; a `LIVE Build: Alpha x.y.z` / `VERSION: Alpha x.y.z` / `ALPHA x.y.z` marker supplies `version`.
- **Precedence** (stated in both prompts): live API data wins for prices/stats/availability; guides win for process, mechanics and strategy; cite the guide when used and note its patch if it differs from the live patch.

## 5. Data layer & failure behaviour

- **Clients:** async `httpx` per upstream; timeouts connect 3 s / total 8 s; ≤2 retries with jitter on 429/5xx only; honest `User-Agent: revenant-discord-bot/<version>`; UEX adds `X-Client-Version` and Bearer when configured.
- **Cache TTLs:** routes & commodity prices 30 min (UEX's own cache window); item prices 2 h; item stats/missions/factions 12 h; name index 6 h. **Stale-on-error:** upstream failure serves a stale entry flagged `stale: true` + age.
- **Client-side rate limits:** Wiki API ≤60/min; UEX ≤120/min.
- **Patch awareness:** read `game_version` from UEX `game_versions` and Wiki API item `version` at startup and every 6 h; if they disagree (e.g. new patch not yet in Wiki data) results carry a `note`.
- **Errors never cross the MCP boundary as exceptions:** tools return `{"error": "<code>", "detail": ..., "stale_fallback": bool}` (`uex_unavailable`, `wiki_unavailable`, `not_found` with `candidates`, `ambiguous` with `candidates`). An empty result is an explicit empty list with `source`, distinct from an error.
- **No persistence.** Cache/index in memory; restart re-warms (~30 s), tools call upstream directly meanwhile.

## 6. Agent sidecar integration (text)

- Channel-voice agent tools: `[run_in_sandbox, sc_toolset]`. The `McpToolset` is built **once at startup** and reused (the Agent is rebuilt per turn; the toolset must not be).
- **Isolation:** an unreachable sc-knowledge must never fail `Chat` or trip the `ChatCircuitBreaker`. A cached availability probe (`/healthz`, re-checked at most every 30 s) decides per turn whether to attach the toolset; unavailable → turn runs without SC tools, logs `sc_tools=unavailable`, and the instruction says live SC data is temporarily unavailable. Pinned by a test.
- **Prompt:** `TOOL_AVAILABILITY_PREAMBLE` gains an SC clause (use `sc_*` for items/stats/shops/prices/missions/reputation/trade; prefer over memory since the game changes every patch; combine with web search for strategy; state data age/patch when relevant; never use the sandbox to reach these APIs). The sandbox-last-resort disposition is unchanged.
- **Sandbox avoidance — three layers (hard requirement):**
  1. *Remove the motive:* tools return pre-computed rankings/profit/rep-per-minute.
  2. *Deterministic backstop:* `run_in_sandbox` refuses — **before any orchestrator call / pod / Kata boot** — code whose text references SC data hosts (`uexcorp.space`, `uexcorp.uk`, `api.star-citizen.wiki`, `star-citizen.wiki`, `sc-trade.tools`, `scunpacked`), returning `{"exit_code": -4, "error": "use_sc_tools", ...}` pointing at the `sc_*` tools. Only fires on those hosts.
  3. *Measured:* offline eval SC case set with a **hard gate of 0 sandbox invocations**; production DQL over `agent.chat` spans: `sc.tool.calls > 0 AND sandbox.invoked == true` should be ≈0.
- **Observability:** `agent.chat` span attrs `sc.tools.available` (bool), `sc.tool.calls` (int), `sc.tool.names` (string). sc-knowledge emits OTLP spans per tool call (`sc.tool`, `sc.upstream`, `sc.cache` = hit|miss|stale, latency).
- **Out of scope:** the bot's direct-OpenAI fallback path gets no SC tools.

## 7. Voice integration (Gemini Live)

- Live `tools = [google_search, Tool(function_declarations=[sc_*])]` when `SC_KNOWLEDGE_ENABLED`. Declarations are fetched from sc-knowledge via MCP `list_tools` at sidecar startup and converted to Gemini `FunctionDeclaration`s (server = single source of truth). Unreachable at startup → search-only (today's behaviour) and a periodic retry.
- **Round trip:** Live `tool_call` → MCP `call_tool` (concurrently for multiple calls, each bounded at **6 s**) → `send_tool_response` with matching ids. Timeout/error → a tool response carrying the structured error (never silence). `tool_call_cancellation` cancels in-flight calls.
- **Persona note** (voice only, appended when SC tools are attached): say a brief natural filler before a lookup; speak the top 2–3 results; offer the rest rather than reading tables.
- **Session interplay:** tool calls do not touch floor control or VAD; in-flight calls are dropped on session resumption (not replayed); `turnComplete` remains correct (Live completes the turn after consuming the tool response).
- **Model:** stays `gemini-live-2.5-flash` (supports function calling + search together via the Live API).
- **Smoke test:** `scripts/smoke-voice-sc.js` — speaks the four example questions (TTS fixtures) at the real sidecar; asserts a tool call occurred and the transcript mentions the expected entity.

## 8. Testing

- **sc-knowledge:** unit tests per tool against recorded real fixtures (`tests/fixtures/`, no live calls in CI); name resolution (fuzzy, ambiguous); cache TTL + stale-on-error; rate limiter; error envelope; in-process MCP client round-trip of every tool over real streamable HTTP.
- **agent sidecar:** toolset-unavailable path doesn't fail `Chat`/trip breaker; sandbox host refusal never calls the orchestrator; span attrs; eval SC case set with the 0-sandbox gate.
- **voice sidecar:** tool_call → tool_response id matching; 6 s timeout → error response; cancellation; concurrent calls; declaration conversion; genai-surface test pinning the `tool_call`/`FunctionResponse` fields used.
- **Live verification before sign-off:** the four questions via text (`AgentClient` from the bot pod) and voice (`smoke-voice-sc.js`); DQL check shows zero sandbox invocations on SC turns.

## 9. Rollout

1. Deploy sc-knowledge (+ Secret, Service, NetworkPolicy; allow its egress and the sidecars' egress to it).
2. `SC_KNOWLEDGE_ENABLED=true` on the agent sidecar → verify text.
3. `SC_KNOWLEDGE_ENABLED=true` on the voice sidecar → verify voice.
Each step reversible by its flag; off = today's behaviour.

## 10. Docs

CLAUDE.md section (service, tools, flags, sandbox backstop, DQL check, deploy rules); `features.md`; README env vars; `k8s/sc-knowledge/README.md` (apply order, deployed-overlay rule).
