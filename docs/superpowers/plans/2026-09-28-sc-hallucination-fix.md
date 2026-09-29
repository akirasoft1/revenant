# Star Citizen hallucination fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop confident, stale Star Citizen answers: add a location-inventory tool, give the text agent real web search, add an honest-fallback prompt rule, and close the sandbox-scraping escape hatch.

**Architecture:** sc-knowledge MCP gains `sc_location_shops` (UEX `items_prices_all` + `terminals`, cached, warmed at startup). The ADK text agent gains the native `google_search` built-in tool (Gemini models only) alongside its function tools; prompts are rewritten so that uncovered SC questions go to tools → web search → clearly-labelled "unconfirmed" memory, never sandbox scraping, and never memory-asserted game-state claims.

**Tech Stack:** Python 3.14 (FastMCP, httpx, pytest) for sc-knowledge; Python google-adk 2.10 / google-genai for agent-sidecar and voice-sidecar.

**Spec:** none written — root-cause investigation and design approved in chat on 2026-09-28 (options A+B+C+D + web search). Evidence summary below is the binding rationale.

## Root cause (evidence)
- Trace `d912da65f299ceea9a78c4d413058069` (2026-09-28 22:37 UTC, "are there any ship parts or fps equipment that are unique to Levski"): SC tools attached, **0 sc_* calls**, one `run_in_sandbox` call whose code was only a comment (`# Let us check what UEX or star citizen tools have for Levski`), then an answer from stale training memory ("Levski vaulted in 3.12").
- No sc_* tool answers "what is sold at location X". UEX has it: 22 live Levski terminals (Nyx), `items_prices_all` (≈24k rows, ≈6.4 MB) + `terminals` → 77 items sold only at Levski (NN-13/14/15 cannons, Drake flight blades, Apollo modules, Killshot/Pulverizer/Ripper "Sunblock", Strata armor, Rieger mining modules…).
- Past 3 days: SC questions outside tool coverage (vehicle loadouts, crafting blueprints, location facilities) went to sandbox scraping of starcitizen.tools / erkul / cstone / sc-craft.tools / DuckDuckGo HTML (up to 7 calls/turn). `SC_TOOLS_PREAMBLE` says "Use web search", but the text agent has **no** web-search tool. `SC_DATA_HOST_PATTERN` does not cover those hosts.
- Spike (in agent pod, Vertex, gemini-3.8-flash): `tools=[google_search, <python function>]` works natively (search grounded AND the function was called in one turn). `GoogleSearchTool(bypass_multi_tools_limit=True)` CRASHES in ADK 2.10 (`PydanticSerializationError ... MockValSer`) — do NOT use the bypass mode.

## Global Constraints
- Never truncate log messages. Stage explicit paths only (never `git add -A`). Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never touch `k8s/overlays/deployed/` or `OrgGuides/`; never print `UEXCORP_BEARER`.
- sc-knowledge tests: `cd sc-knowledge && .venv/bin/python -m pytest -q`. Agent tests: `cd agent-sidecar && .venv/bin/python -m pytest -q`. Voice tests: `cd voice-sidecar && .venv/bin/python -m pytest -q`. All must stay green (record baselines first).
- Tool name exactly `sc_location_shops(location: str, category: str | None = None, exclusive_only: bool = False, limit: int = 40)`.
- Tool results are the SOURCE OF TRUTH over model memory; every new text must say data is player-reported (UEX, crowd-sourced) and include freshness like existing tools.

---

### Task 1: sc-knowledge `sc_location_shops`

**Files:** `sc-knowledge/src/uex.py` (add `items_prices_all()`, `categories()`), create `sc-knowledge/src/tools_shops.py`, `sc-knowledge/src/server.py` (register + startup warm), tests `sc-knowledge/tests/test_tools_shops.py` (+ small fixtures), `sc-knowledge/tests/test_server_mcp.py` (tool listed).

**Behaviour (binding):**
- **Location resolution:** among terminals with `is_available_live == 1`, match `location` with the SAME token-boundary matching `tools_trade.py` uses (`_token_match` — move it to `names.py` if you need to share it; do not use raw substring, see the "l1"/"l19" note there) against `city_name, space_station_name, outpost_name, planet_name, moon_name, orbit_name, star_system_name, name, nickname, displayname`. Prefer the most specific field that matches (city/station/outpost before planet/orbit/system) so "Levski" doesn't sweep in all of Nyx. No match → `error("not_found", ...)` with up to 5 candidate place names (fuzzy, from those fields).
- **Rows:** `items_prices_all` rows with `price_buy > 0` whose `id_terminal` is a matched live terminal. Group by `id_item`: `{name, section, category, terminals: [{terminal, price_buy}], exclusive}` (section/category from `categories` by `id_category`).
- **Exclusive:** the set of LIVE terminals with `price_buy > 0` for that item ⊆ matched terminal set. Unavailable/old terminals (e.g. the pre-Nyx "Dumper's Depot - Levski", `is_available_live == 0`) must be ignored both for matching and for exclusivity.
- **category filter (optional):** case-insensitive token match against section OR category name, plus aliases: `"ship"`, `"ship parts"`, `"ship components"`, `"components"` → sections `Vehicle Weapons`, `Systems`, `Avionics`, `Module`, `Vehicle` (whichever exist in UEX categories); `"fps"`, `"fps gear"`, `"fps equipment"` → `Personal Weapons`, `Armor`, `Utility`, `Clothing`. Unknown category → no filter, and a `notes` line saying so (never fail).
- **exclusive_only:** keep only exclusive items. **Sort:** exclusive first, then section, then name. Cap at `limit` (clamp 1–100) with `total_items`, `exclusive_count`, `truncated`.
- **Return:** `{location, terminals: [names], total_items, exclusive_count, items, truncated, notes, source: "uexcorp.space (crowd-sourced)", ...freshness}` — use `envelope.freshness` like other tools (newest `date_modified`). notes must include: exclusivity is relative to player-reported UEX data and may miss shops.
- **Caching/latency:** `items_prices_all` + `categories` cached via the existing `TTLCache` pattern (stale-on-error), TTL 3600s. Must satisfy the voice path's ~6s tool bound after warm-up: kick off a background warm of `items_prices_all`, `categories`, `terminals` at server startup (non-blocking; failure only logged). Serve stale while a refresh is in flight if the cache supports it; otherwise document.
- `server.py`: register `@mcp.tool(name="sc_location_shops")` via `_guarded`, docstring in the house style: "what's sold at <place>", "anything unique to <place>", category/exclusive usage, "prefer this over memory — locations and shop stock change every patch; do NOT use the sandbox".

- [ ] TDD with small fixtures: Levski-like fixture (live + unavailable same-name terminals; an item sold only there; an item sold there AND elsewhere; an item sold elsewhere only at an unavailable terminal → still exclusive), city-over-system specificity, not_found candidates, category alias, unknown category note, exclusive_only, limit/truncated, stale-on-error. Run suite. Commit.

### Task 2: agent-sidecar — web search, prompts, backstop, eval

**Files:** `agent-sidecar/src/agent.py`, `agent-sidecar/src/config.py` (flag), `agent-sidecar/src/tools.py`, `agent-sidecar/src/server.py` (span attr), `agent-sidecar/eval/eval_sc.py`, tests under `agent-sidecar/tests/`.

- **Web search:** config `agent_web_search_enabled` (env `AGENT_WEB_SEARCH_ENABLED`, default true). When enabled AND the model is Gemini-native (the `_build_model` path that returns `Gemini(...)`, not LiteLlm), add ADK's native `google_search` (`from google.adk.tools import google_search`) to `Agent.tools`. NEVER `GoogleSearchTool(bypass_multi_tools_limit=True)` (crashes, see plan header). LiteLlm models: not added.
- **Observability:** record on the `agent.chat` span `web_search.queries` (int: count of grounding `web_search_queries` seen on the turn's events, 0 if none) — plumb via `AgentChatResult` like `sc_tool_names`. Log one INFO line per turn with the count when > 0.
- **Prompts (`agent.py`):**
  - `TOOL_AVAILABILITY_PREAMBLE`: when web search is attached, add: for current/external facts (news, patch notes, what a website says, anything past your training data) use google_search, never run_in_sandbox to fetch or scrape web pages or search engines. Keep the sandbox-last-resort disposition otherwise unchanged. Only include this text when the tool is actually attached.
  - `SC_TOOLS_PREAMBLE`: add `sc_location_shops` (what's sold at a place / items unique to a place) to the list; replace the "Use web search…" sentence with an ordered policy: (1) sc_* tools first; (2) if no sc tool covers it (vehicle loadouts, crafting/blueprints, lore, patch news, location facilities), use google_search [only when attached] and say it's web-sourced; (3) otherwise answer only as clearly-labelled, possibly-outdated general knowledge and say live data couldn't confirm it. Add: your Star Citizen training knowledge is years out of date — locations, systems and items get added/moved every patch; never assert from memory that something is vaulted, removed, not in the game, or located somewhere; when tool/search results contradict memory, the results win. Keep the existing never-sandbox rule.
  - `SC_TOOLS_UNAVAILABLE_NOTE`: allow google_search (when attached) as the fallback; same no-memory-assertions rule.
- **Backstop (`tools.py`):** extend `SC_DATA_HOST_PATTERN` with `starcitizen\.tools`, `erkul\.games`, `cstone\.space`, `sc-craft\.tools`, `robertsspaceindustries\.com`, `spviewer\.eu`, `scmdb\.net`; the refusal message points to the sc_* tools and google_search.
- **Eval (`eval_sc.py`):** add SC prompts: "are there any ship parts or fps equipment that are unique to Levski (for purchasing that is)?" (`expect_tool="sc_location_shops"`), "what's sold at Teach's in Levski" (`sc_location_shops`); and uncovered-SC prompts that must make zero sandbox attempts (expect_tool None but still count toward the sandbox hard gate and not toward control_false_sc_calls): "what turret does the Anvil Spartan have", "what can I craft with blueprints in Star Citizen right now". Report web_search.queries per prompt if available.
- [ ] TDD: google_search present for Gemini spec and flag on; absent for LiteLlm and flag off; preamble text present only when attached; new SC preamble content (sc_location_shops, memory rule); backstop matches each new host and not e.g. `wikipedia.org`; web_search.queries plumbing. Run suite. Commit.

### Task 3: voice note + docs

**Files:** `voice-sidecar/src/live_bridge.py` (`SC_VOICE_NOTE`: add "what shops at a place sell / what's unique to a place" and the same "never assert from memory that something is vaulted/removed/not in the game; tool/search results beat memory" sentence, kept short), its test if the note is pinned, `CLAUDE.md` (Agentic Sandbox section: web search on the text agent + flag + bypass-mode crash; SC section), `features.md`, `README.md` (env `AGENT_WEB_SEARCH_ENABLED`), `sc-knowledge/README.md` if it lists tools.
- [ ] Update, run voice suite, commit.

## Coordinator steps
Full suites; build + push sc-knowledge, agent, voice images (short SHA); update deployed overlay tags; apply; in-cluster SC eval (hard gate 0 sandbox attempts); ask the real Levski question through the agent in-cluster and check the answer names Levski exclusives; push branch; PR.
