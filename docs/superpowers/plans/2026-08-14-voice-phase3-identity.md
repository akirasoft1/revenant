# Voice Phase 3: Model Identity-Awareness (speaker names) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the bot know *who* is speaking and address people by name in voice — and fix the same name problem in chat/recall, where friends currently appear as `inc1067`.

**Architecture:** A shared **`SpeakerNames`** resolver turns a Discord user into a *spoken* name (override table → `globalName` → nickname → de-suffixed username → omit), sanitised for TTS. In voice, `VoiceService` resolves the floor-holder's name once per speaker and sends a new `SetSpeaker` control event on **speaker change**; the sidecar injects `[SPEAKER: <name>]` via `send_client_content(turn_complete=False)` immediately before that speaker's audio, with a roster + "never read these aloud" rule in `system_instruction`. Chat/recall uses the same resolver so `/tldr` and channel context show preferred names.

**Tech Stack:** Node.js (bot), Python sidecar (`google-genai`), gRPC/protobuf, Jest + pytest.

**Spec:** `docs/superpowers/specs/2026-08-13-multi-user-voice-vad-rework-design.md` — §5.4 (identity injection), **§5.4.1** (where the name comes from — decided 2026-08-14), §9 (grounded Gemini plumbing).

## Global Constraints

- **Model is version-locked to `gemini-live-2.5-flash`.** The `send_client_content` marker pattern is supported mid-conversation on 2.5 Live but **restricted on Gemini 3.x Live**. Do not change `VOICE_LIVE_MODEL` as part of this work; if it ever moves to 3.x, §5.4 must be revisited.
- **Names are SPOKEN.** Every name that reaches the model must go through sanitisation. An unsanitised `Macroplastics by Bic(tm)` is voiced literally.
- **Never assert a wrong name:** if resolution yields nothing usable, omit the marker entirely rather than guess.
- Deploy target namespace `discord-article-bot`, container `bot`; no `:latest` tags. **Do NOT deploy as part of this plan** — code + tests only; the human runs the deploy.
- `k8s/overlays/deployed/` is gitignored and holds real secrets — only the **tracked** manifests/docs may be edited here.
- Sidecar tests run from `voice-sidecar/` with the venv interpreter: **`.venv/bin/python -m pytest -v`** (the system `python3` fails at collection: protobuf gencode 7.35.1 vs runtime 5.29.5). Node tests: `npm test`.
- `GuildMembers` is a privileged intent and is **NOT enabled** (`config/config.js` `intents`). Do not add it; the override table exists so nickname lookup is never required. Any member lookup must degrade gracefully when unavailable.
- Never truncate log messages.

---

## File Structure

- **Create** `services/SpeakerNames.js` — the shared resolver. Pure except for an optional Discord lookup; no I/O in the hot path.
- **Create** `__tests__/services/SpeakerNames.test.js`.
- **Modify** `config/config.js` — parse `VOICE_SPEAKER_NAMES` JSON into `speakerNames` (a `{userId: name}` object), tolerating malformed JSON.
- **Modify** `proto/voice.proto` **and** `voice-sidecar/proto/voice.proto` — add `SetSpeaker` to the `VoiceClientEvent` oneof (field 5); regenerate `voice-sidecar/src/voice_pb2.py`.
- **Modify** `services/VoiceClient.js` — `session.sendSpeaker({ userId, displayName })`.
- **Modify** `services/VoiceService.js` — resolve + cache the speaker name per user; send `SetSpeaker` on speaker change; include the roster in the system prompt.
- **Modify** `voice-sidecar/src/live_bridge.py` — handle `set_speaker`: remember the current speaker and emit the `[SPEAKER: …]` marker before that speaker's next audio.
- **Modify** `voice-sidecar/tests/test_live_bridge.py`.
- **Modify** `services/ChannelContextService.js` + `bot.js` — use the resolver for `authorName`/participants.
- **Modify** `CLAUDE.md`, `features.md`, and the tracked `k8s/voice/` README/manifest notes as applicable.

---

### Task 1: `SpeakerNames` resolver

**Files:**
- Create: `services/SpeakerNames.js`
- Test: `__tests__/services/SpeakerNames.test.js`
- Modify: `config/config.js`

**Interfaces:**
- Produces `createSpeakerNames({ overrides = {} })` returning:
  - `resolve(user, member) -> string | null` — `user` is a discord.js-shaped `{ id, username, globalName }` (accept `global_name` too); `member` is optional `{ nickname }`. Returns a sanitised spoken name, or `null` when nothing usable.
  - `sanitize(raw) -> string` — exported for tests.
- Resolution order (first non-empty **after sanitisation** wins): `overrides[user.id]` → `user.globalName`/`user.global_name` → `member.nickname` → `user.username` with a trailing digit-run stripped → `null`.
- Sanitisation: strip emoji/pictographs, zero-width chars, `™`, `(tm)`/`(r)` (case-insensitive), bracketed/parenthesised tag groups (`[ABC]`, `(tm)`), collapse whitespace, trim, cap at 24 chars (cut on a word boundary when possible). Empty/whitespace-only → `''` so the caller falls through.
- **Overrides bypass nothing:** an override is still sanitised (it is spoken too), but is never discarded for being "weird" unless it sanitises to empty.

- [ ] **Step 1: Write the failing tests**

```javascript
// __tests__/services/SpeakerNames.test.js
'use strict';
const { createSpeakerNames, sanitize } = require('../../services/SpeakerNames');

const U = (o) => ({ id: 'u1', username: 'inc1067', globalName: null, ...o });

test('override table wins over every Discord source', () => {
  const r = createSpeakerNames({ overrides: { u1: 'Mike' } });
  expect(r.resolve(U({ globalName: 'inc' }), { nickname: 'Macroplastics by Bic(tm)' })).toBe('Mike');
});

test('falls back to globalName, then nickname, then de-suffixed username', () => {
  const r = createSpeakerNames({});
  expect(r.resolve(U({ globalName: 'inc' }), { nickname: 'Joke Name' })).toBe('inc');
  expect(r.resolve(U({ globalName: null }), { nickname: 'Joke Name' })).toBe('Joke Name');
  expect(r.resolve(U({ globalName: null }), null)).toBe('inc'); // inc1067 -> inc
});

test('accepts the snake_case global_name shape too', () => {
  const r = createSpeakerNames({});
  expect(r.resolve({ id: 'u1', username: 'x9', global_name: 'Ecks' })).toBe('Ecks');
});

test('sanitises names that would otherwise be SPOKEN literally', () => {
  expect(sanitize('Macroplastics by Bic(tm)')).toBe('Macroplastics by Bic');
  expect(sanitize('[CLAN] Dave ™')).toBe('Dave');
  expect(sanitize('🔥🔥 Mike 🔥')).toBe('Mike');
  expect(sanitize('   spaced   out   ')).toBe('spaced out');
});

test('returns null rather than asserting a wrong name', () => {
  const r = createSpeakerNames({});
  expect(r.resolve({ id: 'u1', username: '12345', globalName: null })).toBeNull(); // all digits
  expect(r.resolve({ id: 'u1', username: '🔥', globalName: null })).toBeNull();
});

test('a username that is only digits does not become an empty string', () => {
  const r = createSpeakerNames({});
  expect(r.resolve({ id: 'u1', username: '007', globalName: null })).toBeNull();
});

test('caps absurdly long names', () => {
  const long = 'A'.repeat(80);
  expect(sanitize(long).length).toBeLessThanOrEqual(24);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --testPathPatterns="SpeakerNames"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `services/SpeakerNames.js`**

```javascript
'use strict';

// Turns a Discord user into a name we are willing to SAY OUT LOUD.
//
// Discord exposes four name layers and the two automatic ones are both
// unreliable here: `username` carries junk suffixes (`inc1067` for someone who
// goes by `inc`) and per-guild `nickname` is often a joke
// (`Macroplastics by Bic(tm)`). discord.js's `displayName` resolves
// `nickname ?? globalName ?? username`, i.e. it prefers exactly the worst one.
// Because Phase 3 names are spoken by TTS, an unsanitised nickname is voiced
// literally -- so an explicit override table leads, and everything is
// sanitised. See spec 5.4.1.
const MAX_LEN = 24;

function sanitize(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw;
  s = s.replace(/[​-‍﻿]/g, '');            // zero-width
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' '); // emoji/pictographs
  s = s.replace(/™/g, ' ');                           // ™
  s = s.replace(/\((?:tm|r|c)\)/gi, ' ');                  // (tm) (r) (c)
  s = s.replace(/[\[\({][^\])}]*[\])}]/g, ' ');            // [CLAN] (tag) {x}
  s = s.replace(/[_*~`|]/g, ' ');                          // markdown-ish noise
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_LEN) {
    const cut = s.slice(0, MAX_LEN);
    const sp = cut.lastIndexOf(' ');
    s = (sp > 8 ? cut.slice(0, sp) : cut).trim();
  }
  return s;
}

// A name must contain at least one letter to be worth saying.
function usable(s) { return !!s && /\p{L}/u.test(s); }

function createSpeakerNames({ overrides = {} } = {}) {
  const table = overrides && typeof overrides === 'object' ? overrides : {};

  function resolve(user, member) {
    if (!user) return null;
    const candidates = [
      table[user.id],
      user.globalName || user.global_name,
      member && (member.nickname || member.nick),
      // `inc1067` -> `inc`; a digits-only username yields '' and falls through.
      typeof user.username === 'string' ? user.username.replace(/\d+$/, '') : null,
    ];
    for (const c of candidates) {
      const s = sanitize(c);
      if (usable(s)) return s;
    }
    return null; // never assert a name we are not confident in
  }

  return { resolve, sanitize };
}

module.exports = { createSpeakerNames, sanitize, MAX_LEN };
```

- [ ] **Step 4: Add the config table**

In `config/config.js`, inside the `voice: { ... }` object, add:

```javascript
    // userId -> spoken name overrides, e.g. {"1616...":"Mike"}. Authoritative:
    // Discord's own name layers are unreliable here (see spec 5.4.1). Malformed
    // JSON must never take the bot down -- fall back to an empty table.
    speakerNames: (() => {
      try { return JSON.parse(process.env.VOICE_SPEAKER_NAMES || '{}'); }
      catch (e) { return {}; }
    })(),
```

- [ ] **Step 5: Run tests to green**

Run: `npm test -- --testPathPatterns="SpeakerNames"` → PASS.
Then `node -e "require('./config/config'); console.log('config ok')"` → prints `config ok`.

- [ ] **Step 6: Commit**

```bash
git add services/SpeakerNames.js __tests__/services/SpeakerNames.test.js config/config.js
git commit -m "feat(voice): SpeakerNames resolver — a name we are willing to say out loud"
```

---

### Task 2: `SetSpeaker` on the wire (proto + VoiceClient)

**Files:**
- Modify: `proto/voice.proto`, `voice-sidecar/proto/voice.proto`
- Regenerate: `voice-sidecar/src/voice_pb2.py` (+ `_grpc` if the tool emits it)
- Modify: `services/VoiceClient.js`
- Test: `voice-sidecar/tests/test_proto_context_fields.py` (or a new proto test)

**Interfaces:**
- Produces `message SetSpeaker { string user_id = 1; string display_name = 2; }` and `SetSpeaker set_speaker = 5;` in the `VoiceClientEvent` oneof (field number **5** — 1-4 are taken).
- `session.sendSpeaker({ userId, displayName })` → `call.write({ set_speaker: { user_id, display_name } })`, guarded like `sendAudioStreamEnd` (a write on a closing stream must not throw).

- [ ] **Step 1: Add the message + oneof entry to BOTH proto copies**

In `proto/voice.proto` and `voice-sidecar/proto/voice.proto`, add next to the other small messages:

```proto
// Identity of the speaker whose audio follows. Sent only when the speaker
// CHANGES, so it is decoupled from the audio cadence.
message SetSpeaker {
  string user_id = 1;
  string display_name = 2;
}
```

and inside `VoiceClientEvent`'s oneof, after `audio_stream_end = 4;`:

```proto
    SetSpeaker     set_speaker      = 5;
```

Keep the two files byte-identical for these additions.

- [ ] **Step 2: Regenerate the Python stubs**

Run from `voice-sidecar/`: `make protoc` (or the equivalent `python3 -m grpc_tools.protoc -I proto --python_out=src --grpc_python_out=src proto/voice.proto`). If `make protoc` uses the system interpreter and fails, run it with `.venv/bin/python -m grpc_tools.protoc ...`.

- [ ] **Step 3: Verify the stub exposes the new field**

Run: `cd voice-sidecar && .venv/bin/python -c "from src import voice_pb2; e=voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(user_id='u1', display_name='Mike')); print(e.WhichOneof('event'), e.set_speaker.display_name)"`
Expected: `set_speaker Mike`

- [ ] **Step 4: Add `sendSpeaker` to `VoiceClient`**

In `services/VoiceClient.js`, beside `session.sendAudioStreamEnd`:

```javascript
    session.sendSpeaker = ({ userId, displayName }) => {
      try {
        call.write({ set_speaker: { user_id: userId || '', display_name: displayName || '' } });
      } catch (e) {
        logger.debug(`VoiceClient sendSpeaker write threw: ${e.message}`);
      }
    };
```

Match the surrounding style and the existing guard on `sendAudioStreamEnd`.

- [ ] **Step 5: Run both suites**

Run: `npm test` and `cd voice-sidecar && .venv/bin/python -m pytest -q` → both green.

- [ ] **Step 6: Commit**

```bash
git add proto/voice.proto voice-sidecar/proto/voice.proto voice-sidecar/src/voice_pb2.py services/VoiceClient.js
git commit -m "feat(voice): SetSpeaker control event on the Converse stream"
```

---

### Task 3: Sidecar — inject the `[SPEAKER: …]` marker

**Files:**
- Modify: `voice-sidecar/src/live_bridge.py`
- Test: `voice-sidecar/tests/test_live_bridge.py`

**Interfaces:**
- Consumes `set_speaker` events (Task 2).
- Behaviour in `_pump_client`: on `set_speaker`, store the pending speaker. Before the **next** audio chunk after a speaker change, send
  `await session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text=f"[SPEAKER: {name}]")]), turn_complete=False)`
  then clear the pending flag. Never send a marker with an empty name. `turn_complete=False` → context only: not read aloud, no premature response.
- Marker sends are counted on `_SessionStats` as `speaker_markers` and included in the session END log.

**Why before-the-next-audio rather than immediately:** `send_realtime_input` explicitly does not guarantee ordering against `send_client_content`, so binding the marker to the audio it describes is best-effort. Emitting it as late as possible — right before that speaker's first chunk — keeps the two as close together as the API allows.

- [ ] **Step 1: Write the failing tests**

```python
# voice-sidecar/tests/test_live_bridge.py (add)
async def test_speaker_marker_is_sent_once_before_that_speakers_audio():
    session = FakeSession([])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    out = []
    async def emit(ev): out.append(ev)
    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
        yield voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(user_id="u1", display_name="Mike"))
        yield voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"\x01"))
        yield voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"\x02"))
        await asyncio.Event().wait()
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.1)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    markers = [t for (t, complete) in session.seeded if "[SPEAKER:" in str(t)]
    assert len(markers) == 1, f"expected exactly one marker, got {markers}"
    assert "Mike" in str(markers[0])
    # marker must NOT finalize a turn
    assert all(complete is False for (_t, complete) in session.seeded)
    assert len(session.sent_audio) == 2


async def test_marker_is_resent_when_the_speaker_changes():
    session = FakeSession([])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    async def emit(ev): pass
    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
        yield voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(user_id="u1", display_name="Mike"))
        yield voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"\x01"))
        yield voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(user_id="u2", display_name="Sarah"))
        yield voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"\x02"))
        await asyncio.Event().wait()
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.1)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    markers = [str(t) for (t, _c) in session.seeded if "[SPEAKER:" in str(t)]
    assert len(markers) == 2 and "Mike" in markers[0] and "Sarah" in markers[1]


async def test_empty_speaker_name_sends_no_marker():
    session = FakeSession([])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    async def emit(ev): pass
    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
        yield voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(user_id="u1", display_name=""))
        yield voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"\x01"))
        await asyncio.Event().wait()
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.1)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert not any("[SPEAKER:" in str(t) for (t, _c) in session.seeded)
```

> `FakeSession.seeded` already records `(turns, turn_complete)` tuples from `send_client_content`; the history-seeding entries appear there too, which is why the assertions filter on `[SPEAKER:`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd voice-sidecar && .venv/bin/python -m pytest tests/test_live_bridge.py -k speaker -q`
Expected: FAIL — `set_speaker` unhandled, no markers recorded.

- [ ] **Step 3: Implement in `_pump_client`**

Add to `_SessionStats.__slots__` a `speaker_markers` counter initialised to 0. In `_pump_client`, alongside the existing `kind ==` branches (and before the audio branch's send), add:

```python
            if kind == "set_speaker":
                name = (ev.set_speaker.display_name or "").strip()
                # Only a name we are confident in; the bot omits rather than guess.
                if name and name != current_speaker:
                    current_speaker = name
                    pending_speaker = name
                continue
```

and immediately before sending an audio chunk (inside the `try`, in the `kind == "audio"` branch, before `send_realtime_input`):

```python
                    if pending_speaker:
                        # Out-of-band identity for the audio that follows.
                        # turn_complete=False -> conversational CONTEXT only: the
                        # model is not prompted to reply and does not read it
                        # aloud. Sent as late as possible (right before this
                        # speaker's first chunk) because send_realtime_input does
                        # not guarantee ordering against send_client_content.
                        await session.send_client_content(
                            turns=types.Content(role="user",
                                                parts=[types.Part(text=f"[SPEAKER: {pending_speaker}]")]),
                            turn_complete=False,
                        )
                        stats.speaker_markers += 1
                        logger.info("voice: speaker is now %s", pending_speaker)
                        pending_speaker = None
```

Initialise `current_speaker = None` and `pending_speaker = None` next to the other per-session latches at the top of `_pump_client`. Reset both to `None` on the session-swap branch (where `_warned_send_failure` is reset), so a resumed session re-announces the speaker. Add `speaker_markers=%d` to the session END log line.

- [ ] **Step 4: Run tests to green**

Run: `cd voice-sidecar && .venv/bin/python -m pytest -q` → all green (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add voice-sidecar/src/live_bridge.py voice-sidecar/tests/test_live_bridge.py
git commit -m "feat(voice): inject [SPEAKER: name] markers ahead of that speaker's audio"
```

---

### Task 4: Bot — resolve names, send `SetSpeaker`, add the roster

**Files:**
- Modify: `services/VoiceService.js`
- Modify: `bot.js` (construct the resolver, pass into `VoiceService`)
- Test: `__tests__/services/VoiceService.test.js`

**Interfaces:**
- Consumes `createSpeakerNames` (Task 1), `session.sendSpeaker` (Task 2).
- `VoiceService` gains `speakerNames` (injected; optional — when absent, behave exactly as today and send no markers).
- Per-user context (`_perUser`) caches `name` on first contact so the hot path never re-resolves.
- On forwarding the floor-holder's audio, if `g.lastSpeakerSent !== userId` and a name exists, call `session.sendSpeaker({...})` and record it. Cleared in `_endSession` so a new session re-announces.
- `_appendVoicePersona` gains the roster + the never-read-aloud rule, built from the names known for the guild.

- [ ] **Step 1: Write the failing tests**

```javascript
// __tests__/services/VoiceService.test.js (add)
describe('speaker identity', () => {
  test('sends SetSpeaker once per speaker change, not per frame', async () => {
    const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, holderId } = await buildActiveVoiceService({
      makeVadGate: () => gate,
      speakerNames: { resolve: () => 'Mike', sanitize: (s) => s },
    });
    await svc._handleUserPcm(guildId, holderId, to48kStereo(Buffer.alloc(320 * 2)));
    await svc._handleUserPcm(guildId, holderId, to48kStereo(Buffer.alloc(320 * 2)));
    expect(session.sendSpeaker).toHaveBeenCalledTimes(1);
    expect(session.sendSpeaker).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Mike' }));
    expect(session.sendAudio).toHaveBeenCalledTimes(2);
  });

  test('sends no SetSpeaker when the name cannot be resolved', async () => {
    const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, holderId } = await buildActiveVoiceService({
      makeVadGate: () => gate,
      speakerNames: { resolve: () => null, sanitize: (s) => s },
    });
    await svc._handleUserPcm(guildId, holderId, to48kStereo(Buffer.alloc(320 * 2)));
    expect(session.sendSpeaker).not.toHaveBeenCalled();
    expect(session.sendAudio).toHaveBeenCalledTimes(1); // audio still flows
  });

  test('voice persona instructs the model never to read the marker aloud', () => {
    const { svc } = makeService(makeDeps({}), {}, undefined);
    const p = svc._appendVoicePersona('BASE');
    expect(p).toMatch(/\[SPEAKER:/);
    expect(p.toLowerCase()).toMatch(/never read|do not read|aloud/);
  });
});
```

> Extend `buildActiveVoiceService` to accept a `speakerNames` override and pass it into `makeService`, and add `sendSpeaker: jest.fn()` to the fake session the voice-client mock returns (mirroring `sendAudioStreamEnd`).

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --testPathPatterns="VoiceService" -t "speaker identity"` → FAIL.

- [ ] **Step 3: Accept the resolver and cache the name per user**

In the `VoiceService` constructor accept `speakerNames` and store it as `this._speakerNames`. In `_perUser`, resolve once:

```javascript
      // Resolved ONCE per speaker: the hot path must never re-resolve, and we
      // never assert a name we are not confident in (null -> no marker sent).
      let name = null;
      try {
        name = this._speakerNames
          ? this._speakerNames.resolve(this._deps.lookupUser ? this._deps.lookupUser(userId) : { id: userId }, null)
          : null;
      } catch (e) { logger.warn(`voice: speaker-name resolution failed for ${userId}: ${e.message}`); }
      u.name = name;
```

(Place it where the other per-user fields are initialised.) `deps.lookupUser` is optional; when absent the resolver still applies the override table via `{ id: userId }`.

- [ ] **Step 4: Send `SetSpeaker` on speaker change**

In the floor-holder branch of `_handleUserPcm`, immediately before the first `g.session.sendAudio(pcm16)`:

```javascript
      // Identity travels on speaker CHANGE only -- decoupled from the audio
      // cadence. The sidecar turns this into an out-of-band [SPEAKER: name]
      // marker ahead of this speaker's next chunk.
      if (u.name && g.lastSpeakerSent !== userId && typeof g.session.sendSpeaker === 'function') {
        g.session.sendSpeaker({ userId, displayName: u.name });
        g.lastSpeakerSent = userId;
      }
```

Add `lastSpeakerSent: null` to the guild state in `join`, and reset it to `null` in `_endSession` (so a fresh session re-announces the speaker).

- [ ] **Step 5: Add the roster + never-read-aloud rule**

In `_appendVoicePersona`, append a paragraph:

```javascript
      `You are in a shared voice room. Before someone's turn you may receive a line like "[SPEAKER: Mike]". That is out-of-band metadata telling you who is talking now — NEVER read it aloud, never repeat the brackets or the word SPEAKER, and never mention that you receive it. Use it only to know who you are talking to, and address people by name when it is natural.`,
```

- [ ] **Step 6: Wire it in `bot.js`**

Where `VoiceService` is constructed, build the resolver and pass it:

```javascript
        const { createSpeakerNames } = require('./services/SpeakerNames');
        const speakerNames = createSpeakerNames({ overrides: config.voice.speakerNames });
```

Pass `speakerNames` into the `new VoiceService({ ... })` options, and add a `lookupUser` dep that resolves a cached Discord user without a privileged-intent fetch:

```javascript
            lookupUser: (userId) => {
              const u = this.client.users.cache.get(userId);
              return u ? { id: u.id, username: u.username, globalName: u.globalName } : { id: userId };
            },
```

(Match the surrounding `deps` style. `users.cache` needs no privileged intent; a miss simply degrades to the override table.)

- [ ] **Step 7: Run tests to green**

Run: `npm test` → all green.

- [ ] **Step 8: Commit**

```bash
git add services/VoiceService.js bot.js __tests__/services/VoiceService.test.js
git commit -m "feat(voice): resolve speaker names and announce them on speaker change"
```

---

### Task 5: Use the resolver in chat/recall

**Files:**
- Modify: `services/ChannelContextService.js` (`authorName`, `updateParticipant`)
- Modify: `bot.js` (`authorName` at the message-record site)
- Test: `__tests__/services/ChannelContextService.test.js`

**Interfaces:** consumes `createSpeakerNames`. Where `message.author.username` is used as a human-facing name, resolve instead; fall back to `message.author.username` when resolution returns null (chat is text — a slightly ugly name is fine, whereas voice omits).

- [ ] **Step 1: Write the failing test**

```javascript
test('records the resolved preferred name, not the raw username', async () => {
  // service constructed with a resolver that maps u1 -> 'Mike'
  // record a message from { id: 'u1', username: 'inc1067' }
  // expect the stored authorName to be 'Mike'
});
```

Fill this in against the file's existing construction/mocking pattern (it already has tests that record messages — reuse that harness and assert on the stored `authorName`).

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --testPathPatterns="ChannelContext"` → FAIL.

- [ ] **Step 3: Implement**

Accept an optional `speakerNames` in the `ChannelContextService` constructor. Replace the two `message.author.username` human-name uses (`authorName:` at ~`:285` and `updateParticipant(...)` at ~`:298`) with:

```javascript
      const authorName = (this.speakerNames && this.speakerNames.resolve(message.author, message.member))
        || message.author.username;
```

Pass the resolver through from `bot.js` where the service is constructed. Do NOT change `authorId` — identity keys stay the Discord id. Also update `bot.js:707`'s `authorName` the same way.

- [ ] **Step 4: Run tests to green**

Run: `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add services/ChannelContextService.js bot.js __tests__/services/ChannelContextService.test.js
git commit -m "feat(chat): use resolved preferred names in channel context and recall"
```

---

### Task 6: Documentation

**Files:** `CLAUDE.md`, `features.md`, `k8s/voice/README.md` (tracked)

- [ ] **Step 1: Update `CLAUDE.md`**

Document: the `SpeakerNames` resolver and its order (override → globalName → nickname → de-suffixed username → omit) and that names are sanitised **because they are spoken**; the `VOICE_SPEAKER_NAMES` JSON tunable (with an example) and that it needs a pod restart; the `SetSpeaker` event + `[SPEAKER: …]` marker mechanism and the "never read aloud" prompt rule; and that the resolver also feeds chat/recall so friends stop appearing as `inc1067` (previously-stored rows keep their old names — no backfill). Add `VOICE_SPEAKER_NAMES` to the bot-env tunables list.

**Re-flag the version lock:** the marker mechanism depends on mid-conversation `send_client_content`, supported on `gemini-live-2.5-flash` but restricted on Gemini 3.x Live — do not move `VOICE_LIVE_MODEL` without revisiting spec §5.4.

Move "model identity-awareness (Phase 3)" OUT of the deferred list, and ADD the deferred self-service follow-up: move the table to MongoDB behind `/voice name @user <spoken name>` so people set their own names (explicitly wanted for the emergent chaos; configmap stays as the seed layer).

- [ ] **Step 2: Update `features.md`** — a bullet: the bot knows who is speaking in voice and addresses people by name; preferred names configurable.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md features.md k8s/voice/README.md
git commit -m "docs(voice): document speaker identity, name resolution and the self-service follow-up"
```

---

### Task 7: Real-model smoke test for speaker identity (no humans, no Discord)

**Files:**
- Create: `scripts/smoke-voice-identity.js`
- Modify: `CLAUDE.md` (mention the script under the voice section)

**Why:** the three things Phase 3 can actually get wrong are only observable against the REAL model: (1) does it read the `[SPEAKER: …]` marker aloud, (2) does the marker bind to the right speaker's audio, (3) does it use the names naturally. None of these need a second human — they need the real Live session and two distinct voices, both of which we can synthesize. This is the "Layer 4" smoke test the design specced and deferred.

**Interfaces:**
- Consumes: the running sidecar's `Converse` gRPC stream (same proto as the bot), `scripts/gen-test-voices.js` fixtures (or the user's own `.m4a` recordings), `ffmpeg` for decode.
- Produces: a CLI that opens ONE real Live session and drives a scripted two-speaker conversation, printing every transcript and a PASS/FAIL verdict per check.

- [ ] **Step 1: Write the script**

It must, in order:
1. Resolve two audio inputs (default: two `voice-fixtures/*.wav` from `gen-test-voices.js`; accept two file paths as argv). Decode each to **16 kHz mono s16le** via ffmpeg and chunk to 20 ms (640-byte) frames, matching what the bot sends.
2. Connect to the sidecar over gRPC using `proto/voice.proto` (reuse `services/VoiceClient.js` if it can be pointed at an address, otherwise load the proto directly with `@grpc/proto-loader`, same options as `VoiceClient`).
3. `sendStart` with a `system_prompt` that includes the SAME roster + never-read-aloud rule the bot builds (import `_appendVoicePersona` output shape or inline the identical text), so the test exercises the real prompt.
4. Speaker A: `sendSpeaker({userId:'A', displayName:'Mike'})`, stream A's frames, pause ~1s for the reply.
5. Speaker B: `sendSpeaker({userId:'B', displayName:'Sarah'})`, stream B's frames, pause for the reply.
6. Collect `input_transcript` / `output_transcript` / `audio` / `turn_complete` events throughout; `sendSessionEnd` and close.

Then assert and print a verdict for each:
- **MARKER SILENT (critical):** no output transcript contains `SPEAKER`, `[`, `]`, or the literal marker text. Fail loudly if it does — that is the one defect that would be embarrassing live.
- **NAMES USED:** at least one output transcript mentions `Mike` or `Sarah`.
- **NO DOUBLE-ANSWER:** count `turn_complete` events and total output-audio bytes; flag if a single question produced more than one full reply (this is the regression class fixed in the dual-endpointing work).
- **ATTRIBUTION SANITY:** print each input transcript next to the speaker that was current when it arrived, so a human can eyeball that A's words were not attributed to B.

Print a final summary line with each check as PASS/FAIL and exit non-zero on any critical failure. Never truncate transcripts.

- [ ] **Step 2: Run it against the deployed sidecar**

The sidecar is reachable in-cluster, so run it from the bot pod or via a port-forward:

```bash
kubectl port-forward svc/discord-article-bot-voice 50051:50051 -n discord-article-bot &
node scripts/smoke-voice-identity.js
```

(If `gen-test-voices.js` has not been run, generate fixtures first — it needs `GEMINI_API_KEY`.) Paste the full output into the report.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-voice-identity.js CLAUDE.md
git commit -m "test(voice): real-model smoke test for speaker identity (two synthetic speakers)"
```

---

## Self-Review

**Spec coverage:** §5.4 mechanism → Tasks 2-4 (proto `SetSpeaker`, sidecar marker, bot send + roster). §5.4.1 name resolution → Task 1 (+ Task 5 for the chat scope it mandates). §9 plumbing (`send_client_content` with `turn_complete=False`) → Task 3, used verbatim. Version lock → Global Constraints + Task 6. ✓
**Out of scope (correct):** Phase 4 deferral responses; the Mongo/`/voice name` self-service table (documented as a follow-up per the human's decision); no backfill of previously-stored chat names.
**Deployment:** explicitly excluded — the human deploys.

**Placeholder scan:** Task 5 Step 1's test body is deliberately described rather than written because it must match `ChannelContextService.test.js`'s existing construction/mocking harness, which the implementer will read; the assertion is stated exactly (stored `authorName` === `'Mike'`). Everything else carries literal code.

**Type consistency:** `createSpeakerNames({overrides}) -> {resolve(user, member), sanitize}` defined Task 1, consumed Tasks 4-5. `resolve` returns `string | null` — Task 4 omits the marker on null, Task 5 falls back to `username` on null (deliberate difference, stated in both). `session.sendSpeaker({userId, displayName})` defined Task 2, consumed Task 4, asserted in Task 4's tests. `SetSpeaker{user_id, display_name}` field 5 defined Task 2, consumed Task 3. `u.name` set in Task 4 Step 3, read in Step 4. `g.lastSpeakerSent` added in Step 4 and reset in `_endSession`.

**Known risk (flagged):** marker→audio binding is best-effort — `send_realtime_input` does not guarantee ordering against `send_client_content`. Task 3 mitigates by sending the marker as late as possible and only on speaker change; the empty-name and once-per-change tests pin the contract. Real-model behaviour (does it stay silent about the marker?) is only provable live, so treat the first multi-speaker session as the acceptance test.
