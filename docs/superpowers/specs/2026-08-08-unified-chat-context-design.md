# Unified Chat Context — Design Spec

**Date:** 2026-08-08
**Status:** Approved (design), pending implementation plan
**Branch:** `feat/unified-chat-context`

## Goal

Make the channel-voice chat brain **always speak in the group's voice and reason with the group's memory**, whether a turn is text or voice — by having the bot forward its fully-resolved context (personality + memory + recent history) to the sidecar that runs the model, and keeping the sandbox a pure execution tool the model reaches for only when a correct answer genuinely requires it.

## Background / motivation

Production traces (2026-08-07) showed channel-voice replies that were generic-assistant in tone and claimed "I don't have access to chat history." The `gcp.vertex.agent.llm_request` spans proved why: the text agent path sends the model a generic `"You are a helpful assistant."` instruction and **only** the single user message — no personality, no memory, no history. Separately, ~50% of agent turns invoke no sandbox at all, and the worst-latency turn (58.6 s, 6 sandbox calls) was a document-authoring ask that should never have touched the sandbox.

Root cause: the bot assembles rich context (personality with dynamic voice-profile substitution, recency-aware recall, recent-turns buffer) **only for its direct-OpenAI path**; the agent (text) and voice (Live) sidecar paths receive a weaker subset or nothing. The design intent — "the sandbox is execution-only; the bot owns voice + memory via its prompts" — was only half-wired.

## Confirmed decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | **Unify onto one in-voice brain per modality; sandbox = a tool** | Tool-choice is the routing; voice+memory always present; no classifier, no re-voicing pass. Matches the stated intent. |
| Brain host | **Sidecars keep the model+tool loop; the bot forwards context** | Preserves dual-use (GEAP-Gemini `BLOCK_NONE`) and keeps GEAP creds isolated to the sidecar (post-`.env`-leak discipline). Moving the model into Node would refuse dual-use asks (OpenAI) or sprawl creds. |
| Context payload | **Resolved personality prompt + ranked recall block + recent structured turns** | Fixes both the "no history / no voice" gap and in-conversation follow-up continuity ("craft it from scratch"). Mirrors what the direct path already assembles. |
| Scope | **Both text (agent) and voice (Live) adopt the shared builder in this spec** | User opted for the single larger pass. Voice today uses a *static* prompt, recall without recency, and no history — this brings it to parity. |
| Sandbox disposition | **Keep the deployed answer-directly `TOOL_AVAILABILITY_PREAMBLE`** | It becomes the tool-usage guidance for the now-context-rich brain; the added memory/history should further reduce false-invocations. |

## Non-goals

- **Pre-flight classifier / router.** The unify approach eliminates the misroute *class*; a separate classifier is unnecessary.
- **Re-voicing pass.** Both brains run the channel-voice prompt, so output is already in-voice.
- **Giving the sandbox executor memory.** It stays a pure code/command executor (the user's invariant).
- **Moving the model call into the Node bot.**
- **Standalone sandbox-executor service.** Noted as a future convergence (both brains calling one executor as a tool) — not built here.

---

## Architecture

One **shared context-builder** in the bot is the spine. It produces the same context object for **three consumers**:

```
                          ┌─────────────────────────────────────┐
   personality (channel-voice, {VOICE_INSTRUCTIONS} → live voice profile)
   + RecallService.recall (recency-aware, ranked)               │
   + recent-turns buffer                                        │
                          └───────────────┬─────────────────────┘
                        shared context-builder → { systemPrompt, memoryBlock, historyTurns }
                                          │
         ┌────────────────────────────────┼─────────────────────────────────┐
         ▼                                ▼                                   ▼
  direct-OpenAI path            text agent path (gRPC ChatRequest)     voice path (gRPC SessionStart)
  (fallback; already            → sidecar ADK agent runs it,           → sidecar LiveBridge seeds it,
   uses this build)               run_in_sandbox as a tool               Gemini Live speaks it
```

The text agent sidecar and the voice sidecar stay **separate services** (unchanged lifecycles: text = `Recreate`/do-not-scale; voice = `RollingUpdate`/scalable). The sandbox stays a pure executor with no memory.

---

## Components

### 1. Shared context-builder (`services/ChatService.js`, extracted/reused)

The direct path already calls `_buildGroupSystemPrompt(personality, memoryContext, channelContext, sharedContext, voiceContext)` and `recallService.recall({ recentMessages, scope })` with the recent buffer. Extract a single method (e.g. `buildTurnContext({ userId, userTag, channelId, guildId, userMessage })`) that returns:
- `systemPrompt` — the resolved channel-voice prompt with `{VOICE_INSTRUCTIONS}` substituted from the live voice profile (via `VoiceProfileService`/`voiceContext`), plus channel/shared context blocks as today.
- `memoryBlock` — the ranked `RecallService.recall(...).block` (recency-aware: `recentMessages` populated from the recent buffer, **not** empty).
- `historyTurns` — the last N recent messages as `{ role, content }` (depth reuses existing config, e.g. `CHANNEL_CONTEXT_PROMPT_RECENT_COUNT`).

The direct path is refactored to consume this same method (no behavior change), so all three paths share one assembly and cannot drift.

### 2. Proto changes

**`proto/agent.proto` (+ sidecar copy) — `ChatRequest`:** add
- `string system_prompt`
- `string memory_context`
- `repeated Turn history` where `Turn { string role; string content; }`

**`proto/voice.proto` (+ sidecar copy) — `SessionStart`:** add
- `repeated Turn history` (it already has `system_prompt` and `recall_context`).

Both protos keep their existing fields; both define a local `Turn` message (separate packages, minor duplication is acceptable).

### 3. Text agent sidecar (`agent-sidecar/src/agent.py`, `server.py`)

- `Chat`/`process_chat` accept `system_prompt`, `memory_context`, `history`.
- Build the ADK agent with `instruction = system_prompt + "\n\n" + TOOL_AVAILABILITY_PREAMBLE`. If `system_prompt` is empty (e.g. an old client), fall back to the existing `_load_base_prompt()` — so the generic prompt is a safety net, not the operating prompt.
- Seed the turn's conversation with `history` (prior turns) and a `## Memory Context` block built from `memory_context`, then the user message. (Exact ADK seeding mechanism resolved in the plan.)
- `run_in_sandbox` tool + `BLOCK_NONE` config unchanged. `sandbox.invoked`/`sandbox.call_count` telemetry unchanged.

### 4. Voice sidecar (`voice-sidecar/src/live_bridge.py`, `server.py`)

- `SessionStart` handling seeds `history` turns alongside the `recall_context` it already seeds via `send_client_content(turns=..., turn_complete=False)`.
- No change to the fact that it uses `SessionStart.system_prompt` as the Live `system_instruction` — the change is that the **bot now sends the dynamically-built prompt** instead of the static `config.voice.systemPrompt`.

### 5. Bot voice wiring (`services/VoiceService.js`, `bot.js`)

- `VoiceService._startSession` calls the shared `buildTurnContext(...)` (scoped to the voice session's channel + waking user) instead of its current `recall({ recentMessages: [], ... })` + static `config.voice.systemPrompt`.
- `sendStart(...)` forwards `systemPrompt` (dynamic), `recallContext` (= `memoryBlock`), and the new `history` turns.
- `config.voice.systemPrompt` static fallback is retained only for when the builder yields nothing.

### 6. Offline eval harness (`agent-sidecar/eval/`)

- Extend `sandbox_eval_set.py` with the missed classes, labeled `direct`: **document/authoring** ("draft a doc for X", "write up the section", "craft it from scratch") and **context-dependent** ("based on our earlier discussion of X, …").
- Because behavior now depends on context, the runner supplies **representative `system_prompt` + `memory_context` + `history`** for these cases (so the eval reflects the production brain, not a context-less one).
- Success criteria unchanged: false-invocation on `direct` stays low (target ≤ ~15%, ideally ~0%), false-omission on `sandbox` near zero.

---

## Data flow (text turn, happy path)

1. Discord mention → `bot.js:_handleMentionChat` → `ChatService.chat('channel-voice', …)`.
2. ChatService calls `buildTurnContext(...)` → `{ systemPrompt, memoryBlock, historyTurns }`.
3. gRPC `ChatRequest(system_prompt, memory_context, history, user_message, …)` → text agent sidecar.
4. Sidecar agent runs **in-voice, with memory**; invokes `run_in_sandbox` only if a correct answer requires execution.
5. Returns in-voice `messageText` → ChatService → `_handleMentionChat` → `message.reply(...)`.

**Voice turn:** wake word → `VoiceService._startSession` calls `buildTurnContext(...)` → `SessionStart(system_prompt, recall_context, history, …)` → `LiveBridge` seeds prompt+recall+history into the Live session → speech in-voice, with memory.

---

## Error handling / fallback

- **Text sidecar unhealthy** → existing direct-OpenAI fallback (degraded: no dual-use, no sandbox — but the bot stays alive). Unchanged tradeoff.
- **Context-builder failure** (recall down, no history) → degrade gracefully to empty `memoryBlock`/`historyTurns`; the turn still runs with at least the personality prompt.
- **Old-client compatibility** → empty `system_prompt` falls back to `_load_base_prompt()` in the sidecar.
- **Token budget** → reuse the direct path's existing truncation/budgeting for the forwarded context; do not send unbounded history.

---

## Testing

- **Shared builder (bot):** unit tests that `buildTurnContext` resolves `{VOICE_INSTRUCTIONS}`, populates recency-aware recall (non-empty `recentMessages`), and returns the last-N history turns; the direct path still behaves identically after refactor.
- **Text sidecar:** the agent uses the passed `system_prompt` (not `base.txt`), seeds history + memory, and still exposes `run_in_sandbox`; empty `system_prompt` falls back.
- **Voice bridge:** seeds `history` turns in addition to recall; uses the passed dynamic `system_prompt`.
- **Offline eval:** the expanded set (document/authoring + context-dependent) is answered directly under representative context; false-invocation stays low.
- **Acceptance (live):** replay the document case (text) → in-voice draft, no sandbox, seconds; a "hey jarvis, based on our earlier chat about X…" (voice) → in-voice, uses memory.

---

## Deferred to the plan (intent settled)

- Exact ADK mechanism for seeding bot-supplied `history` into the per-turn text agent (session seeding vs. leading contents).
- Precise definition of "recent history" for a voice session (voice transcripts + associated channel, scoped by `channelId`).

## Future (noted, not built)

- Standalone sandbox-executor service both the text brain and the voice Live session call as a tool (Gemini Live supports session tools), converging execution onto one substrate.
