# Voice Control Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Spoken "end conversation" and "go quiet for N minutes" in Discord voice, recognised by Gemini Live tool calls AND a bot-side phrase backstop, enforced bot-side.

**Architecture:** The voice sidecar declares two local control tools and emits a new `Control` server event; the bot handles `Control` events and phrase matches through one idempotent `_requestControl`, executes after playback drains, and gates the idle wake-word branch with a per-guild `quietUntil`. `/voice resume` clears quiet.

**Tech Stack:** Node.js (discord.js, @grpc/proto-loader, Jest v30 — `--testPathPatterns`), Python 3.14 voice sidecar (google-genai Live, grpcio, pytest).

**Spec:** `docs/superpowers/specs/2026-09-27-voice-control-commands-design.md` (binding — read it; exact values live there).

## Global Constraints
- Proto: `message Control { string action = 1; int32 seconds = 2; }`, `VoiceServerEvent.oneof` field `Control control = 7`; actions exactly `"end"` / `"quiet"`.
- Tool names exactly `end_conversation` and `go_quiet` (param `minutes`, number).
- Quiet clamp 1–120 min; default 15 min; teardown after playback drain with a 10 s ceiling.
- Flags: bot `VOICE_CONTROL_COMMANDS_ENABLED` (default true), sidecar `VOICE_CONTROL_TOOLS_ENABLED` (default true).
- Flags off ⇒ byte-identical to today's behaviour (tests pin it).
- Never truncate log messages. Stage explicit paths only. Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Don't touch `k8s/overlays/deployed/` or `OrgGuides/`. Voice sidecar tests: `cd voice-sidecar && .venv/bin/python -m pytest -q` (baseline 116). Bot tests: `npm test` (baseline 1248).
- Read CLAUDE.md "Voice" section first — the bridge/VoiceService have load-bearing subtleties (pump close contract, `_resetToIdle`, `_botIsSpeaking`, floor control, `/voice listen` continuous mode).

---

### Task 1: Proto `Control` event + sidecar control tools

**Files:** `proto/voice.proto`, `voice-sidecar/proto/voice.proto` (if a copy exists — keep both identical), regenerated `voice-sidecar/src/voice_pb2*.py`, `voice-sidecar/src/config.py`, `voice-sidecar/src/live_bridge.py`, tests under `voice-sidecar/tests/`.

**Interfaces — Produces:**
- Proto `Control` + `VoiceServerEvent.control = 7`.
- Config `control_tools_enabled: bool` (env `VOICE_CONTROL_TOOLS_ENABLED`, default true).
- `live_bridge`: `CONTROL_TOOL_DECLARATIONS` (two `types.FunctionDeclaration`s: `end_conversation` no params; `go_quiet` with `{"type":"object","properties":{"minutes":{"type":"number"}}}`, descriptions telling the model when to call them). `_live_config` includes them (in the same `Tool(function_declarations=...)` as SC tools, or their own Tool when SC is absent) when enabled, independent of SC. `CONTROL_NOTE` appended to the system instruction when declared (one or two sentences per spec).
- Tool-call handling in `_pump_server`: calls named `end_conversation` / `go_quiet` are handled locally (never MCP / never `unknown_tool`): send `FunctionResponse(id, name, response={"ok": True, "action": ..., "minutes": ...})` to the CURRENT session, then `emit(VoiceServerEvent(control=Control(action="end"|"quiet", seconds=round(minutes*60) or 0)))`. Log INFO `voice: control <action> (<seconds>s) via tool`.
- Search-only fallback keeps control tools (drops SC only); if an open fails with only control tools attached, fall back to no declarations (same single-shot rule as today).

- [ ] TDD: tests for declarations present with/without SC and absent when flag off; tool call → FunctionResponse ok + Control event emitted + executor never called; fallback keeps control tools; `_live_config` identical to today when flag off and SC off. Regenerate stubs (Makefile/proto target), run suite, rebuild image (`docker build -q -f voice-sidecar/Dockerfile voice-sidecar/`), commit.

### Task 2: Bot phrase matcher

**Files:** create `services/voice/controlPhrases.js`, `__tests__/services/voice/controlPhrases.test.js`.

**Interfaces — Produces:** `matchControlPhrase(text: string) -> {action:'end'} | {action:'quiet', seconds:number|null} | null` (`seconds:null` = no duration spoken → caller applies default). Exports `parseDurationSeconds(text) -> number|null` too.

- [ ] TDD table tests per spec: positives ("end the conversation", "stop the conversation", "thanks jarvis, that's all", "okay we're done", "stop listening for ten minutes" → 600, "go quiet for 20 minutes", "be quiet for a couple minutes" → 120, "shut up for half an hour" → 1800, "mute for an hour" → 3600, "go quiet" → seconds null, "leave us alone for 5 min" → 300, "stop listening" → quiet null); negatives ("that's all I know about it, what do you think?", "we're done with the raid, where do we sell the cargo", "I stopped listening to that album", "what's the best quiet quantum drive", "end of the conversation about shields was…"), case/punctuation insensitive. Implement, run, commit.

### Task 3: Bot VoiceClient + VoiceService control handling

**Files:** `services/VoiceClient.js`, `services/VoiceService.js`, `config/config.js` (flag), tests in `__tests__/services/` (follow existing VoiceService test harness patterns).

**Interfaces — Consumes:** Task 1 `control` server event; Task 2 `matchControlPhrase`. **Produces:** `VoiceService.resume(guildId) -> {wasQuiet:boolean, remainingMs:number}`; `VoiceService.quietStatus(guildId) -> {quiet:boolean, remainingMs:number}`; config `voice.controlCommandsEnabled`.

- VoiceClient: `case 'control'` → `session.emit('control', { action: ev.control.action, seconds: ev.control.seconds })`.
- VoiceService: on session `'control'` (guarded `g.session === session`) and on `'inputTranscript'` (after buffering, match the JOINED current-turn input buffer) call `_requestControl(g, guildId, action, seconds, source)`; idempotent per session (first request wins; a later `quiet` upgrades an earlier `end`). `_tick`: if `g.pendingControl` and (`!_botIsSpeaking(g)` or 10 s since request) → execute: `_resetToIdle(g, guildId, 'ended by voice command (<source>)')`; for quiet set `g.quietUntil = now + clamp(seconds ?? 900, 60, 7200)*1000` AFTER the reset (reset must not clear it). Idle wake branch: while `now < g.quietUntil` skip wake detection entirely (do not feed the wake gate, do not open sessions); on expiry clear + INFO log. Pre-roll buffer should not accumulate while quiet (or is harmless — document which). `listen()` while quiet: clears quiet (explicit admin action wins) — test it. Flag off ⇒ no phrase matching, `control` events ignored (log DEBUG).
- [ ] TDD tests per spec (both sources, drain wait, 10 s ceiling, idempotence/upgrade, wake ignored while quiet, expiry, resume(), leave clears, listen clears, flag off byte-identical). Full `npm test`, commit.

### Task 4: `/voice resume`, smoke fixtures, docs

**Files:** `commands/slash/voice.js` (+ its tests), `scripts/gen-test-voices.js` (two fixtures: "hey jarvis, go quiet for two minutes", "thanks jarvis, that's all"), `scripts/smoke-voice-control.js` (new; model on `scripts/smoke-voice-sc.js`: stream each fixture, assert a `control` server event arrives with the right action within 45 s; print PASS/FAIL; non-zero exit on FAIL), `CLAUDE.md` (Voice section: commands, flags, bot-side idempotent enforcement, drain-before-teardown, quiet gating), `README.md` (env vars), `features.md`.
- [ ] `/voice resume`: replies ephemerally "Quiet mode ended (X min left)." or "I wasn't in quiet mode." (bot not in voice → the existing not-in-voice reply pattern). TDD for the command. `node --check` the smoke script. Commit.

## Coordinator steps
Full suites; build + push bot and voice images (short SHA); scan bot image for OrgGuides/PDF/.env/keys; update deployed overlay tags; apply voice then bot; run `scripts/registerCommands.js` in the bot pod; real-model smoke via port-forward; push branch; PR.
