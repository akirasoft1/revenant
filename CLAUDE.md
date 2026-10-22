# Discord Article Bot - Development Guidelines

## Feature Development Workflow (TDD + Build + Deploy)

When implementing new features or fixes, follow this complete workflow:

### 1. Create Feature Branch
```bash
git checkout main && git pull origin main
git checkout -b feat/<feature-name>
# or fix/<issue-name> for bug fixes
```

### 2. TDD: Write Tests First (Red Phase)
- Write failing tests in `__tests__/` that define expected behavior
- Run tests to confirm they fail: `npm test -- --testPathPatterns="<TestFile>"`
- Tests should cover: happy path, edge cases, error handling

### 3. Implement Feature (Green Phase)
- Write minimal code to make tests pass
- Run tests frequently to verify progress
- Commit checkpoints with descriptive messages

### 4. Refactor (if needed)
- Clean up implementation while keeping tests green
- Ensure code follows existing patterns in codebase

### 5. Run Full Test Suite
```bash
npm test
```
All tests must pass before proceeding.

### 6. Update Documentation
- Update `features.md` with new capabilities
- Update `README.md` if user-facing features changed
- Update `CLAUDE.md` if development practices changed

### 7. Commit Changes
```bash
git add -A
git commit -m "feat: <description>

<detailed explanation>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

### 8. Bump Version
```bash
npm version patch --no-git-tag-version  # for fixes
npm version minor --no-git-tag-version  # for features
git add package.json package-lock.json
git commit -m "chore: bump version to <version>"
```

### 9. Build, Deploy and Verify
Follow "Deployment" → "Deployment Steps" below (one copy of the commands lives there).

### 10. Push Branch and Create PR
```bash
git push -u origin feat/<feature-name>
# Create PR via GitHub (gh auth may be expired)
```

### Checkpoint Commits
For larger features, commit checkpoints along the way:
- After tests are written (even if failing)
- After major implementation milestones
- Before risky refactoring

## Deployment

- **Namespace**: Always deploy to `discord-article-bot` namespace, not `default`
- **Container name**: The deployment container is named `bot`, not `discord-article-bot`
- **Source of truth**: `k8s/overlays/deployed/` (gitignored, contains real secrets)
- **Do NOT use kustomize**: The `k8s/base/` and `k8s/overlays/prod/` are out of sync and contain placeholder secrets

### Deployment Steps

1. Build and push Docker image:
   ```bash
   docker build -t mvilliger/discord-article-bot:<version> .
   docker push mvilliger/discord-article-bot:<version>
   ```

2. Update image version in `k8s/overlays/deployed/deployment.yaml`

3. Apply the deployment:
   ```bash
   kubectl apply -f k8s/overlays/deployed/ -n discord-article-bot
   ```

   Or for image-only updates (still do step 2, so the overlay matches what is running):
   ```bash
   kubectl set image deployment/discord-article-bot bot=mvilliger/discord-article-bot:<version> -n discord-article-bot
   ```

4. Verify rollout:
   ```bash
   kubectl rollout status deployment/discord-article-bot -n discord-article-bot --timeout=120s
   kubectl get pods -n discord-article-bot
   kubectl logs -f deployment/discord-article-bot -n discord-article-bot
   ```

### NetworkPolicy Configuration

**IMPORTANT**: This namespace uses a restrictive NetworkPolicy that blocks egress to private IP ranges by default.

When adding a new external service integration (especially services on local/home network IPs like `192.168.x.x`, `10.x.x.x`, `172.16.x.x`):

1. **Update the NetworkPolicy** in `k8s/overlays/deployed/networkpolicy.yaml`
2. Add an egress rule for the specific IP and port:
   ```yaml
   # Example: Allow Local LLM (Ollama) on home network
   - to:
       - ipBlock:
           cidr: 192.168.1.164/32
     ports:
       - protocol: TCP
         port: 11434
   ```
3. Apply the change: `kubectl apply -f k8s/overlays/deployed/networkpolicy.yaml -n discord-article-bot`
4. Restart the pod to re-initialize the service

**Debugging connectivity issues**:
```bash
# Check current NetworkPolicy
kubectl get networkpolicies -n discord-article-bot -o yaml

# Test connectivity from a fresh pod (no NetworkPolicy restrictions)
kubectl run test-curl --rm -it --image=curlimages/curl -- curl http://<ip>:<port>/endpoint
```

## Voice Profile (Channel Voice Personality)

The `channel-voice` personality dynamically learns the group's communication style from IRC history and Discord messages. It requires:
- `VOICE_PROFILE_ENABLED=true`
- Qdrant service enabled (for IRC history sampling + few-shot retrieval)
- Channel Context service enabled (for Discord message sampling)

**Config env vars**: `VOICE_PROFILE_REGEN_HOURS`, `VOICE_PROFILE_SAMPLES_PER_DECADE`, `VOICE_PROFILE_DISCORD_SAMPLES`, `VOICE_PROFILE_ANALYSIS_MODEL`, `VOICE_PROFILE_AB_LOGGING`

**A/B logging**: Set `VOICE_PROFILE_AB_LOGGING=true` to log styled vs. unstyled response comparisons to the `ab_comparisons` MongoDB collection.

**Profile storage**: MongoDB `voice_profiles` collection. Versioned with `previousVersion` for history.

## Recall (v2 centralized ranked recall)

`RecallService` (`services/RecallService.js`) replaces the scattered Mem0 + channel-context recall when `RECALL_V2_ENABLED=true`. It over-retrieves from all sources, dedupes, ranks by recency+importance (Mongo `recall_ledger` holds importance/access/last-access), and injects one `## Memory Context` block. Pure logic in `services/recall/` (ranking, queryBuilder, adapters, evalMetrics).

- **Validate before flipping on**: run `node scripts/eval-recall.js` (offline ranker eval) and enable `RECALL_SHADOW_ENABLED=true` to log old-vs-new to `recall_comparisons`.
- Recent buffer + voice few-shot are intentionally NOT ranked (separate blocks).
- Spec: `docs/superpowers/specs/2026-05-30-centralized-ranked-recall-design.md`.

## Agentic Sandbox

When `AGENT_ENABLED=true`, channel-voice chats are routed through the Python agent sidecar (`discord-article-bot-agent`). The sidecar is an ADK Agent with one tool — `run_in_sandbox` — that spawns ephemeral pods per execution and returns `{exit_code, stdout, stderr, duration_ms, egress_events, runtime_events}` to the model. Other personalities are unaffected.

**Chat context (unified):** Both the text agent path (`ChatRequest`) and voice Live path (`SessionStart`) forward the same three context fields to the sidecar:
- `system_prompt`: the dynamic channel-voice personality with `{VOICE_INSTRUCTIONS}` substituted from the live voice profile
- `memory_context`: the ranked `RecallService` block (Mem0 + channel semantic + channel facts, deduplicated and ranked by recency + importance)
- `history`: recent conversation turns as `[{role, content}, ...]`, sourced bot-inclusively from `MongoService.getRecentChannelMessages` (the `channel_messages` MongoDB collection)

`channel_messages` is the ONLY history source, so **every chat entry point records both sides of its exchange there** with the same doc shape (shared writers in `utils/channelMessageRecorder.js`): @mention and reply — the user message via bot.js's `messageCreate` recorder, the bot reply via `_recordBotReply`; `/chat` — a slash interaction is not a channel message (messageCreate never sees it), so `ChatCommand` records the prompt itself (`messageId` = interaction id, guild-only like messageCreate) *before* calling chat, awaited so `buildTurnContext`'s `_dropDuplicatedCurrentTurn` removes it and the current turn reaches the model once, then the raw model reply (`isBot`, `executionIds`). Before this, a `/chat` Q&A was invisible to every later turn. **Discord replies name their referenced bot message on the current turn:** the reply fall-through (`bot.js` `_handleReplyToBot` → `_handleMentionChat` → `ChatService.chat(..., { referencedMessage })`) hands `buildTurnContext` the replied-to bot message, and on EVERY such turn (non-empty after stripping the fallback banner / `<url>` wrapping) it returns `currentTurn` = `[Replying to your earlier message: "<full referenced text>"]\n<userMessage>`, which `chat()` sends as the agent's `userMessage` (full text, never truncated). History is left chronological and untouched. Why not window position: the old rule appended the target as an assistant turn only when it was OUT of the window and was a no-op otherwise — in the 2026-09-29 incident the replied-to Levski answer WAS in the window, followed by a newer, unrelated Ruin Station question from another user, so "are they unique…?" was resolved to Ruin Station. Moving the target next to the current turn was rejected too: after a newer question it reads as the answer to *that* question. The prefix is applied AFTER `_dropDuplicatedCurrentTurn` (which compares the raw text), and stored `channel_messages` content and recall queries stay raw. If `buildTurnContext` throws, the degraded path sends the raw `userMessage` (no prefix). This also covers replies to `/chat`'s interaction replies. Agent path only — the direct-OpenAI fallback does not use it.

**Who-said-what labels + roster (member identity, since 2026-10-09):** `buildTurnContext` labels every non-bot history turn `[<Name> · <discordId>]: <content>` (middle dot U+00B7) and prefixes the current turn with the current speaker's label (composed under the reply prefix: `[Replying to …]\n[Name · id]: <message>`), so "I/me/my" resolve to the labelled speaker instead of the model guessing from first-person text. Bot (`isBot`) turns and rows without an `authorId` stay unlabelled. **Naming order for a label:** registry `addressName` → latest stored `authorName` → `VOICE_SPEAKER_NAMES`/Discord names (`SpeakerNames`) → registry alias → `Unknown`. **Labelling happens AFTER the raw dedupe** (`_dropDuplicatedCurrentTurn` still compares raw text; stored `channel_messages` content and recall queries stay raw). A `## People in this conversation` roster block is appended to the returned `systemPrompt`: current speaker first (marked `← current speaker`), every distinct `authorId` in the history window, plus any registry member whose addressName/alias appears as a whole word (case-insensitive, Unicode-aware boundaries, so alias `Aki` does not match inside `Akirasoft`) in the window or current message; cap 20, never the full table, omitted when empty; the block's instruction (`ROSTER_INSTRUCTION`) says "I/me/my" mean the labelled speaker, to use the list only to work out who is who, not to mention aliases unless it matters, and never to start its own replies with a label. **Failure isolation:** registry lookups are in-memory and never throw into a turn; if the registry failed to load, labels fall back to stored `authorName` and the roster lists resolved names only. Origin: an incident where the model answered another user's "Akira, …" as if it were the asker. Spec: `docs/superpowers/specs/2026-10-09-member-identity-design.md`.

Built by one shared method: `ChatService.buildTurnContext({...}) -> { systemPrompt, memoryBlock, historyTurns }`. The sidecar runs the bot's `system_prompt` (generic `base.txt` is fallback-only when `system_prompt` is empty). The sandbox executor itself still receives no memory or history — context is injected at the model turn only, not the tool layer. `run_in_sandbox` remains a last-resort tool gated by `TOOL_AVAILABILITY_PREAMBLE`. Note: sidecar `requirements.txt` floors track the current releases (raised 2026-09-26; both sidecars run `python:3.14-slim`). **Agent-sidecar holdback:** google-adk ≥2.8 caps OpenTelemetry at ≤1.42.1, which needs protobuf <7, and every grpcio-tools newer than 1.81.1 needs protobuf 7 — so the agent sidecar runs protobuf 6.33 / grpcio-tools 1.81.1 / OTel 1.42.1 (stubs regenerated to match). Raise all three together once adk lifts its OTel cap. The voice sidecar has no adk and runs protobuf 7.x.

**Token-trim split (deliberate, not DRY debt):** `buildTurnContext` forwards `memoryBlock`/`historyTurns` to the unified agent path UNTRIMMED — no legacy `config.recall.promptMaxTokens` cap — because Gemini's ~1M-token context window doesn't need it; volume is already bounded by RecallService's own budget (`maxItems`/`tokenBudget`) plus the `channelContext.promptRecentCount` history cap. The direct-OpenAI path (`ChatService.chat`'s fallthrough, used when the sidecar is disabled/unhealthy or for non-channel-voice personalities) INTENTIONALLY keeps `_buildGroupSystemPrompt`'s `promptMaxTokens` trim, since it's the unhappy-path fallback on a smaller-window, cost-sensitive model.

**Sandbox isolation:** Kata Containers, specifically `runtimeClassName: kata-qemu-runtime-rs` (Kata's Rust runtime — statically linked, no glibc coupling). Each `run_in_sandbox` call lands in its own tiny QEMU/KVM guest. Originally specified for gVisor, swapped to Kata on 2026-04-29 because Harvester's immutable SLE Micro host OS makes installing `runsc` impractical, and KubeVirt-on-bare-metal is already the platform's native model. Sandbox pods carry `dynatrace.com/inject: "false"` to keep OneAgent out of ephemeral guests (otherwise PID 1 doesn't release on container exit, ballooning wall-clock per execution to ~120s). See `k8s/sandbox/README.md` for the full Kata install play-by-play including the RKE2 containerd-template patch, the `kvm_amd sev=0` workaround for AMD hosts, and the smoke-test recipe. Cold start adds ~1.5–3s per call (VM boot); the agent prompt is aware of this so the model doesn't think the call hung.

**Toggle:** `AGENT_ENABLED=false` reverts channel-voice to direct OpenAI immediately. The `AgentClient` health-polls every 5s and considers the sidecar unhealthy after 30s without a successful Health response, falling through to direct OpenAI when the sidecar is gone.

**Sidecar internals moved to `agent-sidecar/CLAUDE.md` (2026-10-12) — read it before changing the sidecar.** It holds the health breaker, K8s API timeouts, the GEAP backend and 503 retries, sandbox disposition and web search. The short form:
- **Health means "Chat works", not "the port is open":** `Health` reports a consecutive-failure breaker over observed `Chat` outcomes, with a load-bearing half-open. Do NOT "fix" it with `healthy = self._agent is not None`, and keep the explicit `except asyncio.CancelledError` in `AgentServicer.Chat`.
- **Gemini runs on GEAP (Vertex), not the consumer API:** `GOOGLE_CLOUD_LOCATION=global`, `GEMINI_API_KEY` blanked in the sidecar, production model `gemini-3.8-flash`. The bot's ImagenService/LyriaService still use the consumer key.
- **The sandbox is a LAST resort** (`TOOL_AVAILABILITY_PREAMBLE`); web search is ADK's plain `google_search`. **Never `GoogleSearchTool(bypass_multi_tools_limit=True)`** — it crashes in ADK 2.10.
- **The exec/attach websocket ignores `_request_timeout`;** the bound is the `_install_ws_connect_timeout` monkeypatch in `k8s_client.py`, pinned by `tests/test_k8s_client_timeouts.py`.

**Degradation is announced, never silent:** three paths can hand the user something other than a normal agent reply, and each now says which. (1) Agent RPC failure → `ChatService.chat` falls through to direct OpenAI and attaches `result.fallback` naming the substitute model; the log line names it too. (2) `fallback_occurred` on `ChatResponse` is real plumbing now — the sidecar sets it when a turn ran on the generic `base.txt` instead of the bot's learned channel-voice `system_prompt`. (3) `buildTurnContext` throwing no longer silently strips personality + memory + history: the turn still runs (degraded-but-working is correct) but it is logged at error with the stack and flagged to the user. `bot.js` renders `result.fallback.notice` supplied by ChatService — it used to hardcode "Local LLM unavailable" for every fallback, mislabelling agent failures as a problem in an unrelated feature.

**Sidecar:** single-replica `Recreate` Deployment — concurrency state is in-process; **do not scale**.

**Tunables (sandbox-config ConfigMap):** `SANDBOX_INLINE_OUTPUT_CHARS`, `SANDBOX_WALL_CLOCK_SECONDS`, `SANDBOX_PER_USER_CONCURRENCY`, `SANDBOX_GLOBAL_CONCURRENCY`, `SANDBOX_MEMORY_LIMIT`, `SANDBOX_CPU_LIMIT`, `SANDBOX_BASE_IMAGE`, `SANDBOX_TRACE_RETENTION_PER_USER`, `SANDBOX_AGENT_TURN_CALL_BUDGET`. Health-breaker knobs (sidecar env, defaults are sane): `AGENT_HEALTH_FAILURE_THRESHOLD` (3), `AGENT_HEALTH_COOLDOWN_SECONDS` (60), `AGENT_CHAT_TIMEOUT_SECONDS` (540 — must stay under the bot's 600s `chatDeadlineMs`).

**Reaction reveal:** on a bot reply that ran code, react with 🔍 (source code), 📜 (stdout + stderr if non-empty), or 🐛 (stderr only) to get the artifact attached.

**Trace storage:** MongoDB `sandbox_executions` (one doc per call). The retention loop in the sidecar demotes >N (default 50) traces per user — older docs keep `exit_code`/`stdout`/`stderr`/`duration_ms` but null out `code`, `stdin`, `env_keys`, `egress_events`, `runtime_events`, `agent_rationale`. The `runtime_events` field is empty by default under Kata (no built-in syscall-deny telemetry); the field is reserved for future `auditd`-in-guest signals.

**Manifests:** `k8s/sandbox/` (tracked) — see its README for the kata-deploy prereq, apply order, and the two small edits the bot Deployment + NetworkPolicy need.

## Star Citizen Knowledge (sc-knowledge)

Spec: `docs/superpowers/specs/2026-09-26-star-citizen-knowledge-design.md`. A third, NEW Python service (`sc-knowledge`, `python:3.14-slim`, FastMCP, stateless streamable HTTP at `:8080/mcp` + `GET /healthz`) that both the agent sidecar and the voice sidecar attach to as an MCP toolset, so channel-voice chat and voice sessions can answer Star Citizen questions with live game data instead of stale parametric knowledge.

**Seven game-data tools** (plus the three member-hangar tools `sc_member_hangar` / `sc_member_fit_check` / `sc_pledge_leaderboard`, see "Member hangar" below)**:** `sc_find_item` (items/components via the Star Citizen Wiki API with embedded UEX shop prices; SHIPS/VEHICLES resolve via UEX `vehicles` + `vehicles_purchases_prices` — e.g. "where can I buy a Scorpius" → New Deal, Lorville), `sc_compare_components` (shield/power_plant/cooler/quantum_drive/radar/weapon/missile, stat paths verified against live data, lower-is-better stats sort ascending; `purchasable_only=True` keeps only items with a current UEX shop buy price), `sc_faction_missions` (rank ladder + missions ranked by rep/min, outliers >3× median flagged with a caveat rather than silently trusted), `sc_trade_routes` (commodity/terminal-first resolution, profit capped by cargo SCU + budget aUEC, a Pyro `lawless` flag), `sc_commodity_prices`, `sc_location_shops` (what's sold at a place, and what's unique to it), and `sc_org_guides` (BM25 section search over the org's own curated guides).

**Server internals moved to `sc-knowledge/CLAUDE.md` (2026-10-12) — read it before changing the service.** It holds `sc_location_shops` resolution and exclusivity rules, cache TTLs and stale-on-error, the `/mcp` Host allow-list, `/healthz`, outlier flagging and vehicle ambiguity. The short form: an in-cluster `421 Invalid Host header` is the server's `SC_ALLOWED_HOSTS` list, not the NetworkPolicy (a renamed Service or new caller hostname must be added there); `/healthz` never touches upstream; expired cache entries are served with `stale: true` rather than failing. The voice sidecar's SC tool-call plumbing is in `voice-sidecar/CLAUDE.md`.

**Sources — and why NOT p4k/datap4k/erkul:** UEX (`api.uexcorp.uk/2.0`) for prices/trade/vehicles, the Star Citizen Wiki API (`api.star-citizen.wiki/api`) for item/vehicle/mission/faction data, and the org's own curated guides for org-specific procedure knowledge. Unpacking the game's `.p4k`/`datap4k` archives or scraping erkul.games was deliberately avoided — both require either bundling extracted game assets (a licensing and staleness liability) or a scraper that breaks on every patch; UEX + the Wiki API are maintained, versioned, patch-aware public APIs that already do that work. **The one deliberate exception is the hangar ship-wireframe pipeline** (`tools/wireframes/`, see `tools/wireframes/CLAUDE.md` and the HARD RULE under "Member hangar" below): the owner runs StarBreaker extraction locally to get real hardpoint positions, and the extracted GLBs/bundles are kept out of the repo and images and served only from a private store to a gated site — the exception does not extend to sc-knowledge or its data.

**Org guides — privacy is load-bearing, not incidental:** the org's curated guides are PRIVATE PDFs kept in repo-root `OrgGuides/` (git- and docker-ignored — this repo and its images are PUBLIC). They are converted to text and synced into a Kubernetes ConfigMap (`sc-org-guides`) by `scripts/sync-org-guides.sh` (pdftotext, 900 KB guard, `kubectl apply --server-side` — a client-side apply copies the whole ConfigMap into the 256 KiB-capped last-applied annotation and fails far below the guard), mounted read-only at `/guides` (`SC_GUIDES_DIR`) on sc-knowledge, and hot-reloaded on mtime change within 60s — adding or updating a guide is "drop a PDF, rerun the script," no redeploy. Guide text is never committed to git, never baked into an image, and never allowed into this documentation: refer to guide content only generically (as here), never by title or excerpt.

**Flags and secrets (both sidecars):** `SC_KNOWLEDGE_ENABLED` (default `false`) and `SC_KNOWLEDGE_URL` (default the in-cluster sc-knowledge Service) gate attachment on the agent sidecar and the voice sidecar independently — each is reversible on its own. `UEXCORP_BEARER` (optional, raises UEX rate limits) lives in Secret `sc-knowledge-secrets`, sourced from the repo's own `.env`, never committed.

**Isolation guarantee — probe-gated, never fails Chat:** the agent sidecar's `ScToolsProvider` builds the MCP toolset ONCE at startup, then gates *attachment per turn* on a cached availability check (30s cache): a `/healthz` probe (2s timeout) AND a real `get_tools()` on the toolset that must list at least one `sc_*` tool (5s bound; any exception/timeout/empty listing → unavailable). `/healthz` alone is not enough — an MCP-path-only failure (e.g. the Host allow-list 421, `sc-knowledge/CLAUDE.md`) leaves it green while every tool silently fails to load under a preamble promising them. sc-knowledge being down degrades a turn to `SC_TOOLS_UNAVAILABLE_NOTE` (no tools, model still answers) rather than failing the whole `Chat` RPC or tripping the agent health breaker (`agent-sidecar/CLAUDE.md`). The toolset itself is a **non-closing proxy**: ADK's `Runner.close()` would otherwise close the shared MCP toolset after every single turn (it's built once, per-turn `Runner`s don't own it), so a wrapper intercepts `close()` as a no-op and the real toolset is only closed at process shutdown. Voice mirrors this with its own `ScToolExecutor`, opening a fresh MCP session per tool call (bounded, see `voice-sidecar/CLAUDE.md` "Star Citizen tool calls") rather than holding one shared session across a whole Live conversation.

**MCP timeouts — 3s / 15s, not the library defaults:** the `mcp_registry` profile for this toolset (`channel_voice`, auth-less) sets per-server `timeout=3` and `sse_read_timeout=15`. A hung sc-knowledge call inside a live voice or chat turn is worse than a fast, honest failure — 3s is enough for a normal MCP round trip against an in-cluster service, and 15s bounds how long a streaming response can be read before the caller gives up, so one bad upstream call can't stall a turn indefinitely.

**Sandbox avoidance — three independent layers, because any one alone is fixable but fragile:**
1. **Pre-computed tool results.** The agent's system prompt and the `sc_*` tool results themselves are the intended path to SC data — the model is never told "go fetch this yourself."
2. **A host-side backstop in `RunInSandboxTool`:** code/stdin matching `SC_DATA_HOST_PATTERN` (`uexcorp.space|uexcorp.uk|star-citizen.wiki|sc-trade.tools|scunpacked|starcitizen.tools|erkul.games|cstone.space|sc-craft.tools|robertsspaceindustries.com|spviewer.eu|scmdb.net` — the last six widened 2026-09-28 after the model was caught scraping those community sites through the sandbox for questions no `sc_*` tool covered) is refused BEFORE the concurrency budget or orchestrator are touched, returning `exit_code -4` / `use_sc_tools` — no pod is ever spawned for it, and the refusal still counts toward attempt telemetry so a model that keeps trying is visible. The refusal message now points at `sc_location_shops` and `google_search` (see `agent-sidecar/CLAUDE.md` "Sandbox disposition and web search"), not just the original five tools.
3. **A hard eval gate.** `eval/eval_sc.py` fails the suite if `sandbox_attempts_total` is ever nonzero for an SC-answerable prompt, and the production DQL check `fetch spans | filter span.name == "agent.chat" and toLong(sc.tool.calls) > 0 and sandbox.invoked == true` should read ~0 — a model routing SC questions through the sandbox instead of the tools is a regression this DQL line is meant to catch immediately, not eventually.

**2026-09-28 hallucination incident and fix:** trace `d912da65f299ceea9a78c4d413058069` asked "are there any ship parts or fps equipment that are unique to Levski" — SC tools were attached, but none of the original six covered "what's sold at this place," so the model made one `run_in_sandbox` call whose code was only a comment (`# Let us check what UEX or star citizen tools have for Levski`) and then answered from stale training memory ("Levski vaulted in 3.12" — false; Levski has 22 live UEX terminals with 77 exclusive items). Root cause was two gaps, both closed the same day: no tool answered location-inventory questions (fixed by `sc_location_shops`, see `sc-knowledge/CLAUDE.md`), and the text agent had no web-search fallback for genuinely uncovered SC questions, so its prompt's "use web search" instruction had nothing behind it (fixed by native `google_search`, see `agent-sidecar/CLAUDE.md` "Sandbox disposition and web search"). Every SC-facing prompt (`sc_tools_preamble`, `sc_tools_unavailable_note`, and this section's voice note) now also states outright: the model's Star Citizen training knowledge is years out of date, and it must never assert from memory that something is vaulted, removed, not in the game, or located somewhere — tool and search results beat memory when they disagree.

**Disputed game mechanics — search, then defer; never argue from memory (both surfaces, since 2026-09-29):** in a voice session a player described NAV-mode quantum-drive behaviour they were seeing live ("engines max at 205; spool the quantum drive to 100% and I can go 1,000 m/s") and the model argued ~10 turns from stale memory ("probably your afterburner", "my data says otherwise"), even after "recheck your sources" — with `tool_calls=0`, since no `sc_*` tool covers flight mechanics. One rule now rides on both surfaces: voice `SC_VOICE_NOTE` (`voice-sidecar/src/live_bridge.py`) and the text agent's `_sc_dispute_rule` inside `sc_tools_preamble` / `sc_tools_unavailable_note` (`agent-sidecar/src/agent.py`). Search variant (voice always; text when `google_search` is attached): look mechanics up with search rather than memory, look it up again when a player disputes a claim or describes what they see in-game right now, and if still unconfirmed defer to the player's live observation. The re-check names whichever sources are actually attached: "sc_* tool or google_search" / "tool or search" when the `sc_*` tools are on (so a dispute about something a tool covers re-calls the tool rather than only searching), plain "search again" in the text agent's sc-unavailable note (`_sc_dispute_rule(tools_attached=False)`, which also drops the "anything the sc_* tools don't cover" scope) and in voice's standalone note. No-search variant (`SC_TOOLS_PREAMBLE` / `SC_TOOLS_UNAVAILABLE_NOTE`): don't repeat the claim from memory — say it can't be verified live and defer. **Voice: exactly once in every session.** `SC_VOICE_NOTE` is only appended when SC declarations are attached, so when they are NOT (sc-knowledge off/unavailable, empty declarations, or the search-only connect fallback) `_live_config` appends the standalone `SC_MECHANICS_VOICE_NOTE` instead — same rule (Google Search is always attached in Live, so the search variant always applies), names no `sc_*` tool. Exactly one of the two is appended per config, never both; the dispute sentence's tail is the shared constant `SC_DISPUTE_TAIL`, and `tests/test_live_bridge_mechanics_note.py` counts it to pin exactly-once across SC-attached, SC-absent and fallback. Consequence: the voice `system_instruction` is never just the bare persona any more, even with SC and control tools both off (an empty persona is dropped before joining, so there is no leading blank line). Eval: `sc_eval_set.py` carries an `sc_dispute` case that replays the incident's exchange via per-case `history` (see `agent-sidecar/eval/README.md`); it is scored like `uncovered_sc` with the soft `NO WEB SEARCH in N/M runs` flag, no new gate.

**Adding SC Trade Tools (or another future SC MCP server) later:** the `mcp_registry` is a per-profile registry keyed by name (`channel_voice` is sc-knowledge's entry today) — a second server is added as its own registry entry with its own `token_attr` for auth, alongside sc-knowledge rather than folding into it. No code change to `ScToolsProvider`/`ScToolExecutor` should be needed beyond registering the new entry.

**Deploy rules (same posture as the sandbox/voice sidecars above):** apply only from the deployed overlay (`k8s/overlays/deployed/sc-knowledge-{deployment,service,networkpolicy}.yaml`), never the tracked `k8s/sc-knowledge/` placeholders; `RollingUpdate` (sc-knowledge is stateless, unlike the agent sidecar); image tagged with the git short SHA, never `:latest`; NetworkPolicy egress rules added on BOTH the agent and voice sidecars for sc-knowledge port 8080, and sc-knowledge's own NetworkPolicy only accepts ingress from those two sidecars. Rollout order was sc-knowledge first, then flip `SC_KNOWLEDGE_ENABLED=true` on the agent sidecar (verify via text chat + the `sc.tool.calls`/sandbox DQL check above) and only then on the voice sidecar (verify via `scripts/smoke-voice-sc.js`) — each flag is independently reversible if its half regresses.

### Member hangar (per-member ship loadouts, since 2026-10-09)

Spec: `docs/superpowers/specs/2026-10-09-member-hangar-design.md` (project 1 of 3). Each member's Star Citizen ships and what is fitted in them, answered by tool in text AND voice: "what's a purchasable upgraded shield for my Harbinger?" (UC1), "I just looted a Hemera quantum drive, is it a usable upgrade for any of my ships?" (UC2), "I can't use this Hemera, can Micro?" (UC2b), "what's on my Connie?" (UC4).

**Where the detail lives (moved out of this file 2026-10-12 — read the matching file BEFORE changing that area):**
- `hangar-service/CLAUDE.md` — the Cloud Run service: auth, data model, catalog and slot rules, the web editor's server side (Discord OAuth, sessions, CSRF, spviewer import), wireframe storage/upload/slot matching, the RSI (HTF) import with the pledge ledger and leaderboard, slots from fitted items.
- `hangar-editor/CLAUDE.md` — the SPA at `https://hangar.aklabs.io`: Terminal view, wireframe viewer, `/admin/models`, and the follow-up queue.
- `tools/wireframes/CLAUDE.md` — the wireframe pipeline and the `.swf.gz` bundle format.
- `docs/hangar.md` — everything outside those directories: cluster credentials, the sc-knowledge hangar tools, prompting, chat edits (agent + voice sidecars), the bot's `/hangar` command. **Nothing auto-loads it:** read it before touching hangar code in `sc-knowledge/`, `agent-sidecar/`, `voice-sidecar/`, `commands/slash/HangarCommand.js` or `services/HangarClient.js`.

**Rules that hold everywhere (short form; the reasons are in the files above):**
- **Cloud Run, NOT the cluster:** `hangar-service` in GCP project `revenant-discord-bot-2`, `us-central1`, image tagged with the git short SHA (never `:latest`), min-instances 1.
- **The token audience is exactly `https://hangar-service-hvmf2jpuca-uc.a.run.app`** (no trailing slash); callers mint for and call that URL — the other `run.app` form is a 401. Health is `/health`, not `/healthz`.
- **Cloud Run's invoker IAM check is OFF on purpose** (`--no-invoker-iam-check`); the app's own authentication is the only gate. Do NOT re-enable the check — it locks every browser out.
- **Credentials:** the `hangar-api@` key lives only in Secret `hangar-api-sa`, mounted at `/var/secrets/hangar/key.json` in all four callers (bot, sc-knowledge, agent sidecar, voice sidecar). It must be readable by uid 1000 (`defaultMode: 0400` breaks it), each caller pod needs NetworkPolicy egress to `oauth2.googleapis.com` and `*.run.app` on 443, and key rotation needs pod restarts.
- **The acting member of a chat edit is supplied by trusted plumbing, NEVER a tool argument** (text: `ChatRequest.user_id`; voice: `SetSpeaker.user_id`, else the session opener). No cross-member chat edits, admins included.
- **Every chat edit tool is a write:** a `maybe_applied` result must not be retried blindly (a second `hangar_add_ship` adds a second ship).
- **Ship data is tool-called, never injected into a prompt.** The sc-knowledge hangar client is read-only (a test pins it).
- **Keep-in-sync pairs:** sc-knowledge's fit check ↔ hangar-service `check_compatible`; the ship resolver `hangar-service/src/ship_resolve.py` ↔ `sc_member_hangar`'s; image hosts have one source, `IMAGE_HOSTS` in `hangar-service/src/catalog.py` (the CSP is built from it).
- **`scripts/registerCommands.js`:** run it from the bot pod. Registration replaces the whole command set, so running it without `HANGAR_API_URL` silently DROPS `/hangar`. A new subcommand needs a re-run; a new sc-knowledge tool needs a voice sidecar restart (declarations load once at startup).
- **Pledge costs are visible to every signed-in guild member and to the bot by the owner's deliberate choice** — don't add per-member hiding without asking.
- **Secrets:** `hangar-discord-client-secret` and `hangar-session-key` live in Secret Manager only. The image build context is the repo root, so `hangar-service/Dockerfile.dockerignore` is an allow-list and the root ignore files cover `.env_*`.
- **HARD RULE: extracted game data never enters the repo or an image.** `.glb` exports, `.swf.gz` bundles and any geometry derived from them stay on the owner's machine and in the private model store. **Docker ignore patterns are root-anchored (unlike gitignore): a bare `*.glb` only matches the context root.** So BOTH the root `.dockerignore` (the bot image, `COPY . .`, PUBLIC) and `hangar-service/Dockerfile.dockerignore` (an allow-list, but its re-included trees such as `hangar-editor/**` and `hangar-service/src/**` can still hold stray files) carry `**/*.glb` and `**/*.swf.gz`, and HangarXPLOR `shiplist.json` exports (personal pledge data) are ignored in git and in both Docker contexts (`shiplist.json` and `**/shiplist.json`); `tools/` is excluded wholesale from the bot image. This was verified with a scratch `COPY . /ctx` build using the real ignore files and marker files at the root, in `scripts/`, `hangar-editor/public/` and `hangar-service/src/` (the old bare patterns leaked the markers and a root `shiplist.json`; the `**/` patterns leak nothing). Re-run that check if an ignore file changes. The tests build ALL geometry in code (`tools/wireframes/tests/synth.py`); never add a real export, or anything derived from one, as a fixture, and never force-add. **Why:** this repo and its Docker Hub images are PUBLIC; the owner accepts the licensing risk of using extracted geometry only for a private, Discord-gated site, not for redistribution.

## Voice (discord-article-bot-voice sidecar)

When `VOICE_ENABLED=true`, `/voice join` puts the bot in a Discord voice channel and routes audio through a **second, separate** Python gRPC sidecar — `discord-article-bot-voice` — that hosts one Gemini Live session per active voice channel. It is a distinct Deployment from the agent sandbox sidecar (`discord-article-bot-agent`): they solve different problems and have opposite scaling needs.

**New-sidecar rationale (RollingUpdate/scalable vs. the agent sidecar's Recreate/do-not-scale):** the agent sidecar keeps sandbox-orchestration concurrency state in-process, so it must stay single-replica `Recreate` and never scale. The voice sidecar instead holds long-lived, real-time gRPC audio streams for as long as the bot sits in a voice channel — a `Recreate` rollout would drop every live call. It ships as its own `RollingUpdate`, horizontally scalable Deployment (`k8s/voice/voice-deployment.yaml`) for exactly that reason.

**Where the detail lives (moved out of this file 2026-10-12 — read the matching file BEFORE changing that area):**
- `docs/voice.md` — the bot side (`services/VoiceService.js`, `services/voice/`, `commands/slash/voice.js`): wake word, VAD, turn rhythm, floor control, pre-roll, session-open recovery, `/voice` commands, speaker-name resolution, Phase 4 deferral, voice control commands, tunables, the deploy checklist and the real-model smoke tests. **Nothing auto-loads it for `services/VoiceService.js`.**
- `voice-sidecar/CLAUDE.md` — the sidecar side: GEAP backend, Live model, session resumption and compression, grounding logs, speaker markers, hangar edit plumbing.

**Rules to know without opening them (short form; the reasons are in the files above):**
- **Live model: `gemini-3.8-live`, which serves ONLY in `us-central1` on this project** — the voice sidecar sets `GOOGLE_CLOUD_LOCATION=us-central1` while the agent sidecar stays on `global`. Changing `VOICE_LIVE_MODEL` means re-checking the location and re-running `scripts/smoke-voice-sc.js`, `smoke-voice-control.js` and `smoke-voice-identity.js`.
- **3.8-live follows prompts literally.** The persona note must NOT say "never mention that you receive it" about the `[SPEAKER: …]` marker (the model then refuses to say who is speaking); a test in `__tests__/services/VoiceService.test.js` pins the wording.
- **Deploy from `k8s/overlays/deployed/` only. Do NOT run `kubectl apply -f k8s/voice/`:** the tracked manifest is pinned to the placeholder tag `REPLACE_WITH_SHA`, so the rollout stalls in `ImagePullBackOff` and the Service and NetworkPolicy revert to placeholders. Full checklist: `docs/voice.md`.
- **The voice sidecar loads sc-knowledge tool declarations once at startup** — restart it after adding or changing an `sc_*` tool.
- **Phase 4 deferral is off** (`VOICE_DEFERRAL_ENABLED` default false). It needs `VOICE_ALLOW_BARGE_IN=true`, and the 700 ms default threshold sits below the ~768 ms VAD-hangover noise floor — read `docs/voice.md` "Turn deferral" before measuring or enabling it. Spec: `docs/superpowers/specs/2026-08-14-voice-phase4-deferral-design.md`.
- **Voice control commands** ("that's all", "go quiet for ten minutes", `/voice resume`): a pending command executes only after the spoken confirmation has played, never on the bare `turnComplete` of the tool-call turn. Spec: `docs/superpowers/specs/2026-09-27-voice-control-commands-design.md`.
- **`VOICE_MAX_SESSION_SECONDS` (default 600) is a hard cap** that ends every session, including `/voice listen`, regardless of resumption.
- **Stale audio is never replayed:** frames that arrive during a reconnect are dropped, and `g.pending` is bounded drop-NEWEST (the pre-roll is drop-oldest; the difference is deliberate).

**Bot image base — Debian slim (glibc), NOT Alpine:** `@discordjs/voice` ^0.19.0 requires Node ≥22.12. The repo-root `Dockerfile` uses Node 24 LTS on Debian — `node:24-trixie` (build stage) / `node:24-trixie-slim` (runtime) — NOT Alpine (musl): `onnxruntime-node` (the openWakeWord engine) ships glibc-only prebuilt binaries (`libc.so.6`/`libm.so.6`, GLIBC_* symbol versions) with no musl variant, so it fails to load on Alpine. The same applies to the other native modules in the image: `@discordjs/opus`, `sodium-native`, and `better-sqlite3` (mem0ai v3 loads it on import even with history disabled). Any manual/local run of the bot needs Node ≥22.12.0 on glibc.

**Manifests:** `k8s/voice/` (tracked) — see its README for the apply order, the required bot ConfigMap/Secret/NetworkPolicy edits, and the build/push command.

## Member identity registry (`/whois`)

**Member identity registry:** Mongo collection `member_identities` (`{_id: discordId, addressName, aliases[], updatedBy, updatedAt}`), owned by `services/MemberIdentityService.js` (`bot.memberIdentity`, constructed in `bot.js` before `SpeakerNames`). **Cache:** loaded fully into memory (reads are sync and never touch Mongo); startup load retries every 3s until Mongo answers, then refreshes every 60s; writes are serialised behind a write lock and reload the cache themselves, and a stale-load guard stops an older in-flight load from clobbering a newer write. Writes return `unavailable` when Mongo is down (do not gate writes on `isLoaded()`). **Validation (`services/identity/validation.js`):** names are sanitised like `SpeakerNames` (emoji/tags/zero-width removed, separator characters stripped so a name cannot forge a `[Name · id]` label, 24-char cap), must contain a letter, be 2+ chars (longer names are shortened to 24), and contain no run of 15 or more digits (rejects pasted Discord IDs, another label-spoofing vector); max 10 aliases per member. **Collision rule:** a name held by ANOTHER member's addressName or alias (case-insensitive) is rejected with `taken` and the holder's ID; an alias equal to the member's own address name is a no-op. **`/whois`** (`commands/slash/WhoisCommand.js`): `show [member]`, `address <name> [member]`, `alias-add <alias> [member]`, `alias-remove <alias> [member]`; all replies ephemeral; anyone edits themselves, editing another member requires `BOT_ADMIN_USER_IDS` (`isAdmin`), `show` is open to everyone; `show` for a member with no record says so and prints the name the bot currently resolves for them. **Seed script:** `node scripts/seed-member-identities.js` (dry run) / `--apply` inserts `addressName` from `VOICE_SPEAKER_NAMES` for IDs with no doc and never overwrites (seed docs carry `updatedBy: 'seed'`); run it from the bot pod (needs the Mongo URI).

## AI Models (updated 2026-09-26)

- **OpenAI (bot):** `OPENAI_MODEL=gpt-6-luna` everywhere (chat fallback, summaries, catch-me-up, voice-profile analysis, voice search, image-prompt analysis, Mem0 extraction). gpt-4o-mini / gpt-4.1-mini / gpt-5-mini / gpt-5.1 are deprecated. `utils/openaiModels.js` is the single source for the default model id and the price table (old ids are kept in the table because historical Mongo usage rows reference them).
- **gpt-6-* are reasoning models:** they 400 on `temperature` (≠1), `top_p`, and `max_tokens` (chat wants `max_completion_tokens`), and reasoning tokens count against any output cap — a tight cap yields EMPTY text. Never send those params; each call site pins its effort through `reasoningParams()` (which omits effort if someone overrides the model with a non-reasoning one). `OPENAI_REASONING_EFFORT` (default `low`) sets chat effort. `__tests__/openaiCallSites.test.js` pins every call site's request params. tiktoken falls back to `o200k_base` for model ids it doesn't know.
- **openai npm held at 6.x:** `@traceloop/instrumentation-openai` (and the OTel openai instrumentation) only patch `openai >=4 <7`; v7 would silently drop the LLM spans in Dynatrace. Auto-instrumentations' own OpenAI instrumentation is disabled in `tracing.js` so calls aren't traced twice.
- **Gemini (bot, consumer `GEMINI_API_KEY`):** image `gemini-3.1-flash-image`, admin image `gemini-3-pro-image` (GA; the `-preview` ids passed their shutdown dates), music `lyria-3.5` ($0.08/song — note the live model list says `lyria-3.5` although docs call it `lyria-3.5-pro-preview`), test-voice TTS `gemini-3.8-flash-tts` (returns a complete WAV, not raw PCM). Veo stays `veo-3.1-*-001` on Vertex (newest GA) and now goes through `@google/genai` in Vertex mode (`@google-cloud/vertexai` is deprecated and removed).
- **Agent sidecar (GEAP):** `gemini-3.8-flash`. **Voice sidecar:** `gemini-3.8-live` in `us-central1` only (since 2026-10-10; was `gemini-live-2.5-flash` — see `voice-sidecar/CLAUDE.md` "Live model").
- **Unchanged on purpose:** embeddings stay `text-embedding-3-small` (switching forces re-embedding every Qdrant collection); ElevenLabs stays `music_v1` (`music_v2*` uses a different, chunk-based composition-plan format — not drop-in).

## Mem0 v3 + Qdrant 1.18 (since 2026-09-26)

- **mem0ai v3 renamed the payload owner keys** `userId`/`agentId`/`runId` → `user_id`/`agent_id`/`run_id`. Memories written by v2 are invisible to v3 lookups until migrated: `node scripts/migrate-mem0-v3-payload.js` (dry run) then `--apply` (port-forward Qdrant first). It adds the new keys and keeps the old ones for rollback; safe to re-run.
- v3 API: `search()`/`getAll()` take `{ topK, filters: { user_id, agent_id, run_id } }`. `Mem0Service` keeps `getAll` at 100 (v3 default 20 would truncate `/memories`) and searches with `threshold: 0` (plain top-k, as before).
- v3 creates `discord_memories_entities` alongside the main collection, logs once that keyword search is disabled on the pre-existing collection (semantic search unaffected), and would phone home to PostHog — `MEM0_TELEMETRY` defaults to `false` in code.
- **Qdrant server is 1.18.x.** Upgrade ONE MINOR VERSION AT A TIME (storage compat is only guaranteed across one minor); 1.16 is the mandatory RocksDB→Gridstore bridge before 1.17+. After each restart a collection can show `grey` (optimizations queued but not triggered) — a no-op `PATCH /collections/<name>` with `{"optimizers_config":{}}` kicks it. The deployment is `Recreate` (RWO PVC) with 8 CPU / 8Gi limits: at 2 CPU / 4Gi an `irc_history` (~378k × 1536) segment merge ran pegged near the memory ceiling. Take per-collection snapshots (`POST /collections/<c>/snapshots`, then download) before any server upgrade — the in-pod `/qdrant/snapshots` dir is not on the PVC.

## Embedding Data Quality Validation

Run the validation script to check health of all Qdrant collections:

```bash
kubectl port-forward svc/qdrant 6333:6333 -n discord-article-bot &
node scripts/validate-embeddings.js        # Read-only check
node scripts/validate-embeddings.js --fix  # Delete expired points
```

Checks: expired point accumulation, required payload fields, content quality, indexing status, duplicate detection.

## Slash Command Development Guidelines

When creating or modifying slash commands:

1. **Service method signatures**: Verify correct method names and parameter order by checking the service implementation
   - Example: `resetConversation(channelId, personalityId)` - channelId comes first
   - Example: `listUserConversations(userId, guildId)` - requires guildId parameter

2. **Service enabled checks**: Optional services (Mem0, Qdrant, etc.) need `isEnabled()` checks at the start of execute()
   ```javascript
   if (!this.mem0Service.isEnabled()) {
     await this.sendReply(interaction, {
       content: 'Memory feature is not enabled on this bot.',
       ephemeral: true
     });
     return;
   }
   ```

3. **Error handling patterns**: Some errors should not have "Error:" prefix
   - Conversation limit reasons ('expired', 'message_limit', 'token_limit') are informational, not errors

4. **Formatter usage**: Use service formatters (e.g., `qdrantService.formatResult()`) for consistent output

## Discord Embed Limits

- Embed field name: max 256 characters
- Embed field value: max 1024 characters (NOT 4000)
- Empty field values cause validation errors - always provide fallback text

## Testing

- Slash command tests need to mock all service methods including `isEnabled()`
- Global slash commands take up to 1 hour to propagate; use `DISCORD_TEST_GUILD_ID` for faster testing

## Debugging Common Issues

### Duplicate Messages / Multiple Replies

**ALWAYS CHECK FIRST**: Are there multiple bot instances running with the same Discord token?

```bash
# Check ALL namespaces for bot deployments
kubectl get pods -A | grep -i discord
kubectl get deployments -A | grep -i discord
```

Multiple instances with the same token will ALL receive Discord events and ALL respond, causing:
- Duplicate replies (different content if conversation contexts differ)
- One reply faster than the other
- Replies with stale/old conversation context

**Root cause example (Dec 2025)**: A forgotten deployment in `default` namespace ran alongside the production deployment in `discord-article-bot` namespace for 10 days, causing duplicate replies to every message.
