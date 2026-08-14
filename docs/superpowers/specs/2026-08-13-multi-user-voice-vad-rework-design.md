# Multi-User Voice: VAD Rework + Speaker-Attributed Shared Room — Design

- **Date:** 2026-08-13
- **Status:** Draft (pending review)
- **Branch context:** `fix/voice-join-latency` (PR #98)
- **Related:** [`2026-08-06-discord-voice-live-design.md`](2026-08-06-discord-voice-live-design.md) (original voice feature), [`2026-08-08-unified-chat-context-design.md`](2026-08-08-unified-chat-context-design.md) (shared turn context)

---

## 1. Context & Motivation

The Discord voice assistant (Node bot + `discord-article-bot-voice` Python sidecar hosting one Gemini Live session per channel) works for a single user after a long stabilization effort. Before investing further we ran a four-stream SOTA validation of the approach. Two findings drive this design:

1. **We are in an incoherent dual-VAD state (a real defect, not just a tuning gap).** The active path drops sub-threshold frames (`VoiceService.js` energy gate, `frameMeanAbs < REAL_SPEECH_MEANABS`) **while** Gemini's server-side VAD is left enabled (`live_bridge.py` sets only `activity_handling`, leaving `automatic_activity_detection` on by default). Dropping frames starves the server VAD of the trailing silence it needs to endpoint, so our fixed 800 ms `audio_stream_end` timer silently became the *sole* endpointer — the root of the turn-finalization bugs. Google documents our intended pattern as **Hybrid VAD**: keep server VAD on, stream continuously, and use a client VAD only to fire an *early* `audio_stream_end`. We implemented the anti-pattern version.
2. **The fixed mean-abs energy gate is a below-WebRTC-quality VAD.** SOTA is a neural VAD (Silero, ROC-AUC ~0.96 vs WebRTC GMM 0.73) which is SNR-robust and needs no threshold tuning. Because we already run `onnxruntime-node` (for openWakeWord), Silero is a ~2 MB drop-in on existing infrastructure. This also **retires the previously-planned adaptive-noise-floor feature** — it would have been hand-tuning the exact primitive Silero replaces.

Separately, the product goal is to bring chat's best property — **knowing who is talking** — into voice. Today there is one shared Gemini session per channel, everyone's audio is mixed into it, and transcripts are stored with no author, even though Discord hands us **per-speaker separated streams** (`connection.receiver.subscribe(userId)` — verified). Speaker identity exists at the bottom of the pipeline and is discarded one layer up.

This design fixes the VAD incoherence and builds a **speaker-attributed shared room** on top of the per-speaker streams we already receive.

## 2. Goals / Non-Goals

**Goals**
- Replace the fixed energy gate with **per-speaker Silero VAD**; resolve the dual-VAD incoherence into a correct Gemini Hybrid VAD.
- Support **multiple concurrent speakers** in one shared Gemini Live session without breaking turn-taking ("second user joins" hardening).
- **Attribute** every turn/transcript to the real Discord `userId`, and make the **model identity-aware** so it can address people by name.
- **Active-speaker floor control**: one human holds the floor per exchange; others are detected/attributed but not forwarded until it frees.
- Keep the session alive past the 15-min audio cap (compression + resumption).
- Shrink the deploy-test loop with offline harnesses.

**Non-Goals (this spec)**
- True parallel multi-topic handling ("let me finish X, then get to Y") — Phase 4, future, out of scope here (but `FloorControl` exposes the signal it will need).
- Per-speaker *separate* Gemini sessions (rejected: cost/complexity, breaks shared context).
- Server-side acoustic echo cancellation (physically can't work across the Discord round-trip; Discord's client AEC + half-duplex is the correct posture).
- Migrating to a Gemini 3.x Live model (would break the identity-marker mechanism — see Risks).

## 3. Locked Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Session model | **One shared Gemini Live session per channel** ("room") + context compression + session resumption |
| VAD engine | **Per-speaker Silero VAD** (one instance per active Discord stream), replacing the fixed energy gate |
| Endpointing | **Gemini Hybrid VAD**: stream continuously, Silero fires an early `audio_stream_end`; server VAD kept on as fallback |
| Multi-speaker | **Active-speaker floor control** (one at a time; others attributed but withheld) |
| Attribution depth | **Model identity-aware** (per-turn marker + roster) AND authoritative transcript attribution from Discord `userId` |
| Echo | Keep half-duplex default; barge-in toggle relaxed (Discord client AEC covers most users) |
| Keep unchanged | wake-gating, ~3 s pre-roll, 60 s follow-up window, open-on-wake/idle-teardown lifecycle |

**Guiding principle — favor quality over resource frugality.** The cluster has ample CPU/memory headroom. When a better approach costs more compute (per-speaker Silero instances, finer chunking with more/smaller sends, a larger/heavier model, extra buffering for smoothing), prefer it over a resource-minimizing shortcut. Do not optimize for frugality at the expense of correctness or conversational quality.

## 4. Architecture Overview

```
Discord voice (per-speaker Opus)
  └─ receiver.subscribe(userId) ──> decode ──> downsampleTo16kMono ──> per-speaker 16k PCM
        │
        ├─(room idle)──> WakeWordGate(userId)         # any speaker can wake
        └─(room active)─> SileroVad(userId) ──speech start/end──> FloorControl
                                                             │
                                     ┌───────────────────────┴───────────────────────┐
                                     │ floor-holder's audio                            │ non-holder
                                     ▼                                                 ▼
             (on speaker change) send_client_content("[SPEAKER: name]", turn_complete=False)
             then stream audio via send_realtime_input  ──>  ONE shared Gemini Live session
                                     │                                                 │
                                     │  Silero end-of-speech ──> sendAudioStreamEnd()  │ (attributed, logged;
                                     ▼                                                 │  not forwarded)
              server_content: audio / input_transcription / interrupted
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                             ▼
   play (24k→48k)          author transcript                flush playback
                           (userId + transcription)         on interrupted:true
```

The room's coarse state (`idle → active → hot`) stays in **`VoiceSessionMachine`** (unchanged responsibility). **`FloorControl`** is a new, orthogonal layer tracking *which speaker* owns the current exchange. Per-speaker **`SileroVad`** replaces the fixed energy gate as the source of speech-start/end events.

## 5. Component Breakdown

Each unit is small, single-purpose, and independently testable. New pure-logic units live under `services/voice/`.

### 5.1 `SileroVad` (new — `services/voice/SileroVad.js`)
- **Purpose:** neural speech detection per stream. Emits `speechStart` / `speechEnd` events.
- **Interface:** `create({ modelPath, ... }) -> { process(frame16k) -> {speaking, justStarted, justEnded}, reset(), ready() }`. One instance per active `userId`.
- **Depends on:** `onnxruntime-node` (already vendored), `silero_vad.onnx` (~2 MB, MIT, added to `models/`).
- **Notes / spike:** Silero v5 wants **512-sample (32 ms) @16k** chunks and is **stateful** (carries a context/state tensor between chunks). Our pipeline emits 1280-sample (80 ms) frames, so this unit **re-chunks** internally to 512 and carries state. Mirrors the existing openWakeWord async-inference-queue pattern (`wakeword.js`) — `session.run` is async, contract surfaces detections on the next call. Low-risk given precedent; validated by the Layer-2 harness before wiring in.

### 5.2 `FloorControl` (new — `services/voice/FloorControl.js`, pure logic)
- **Purpose:** given per-speaker speech events, decide who holds the floor and whether a given speaker's audio should be forwarded.
- **Interface (pure, deterministic):**
  `onSpeechStart(userId, nowMs) -> { grantFloor?: userId, forward: bool, waiting?: userId }`
  `onSpeechEnd(userId, nowMs) -> {...}`; `holder()`; `releaseFloor()`.
- **Rules:**
  - Room idle → wake grants the floor to the waker; session opens.
  - Floor held by A → A's frames `forward:true`; a different speaker B → `forward:false`, recorded as `waiting:B` (this is the Phase-4 hook), still attributed/logged.
  - Floor frees on A's exchange ending (follow-up window expiry / idle / `/voice leave`); next waker (or `waiting` speaker, future) may take it.
- **Depends on:** nothing (pure). Drives, and is driven by, `VoiceSessionMachine` transitions via `VoiceService`.

### 5.3 Endpointing (the dual-VAD fix — in `VoiceService` + sidecar config)
- **Change:** in the floor-holder's active turn, **stop dropping frames** — stream continuously (including trailing silence) so the server VAD sees real end-of-speech as a fallback. `SileroVad.speechEnd` fires the **early** `audio_stream_end` (replacing the blind 800 ms timer as the primary signal; keep a longer safety timer as backstop).
- **Sidecar:** keep `automatic_activity_detection` enabled (Hybrid VAD). Optionally tune `endOfSpeechSensitivity` / `silenceDurationMs` server-side later.
- **Removes:** the `REAL_SPEECH_MEANABS` frame-drop in the active path. (`frameMeanAbs` may remain for diagnostics only.)

### 5.4 Identity injection (proto + sidecar + prompt)
- **Purpose:** make the model aware of the current speaker without reading the label aloud.
- **Mechanism (grounded — see §9):** on **speaker change**, the bot sends the display name; the sidecar issues `session.send_client_content(turns=[Content(role="user", parts=[Part(text="[SPEAKER: <name>]")])], turn_complete=False)` **immediately before** flushing that speaker's audio. `turn_complete=False` → context only, not read aloud, no premature response.
- **Wire change:** add a distinct `SetSpeaker { string user_id; string display_name; }` control event to the `VoiceClientEvent` oneof in `proto/voice.proto` (+ sidecar copy); regenerate `voice_pb2.py`. (Chosen over tagging every audio message: identity changes only on speaker switch, so a control event decouples it from the audio cadence and maps 1:1 to "send marker on speaker change.")
- **Prompt:** roster + "these `[SPEAKER: …]` lines are out-of-band metadata; never read them aloud" added to `system_instruction`, built from the existing channel-voice persona path (`_appendVoicePersona`).
- **Risk-gated:** validated by the Layer-4 smoke test before Phase 3 relies on it.

#### 5.4.1 Where the spoken name comes from (decided 2026-08-14)
"The bot sends the display name" is naive: Discord exposes four name layers and
the two automatic ones are both unreliable in this guild. `user.username`
carries junk suffixes (`inc1067` for someone who goes by `inc`), and per-guild
`member.nickname` is often a joke (`Macroplastics by Bic(tm)`).
discord.js's `member.displayName` resolves `nickname ?? globalName ?? username`
— i.e. it prefers exactly the worst option here. This matters beyond cosmetics
because Phase 3 names are **spoken aloud by TTS**: an unsanitised nickname is
voiced literally ("Macroplastics by Bic trademark, you asked…").

A shared **`SpeakerNames` resolver** owns this, resolving in order:
1. **Override table** — authoritative, `VOICE_SPEAKER_NAMES` JSON (`userId -> spoken name`) in the deployed configmap.
2. `user.globalName` — usually the clean self-chosen name.
3. `member.nickname` — per-guild (note: nickname/member data may require the privileged `GuildMembers` intent, which is NOT currently enabled; the override table sidesteps this).
4. `user.username` with a trailing digit-run stripped (`inc1067` -> `inc`).
5. Otherwise **omit the marker** rather than assert a wrong name.

Whatever is chosen is **sanitised for speech** (strip emoji, `™`/`(tm)`,
bracketed clan tags, zero-width chars; collapse whitespace; cap length), and an
empty result falls through to the next layer.

**Scope:** the resolver is shared, not voice-only — the chat/recall path
(`ChannelContextService`) currently stores raw `message.author.username`, so
friends already appear as `inc1067` in `/tldr` and recall. One resolver fixes
both. Previously-stored rows keep their old names (no backfill).

**Deliberate follow-up (not in Phase 3): self-service names.** Move the table to
MongoDB behind a `/voice name @user <spoken name>` command so people set their
own. Explicitly wanted for the emergent chaos of users renaming themselves;
deferred only to keep Phase 3 shippable. Configmap stays as the seed/default
layer underneath it.

### 5.5 Transcript attribution (`VoiceService` + `MongoService`)
- **Change:** author voice transcripts with the real Discord `userId` (from the stream the audio arrived on) paired with `input_audio_transcription` text, instead of anonymous. Closes the CLAUDE.md "per-speaker transcript author fields" deferred follow-up; `/tldr` and recall gain per-speaker identity.

### 5.6 Session length (sidecar `LiveConnectConfig`)
- **Change:** add `context_window_compression` (sliding window) so the room isn't capped at ~15 min, and `session_resumption` (store `SessionResumptionUpdate.new_handle`, reconnect with it; 2 h validity) so transient drops don't end the room. Watch `GoAway` for pre-disconnect warning. Exact shapes in §9.

### 5.7 Correctness cleanups
- On `response.server_content.interrupted == True`, **flush playback immediately** (verify the sidecar surfaces it to the bot and `_stopPlayback` fires).
- Per-speaker **wake** while idle (any participant can wake the room), not one shared gate.

### 5.8 Frame-size reconciliation (three sizes in play — do NOT force one everywhere)
There are **three** consumers wanting three different frame sizes, and today's single 80 ms pipeline frame is coarser than two of them. The active path must decouple from the 80 ms frame:

| Consumer | Wants | Why |
|---|---|---|
| openWakeWord (idle path) | **1280 samples / 80 ms** @16k | Hard requirement of the vendored model; unchanged. |
| Silero VAD (active path) | **512 samples / 32 ms** @16k | Silero's native chunk; stateful across chunks. |
| Gemini forward (active path) | **20–40 ms** (~320–640 samples) @16k | Google best practice; our current 80 ms is too coarse (adds latency, degrades server-VAD fallback). |

**Reconciliation:** feed the continuous 16 k PCM stream into a small re-chunker that fans out per-consumer — the **idle** path keeps assembling 1280-sample frames for openWakeWord; the **active** path feeds Silero at 512-sample windows (carrying VAD state) and the Gemini forwarder at 20–40 ms chunks. Per the guiding principle, we accept the extra, smaller sends for the latency/quality gain rather than coarsening to one convenient size.

**Phase 1 frame-size note (accuracy correction):** the pipeline already forwards ~20 ms per-Opus-packet chunks to Gemini (the 1280 / 80 ms figure in the table is openWakeWord's **internal** frame size, rebuffered inside `WakeWordGate`), so Phase 1's only frame-size work is the Silero 512-sample rebuffer; no change to the Gemini forward chunk size was needed. Layer-2 harness validation confirmed real Silero fires at 960 ms (confidence 0.98/0.99) on both clean-16k and 48k→downsample paths against `Recording.m4a`.

## 6. Data Flow (turn lifecycle, multi-user)

1. Room idle. Each speaking `userId` feeds its own `WakeWordGate`. Speaker A says the wake word → `onWake` → session opens, `FloorControl` grants A the floor, `VoiceSessionMachine` → active.
2. A speaks. `SileroVad(A)` reports speaking; `FloorControl` says `forward:true`. On speaker-change the sidecar emits the `[SPEAKER: A]` marker, then streams A's 16k audio continuously.
3. Speaker B talks over A. `SileroVad(B)` fires; `FloorControl` returns `forward:false, waiting:B` — B's utterance is transcribed/attributed and logged, **not** forwarded. (Phase 4 will let the model acknowledge "one sec, B.")
4. A goes quiet. `SileroVad(A).speechEnd` → `sendAudioStreamEnd()` → Gemini finalizes → model replies. Bot plays audio (half-duplex: A's mic muted during playback unless barge-in). Transcript authored to A.
5. `turnComplete` → room → hot (60 s follow-up, floor stays with A). A continues without re-wake; on expiry → idle, floor released.

## 7. Phasing (each phase is a strict subset — nothing is rebuilt)

- **Phase 1 — VAD rework + endpointing fix (single-user).** Add `SileroVad`, replace the energy gate, stop dropping frames, Hybrid `audio_stream_end` from Silero, shrink chunk size, verify interrupt flush. Fixes the finalization bugs; ships value solo. *Tests: Layer 1 (VAD/endpoint logic) + Layer 2 (real Silero on `Recording.m4a`).*
- **Phase 2 — Multi-user shared room.** Per-speaker wake + `FloorControl` + transcript attribution + session compression/resumption. The "second user" hardening. *Tests: Layer 1 (floor logic, synthetic multi-speaker timelines) + Layer 3 (two real TTS voices into two Silero instances).*
- **Phase 3 — Model identity-awareness.** Proto `speaker` field + sidecar marker injection + roster prompt. Riskiest; built on proven plumbing. *Tests: Layer 4 (real Live smoke test — verify marker is silent and binds correctly).*
- **Phase 4 (future, not scoped).** Human-like "finish X, then get to Y" using `FloorControl`'s `waiting` signal.

## 8. Testing Strategy

Discord streams are **already separated per speaker**, so simulating simultaneous speakers offline is *faithful*, not approximate — the only unsimulable bit is real acoustic echo, which the per-stream model + Discord client AEC means we never process anyway.

- **Layer 1 — pure logic, no audio (`npm test`).** `FloorControl` + `VoiceSessionMachine` driven by synthetic speech-event timelines for 2–3 fake `userId`s. Deterministic, ms-fast, **permanent regression suite** for multi-user arbitration.
- **Layer 2 — real Silero, single stream (`scripts/test-vad.js`).** Extends `scripts/test-wakeword.js`: feeds `Recording.m4a` (clean-16k and 48k→downsample paths) through real Silero; prints speech-start/end + endpointing decisions. Grounds "does Silero cope with Discord-degraded audio."
- **Layer 3 — multi-stream simulation (`scripts/test-floor.js`).** Two+ independent PCM sources (TTS voices, time-offset) → two Silero instances → `FloorControl`; prints the floor timeline.
- **Layer 4 — real Gemini Live smoke test, no Discord (`scripts/smoke-voice-live.js`).** Opens a real Live session (via sidecar `kubectl exec`), sends audio + `[SPEAKER: …]` marker, prints transcript/response. De-risks identity injection (silent? correctly bound?) without a deploy.
- **Fixtures.** `scripts/gen-test-voices.js` (committed) regenerates distinct-voice `.wav`s via Gemini-TTS (Gemini API, `gemini-2.5-flash-preview-tts`, consumer `GEMINI_API_KEY`, prebuilt voices Charon/Kore/Aoede, L16 24k → WAV). Generated `.wav`s are **gitignored** (no binaries committed).

**Still requires a Discord deploy:** only final end-to-end integration — `@discordjs/voice` receiver wiring, DAVE E2EE, live playback, and the human "feels right" pass.

## 9. Gemini Live Plumbing Reference (grounded — python-genai / GEAP)

Model in use: `gemini-live-2.5-flash` (confirmed `VOICE_LIVE_MODEL` in `voice-deployment.yaml`).

**Per-turn identity marker (on speaker change):**
```python
await session.send_client_content(
    turns=[types.Content(role="user", parts=[types.Part(text=f"[SPEAKER: {display_name}]")])],
    turn_complete=False,   # context only: NOT read aloud, does NOT trigger a reply
)
await session.send_realtime_input(audio=types.Blob(data=pcm, mime_type="audio/pcm;rate=16000"))
```

**LiveConnectConfig (input transcription + compression + resumption + roster):**
```python
config = types.LiveConnectConfig(
    response_modalities=["AUDIO"],
    system_instruction=types.Content(parts=[types.Part(text=ROSTER_AND_MARKER_RULES)]),
    input_audio_transcription=types.AudioTranscriptionConfig(),   # -> response.server_content.input_transcription.text
    context_window_compression=types.ContextWindowCompressionConfig(
        sliding_window=types.SlidingWindow(),                     # unbounded session length
    ),
    session_resumption=types.SessionResumptionConfig(handle=previous_handle),  # None first; refresh from SessionResumptionUpdate.new_handle
    realtime_input_config=types.RealtimeInputConfig(
        activity_handling=types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,  # keep automatic VAD ON (Hybrid)
    ),
    tools=[types.Tool(google_search=types.GoogleSearch())],       # existing grounding, unchanged
)
```
- **Interruption:** `response.server_content.interrupted` (bool) → flush playback.
- **Input transcription:** `response.server_content.input_transcription.text` → pair with Discord `userId`.

## 10. Risks & Validation

| Risk | Severity | Mitigation |
|---|---|---|
| Identity marker→audio binding is **best-effort** (no hard ordering guarantee); a dangling `turn_complete=False` can stall a reply (issue #682) | Med | Keep marker tiny; send only on speaker change, immediately before audio; **Layer-4 smoke test** validates silence + binding before Phase 3 depends on it |
| Mechanism is **`gemini-live-2.5-flash`-specific**; Gemini 3.x Live restricts mid-conversation `send_client_content` | Med | Documented migration risk; do not upgrade `VOICE_LIVE_MODEL` without revisiting §5.4; rest-of-bot's 3.x drift does not affect the pinned voice model |
| Gemini server VAD may not cope with **Discord codec-degraded audio** as fallback | Med | Silero carries endpointing; Layer-2 harness validates on real audio before deploy |
| Silero **re-chunk + stateful** integration | Low | Precedent in `wakeword.js`; Layer-2 harness proves it |
| `FloorControl` edge cases (rapid speaker swaps, overlapping wakes, floor-holder leaves channel) | Med | Layer-1 pure tests enumerate these deterministically |
| Session compression/resumption reconnect handling | Low | Best-practice shapes in §9; resumption handle stored per room |

## 11. Deferred Follow-ups (unchanged / newly-closed)
- **Closed by this spec:** per-speaker transcript author fields (§5.5).
- **Still deferred:** idle auto-leave, playback jitter smoothing / proper 24k→48k resampler, dynamic voice-profile injection, Phase-4 parallel-topic handling.

## 12. References
- Validation research (four SOTA streams, 2026-08-13): VAD/endpointing, echo/barge-in, noise-floor/AGC/wake-tuning, reference architectures (Pipecat/LiveKit/OpenAI Realtime/Gemini Live).
- Gemini Live: [capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities) · [WebSockets API ref](https://ai.google.dev/api/live) · [best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices) · [session management](https://ai.google.dev/gemini-api/docs/live-session)
- Silero VAD (MIT, ONNX): https://github.com/snakers4/silero-vad
- openWakeWord (existing infra pattern): `services/voice/wakeword.js`
