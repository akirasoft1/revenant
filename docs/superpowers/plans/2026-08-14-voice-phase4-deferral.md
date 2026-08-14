# Voice Phase 4: Human-Like Turn Deferral ("announce and release") — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When someone speaks while another person holds the floor, the bot notices them, acknowledges them **by name after it has finished speaking**, and then **releases the floor** so whoever speaks next takes it.

**Architecture:** Withholding stays exactly as it is — the interjector's audio is still never forwarded. What's new: their speech duration accrues on their per-user context; once it exceeds a threshold they are a *qualified* waiter. `_tick` (already running at 250 ms) watches for the moment the reply's **playback has drained** — not `turnComplete`, which only means the model stopped generating — and sends a new `AcknowledgeWaiting` control event. The sidecar injects a `[SYSTEM: …]` nudge with `turn_complete=True`, the model phrases the acknowledgment in its own voice, then the floor is released and the speaker identity is cleared.

**Tech Stack:** Node.js (bot), Python sidecar (`google-genai`), gRPC/protobuf, Jest + pytest.

**Spec:** `docs/superpowers/specs/2026-08-14-voice-phase4-deferral-design.md` — read it; §2 (the `turnComplete` finding) is the reason this design looks the way it does.

## Global Constraints

- **The trigger is PLAYBACK DRAIN, never `turnComplete`.** `session.on('turnComplete')` calls `_endPlayback` → `stream.end()`, which lets buffered audio *drain afterwards*; `services/VoiceService.js:298` documents that `player.state.status` stays `playing`/`buffering` through that drain. Gemini Live streams audio faster than real-time, so the model finishes generating long before the bot stops talking. Any implementation that fires on `turnComplete` will interrupt the bot mid-word.
- **Ships with the flag OFF.** `VOICE_DEFERRAL_ENABLED` defaults to `false`. With it off, behaviour must be **byte-identical to today**. The enriched measurement logging ships ON regardless (it is debug-level and behaviour-free).
- **`FloorControl` is NOT modified.** `waiting()` and `release()` already suffice; waiting-duration lives on the per-user context.
- **Never invent a name.** An unresolvable speaker produces **no** announcement (consistent with Phase 3).
- **Do not regress** the hard-won behaviours: level-triggered turn re-arm (`v.justStarted || (v.speaking && !g.turnActive)`), the `_tick` VAD-gate reset, `_clientEndpointing()` default-off (we do **not** send `audio_stream_end`), half-duplex early-return ordering, floor arbitration, pre-roll speaker labelling.
- **Version lock:** the nudge uses the same mid-conversation `send_client_content` channel as Phase 3 markers — supported on `gemini-live-2.5-flash`, restricted on Gemini 3.x Live. Do not change `VOICE_LIVE_MODEL`.
- Node tests: `npm test` (**baseline 1010 passed**). Sidecar tests: `cd voice-sidecar && .venv/bin/python -m pytest -q` (**baseline 47 passed**) — the system `python3` fails at collection (protobuf gencode 7.35.1 vs runtime 5.29.5). **Run all tests in the FOREGROUND**; do not launch background jobs and wait on notifications.
- **DO NOT DEPLOY** — code + tests only; the controller builds and deploys. Do not touch `k8s/overlays/deployed/` (gitignored, real secrets).
- Never truncate log messages.

---

## File Structure

- **Modify** `config/config.js` — `deferralEnabled`, `deferralMinSpeechMs`.
- **Modify** `proto/voice.proto` **and** `voice-sidecar/proto/voice.proto` — `AcknowledgeWaiting`, oneof **field 6**; regenerate `voice-sidecar/src/voice_pb2.py`.
- **Modify** `services/VoiceClient.js` — `session.sendAcknowledgeWaiting({ displayName })`.
- **Modify** `services/VoiceService.js` — waiting accrual + enriched log (non-holder branch); the drain trigger in `_tick`; release + speaker-clear; `ackedThisTurn` lifecycle; persona clause.
- **Modify** `voice-sidecar/src/live_bridge.py` — handle `acknowledge_waiting`; treat empty `SetSpeaker.display_name` as **clear**.
- **Modify** `scripts/test-floor.js`, `scripts/smoke-voice-identity.js` — offline + real-model coverage.
- **Modify** `CLAUDE.md`, `features.md`.

---

### Task 1: Config + measurement logging (ships even with the feature off)

**Files:**
- Modify: `config/config.js`
- Modify: `services/VoiceService.js` (non-holder branch only)
- Test: `__tests__/services/VoiceService.test.js`

**Interfaces:**
- Produces `config.voice.deferralEnabled` (`VOICE_DEFERRAL_ENABLED === 'true'`, default **false**) and `config.voice.deferralMinSpeechMs` (`VOICE_DEFERRAL_MIN_SPEECH_MS`, default **700**).
- Produces `u.waitingMs` on the per-user context: milliseconds of VAD-detected speech accrued *while withheld*, reset when the floor is released.

- [ ] **Step 1: Write the failing test**

```javascript
// __tests__/services/VoiceService.test.js (add)
describe('waiting-speaker measurement', () => {
  test('accrues withheld speech duration on the non-holder per-user context', async () => {
    const holderGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const otherGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const gates = { alice: holderGate, bob: otherGate };
    const { svc, guildId } = await buildActiveVoiceService({
      holder: 'alice',
      makeVadGate: () => gates.__next || holderGate,
    });
    const g = svc._guilds.get(guildId);
    // seed bob's context with his own gate so the non-holder branch uses it
    svc._perUser(g, 'bob').vadGate = otherGate;

    // 20ms frame @16k mono = 320 samples = 640 bytes
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2)));
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2)));

    expect(g.floor.waiting()).toContain('bob');
    expect(svc._perUser(g, 'bob').waitingMs).toBeGreaterThan(0);
  });
});
```

> Use the file's real `buildActiveVoiceService`/`fakeVadGate`/`to48kStereo` helpers — read them first. If the harness cannot give two speakers different gates, generalise it minimally (that generalisation is part of this task).

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --testPathPatterns="VoiceService" -t "waiting-speaker measurement"`
Expected: FAIL — `waitingMs` is undefined.

- [ ] **Step 3: Add the config**

In `config/config.js`, inside `voice: { … }`:

```javascript
    // Phase 4 deferral: acknowledge a speaker who interjected while someone
    // else held the floor. Default OFF -- the qualification threshold below is
    // meant to be set from the measurement logging before this is flipped on.
    deferralEnabled: process.env.VOICE_DEFERRAL_ENABLED === 'true',
    // How much VAD-detected speech a withheld speaker must produce before they
    // are worth announcing. Filters coughs, one-word backchannels and any echo
    // that survives Discord's client-side AEC.
    deferralMinSpeechMs: parseInt(process.env.VOICE_DEFERRAL_MIN_SPEECH_MS || '700', 10),
```

- [ ] **Step 4: Accrue duration + enrich the log**

In `services/VoiceService.js`, replace the non-holder branch body:

```javascript
    if (!isHolder) {
      const nv = u.vadGate ? u.vadGate.push(pcm16) : { speaking: false, justStarted: false, justEnded: false };
      if (nv.speaking) {
        // 16 kHz mono s16le -> 2 bytes/sample. Accrue only REAL speech, so a
        // waiter is qualified on how long they actually talked, not on how long
        // Discord happened to deliver packets.
        u.waitingMs = (u.waitingMs || 0) + Math.round((pcm16.length / 2) / 16);
      }
      if (nv.justStarted) {
        g.floor.noteWaiting(userId);
      }
      if (nv.justEnded) {
        // Measurement (ships even with the feature off): is this a real
        // interjection, or the bot's own voice re-entering someone's mic? The
        // threshold VOICE_DEFERRAL_MIN_SPEECH_MS is meant to be set from this.
        const playing = g.player && g.player.state && g.player.state.status;
        logger.debug(`voice: withheld speech from ${u.name || userId} in guild ${guildId}: ${u.waitingMs || 0}ms while ${g.floor.holder()} holds the floor, bot playback=${playing || 'idle'}`);
      }
      return;
    }
```

- [ ] **Step 5: Run tests to green**

Run: `npm test` → all pass (1010 + your new test).

- [ ] **Step 6: Commit**

```bash
git add config/config.js services/VoiceService.js __tests__/services/VoiceService.test.js
git commit -m "feat(voice): measure withheld-speaker duration + deferral config (flag off)"
```

---

### Task 2: `AcknowledgeWaiting` on the wire

**Files:**
- Modify: `proto/voice.proto`, `voice-sidecar/proto/voice.proto`, regenerate `voice-sidecar/src/voice_pb2.py`
- Modify: `services/VoiceClient.js`
- Test: `__tests__/services/VoiceClient.test.js`, `voice-sidecar/tests/test_proto_context_fields.py`

**Interfaces:**
- Produces `message AcknowledgeWaiting { string display_name = 1; }` and `AcknowledgeWaiting acknowledge_waiting = 6;` in the `VoiceClientEvent` oneof (1–5 are taken).
- Produces `session.sendAcknowledgeWaiting({ displayName })` → `call.write({ acknowledge_waiting: { display_name } })`, guarded exactly like `sendSpeaker` so a write on a closing stream cannot throw.

- [ ] **Step 1: Add to BOTH proto copies**

```proto
// Ask the model to acknowledge someone who tried to speak while it was
// replying. Sent once, after the bot's playback has drained.
message AcknowledgeWaiting {
  string display_name = 1;
}
```
and inside `VoiceClientEvent`'s oneof, after `set_speaker = 5;`:
```proto
    AcknowledgeWaiting acknowledge_waiting = 6;
```
Keep the two files byte-identical for this addition.

- [ ] **Step 2: Regenerate the stub**

From `voice-sidecar/`: `.venv/bin/python -m grpc_tools.protoc -I proto --python_out=src --grpc_python_out=src proto/voice.proto`

- [ ] **Step 3: Verify the stub**

Run: `cd voice-sidecar && .venv/bin/python -c "from src import voice_pb2; e=voice_pb2.VoiceClientEvent(acknowledge_waiting=voice_pb2.AcknowledgeWaiting(display_name='Sarah')); print(e.WhichOneof('event'), e.acknowledge_waiting.display_name)"`
Expected: `acknowledge_waiting Sarah`

- [ ] **Step 4: Add the sender**

In `services/VoiceClient.js`, beside `sendSpeaker`:

```javascript
    session.sendAcknowledgeWaiting = ({ displayName }) => {
      try {
        call.write({ acknowledge_waiting: { display_name: displayName || '' } });
      } catch (e) {
        logger.debug(`VoiceClient sendAcknowledgeWaiting write threw: ${e.message}`);
      }
    };
```

Add a `VoiceClient.test.js` case mirroring the existing `sendSpeaker` test (writes the right shape; a throwing `write` is swallowed).

- [ ] **Step 5: Both suites green**

Run: `npm test` and `cd voice-sidecar && .venv/bin/python -m pytest -q`.

- [ ] **Step 6: Commit**

```bash
git add proto/voice.proto voice-sidecar/proto/voice.proto voice-sidecar/src/voice_pb2.py services/VoiceClient.js __tests__/services/VoiceClient.test.js voice-sidecar/tests/test_proto_context_fields.py
git commit -m "feat(voice): AcknowledgeWaiting control event"
```

---

### Task 3: Sidecar — inject the nudge, and treat an empty speaker as CLEAR

**Files:**
- Modify: `voice-sidecar/src/live_bridge.py`
- Test: `voice-sidecar/tests/test_live_bridge.py`

**Interfaces:**
- Consumes `acknowledge_waiting` (Task 2).
- On receipt, sends `send_client_content(turns=Content(role="user", parts=[Part(text=NUDGE)]), turn_complete=True)` where
  `NUDGE = f"[SYSTEM: {name} tried to speak while you were replying. Briefly let them know you noticed, in your own voice. Do not answer anything else yet.]"`.
  `turn_complete=True` (unlike the Phase 3 speaker marker's `False`) because we *want* a generated reply.
- Empty/whitespace `display_name` → send nothing.
- Names are scrubbed of `[`/`]` before formatting, exactly as the speaker marker is.
- Counted on `_SessionStats` as `deferral_acks`, included in the session END log.
- **Changed behaviour:** `set_speaker` with an empty `display_name` now means **clear** — `current_speaker = None; pending_speaker = None` — instead of being ignored.

- [ ] **Step 1: Write the failing tests**

```python
# voice-sidecar/tests/test_live_bridge.py (add)
async def test_acknowledge_waiting_injects_a_completing_turn():
    session = FakeSession([])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    async def emit(ev): pass
    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
        yield voice_pb2.VoiceClientEvent(acknowledge_waiting=voice_pb2.AcknowledgeWaiting(display_name="Sarah"))
        await asyncio.Event().wait()
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.1)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    nudges = [(t, c) for (t, c) in session.seeded if "[SYSTEM:" in str(t)]
    assert len(nudges) == 1, f"expected one nudge, got {nudges}"
    assert "Sarah" in str(nudges[0][0])
    assert nudges[0][1] is True, "the nudge MUST complete the turn so the model replies"


async def test_empty_acknowledge_waiting_sends_nothing():
    session = FakeSession([])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    async def emit(ev): pass
    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
        yield voice_pb2.VoiceClientEvent(acknowledge_waiting=voice_pb2.AcknowledgeWaiting(display_name="   "))
        await asyncio.Event().wait()
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.1)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert not any("[SYSTEM:" in str(t) for (t, _c) in session.seeded)


async def test_empty_set_speaker_clears_so_the_next_speaker_re_announces():
    session = FakeSession([])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    async def emit(ev): pass
    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
        yield voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(user_id="u1", display_name="Mike"))
        yield voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"\x01"))
        yield voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(user_id="", display_name=""))  # CLEAR
        yield voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(user_id="u1", display_name="Mike"))
        yield voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"\x02"))
        await asyncio.Event().wait()
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.1)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    markers = [str(t) for (t, _c) in session.seeded if "[SPEAKER:" in str(t)]
    # Without the clear, the second "Mike" would dedupe away and produce ONE marker.
    assert len(markers) == 2, f"clear did not re-arm; markers={markers}"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd voice-sidecar && .venv/bin/python -m pytest tests/test_live_bridge.py -k "acknowledge or clears" -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `_pump_client`, add a branch alongside `set_speaker` (before the `session is None` guard so the intent is not lost during a reconnect gap — mirror how `set_speaker` is handled):

```python
            if kind == "acknowledge_waiting":
                name = (ev.acknowledge_waiting.display_name or "").strip()
                if name:
                    pending_ack = name.replace("[", "").replace("]", "")
                continue
```

and where `pending_ack` is flushed (immediately, once a session exists — it does not wait for audio, unlike the speaker marker):

```python
        if pending_ack and session is not None:
            try:
                await session.send_client_content(
                    turns=types.Content(role="user", parts=[types.Part(
                        text=f"[SYSTEM: {pending_ack} tried to speak while you were replying. "
                             f"Briefly let them know you noticed, in your own voice. "
                             f"Do not answer anything else yet.]")]),
                    # turn_complete=True (NOT False like the speaker marker): we
                    # WANT a generated reply here -- this is the acknowledgment.
                    turn_complete=True,
                )
                stats.deferral_acks += 1
                logger.info("voice: acknowledged waiting speaker %s", pending_ack)
            except Exception:  # noqa: BLE001
                logger.warning("voice: failed to send deferral acknowledgment", exc_info=True)
            finally:
                pending_ack = None
```

Declare `pending_ack = None` with the other per-session latches; reset it on session swap. Add `deferral_acks` to `_SessionStats.__slots__`/`__init__` and to the session END log.

Change the `set_speaker` branch so an empty name CLEARS:

```python
            if kind == "set_speaker":
                name = (ev.set_speaker.display_name or "").strip()
                if not name:
                    # Explicit clear (Phase 4 floor release): without this the next
                    # speaker would inherit the previous speaker's identity.
                    current_speaker = None
                    pending_speaker = None
                elif name != current_speaker:
                    current_speaker = name
                    pending_speaker = name
                continue
```

- [ ] **Step 4: Sidecar suite green**

Run: `cd voice-sidecar && .venv/bin/python -m pytest -q` → 47 + 3 new.

- [ ] **Step 5: Commit**

```bash
git add voice-sidecar/src/live_bridge.py voice-sidecar/tests/test_live_bridge.py
git commit -m "feat(voice): inject the deferral acknowledgment; empty SetSpeaker clears the speaker"
```

---

### Task 4: The drain trigger in `_tick` (the heart of the feature)

**Files:**
- Modify: `services/VoiceService.js`
- Test: `__tests__/services/VoiceService.test.js`

**Interfaces:**
- Consumes `config.voice.deferralEnabled` / `deferralMinSpeechMs` (Task 1), `session.sendAcknowledgeWaiting` (Task 2).
- Adds `g.ackedThisTurn` to guild state (`false` in `join`), set `true` on announcement, reset to `false` whenever a new turn opens (where `g.turnActive` is set true) and in `_endSession`.
- In `_tick`, after the existing `audio_stream_end` backstop block and before `this._apply(guildId, g.machine.onTick(now))`, add the announcement.

- [ ] **Step 1: Write the failing tests**

```javascript
// __tests__/services/VoiceService.test.js (add)
describe('deferral: announce and release', () => {
  function qualifiedWaiter(svc, guildId, userId, name = 'Sarah') {
    const g = svc._guilds.get(guildId);
    const u = svc._perUser(g, userId);
    u.name = name;
    u.waitingMs = 5000;              // comfortably over the threshold
    g.floor.noteWaiting(userId);
    return g;
  }

  test('does NOT announce while the bot is still playing (drain, not turnComplete)', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'playing' };   // model finished generating; audio still draining
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
  });

  test('announces once the playback has drained, then releases the floor and clears the speaker', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledWith({ displayName: 'Sarah' });
    expect(g.floor.holder()).toBeNull();                       // released, not handed over
    expect(session.sendSpeaker).toHaveBeenCalledWith(          // identity cleared
      expect.objectContaining({ displayName: '' }));
  });

  test('does not announce an unqualified (too-short) waiter', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = svc._guilds.get(guildId);
    const u = svc._perUser(g, 'bob'); u.name = 'Sarah'; u.waitingMs = 100;  // below 700ms
    g.floor.noteWaiting('bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
  });

  test('does not announce a waiter with no resolvable name', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = svc._guilds.get(guildId);
    const u = svc._perUser(g, 'bob'); u.name = null; u.waitingMs = 5000;
    g.floor.noteWaiting('bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
  });

  test('announces at most once per turn', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledTimes(1);
  });

  test('with the flag OFF, behaviour is unchanged', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({});  // default: disabled
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
    expect(g.floor.holder()).not.toBeNull();
  });
});
```

> Extend `buildActiveVoiceService` to accept `deferralEnabled` (passed into the config overrides) and to expose `player`; add `sendAcknowledgeWaiting: jest.fn()` to the fake session alongside `sendSpeaker`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --testPathPatterns="VoiceService" -t "deferral"`
Expected: FAIL.

- [ ] **Step 3: Implement the trigger**

In `_tick`, after the `audio_stream_end` backstop block:

```javascript
    // --- Phase 4: announce a waiting speaker, then release the floor.
    //
    // The trigger is PLAYBACK DRAIN, not turnComplete. turnComplete only means
    // the MODEL stopped generating -- _endPlayback then ends the stream so the
    // buffered audio drains afterwards, and Live streams faster than real-time,
    // so the bot is typically still talking for seconds after turnComplete.
    // Announcing then would cut it off mid-word.
    if (this._config.voice && this._config.voice.deferralEnabled
        && g.session && !g.ackedThisTurn && g.machine.state === 'hot') {
      const playing = g.player && g.player.state && g.player.state.status;
      const drained = playing !== 'playing' && playing !== 'buffering';
      if (drained) {
        const minMs = this._config.voice.deferralMinSpeechMs || 0;
        const waiterId = g.floor.waiting().find((id) => {
          const wu = g.perUser.get(id);
          // Qualified = spoke long enough to be a real interjection AND we know
          // what to call them. Never invent a name (Phase 3 rule).
          return wu && wu.name && (wu.waitingMs || 0) >= minMs;
        });
        if (waiterId) {
          const wu = g.perUser.get(waiterId);
          logger.info(`voice: acknowledging waiting speaker ${wu.name} in guild ${guildId} (${wu.waitingMs}ms of withheld speech)`);
          try { g.session.sendAcknowledgeWaiting({ displayName: wu.name }); }
          catch (e) { logger.warn(`voice: sendAcknowledgeWaiting failed: ${e.message}`); }
          g.ackedThisTurn = true;
          // Release rather than hand over: if the invitation lands on nobody,
          // the next real speaker simply takes the floor and the room
          // self-corrects. Handing the floor to someone we have not heard is
          // how you get a deaf bot.
          g.floor.release();
          for (const pu of g.perUser.values()) pu.waitingMs = 0;
          g.lastSpeakerSent = null;
          // Clear the model's idea of who is talking, or the next speaker
          // inherits this identity (the hazard Phase 3's review deferred here).
          try { if (typeof g.session.sendSpeaker === 'function') g.session.sendSpeaker({ userId: '', displayName: '' }); }
          catch (e) { logger.warn(`voice: speaker clear failed: ${e.message}`); }
        }
      }
    }
```

Add `ackedThisTurn: false` to the guild state object in `join`; set `g.ackedThisTurn = false` where a new turn opens (next to `g.turnActive = true; g.audioEndSent = false;`) and in `_endSession`.

- [ ] **Step 4: Add the persona clause**

In `_appendVoicePersona`, add:

```javascript
      `Lines beginning "[SYSTEM:" are out-of-band notes to you, exactly like the "[SPEAKER:" markers — NEVER read them aloud or mention them. If one tells you someone tried to speak while you were talking, just briefly let that person know you noticed, in your own voice, and then stop and wait for them — don't answer whatever you think they were going to ask.`,
```

- [ ] **Step 5: Run tests to green**

Run: `npm test` → all green.

- [ ] **Step 6: Commit**

```bash
git add services/VoiceService.js __tests__/services/VoiceService.test.js
git commit -m "feat(voice): announce a waiting speaker on playback drain, then release the floor"
```

---

### Task 5: Offline + real-model coverage

**Files:**
- Modify: `scripts/test-floor.js`
- Modify: `scripts/smoke-voice-identity.js`

**Interfaces:** manual harnesses; no unit tests.

- [ ] **Step 1: Extend the two-stream floor harness**

`scripts/test-floor.js` already drives two PCM sources through two real `VoiceActivityGate`s and a real `FloorControl`. Add accrual + qualification to its timeline: track speaker B's speech duration while withheld and print when B becomes QUALIFIED (crosses `700ms`), so the timeline reads e.g. `SPEAKER B START -> withheld (waiting)` … `B QUALIFIED after 740ms`. Assert nothing; this is an eyeball harness.

- [ ] **Step 2: Add a deferral case to the real-model smoke test**

In `scripts/smoke-voice-identity.js`, add an optional third segment (guard behind a `--deferral` flag so the existing run is unchanged): after speaker A's turn, send `AcknowledgeWaiting{display_name:'Sarah'}` and print the resulting reply, then verify:
- the acknowledgment **references Sarah**,
- it is **brief** (assert a character bound, e.g. < 200 chars — brevity is enforced here, NOT in the prompt),
- it does **not** contain `[SYSTEM:` or `[SPEAKER:` (never read aloud),
- it does **not** answer a question Sarah never asked.

- [ ] **Step 3: Run what you can**

Run `node scripts/test-floor.js` (works offline with synthetic buffers). The smoke test needs the sidecar deployed with Task 3's changes — the controller will run it after deploying; just confirm the script parses (`node -c`) and its argument handling works.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-floor.js scripts/smoke-voice-identity.js
git commit -m "test(voice): deferral coverage in the floor harness and identity smoke test"
```

---

### Task 6: Documentation

**Files:** `CLAUDE.md`, `features.md`

- [ ] **Step 1: Update `CLAUDE.md`**

Document under the Voice section: what deferral does; that the trigger is **playback drain, not `turnComplete`** (and why — the model finishes generating long before the bot stops talking); that the floor is **released, not handed over**, and why; the `[SYSTEM: …]` nudge and its persona-led phrasing; the tunables `VOICE_DEFERRAL_ENABLED` (default **false**) and `VOICE_DEFERRAL_MIN_SPEECH_MS` (default 700, *to be set from the withheld-speech measurement logging before enabling*); and that an empty `SetSpeaker` now clears the speaker.

Move "human-like deferral (Phase 4)" **out** of the deferred-follow-ups list. Leave the self-service `/voice name` command there.

- [ ] **Step 2: Update `features.md`** — a bullet: the bot notices someone who tried to interject and acknowledges them by name after it finishes speaking.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md features.md
git commit -m "docs(voice): document Phase 4 turn deferral"
```

---

## Self-Review

**Spec coverage:** §4 mechanism → Tasks 2–4. §5 guardrails (qualification, once-per-turn, first waiter only, kill switch, no-name-no-announcement) → Tasks 1 and 4, each with a test. §5 measurement → Task 1 (ships with the flag off). §6 speaker-clearing → Task 3 (sidecar clear) + Task 4 (bot sends it). §7 components → all covered. §8 testing → Tasks 1, 3, 4, 5. §9 YAGNI respected: no ledger, no TTLs, no ordering, no `WHEN_IDLE`, no `skip_turn` tool, no buffering. ✓

**Placeholder scan:** No TBDs. Task 5 is deliberately assertion-light for the floor harness (it is an eyeball tool, consistent with how it already works) and states so. Test helpers are deferred to the real ones in the existing file, with the harness generalisation called out as part of the task.

**Type consistency:** `u.waitingMs` written in Task 1, read in Task 4. `u.name` (Phase 3) read in Task 4. `sendAcknowledgeWaiting({displayName})` defined Task 2, called Task 4, asserted in Task 4's tests. `acknowledge_waiting` proto field 6 defined Task 2, consumed Task 3. `g.ackedThisTurn` added and reset in Task 4. `sendSpeaker({userId:'',displayName:''})` (Phase 3 API) used in Task 4, interpreted as CLEAR in Task 3.

**Known risk (flagged):** the trigger reads `g.player.state.status` directly, matching the existing half-duplex check at `VoiceService.js:301`. If a fake player in a test lacks `.state`, the guard must not throw — `drained` is computed defensively from an optional chain.
