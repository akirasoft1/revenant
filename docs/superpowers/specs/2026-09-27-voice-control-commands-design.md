# Voice control commands: end conversation, go quiet — Design

**Date:** 2026-09-27 · **Status:** approved (brainstorming) · **Branch:** `feat/voice-control-commands`

## Goal
Two spoken commands in Discord voice:
1. **End conversation** ("thanks jarvis, that's all", "end conversation") — end the current Live session now instead of waiting for the follow-up/idle timeout; the bot returns to idle, waiting for the wake word. Also ends `/voice listen` continuous mode.
2. **Go quiet** ("go quiet for ten minutes", "stop listening for 20 minutes") — end the session AND ignore the wake word from everyone in that guild's voice channel until the deadline. Nothing is streamed to the model while quiet.

## Decisions
- **Detection — both layers:**
  - *Model tools:* the voice sidecar declares two extra Live function tools, `end_conversation()` and `go_quiet(minutes: number)`, handled **locally in the sidecar** (no MCP): it answers the tool call with `{"ok": true, ...}` so the model can speak a short confirmation, and emits a new server→bot `Control` event.
  - *Phrase backstop:* the bot matches the accumulated **input transcript** of the current turn against a small forgiving pattern set; a match produces the same action. Model cooperation is not required.
- **Enforcement is bot-side.** One idempotent handler; tool path + phrase path firing for the same utterance is harmless.
- **Teardown waits for playback drain** (`_botIsSpeaking(g)` false, checked in `_tick`) so the spoken confirmation is not cut off; bounded by a 10 s ceiling after which teardown proceeds anyway.
- **Quiet:** duration clamped to **1–120 min**; missing/unparseable duration → **15 min**. Deadline stored per guild; the idle-state wake-word branch skips detection while `now < quietUntil`. Expiry is silent (bot is not in a session) — logged at INFO.
- **Early resume:** new `/voice resume` slash subcommand (anyone in the guild) clears quiet; reply states whether quiet was active and how much was left. `/voice leave` clears quiet (guild state is deleted).
- **Who can trigger:** the current floor holder (the person talking to the bot). Transcripts/tool calls only exist for forwarded (floor-holder) audio, so this falls out naturally.
- **Kill switch:** `VOICE_CONTROL_COMMANDS_ENABLED` (bot) default **true**; when false: no phrase backstop, and the bot ignores `Control` events. Sidecar: `VOICE_CONTROL_TOOLS_ENABLED` default **true**; when false the two tools are not declared.

## Interfaces
- `proto/voice.proto`: `message Control { string action = 1; int32 seconds = 2; }` (action `"end"` | `"quiet"`), added to `VoiceServerEvent.oneof` as `Control control = 7`. Stubs regenerated in the sidecar; the bot loads the proto at runtime.
- Sidecar `live_bridge`: control tools are prepended to the function declarations (independently of SC tools — present even when SC is disabled); a `tool_call` for them is answered immediately (`FunctionResponse`) and emits `VoiceServerEvent(control=Control(...))`; `go_quiet.minutes` is passed through as seconds = round(minutes*60) (clamping happens bot-side). Search-only fallback (SC connect-rejection) drops SC declarations but KEEPS control tools; if the control-tool declarations themselves are rejected the existing fallback retries with neither.
- System instruction addendum (only when control tools are declared): one sentence telling the model to call `end_conversation` when the user is done/dismisses it and `go_quiet` when asked to stop listening for a while, and to say a very short confirmation.
- Bot `VoiceClient`: `case 'control'` → `session.emit('control', {action, seconds})`.
- Bot `services/voice/controlPhrases.js` (pure): `matchControlPhrase(text) -> {action:'end'} | {action:'quiet', seconds} | null`. Handles: "end/stop/finish (the/this) conversation", "that's all", "we're done", "stop/quit listening (for N minutes)", "go quiet / be quiet / shut up / mute (for N minutes)", "leave us alone for N minutes"; numbers as digits or words ("ten", "twenty five", "a couple" → 2, "a few" → 3, "half an hour" → 30, "an hour" → 60); hours supported. Quiet verbs without a duration → quiet with default. "that's all" / "we're done" require being the whole utterance or at its end (avoid false positives mid-sentence).
- Bot `VoiceService`: `_requestControl(g, guildId, action, seconds, source)` — idempotent per session; sets `g.pendingControl`; `_tick` executes it once playback drained (or 10 s ceiling): `end` → `_resetToIdle(g, guildId, 'ended by voice command')` (also clears continuous listen); `quiet` → `_resetToIdle(...)` + `g.quietUntil = now + clamp(seconds)`. Idle-state wake branch: if `g.quietUntil && now < g.quietUntil` → skip wake detection (feed nothing to the model); if expired → clear and log. Public `resume(guildId) -> {wasQuiet, remainingMs}`.
- `/voice resume` in `commands/slash/voice.js`; `scripts/registerCommands.js` picks it up.

## Testing
TDD: phrase matcher table tests (incl. ASR-ish variants, number words, false-positive guards); VoiceService tests for both actions via Control event and via phrase, drain-before-teardown, 10 s ceiling, idempotence, wake ignored while quiet, restored on expiry and on `resume()`, leave clears quiet, kill switch; sidecar tests: control declarations present with and without SC, tool call → FunctionResponse ok + Control event + no MCP call, fallback keeps control tools. Real-model smoke: extend `scripts/smoke-voice-sc.js` pattern with two fixtures ("go quiet for two minutes", "that's all, thanks jarvis") asserting a `Control` event is received.

## Docs
CLAUDE.md Voice section (commands, flags, idempotent bot-side enforcement, drain-before-teardown), README env vars, features.md.
