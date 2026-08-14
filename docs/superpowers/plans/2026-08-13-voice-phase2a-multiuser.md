# Voice Phase 2a: Multi-User Shared Room (per-speaker wake + FloorControl + attribution) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let multiple people share one voice room without breaking turn-taking: run wake-word and VAD **per speaker**, arbitrate a single **active-speaker floor** so only the floor-holder's audio reaches Gemini, and **attribute** each voice transcript to the real Discord `userId`.

**Architecture:** Today `VoiceService` keeps ONE shared wake gate + ONE shared VAD gate + one mixed pre-roll per guild — correct for one speaker, wrong for two (the ONNX wake/VAD engines need contiguous single-speaker frames). This plan moves those to **per-speaker** instances (a `Map<userId, {wakeGate, vadGate, preroll}>`, lazily created), adds a pure **`FloorControl`** unit that tracks which speaker owns the current exchange, and rewires `_handleUserPcm` so: any speaker can wake the room (first waker takes the floor); once active, only the floor-holder's frames are forwarded and drive the turn, while a non-holder who speaks is attributed + logged (the Phase-4 "waiting" signal) but NOT forwarded. Transcripts are authored with the floor-holder's `userId`.

**Tech Stack:** Node.js, `@discordjs/voice`, the Phase-1 `SileroVad`/`wakeword` gates, Jest. Bot-side only — no sidecar/proto changes (session longevity is Plan 2b; model identity-awareness is Phase 3).

**Spec:** `docs/superpowers/specs/2026-08-13-multi-user-voice-vad-rework-design.md` (this plan implements the **Phase 2** items §5.2 FloorControl, §5.5 transcript attribution, and per-speaker wake from §5.7 — EXCEPT §5.6 session compression/resumption, which is Plan 2b).

## Global Constraints

- **Container/namespace:** deploy target is namespace `discord-article-bot`, container `bot` (deploy is NOT in this plan — code + tests only).
- **Branch off `main`** (already done: `feat/voice-phase2-multiuser`). No `:latest` image tags.
- **Never truncate log messages.**
- **`onnxruntime-node` is glibc-only** — unit tests MUST inject fake gates via `deps.makeWakeGate`/`deps.makeVadGate`; never load the native binding in tests.
- **DI unchanged in shape:** `deps.makeWakeGate()` and `deps.makeVadGate()` stay the gate factories; the ONLY change is they are now called **once per speaking `userId`** (lazily) instead of once per guild. Tests inject factories that return a fresh fake gate per call.
- **Single-speaker behavior must not regress:** with one speaker, the room behaves exactly as Phase 1 (wake → forward holder audio → early `audio_stream_end` → follow-up window). All existing Phase-1 voice tests must still pass (adapted to per-user DI).
- **Half-duplex ordering preserved:** the barge-in early-return stays before any VAD/forward logic.
- **Guiding principle:** favor correctness/quality over compute frugality — N per-speaker gate instances (each ~a few MB ONNX session, shared via the module-level session cache) is acceptable.

---

## File Structure

- **Create** `services/voice/FloorControl.js` — pure logic. Tracks the floor-holder `userId` and a waiting set. No I/O, no timers.
- **Create** `__tests__/services/voice/FloorControl.test.js` — pure unit tests (multi-speaker event timelines).
- **Modify** `services/VoiceService.js`:
  - Replace `state.gate`/`state.vad`/`state.preroll`/`state.turnActive`/`state.lastSpeechAt`/`state.audioEndSent`/`state.pending` single fields with a per-user map + a room-level `floor` (FloorControl) and holder-owned turn state.
  - Add a `_perUser(g, userId)` helper (lazily builds `{wakeGate, vadGate, preroll}`).
  - Rewire the receiver `onEnd` diagnostics, `_handleUserPcm` (idle-wake + active), `_startSession`, `_persistTurn` (attribution), `_endSession` (per-user cleanup).
- **Modify** `__tests__/services/VoiceService.test.js` — adapt the harness to per-user gate factories; add multi-user scenarios (two speakers: first wakes+holds, second withheld; attribution).
- **Create** `scripts/gen-test-voices.js` — committed generator that regenerates distinct-voice fixtures via Gemini-TTS (used by the offline harness). Generated `.wav`s are gitignored.
- **Create** `scripts/test-floor.js` — offline multi-stream harness: two PCM sources → two VAD gates → FloorControl, prints the floor timeline.
- **Modify** `CLAUDE.md` (Voice section) + `features.md` — document per-speaker gates, floor control, attribution.
- **Modify** `.gitignore` — ignore the generated fixture `.wav`s (e.g. `voice-fixtures/`).

---

### Task 1: `FloorControl` pure unit

**Files:**
- Create: `services/voice/FloorControl.js`
- Test: `__tests__/services/voice/FloorControl.test.js`

**Interfaces:**
- Produces: `new FloorControl()` with:
  - `grant(userId) -> bool` — if no current holder, set holder=userId and return true; else return false (and, if a different user, add them to the waiting set).
  - `holder() -> userId | null`
  - `isHolder(userId) -> bool`
  - `noteWaiting(userId) -> void` — record that a non-holder spoke (dedup via a Set).
  - `waiting() -> userId[]` — the waiting set as an array (for the Phase-4 signal / logging).
  - `release() -> void` — clear holder AND waiting set (called when the room returns to idle).

- [ ] **Step 1: Write the failing tests**

```javascript
// __tests__/services/voice/FloorControl.test.js
'use strict';
const FloorControl = require('../../../services/voice/FloorControl');

test('first grant wins; a second speaker cannot take the floor and is recorded waiting', () => {
  const fc = new FloorControl();
  expect(fc.grant('alice')).toBe(true);
  expect(fc.holder()).toBe('alice');
  expect(fc.grant('bob')).toBe(false);       // alice holds it
  expect(fc.isHolder('alice')).toBe(true);
  expect(fc.isHolder('bob')).toBe(false);
  expect(fc.waiting()).toEqual(['bob']);      // bob wanted the floor
});

test('re-grant to the same holder is a no-op success and does not add them to waiting', () => {
  const fc = new FloorControl();
  fc.grant('alice');
  expect(fc.grant('alice')).toBe(true);
  expect(fc.waiting()).toEqual([]);
});

test('noteWaiting dedups; release clears holder and waiting', () => {
  const fc = new FloorControl();
  fc.grant('alice');
  fc.noteWaiting('bob'); fc.noteWaiting('bob'); fc.noteWaiting('carol');
  expect(fc.waiting().sort()).toEqual(['bob', 'carol']);
  fc.release();
  expect(fc.holder()).toBe(null);
  expect(fc.waiting()).toEqual([]);
  expect(fc.grant('bob')).toBe(true);         // floor free again
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --testPathPatterns="FloorControl"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FloorControl.js`**

```javascript
// services/voice/FloorControl.js
'use strict';

// Active-speaker floor arbitration for a shared voice room. Pure logic: no I/O,
// no timers. One holder at a time; others who speak are recorded as "waiting"
// (the signal a future phase uses for "let me finish X, then get to Y").
class FloorControl {
  constructor() {
    this._holder = null;
    this._waiting = new Set();
  }

  grant(userId) {
    if (this._holder === null) { this._holder = userId; return true; }
    if (this._holder === userId) return true;   // already holds it
    this._waiting.add(userId);                   // someone else wants in
    return false;
  }

  holder() { return this._holder; }
  isHolder(userId) { return this._holder === userId; }
  noteWaiting(userId) { if (userId !== this._holder) this._waiting.add(userId); }
  waiting() { return Array.from(this._waiting); }
  release() { this._holder = null; this._waiting.clear(); }
}

module.exports = FloorControl;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --testPathPatterns="FloorControl"`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add services/voice/FloorControl.js __tests__/services/voice/FloorControl.test.js
git commit -m "feat(voice): FloorControl — active-speaker floor arbitration (pure)"
```

---

### Task 2: Per-speaker gate context + FloorControl wiring in `VoiceService` (state + helpers + cleanup)

**Files:**
- Modify: `services/VoiceService.js` (state shape in `join`, new `_perUser` helper, `_endSession` cleanup, receiver `onEnd` diagnostics)
- Test: `__tests__/services/VoiceService.test.js` (adapt harness to per-user factories)

**Interfaces:**
- Consumes: `FloorControl` (Task 1); `deps.makeWakeGate()`/`deps.makeVadGate()` — now called per user.
- Produces:
  - Guild state gains `perUser: Map<userId, { wakeGate, vadGate, preroll: [] }>`, `floor: FloorControl`, and holder-owned turn state stays on `g` (`turnActive`, `lastSpeechAt`, `audioEndSent`, `pending`) but is only driven by the floor-holder.
  - `this._perUser(g, userId) -> { wakeGate, vadGate, preroll }` — lazily creates the per-user entry (calling the gate factories once) and returns it.

- [ ] **Step 1: Write/adapt the failing test for lazy per-user gate creation**

Add to `__tests__/services/VoiceService.test.js` (reuse the file's existing VoiceService construction helper; make `makeWakeGate`/`makeVadGate` return a NEW fake gate per call and count calls):

```javascript
test('per-user gates are created lazily, one set per distinct speaker', async () => {
  let wakeCalls = 0, vadCalls = 0;
  const deps = makeDeps({ // the file's existing deps builder
    makeWakeGate: () => { wakeCalls++; return fakeWakeGate(false); },
    makeVadGate: () => { vadCalls++; return fakeVadGate([{ speaking: false, justStarted: false, justEnded: false }]); },
  });
  const { svc, guildId } = buildJoinedVoiceService(deps); // joined, room idle
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(silence()));
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(silence()));
  await svc._handleUserPcm(guildId, 'bob', to48kStereo(silence()));
  expect(wakeCalls).toBe(2); // one for alice, one for bob (not per frame)
  const g = svc._guilds.get(guildId);
  expect(g.perUser.size).toBe(2);
});
```

> `makeDeps`, `buildJoinedVoiceService`, `fakeWakeGate`, `silence`, `to48kStereo` follow the existing test file's helpers/patterns. If the file currently builds a single shared gate in its harness, generalize the harness to the per-call factory shape — that generalization is part of this task.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: FAIL — `g.perUser` undefined / gates created once at join.

- [ ] **Step 3: Change guild state + add `_perUser`**

In `join` (`VoiceService.js:123-131`), replace the `gate`/`vad` single fields. New state object:

```javascript
    const state = { connection, player, machine, session: null,
      channelId: channel.id, buffers: { in: [], out: [] }, tickTimer: null,
      sessionOpenedAtMs: null, receiving: new Set(), playback: null,
      pending: null, lastSpeechAt: null, audioEndSent: false, turnActive: false,
      perUser: new Map(), floor: new FloorControl() };
    this._guilds.set(guildId, state);
```

Remove the `state.gate = d.makeWakeGate();` / `state.vad = d.makeVadGate ...` lines. Add the helper (near `_handleUserPcm`):

```javascript
  // Lazily build the per-speaker gate context. Each speaker runs their OWN
  // wake-word + VAD engine (the ONNX engines need contiguous single-speaker
  // frames; a shared gate would interleave two people's audio) and their own
  // pre-roll. Gate factories are the same DI as before, now per user.
  _perUser(g, userId) {
    let u = g.perUser.get(userId);
    if (!u) {
      u = {
        wakeGate: this._deps.makeWakeGate(),
        vadGate: this._deps.makeVadGate ? this._deps.makeVadGate() : null,
        preroll: [],
      };
      g.perUser.set(userId, u);
    }
    return u;
  }
```

Add `const FloorControl = require('./voice/FloorControl');` at the top with the other requires.

- [ ] **Step 4: Fix the receiver `onEnd` diagnostics to use the per-user gate**

In the `onEnd` closure (`VoiceService.js:186-190`), replace `state.gate` references with the per-user gate:

```javascript
        const u = state.perUser.get(userId);
        const gate = u && u.wakeGate;
        const wakeErr = gate && typeof gate.lastError === 'function' ? gate.lastError() : null;
        const wakeScore = gate && typeof gate.lastScore === 'function' ? gate.lastScore() : null;
        const fs = gate && typeof gate.frameStats === 'function' ? gate.frameStats() : null;
```

- [ ] **Step 5: Per-user cleanup in `_endSession` (and the unhealthy path)**

In `_endSession` (`VoiceService.js:477-500`), replace the single `g.gate.reset()` with per-user reset + floor release, and reset holder-owned turn state:

```javascript
    g.turnActive = false;
    g.pending = null;
    g.lastSpeechAt = null;
    g.audioEndSent = false;
    if (g.floor) g.floor.release();
    if (g.perUser) {
      for (const u of g.perUser.values()) {
        if (u.wakeGate && typeof u.wakeGate.reset === 'function') u.wakeGate.reset();
        if (u.vadGate && typeof u.vadGate.reset === 'function') u.vadGate.reset();
        u.preroll = [];
      }
    }
```

Apply the same `g.floor.release()` + per-user `wakeGate.reset()` in the sidecar-unhealthy branch of `_startSession` (where it currently calls `g.gate.reset()` and `g.pending = null`). Keep the `perUser` map itself (users may speak again in the next window) — resetting the gates is enough; do not clear the Map on endSession unless `leave()` tears the guild down.

- [ ] **Step 6: Run the focused test to green**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: the new lazy-creation test PASSES. Other tests may fail because `_handleUserPcm` still references `g.gate`/`g.vad` — Tasks 3-4 fix those. If the harness change makes several fail, that's expected; keep going (they go green after Task 4). Note which fail.

- [ ] **Step 7: Commit**

```bash
git add services/VoiceService.js __tests__/services/VoiceService.test.js
git commit -m "feat(voice): per-speaker gate context (perUser map) + FloorControl state + cleanup"
```

---

### Task 3: Idle-wake path — per-user wake gate grants the floor

**Files:**
- Modify: `services/VoiceService.js` (`_handleUserPcm` idle branch)
- Test: `__tests__/services/VoiceService.test.js`

**Interfaces:**
- Consumes: `_perUser` (Task 2), `g.floor` (FloorControl).
- Produces: any speaker can wake the room; the FIRST to wake takes the floor; their pre-roll is captured into `g.pending`; a wake from a second user while the room is already opening/active does NOT re-open (it goes through the active path instead).

- [ ] **Step 1: Write the failing multi-user wake tests**

```javascript
test('first speaker to wake takes the floor and opens the session', async () => {
  const gates = new Map();
  const deps = makeDeps({
    makeWakeGate: () => fakeWakeGate('nextPushWakes'), // wakes on next push (helper)
    makeVadGate: () => fakeVadGate([{ speaking: false, justStarted: false, justEnded: false }]),
  });
  const { svc, guildId, startSession } = buildJoinedVoiceService(deps);
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));
  const g = svc._guilds.get(guildId);
  expect(g.floor.holder()).toBe('alice');
  expect(startSession).toHaveBeenCalledTimes(1);
});
```

> Use whatever `fakeWakeGate` shape the file already has to simulate a detection; the point asserted is `floor.holder()` + one session open.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: FAIL — idle branch still uses `g.gate`.

- [ ] **Step 3: Rewire the idle branch of `_handleUserPcm`**

Replace the idle block (`VoiceService.js:224-236`):

```javascript
    if (g.machine.state === 'idle') {
      const u = this._perUser(g, userId);
      // Per-speaker pre-roll so the words spoken WITH the wake phrase aren't lost.
      u.preroll.push(pcm16);
      if (u.preroll.length > MAX_PREROLL_FRAMES) u.preroll.shift();
      if (u.wakeGate.push(pcm16)) {
        // First waker takes the floor; a near-simultaneous second wake loses the
        // race and will be handled by the active path (withheld + noted waiting).
        if (g.floor.grant(userId)) {
          logger.info(`voice: wake word detected in guild ${guildId} (user ${userId}) — floor granted`);
          g.pending = u.preroll.slice(); // carry THIS speaker's wake-phrase audio in
          u.preroll = [];
          await this._apply(guildId, g.machine.onWake(), { userId });
        }
      }
      return;
    }
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: the new wake test PASSES. Active-path tests may still fail (Task 4).

- [ ] **Step 5: Commit**

```bash
git add services/VoiceService.js __tests__/services/VoiceService.test.js
git commit -m "feat(voice): per-speaker wake — first waker takes the floor"
```

---

### Task 4: Active path — floor arbitration (holder drives the turn; non-holder withheld + noted)

**Files:**
- Modify: `services/VoiceService.js` (`_handleUserPcm` active branch)
- Test: `__tests__/services/VoiceService.test.js`

**Interfaces:**
- Consumes: `_perUser`, `g.floor`.
- Produces: while the room is active/hot, only the floor-holder's frames are VAD-gated and forwarded (driving `turnActive`/`lastSpeechAt`/`justEnded` exactly as Phase 1); a non-holder who speaks is run through their own VAD only to detect speech, recorded via `g.floor.noteWaiting(userId)` + a debug log, and is NEVER forwarded.

- [ ] **Step 1: Write the failing arbitration tests**

```javascript
test('only the floor-holder audio is forwarded; a second speaker is withheld and noted waiting', async () => {
  const holderVad = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
  const otherVad  = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
  const vadByUser = { alice: holderVad, bob: otherVad };
  const deps = makeDeps({
    makeWakeGate: () => fakeWakeGate(false),
    makeVadGate: () => { /* return next by insertion */ },   // see note
  });
  const { svc, guildId, session } = buildActiveVoiceService(deps, { holder: 'alice' }); // alice holds floor
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech())); // holder -> forwarded
  await svc._handleUserPcm(guildId, 'bob',   to48kStereo(speech())); // non-holder -> withheld
  expect(session.sendAudio).toHaveBeenCalledTimes(1);               // only alice
  const g = svc._guilds.get(guildId);
  expect(g.floor.waiting()).toContain('bob');
});
```

> Provide per-user fake VAD gates (e.g. a `makeVadGate` that returns the next scripted gate from a queue keyed by call order, or have `buildActiveVoiceService` accept a `vadByUser` map). Reuse the Phase-1 active-session harness; extend it to seed `g.floor` with a holder and to map gates per user.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: FAIL — active branch still uses the shared `g.vad` and forwards regardless of holder.

- [ ] **Step 3: Rewire the active branch**

Replace the Phase-1 active block (the half-duplex check STAYS first, unchanged; then replace the single-`g.vad` logic):

```javascript
    // Half-duplex (unchanged) stays here, before any VAD work.
    if (!(this._config.voice && this._config.voice.allowBargeIn)) {
      const playing = g.player && g.player.state && g.player.state.status;
      if (playing === 'playing' || playing === 'buffering') return;
    }

    const u = this._perUser(g, userId);
    const isHolder = g.floor.isHolder(userId);

    // Non-holder: detect that they spoke (for attribution/logging + the future
    // "someone else wants in" signal), but DO NOT forward their audio.
    if (!isHolder) {
      const nv = u.vadGate ? u.vadGate.push(pcm16) : { speaking: false, justStarted: false, justEnded: false };
      if (nv.justStarted) {
        g.floor.noteWaiting(userId);
        logger.debug(`voice: ${userId} spoke while ${g.floor.holder()} holds the floor (guild ${guildId}) — withheld`);
      }
      return;
    }

    // Floor-holder: Phase-1 VAD-driven turn logic, scoped to this speaker.
    const v = u.vadGate ? u.vadGate.push(pcm16) : { speaking: true, justStarted: !g.turnActive, justEnded: false };
    if (v.justStarted) {
      g.turnActive = true;
      g.audioEndSent = false;
      await this._apply(guildId, g.machine.onUserSpeechStart(), { userId });
    }
    if (v.speaking) g.lastSpeechAt = this._deps.now();
    if (!g.turnActive) return;
    if (g.session) {
      g.session.sendAudio(pcm16);
    } else {
      (g.pending || (g.pending = [])).push(pcm16);
    }
    if (v.justEnded && g.session && !g.audioEndSent) {
      try { g.session.sendAudioStreamEnd(); } catch (e) { logger.warn(`voice: audio_stream_end (vad) failed: ${e.message}`); }
      g.audioEndSent = true;
      g.turnActive = false;
    }
```

- [ ] **Step 4: Run the full voice suite to green**

Run: `npm test -- --testPathPatterns="VoiceService|SileroVad|FloorControl"`
Expected: PASS — the new arbitration tests plus all Phase-1 tests adapted to per-user DI. Fix any remaining Phase-1 tests that assumed the single shared gate (they should drive `g.floor`/per-user gates now).

- [ ] **Step 5: Commit**

```bash
git add services/VoiceService.js __tests__/services/VoiceService.test.js
git commit -m "feat(voice): active-speaker floor arbitration — holder forwards, others withheld+noted"
```

---

### Task 5: Transcript attribution to the floor-holder's userId

**Files:**
- Modify: `services/VoiceService.js` (`_persistTurn`)
- Test: `__tests__/services/VoiceService.test.js`

**Interfaces:**
- Consumes: `g.floor.holder()`.
- Produces: a persisted user voice transcript whose `authorId` is the real Discord `userId` of the floor-holder (not the `'voice-user'` placeholder); the bot transcript stays `authorId: 'bot'`.

- [ ] **Step 1: Write the failing attribution test**

```javascript
test('voice user transcript is authored with the floor-holder userId', async () => {
  const { svc, guildId, mongo } = buildActiveVoiceService(makeDeps({}), { holder: 'alice' });
  const g = svc._guilds.get(guildId);
  g.buffers.in = ['what is the weather'];
  g.buffers.out = ['sunny and warm'];
  await svc._persistTurn(guildId);
  const userDoc = mongo.recordChannelMessage.mock.calls.map(c => c[0]).find(m => m.isBot === false);
  expect(userDoc.authorId).toBe('alice');   // not 'voice-user'
  expect(userDoc.source).toBe('voice');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: FAIL — `authorId` is `'voice-user'`.

- [ ] **Step 3: Change `_persistTurn`**

In `_persistTurn` (`VoiceService.js:436-445`), author the user turn with the floor-holder:

```javascript
    const speakerId = (g.floor && g.floor.holder()) || 'voice-user'; // fallback if floor already released
    if (userText) await this._mongo.recordChannelMessage({ ...base, authorId: speakerId, content: userText, isBot: false });
    if (botText) await this._mongo.recordChannelMessage({ ...base, authorId: 'bot', content: botText, isBot: true });
```

> `_persistTurn` runs on `turnComplete`, before the follow-up window releases the floor, so `holder()` is still the speaker. Keep the `'voice-user'` fallback for the edge where the floor was released (e.g. teardown races).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/VoiceService.js __tests__/services/VoiceService.test.js
git commit -m "feat(voice): attribute voice transcripts to the floor-holder userId"
```

---

### Task 6: Full-suite reconciliation + multi-user regression coverage

**Files:**
- Modify: `__tests__/services/VoiceService.test.js`

**Interfaces:** consumes the rewired VoiceService (Tasks 2-5). Produces a fully green suite with explicit multi-user coverage.

- [ ] **Step 1: Run the full suite and list any remaining failures**

Run: `npm test`
Expected: identify any Phase-1 tests still assuming the single `g.gate`/`g.vad`/`g.preroll` fields. Note each.

- [ ] **Step 2: Migrate each remaining failure to the per-user model**

For every test that referenced `g.gate`, `g.vad`, or `g.preroll` directly, or injected a single shared fake gate, update it to the per-user factory shape (a fresh fake per `makeWakeGate`/`makeVadGate` call; seed `g.floor`/per-user gates where the test drives an active session). Do not weaken assertions — keep them testing real forwarding/turn behavior.

- [ ] **Step 3: Add the two end-to-end multi-user scenarios**

```javascript
test('single-speaker flow is unchanged (wake -> forward -> early end -> attribution)', async () => {
  // one speaker 'alice': wake opens session, speech forwards, justEnded fires
  // audio_stream_end once, _persistTurn authors as 'alice'. (Phase-1 parity.)
});

test('two speakers: alice holds through her turn; bob only takes the floor after release', async () => {
  // alice wakes+holds; bob speaks -> withheld + waiting; end alice's turn and
  // let the room go idle (floor.release via _endSession/idle); THEN bob wakes ->
  // bob becomes holder. Assert holder transitions and that bob's audio only
  // forwards once he holds.
});
```

Fill these in with the file's real harness (drive `_handleUserPcm`, advance the fake clock via `_tick`, assert `session.sendAudio`/`floor.holder()`/persisted `authorId`).

- [ ] **Step 4: Full suite green**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add __tests__/services/VoiceService.test.js
git commit -m "test(voice): reconcile suite to per-user gates + multi-user regression coverage"
```

---

### Task 7: Committed TTS fixture generator + offline multi-stream harness

**Files:**
- Create: `scripts/gen-test-voices.js`
- Create: `scripts/test-floor.js`
- Modify: `.gitignore` (ignore generated fixture `.wav`s)

**Interfaces:** consumes `FloorControl`, `createSileroVadEngine`/`VoiceActivityGate` (Phase 1), `downsampleTo16kMono`. Produces a manual multi-stream validation of floor arbitration on real distinct voices.

- [ ] **Step 1: Write the fixture generator**

`scripts/gen-test-voices.js` — regenerates distinct-voice clips via the Gemini API TTS (`gemini-2.5-flash-preview-tts`, consumer `GEMINI_API_KEY` from env; prebuilt voices Charon/Kore/Aoede), decoding the returned L16/24k inline data to WAV under `voice-fixtures/`. (Reference request/response shape: `contents:[{parts:[{text}]}]`, `generationConfig.responseModalities:["AUDIO"]`, `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`; response `candidates[0].content.parts[0].inlineData.data` is base64 PCM `audio/L16;rate=24000`.) Write a `README`/usage header; require `GEMINI_API_KEY` in env and error clearly if absent.

- [ ] **Step 2: gitignore the generated wavs**

Add `voice-fixtures/` to `.gitignore`. Verify `git status` shows no `.wav` staged.

- [ ] **Step 3: Write `scripts/test-floor.js`**

Feed TWO independent PCM sources (two fixture files, time-offset so they overlap) into TWO `VoiceActivityGate` instances and a `FloorControl`; on each gate's `justStarted`, call `floor.grant` (speaker A) / observe `floor.noteWaiting` (speaker B); print a timeline of `SPEAKER A START / floor=A`, `SPEAKER B START / withheld (waiting)`, etc. This mirrors `scripts/test-vad.js` but drives the floor logic with two streams — faithful to production because Discord delivers per-speaker separated streams.

- [ ] **Step 4: Run it (if `GEMINI_API_KEY` available) or dry-run the logic with silence/tone buffers**

Run: `node scripts/gen-test-voices.js && node scripts/test-floor.js` (or, without a key, feed two synthetic tone/silence buffers to prove the floor timeline prints). Paste output into the commit message body or a comment. This is a manual harness, not a unit test.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-test-voices.js scripts/test-floor.js .gitignore
git commit -m "test(voice): TTS fixture generator + offline multi-stream floor harness"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md` (Voice section), `features.md`

- [ ] **Step 1: Update `CLAUDE.md`**

Document: wake-word AND VAD now run **per speaker** (one gate set per Discord `userId`, lazily created; the ONNX session cache shares model weights across them); **active-speaker floor control** (`services/voice/FloorControl.js`) — first waker holds the floor, only the holder's audio reaches Gemini, a second speaker is attributed + logged as "waiting" but withheld; voice transcripts are **attributed to the floor-holder's `userId`** (so `/tldr` and recall show who spoke). Note what's still deferred to later phases: model identity-awareness (Phase 3), session compression/resumption (Plan 2b), and the human-like "let me finish X, then get to Y" deferral (Phase 4 — uses `FloorControl.waiting()`).

- [ ] **Step 2: Update `features.md`**

Add a bullet: multi-user voice — per-speaker wake/VAD, active-speaker floor control, per-speaker transcript attribution.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md features.md
git commit -m "docs(voice): document multi-user shared room (per-speaker gates, floor control, attribution)"
```

---

## Self-Review

**Spec coverage (Phase 2a scope):**
- §5.2 FloorControl → Task 1 (unit) + Tasks 3-4 (wired). ✓
- Per-speaker wake (§5.7) → Tasks 2-3. ✓
- Active-speaker floor (holder forwards; others withheld+noted) → Task 4. ✓
- §5.5 transcript attribution → Task 5. ✓
- Offline multi-stream validation (Layer 1 pure + Layer 3 harness) → Task 1 tests, Task 6 scenarios, Task 7 harness. ✓
- **Out of scope (correctly deferred):** §5.6 session compression/resumption → Plan 2b; §5.4 model identity-awareness → Phase 3; Phase-4 deferral (FloorControl exposes `waiting()` for it). ✓
- Single-speaker parity guaranteed by the constraint + Task 6 parity test. ✓

**Placeholder scan:** Test helpers (`makeDeps`, `buildJoinedVoiceService`, `buildActiveVoiceService`, `fakeWakeGate`, `fakeVadGate`, `to48kStereo`, `speech`/`silence`) are explicitly deferred to the existing Phase-1 test file's real helpers, generalized to per-user factories as part of Task 2 — not invented anew. Task 7's fixture output is a manual paste, not a placeholder assertion.

**Type consistency:** `FloorControl` API (`grant`/`holder`/`isHolder`/`noteWaiting`/`waiting`/`release`) defined in Task 1 and consumed identically in Tasks 2-5 and Task 7. `_perUser(g, userId) -> {wakeGate, vadGate, preroll}` defined in Task 2, consumed in Tasks 3-4. Gate `push()` returns `{speaking, justStarted, justEnded}` (Phase 1) — consumed unchanged. `deps.makeWakeGate`/`deps.makeVadGate` semantics changed from once-per-guild to once-per-user — reflected in the DI constraint and Task 2's harness generalization.

**Known coupling (flagged):** Tasks 2-4 all edit `_handleUserPcm`/state and each leaves some Phase-1 tests red until Task 4/6; the executor may batch 2-4 (and their test reconciliation) into one dispatch to keep a green boundary (as Phase 1 batched its rewire+tests). Task 6 is the guaranteed green-up.
