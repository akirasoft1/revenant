# Discord Voice via Gemini Live — Design Spec

**Date:** 2026-08-06
**Status:** Approved (design), pending implementation plan
**Scope:** Sub-feature 1 of a multi-part effort. This spec covers a **general-purpose
voice interface only**. Star Citizen (and any other domain specialization) is deferred
to a follow-up spec once the voice interface is validated end-to-end.

---

## Goal

Let users talk to the bot in a Discord voice channel and hear it talk back, in real
time, with its existing `channel-voice` personality — driven by the **Gemini Live
API** on the enterprise-governed GEAP/Vertex surface, gated by a local wake word, and
sharing one continuous memory with text chat.

## Non-Goals (this spec)

- Star Citizen or any domain-specific knowledge/tooling (separate spec).
- Running the sandbox from a voice turn (deferred; see "Sandbox delegation" note).
- Open-mic / always-listening mode (rejected: cost + false triggers). Wake-word only.
- Multi-channel simultaneous presence beyond a configurable concurrency cap.

---

## Confirmed Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Listen mode | **Wake-word / addressed** | Natural feel without streaming everyone's chatter to a paid model. |
| Voice brain | **Gemini Live API** | Real-time speech-in/speech-out, native VAD + barge-in + transcription; runs on existing GEAP/Vertex ADC auth. |
| Hosting | **New dedicated sidecar `discord-article-bot-voice`** | Long-lived real-time WebSockets are incompatible with the agent sidecar's single-replica `Recreate`, do-not-scale lifecycle; different runtime profile; failure isolation. |
| Join model | **`/voice join` + `/voice leave`** | Explicit, predictable, bounded cost. Plus auto-leave on empty channel / idle timeout. |
| Turn rhythm | **Wake → reply → ~15s hot follow-up window → idle** | Natural back-and-forth; no streaming during idle. |
| Personality | **Reuse `channel-voice` system prompt** as the Live session instruction | Sounds like the same bot across text and voice. |
| Wake-word engine | **Picovoice Porcupine (`@picovoice/porcupine-node`)** | Natural Node fit, CPU-only, built-in keyword needs no training. |
| Barge-in | **Enabled** (`START_OF_ACTIVITY_INTERRUPTS`) | Cut the bot off mid-sentence; Live supports it natively. |
| Memory | **Log transcripts to Mongo + shared recall** | Voice reads recall on session start; transcripts flow back to the Mongo message store (→ `/tldr` + recall). Voice and text = one memory. |

---

## Architecture

Two processes, split along the seam each is best at:

- **Node bot** — owns Discord + audio + memory I/O: channel join/leave, per-user Opus
  receive, wake-word detection, resampling, playback, the turn state machine, and —
  because it already owns `RecallService` and the Mongo message store — **all memory
  reads and writes**.
- **`discord-article-bot-voice`** (new sidecar) — a thin, **stateless Gemini Live
  bridge**: holds the Live WebSocket on the shared GEAP auth and shuttles audio +
  transcripts between Node and Google. No Mongo, no recall logic of its own.

The two talk over a **new bidirectional streaming gRPC** (`proto/voice.proto`). The
key property: the sidecar never touches the bot's data systems. Node feeds it recall
as session-seed context and captures transcripts on the way out, so voice transcripts
flow through the *same* persistence + recall-ingestion path as text messages.

```
Discord VC
   │  Opus (48k stereo)
   ▼
Node bot (VoiceService)
   ├── decode + resample → 16k mono PCM
   ├── Porcupine wake-word gate (idle)
   ├── RecallService.get() on wake  ─────────┐  (memory read)
   ├── turn state machine + playback         │
   └── Mongo message store  ◀── transcripts  │  (memory write)
             │  gRPC Voice.Converse (bidi stream)
             ▼
discord-article-bot-voice (Live bridge)
   └── client.aio.live.connect (GEAP/Vertex ADC)
             │  WebSocket
             ▼
        Gemini Live
```

---

## Components

### 1. Node: `/voice` slash command (`commands/slash/voice.js`)

- `/voice join` — joins the invoking user's current voice channel (error if they're not
  in one). `/voice leave` — disconnects.
- Requires the **`GuildVoiceStates`** gateway intent (not currently enabled) added to
  both `bot.js` client instantiation and `config/config.js` `discord.intents`.
- Gated by `VOICE_ENABLED`; if disabled, replies ephemerally that voice is off.

### 2. Node: `services/VoiceService.js`

Owns a per-guild voice session. Responsibilities:

- **Connection:** `joinVoiceChannel` from `@discordjs/voice`; track
  `VoiceConnectionStatus` for reconnect; auto-leave when the channel has no human
  members or after `VOICE_IDLE_TIMEOUT_MS`.
- **Receive + transform:** subscribe to each speaking user
  (`connection.receiver.subscribe(userId, { end: { behavior: AfterSilence } })`),
  decode Opus → PCM, resample 48k stereo → **16k mono** (the format Porcupine and Live
  both want — one resample serves both).
- **Wake-word gate (idle):** feed 16k frames to Porcupine. On detection of the
  configured keyword, transition `idle → streaming`.
- **Turn state machine:** `idle → streaming → reply → hot-window → idle`.
  - On wake: call `RecallService` for recall + recent buffer, open a `Converse` gRPC
    stream, send `SessionStart` (with the recall context), then stream 16k PCM
    `AudioChunk`s.
  - Play returned 24k audio via `AudioPlayer` + `connection.subscribe(player)`.
  - **Barge-in:** if the user speaks during playback, stop the `AudioPlayer` and flush
    queued audio immediately.
  - After `TurnComplete`, keep the session **hot for `VOICE_FOLLOWUP_WINDOW_MS`
    (~15s)**, still streaming, so a follow-up needs no wake word. Silence past the
    window → send `SessionEnd`, close the stream, return to `idle`.
- **Persist:** on `InputTranscript` / `OutputTranscript` events, write both to the
  existing Mongo message store (same path text messages use → `/tldr` + recall).
- **Health + concurrency:** health-poll the voice sidecar (mirror `AgentClient`'s 5s
  poll + `isHealthy()` gate); enforce `VOICE_MAX_SESSIONS`.

### 3. Transport: `proto/voice.proto`

New service, separate from `agent.proto` (different deployment, different shape):

```proto
service Voice {
  rpc Converse(stream VoiceClientEvent) returns (stream VoiceServerEvent);
  rpc Health(HealthRequest) returns (HealthResponse);
}

message VoiceClientEvent {
  oneof event {
    SessionStart session_start = 1;  // user_id, user_tag, channel_id, guild_id, recall_context, system_prompt
    AudioChunk   audio         = 2;  // pcm16 @ 16k mono
    SessionEnd   session_end   = 3;
  }
}

message VoiceServerEvent {
  oneof event {
    AudioChunk        audio             = 1;  // pcm16 @ 24k mono
    Transcript        input_transcript  = 2;  // user speech → text
    Transcript        output_transcript = 3;  // bot speech → text
    TurnComplete      turn_complete     = 4;
    Interrupted       interrupted       = 5;  // barge-in acknowledged
    ErrorEvent        error             = 6;
  }
}
```

Turn boundaries are driven by **Gemini Live's server-side VAD**; Node streams audio
continuously while the session is hot and lets VAD/`TurnComplete` delimit turns.

### 4. Voice sidecar (`voice-sidecar/`)

- `grpc.aio` async server implementing `Voice`.
- On `SessionStart`: open a Gemini Live session via
  `client.aio.live.connect(model=<live-audio-model>, config=LiveConnectConfig(...))`
  with:
  - `response_modalities=[AUDIO]`, a configurable `speech_config` voice,
  - `system_instruction` = the `channel-voice` prompt passed in `SessionStart`,
  - the recall context seeded as prior turns via `send_client_content(turns=..., turn_complete=False)`,
  - `input_audio_transcription` + `output_audio_transcription` enabled,
  - `realtime_input_config` with automatic VAD + `activity_handling = START_OF_ACTIVITY_INTERRUPTS` (barge-in).
- Bridge loops: forward Node `AudioChunk` → `session.send_realtime_input(audio=Blob)`;
  iterate `session.receive()` → map audio/transcripts/turn-complete/interrupt back to
  `VoiceServerEvent`.
- **Auth:** reuses the `agent-genai-sa` Secret (GEAP/Vertex ADC), `GOOGLE_GENAI_USE_VERTEXAI=true`,
  `GOOGLE_CLOUD_LOCATION=global`, `GEMINI_API_KEY` blanked — identical governed surface
  to the agent sidecar. No new credential exposure.
- **Stateless:** no Mongo, no recall. Just the bridge.

---

## Data Flow (happy path)

1. `/voice join` → bot joins, subscribes to the receiver.
2. User speaks → Node decodes + resamples to 16k mono → Porcupine watches for the keyword.
3. Wake → Node fetches recall + recent buffer from `RecallService`, sends `SessionStart`
   (with that context + the `channel-voice` prompt), then streams PCM.
4. Sidecar → Live (VAD closes the user's turn) → model responds with audio.
5. Sidecar streams `AudioChunk` (24k) + transcripts back → Node plays audio; user
   speaking during playback → **barge-in** stops it.
6. After `TurnComplete`, Node holds the session **hot ~15s** for wake-word-free
   follow-ups; silence past the window → `SessionEnd` → idle.
7. Node writes input + output transcripts to the Mongo message store → `/tldr` + recall.
8. Channel empties or idle timeout → auto-leave.

---

## Error Handling

- **Sidecar down / unhealthy:** health-gate before opening sessions (mirror `AgentClient`);
  if unhealthy on wake, play a short spoken/earcon failure, keep the channel connection.
- **Live 503 / model overload:** sidecar reconnects with exponential backoff (reuse the
  retry ethos from `agent.py`); unrecoverable → `ErrorEvent` → Node notifies the user
  audibly and returns to idle.
- **Discord voice disconnect:** handle `VoiceConnectionStatus.Disconnected` → attempt
  reconnect, re-subscribe; give up + `/voice leave` after N failures.
- **Resample / Porcupine frame errors:** drop the frame, continue (never crash the loop).
- **Cost guards:** hard max session duration, idle auto-close, and `VOICE_MAX_SESSIONS`
  concurrency cap so nothing streams to the paid model unbounded.

---

## Testing (TDD)

- **Node (`__tests__/`):** state-machine unit tests with a fake receiver, fake
  Porcupine, and fake gRPC stream — wake transition, follow-up-window timer, barge-in
  stop, auto-leave, health-gate fallback. Slash-command tests (mock voice connection +
  `isEnabled()`), following the project's slash-command test conventions.
- **Sidecar (`voice-sidecar/tests/`):** bridge tests against a **fake Live session**
  (canned `receive()` events) — `SessionStart` seeding (system prompt + recall turns),
  audio + transcript forwarding, `TurnComplete`/`Interrupted` mapping, error
  propagation. Mirrors the agent sidecar's fake-orchestrator test style.
- **Pre-flight validation gate:** a probe (script or test) that confirms the chosen
  **Live audio model actually serves on GEAP `global`** before wiring the bridge —
  the flash-model 404-at-`us-central1` lesson applies here too.
- Full `npm test` + sidecar `pytest` green before deploy.

---

## Deployment

- **New image** `mvilliger/discord-article-bot-voice:<git-sha>` from `voice-sidecar/`
  (deps: `google-genai` — or `google-adk` if reused —, `grpcio`, otel; **no** Mongo).
  Pinned to git short-SHA per project rule.
- **New Deployment** `discord-article-bot-voice` — **`RollingUpdate`, replicas
  configurable** (the entire reason it's a separate service). Mounts `agent-genai-sa`
  Secret; GEAP env + OTLP env; a gRPC `Service`.
- **NetworkPolicy:** egress to `aiplatform.googleapis.com`; allow bot → voice sidecar
  on the gRPC port.
- **Bot config:** new `voice` block in `config/config.js` — `VOICE_ENABLED`,
  `VOICE_GRPC_ADDR`, `PICOVOICE_ACCESS_KEY` (Secret), `VOICE_WAKE_WORD`,
  `VOICE_LIVE_VOICE`, `VOICE_LIVE_MODEL`, `VOICE_FOLLOWUP_WINDOW_MS`,
  `VOICE_IDLE_TIMEOUT_MS`, `VOICE_MAX_SESSIONS`, `VOICE_MAX_SESSION_SECONDS`.
- **New Node deps** in `package.json`: `@discordjs/voice`, an Opus decoder + encryption
  lib, a resampler, `@picovoice/porcupine-node`.
- **New slash command** must be run through `scripts/registerCommands.js` after deploy.

---

## Upfront Dependencies / Risks

1. **Picovoice access key** — free for personal use; built-in keyword ("computer" /
   "jarvis") needs no training. Custom "Hey Revenant" is a later Picovoice-console step.
2. **Live audio model on GEAP** — must validate reachability on `global` *before*
   wiring (the pre-flight gate). Model id becomes `VOICE_LIVE_MODEL`.
3. **Native audio deps** (Opus/encryption/resampler) add build weight to the bot image;
   confirm they build cleanly in the bot Dockerfile.

---

## Sandbox Delegation (future note, not this spec)

If a voice turn ever needs code execution, the voice sidecar should **proxy** that tool
call to the agent sidecar's existing gRPC rather than duplicate the sandbox — keeping
the do-not-scale sandbox concurrency state in exactly one place. Not wired in v1.
