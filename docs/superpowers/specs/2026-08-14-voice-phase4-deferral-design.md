# Voice Phase 4: Human-Like Turn Deferral ("announce and release") — Design

- **Date:** 2026-08-14
- **Status:** Approved (design), pending implementation plan
- **Related:** [`2026-08-13-multi-user-voice-vad-rework-design.md`](2026-08-13-multi-user-voice-vad-rework-design.md) (Phases 1–3; this closes its Phase 4 deferral item)

---

## 1. Problem

Today a second person who speaks while someone holds the floor is **silently ignored**: their audio is never forwarded, the bot never hears them, and it never acknowledges them. They have no way to know whether the bot noticed.

The goal, in the owner's words: *"no more than a human would do — when talking about topic X and someone asks about topic Y, it can be confirmed with 'let me finish X and get back to Y'."*

## 2. The finding that shaped this design

**`turnComplete` does not mean "the bot finished talking." It means the model finished generating.**

Verified in our own code: `session.on('turnComplete')` calls `_endPlayback`, which calls `stream.end()` so the *buffered* audio drains afterwards; `VoiceService.js:298` already documents that `player.state.status` stays `playing`/`buffering` "through the reply incl. drain." Gemini Live streams audio **faster than real-time**, so for a ~12s reply the model is done in ~2s.

Two consequences:

1. **Interrupting mid-reply is mostly inoperative.** For most of every reply there is no server-side generation to interrupt. Interrupting locally means `player.play()` replacing a still-draining resource: a hard cut mid-word, no `interrupted` event, no way to resume — destroying the first person's answer.
2. **The correct trigger is playback drain**, not `turnComplete`. `_tick` already runs at 250 ms and can observe `player.state.status`.

Designs built on "interrupt at `turnComplete`" were rejected for this reason.

## 3. Decisions (owner-approved)

| Question | Decision |
|---|---|
| When to acknowledge | **After the bot finishes speaking** (playback drain), never mid-sentence |
| Who gets the floor after | **Nobody** — `release()`; the next person to speak takes it |
| Interjector's audio | **Never forwarded**; they repeat themselves after being invited |

**Why release rather than hand off:** every catastrophic failure the adversarial review found came from *moving* the floor to someone the bot has not actually heard — a deaf bot, a wedged session, transcripts filed under the wrong person. Release is self-correcting: if the invitation lands on nobody (they wandered off, it was a cough, it was echo), the next real speaker simply takes the floor. It also needs **zero changes to `FloorControl`** — `waiting()` and `release()` already suffice.

## 4. Mechanism

**Trigger** (evaluated in `_tick`, all must hold):
- `g.machine.state === 'hot'` (the reply's turn completed), AND
- the player has **drained** (`g.player.state.status` is neither `playing` nor `buffering`), AND
- `g.floor.waiting()` is non-empty and contains at least one **qualified** waiter (§5), AND
- we have not already acknowledged during this turn (`g.ackedThisTurn`), AND
- `config.voice.deferralEnabled`.

**Action**, in order:
1. Send a new `AcknowledgeWaiting { display_name }` control event for the first qualified waiter (resolved through `SpeakerNames`; an unresolvable name means **no announcement** — never invent one).
2. The sidecar injects, via `send_client_content(turn_complete=True)`:
   `[SYSTEM: <Name> tried to say something while you were replying. Acknowledge them by name in one short sentence and invite them to go ahead. Do not answer anything else.]`
   `turn_complete=True` here (unlike the Phase 3 speaker marker, which uses `False`) because we *want* a generated reply — one short line in the bot's own voice.
3. On that reply's completion: `g.floor.release()`, and send `SetSpeaker` with an **empty** `display_name` so the sidecar clears `current_speaker` (§6).
4. Set `g.ackedThisTurn = true`; reset it when a new turn opens.

Cost: one short extra model turn per acknowledgment.

## 5. Guardrails (what stops it embarrassing us)

- **Qualified waiter only.** A waiting speaker qualifies once their VAD-detected speech in the withheld branch exceeds `VOICE_DEFERRAL_MIN_SPEECH_MS`. Duration accrues on the **per-user context** (`u.waitingMs`), *not* in `FloorControl`, keeping that unit unchanged. Coughs, one-word backchannels, and echo bursts do not earn an announcement.
- **One acknowledgment per turn**, never chained.
- **Only the first qualified waiter** is named. No queue, no ordering, no multi-name announcements.
- **Kill switch:** `VOICE_DEFERRAL_ENABLED` (default **false** initially) restores today's exact behaviour.
- **Unresolvable name → no announcement.** Consistent with Phase 3's "never assert a name we aren't confident in."

### The measurement that sets the threshold

The strongest objection to this whole feature: a friend on **laptop speakers** has the bot's own voice re-enter their mic, Silero calls it speech, and the bot apologises to someone who never spoke. Discord's client-side WebRTC AEC + Krisp probably prevents this — but that is an assumption, and this project has been bitten by exactly that class of assumption.

So the existing withheld-speaker debug line (`VoiceService.js:314`) is **enriched first** with: speech duration, whether the player was playing at the time, and the resolved name. It ships with the feature (flag off), and `VOICE_DEFERRAL_MIN_SPEECH_MS` is set from real logged data before the flag is flipped on.

## 6. Speaker-clearing (the hazard Phase 4 makes reachable)

Phase 3's final review flagged: there is no way to **clear** the speaker, so a speaker with no resolvable name inherits the previous speaker's identity. It was unreachable while exactly one holder existed per session. **Phase 4 breaks that invariant** — this is where it gets fixed.

- Bot: on floor release, send `SetSpeaker { user_id: '', display_name: '' }`.
- Sidecar: treat an empty `display_name` as **clear** — set `current_speaker = None` and `pending_speaker = None` — rather than the current "ignore empty" behaviour.
- Consequence: the next speaker's `SetSpeaker` always produces a fresh marker, because `name != current_speaker` is trivially true after a clear.

## 7. Components

- **`proto/voice.proto` + `voice-sidecar/proto/voice.proto`** — `AcknowledgeWaiting { string display_name = 1; }` as `VoiceClientEvent` oneof **field 6** (1–5 taken); regenerate `voice_pb2.py`.
- **`services/VoiceClient.js`** — `session.sendAcknowledgeWaiting({ displayName })`, guarded like `sendSpeaker`.
- **`services/VoiceService.js`** — waiting-duration accrual in the non-holder branch; the `_tick` trigger; the release + speaker-clear; `g.ackedThisTurn` lifecycle; the enriched measurement log.
- **`voice-sidecar/src/live_bridge.py`** — handle `acknowledge_waiting` (inject the nudge, `turn_complete=True`); treat empty `SetSpeaker.display_name` as clear.
- **`config/config.js`** — `deferralEnabled` (`VOICE_DEFERRAL_ENABLED`, default false), `deferralMinSpeechMs` (`VOICE_DEFERRAL_MIN_SPEECH_MS`, default 700).
- **Prompt** — `_appendVoicePersona` gains one clause explaining that a `[SYSTEM: …]` acknowledgment instruction means "say one short line, then stop."
- **`FloorControl` — unchanged.**

## 8. Testing

- **Unit (`VoiceService`)**: acknowledgment fires on **drain**, not on `turnComplete` (assert it does *not* fire while `player.state.status === 'playing'`); does not fire for an unqualified (too-short) waiter; fires at most once per turn; releases the floor and sends the empty `SetSpeaker`; with the flag off, behaviour is byte-identical to today.
- **Sidecar**: `acknowledge_waiting` injects with `turn_complete=True`; empty `SetSpeaker` clears the speaker so the next one re-announces.
- **Offline**: extend `scripts/test-floor.js` — two streams where B interjects mid-A — asserting B is withheld, qualifies, and is announced after drain.
- **Real-model**: extend `scripts/smoke-voice-identity.js` with a deferral case, checking the acknowledgment names B, is one short line, and does not answer B's question.

## 9. Explicitly NOT building (YAGNI)

- A deferred-question **debt ledger** ("did we ever get back to Y?"). Acknowledging *after* the answer collapses promise and redemption into one utterance — no promise to track.
- Wait-age timestamps, TTLs, priority ordering, multi-waiter announcements. Four friends in a channel; `waiting()[0]` and one name is enough.
- `scheduling=WHEN_IDLE` async function calling — genuinely the purpose-built primitive, but unverified on GEAP/Vertex and **unsupported on Gemini 3.x Live**, which would weld us to `gemini-live-2.5-flash` for a second independent reason.
- A model-invoked `skip_turn`-style tool. Research is unambiguous that LLMs are near chance at addressee detection from audio and weak at turn timing. Detect deterministically in JS; let the model only phrase the line.
- Any VAP / predictive turn-taking model (~48% next-speaker accuracy at three speakers).
- Buffering and replaying the interjector's audio (owner-rejected; replayed audio reads as current speech — a bug we already hit during reconnects).

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **False-positive announcement** (echo/noise from a friend on speakers) — the bot apologises to someone who never spoke | Med | Measurement-first threshold; qualified-waiter minimum; flag default off; kill switch |
| Announcement fires while two humans are talking *to each other*, not to the bot | Med | Minimum-duration threshold; one line, never chained; it invites rather than answers |
| Extra billed model turn per acknowledgment | Low | One short turn; gated behind the qualification threshold |
| Empty-`SetSpeaker`-as-clear changes existing sidecar semantics | Low | Currently empty names are ignored, so nothing depends on the old behaviour; covered by a test |
| Depends on the model obeying "one short line" | Low-Med | Prompt clause; observable in the smoke test; worst case is a chattier acknowledgment |

## 11. Version lock (inherited)

The nudge uses the same mid-conversation `send_client_content` channel as Phase 3's speaker markers — supported on `gemini-live-2.5-flash`, **restricted on Gemini 3.x Live**. Do not move `VOICE_LIVE_MODEL` without revisiting this and spec §5.4 of the Phase 1–3 design.
