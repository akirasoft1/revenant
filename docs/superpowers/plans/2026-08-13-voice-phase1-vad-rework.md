# Voice Phase 1: Silero VAD Rework + Endpointing Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed mean-abs energy gate with a per-stream Silero neural VAD that drives turn boundaries, resolving the dual-VAD incoherence into a correct Gemini Hybrid VAD (stream continuously incl. trailing silence; fire an explicit `audio_stream_end` on VAD-detected end-of-speech).

**Architecture:** A new `SileroVad` engine (ONNX on the existing `onnxruntime-node` runtime, mirroring the `wakeword.js` async-inference + session-cache pattern) plus a `VoiceActivityGate` (rebuffers arbitrary PCM to Silero's 512-sample window, applies threshold + min-speech/min-silence hysteresis, emits `{speaking, justStarted, justEnded}`). `VoiceService._handleUserPcm`'s active branch is rewired: a turn opens on `justStarted`, all frames stream continuously while the turn is active (so Gemini's server VAD sees real trailing silence), and the existing debounced `audio_stream_end` finalizes — driven by VAD speech, not a raw energy threshold. Single-user only; multi-user/floor-control/identity are later phases.

**Tech Stack:** Node.js, `onnxruntime-node ^1.27`, `@discordjs/voice`, Jest, Python gRPC sidecar (unchanged in Phase 1), Silero VAD v5 ONNX (MIT).

**Spec:** `docs/superpowers/specs/2026-08-13-multi-user-voice-vad-rework-design.md` (this plan implements **Phase 1** only — §5.1 SileroVad, §5.3 endpointing, §5.8 frame-size reconciliation, §5.7 interrupt-flush verification).

## Global Constraints

- **Container/namespace:** deploy to namespace `discord-article-bot`, container `bot` (deploy is out of scope for this plan — code + tests only).
- **No `:latest` tags; images pinned to git short-SHA** (deploy not in scope).
- **Never truncate log messages.**
- **Bot image is Debian slim (glibc), Node ≥22.12** — `onnxruntime-node` is glibc-only; unit tests MUST inject a fake backend so CI never loads the native binding (mirror `wakeword.js` `defaultSessionFactory` lazy-require).
- **DI pattern:** gates are built by `deps.makeWakeGate()` and injected; tests pass fakes. The VAD gate MUST follow the same `deps.makeVadGate()` pattern — no direct `require` of the engine inside `VoiceService`.
- **Guiding principle:** favor quality/correctness over compute frugality (cluster has ample headroom). Per-stream Silero instances and 512-sample rebuffering are acceptable cost.
- **Model file lives under `models/`** so the existing `COPY . .` (Dockerfile:34) bakes it into the image — no Dockerfile change needed.
- **Silero v5 ONNX is stateful** (carries a `state` tensor between 512-sample chunks) and expects **16 kHz, 512-sample (32 ms)** windows. Exact input/output tensor names are discovered in Task 1 and used verbatim in Task 2.

---

## File Structure

- **Create** `models/silero/silero_vad.onnx` — vendored Silero v5 model (~2 MB, MIT). Baked into image via `COPY . .`.
- **Create** `models/silero/README.md` — provenance, version, license, and the introspected tensor IO spec.
- **Create** `services/voice/SileroVad.js` — exports `createSileroVadEngine({...})`, `VoiceActivityGate`, `preloadSileroVad({...})`. Mirrors `services/voice/wakeword.js` structure (memoized backend, module-level session cache, async inference queue, sync `process()` surfacing latest result).
- **Create** `scripts/test-vad.js` — offline Layer-2 harness (real model on `Recording.m4a`, clean-16k + 48k→downsample paths; prints speech-start/end timeline + probs).
- **Create** `__tests__/services/voice/SileroVad.test.js` — engine rebuffer/state + gate hysteresis tests (injected fake backend/engine).
- **Modify** `config/config.js` — add `voice.vad` config block (threshold, min-speech/min-silence ms, model path).
- **Modify** `bot.js:258,284` — require + `deps.makeVadGate` factory + preload.
- **Modify** `services/VoiceService.js` — rewire `_handleUserPcm` active branch (turn-active logic), add `g.vad`/`g.turnActive`/`g.speaking` state, init at join, reset in `_endSession` + unhealthy path; remove the energy-gate drop.
- **Modify** `__tests__/services/VoiceService.test.js` — replace energy-gate tests with VAD-gated behavior (injected fake VAD gate).
- **Modify** `CLAUDE.md` (Voice section) + `features.md` — document the Silero Hybrid VAD; correct the "energy gate" description.

---

### Task 1: Vendor the Silero VAD model + introspect its tensor IO

**Files:**
- Create: `models/silero/silero_vad.onnx`
- Create: `models/silero/README.md`
- Throwaway: `scripts/_introspect-silero.js` (delete after capturing output into the README)

**Interfaces:**
- Produces: the on-disk model path `models/silero/silero_vad.onnx` and a documented IO spec (input tensor name for samples, the state tensor name + shape, the sample-rate tensor name + dtype, output prob tensor name, output next-state tensor name) that Task 2 consumes verbatim.

- [ ] **Step 1: Download the vendored model**

```bash
mkdir -p models/silero
# Silero VAD v5 ONNX (MIT). Pin to the v5.1 release asset.
curl -fsSL -o models/silero/silero_vad.onnx \
  https://raw.githubusercontent.com/snakers4/silero-vad/v5.1/src/silero_vad/data/silero_vad.onnx
ls -l models/silero/silero_vad.onnx   # expect ~1.8-2.3 MB
```

- [ ] **Step 2: Write a throwaway introspection script**

```javascript
// scripts/_introspect-silero.js
'use strict';
const ort = require('onnxruntime-node');
const path = require('path');
(async () => {
  const s = await ort.InferenceSession.create(path.join(__dirname, '..', 'models', 'silero', 'silero_vad.onnx'));
  console.log('inputNames', s.inputNames);
  console.log('outputNames', s.outputNames);
  console.log('inputMetadata', JSON.stringify(s.inputMetadata, null, 2));
  console.log('outputMetadata', JSON.stringify(s.outputMetadata, null, 2));
})();
```

- [ ] **Step 3: Run it and capture the IO shape**

Run: `node scripts/_introspect-silero.js`
Expected (Silero v5): inputs include `input` (float32 `[?, ?]` samples), `state` (float32 `[2,1,128]`), `sr` (int64 scalar); outputs include `output` (float32 `[?,1]` prob) and `stateN` (float32 `[2,1,128]`). **Record the ACTUAL names/shapes printed** — they are authoritative for Task 2.

- [ ] **Step 4: Write the provenance + IO README**

```markdown
<!-- models/silero/README.md -->
# Silero VAD (vendored)

- Model: `silero_vad.onnx` — Silero VAD **v5.1**, source https://github.com/snakers4/silero-vad (tag `v5.1`)
- License: MIT (see upstream LICENSE)
- Input format: 16 kHz mono s16le, **512-sample (32 ms)** windows.
- Tensor IO (from `node scripts/_introspect-silero.js`, <DATE>):
  - input samples: `<name>` float32 `[1, 512]`
  - state (carried between calls): `<name>` float32 `[2, 1, 128]`, zero-initialized
  - sample rate: `<name>` int64 scalar = 16000
  - output prob: `<name>` float32 `[1, 1]`
  - output next-state: `<name>` float32 `[2, 1, 128]`
```

Fill `<name>`/`<DATE>` from Step 3's real output.

- [ ] **Step 5: Delete the throwaway script and commit**

```bash
rm scripts/_introspect-silero.js
git add models/silero/silero_vad.onnx models/silero/README.md
git commit -m "feat(voice): vendor Silero VAD v5 model + document tensor IO"
```

---

### Task 2: `SileroVad` engine (async ONNX, stateful, rebuffered)

**Files:**
- Create: `services/voice/SileroVad.js`
- Test: `__tests__/services/voice/SileroVad.test.js`

**Interfaces:**
- Consumes: model path from Task 1; a `sessionFactory` (backend) — real (`onnxruntime-node`) in prod, fake in tests.
- Produces:
  - `createSileroVadEngine({ modelPath, sessionFactory }) -> engine`
  - `engine.process(int16Frame)` — **synchronous**, accepts a `Int16Array` of exactly **512** samples, enqueues async inference, returns the latest probability (`number` in `[0,1]`, `-1` before first result) — mirrors `wakeword.js` `process()` returning the latest flag.
  - `engine.whenIdle() -> Promise<void>` (test determinism), `engine.ready() -> Promise<void>`, `engine.reset()`, `engine.lastProb() -> number`.
  - `preloadSileroVad({ modelPath, sessionFactory }) -> Promise` (warm the session cache at boot).

- [ ] **Step 1: Write the failing engine test (rebuffer/state via injected fake backend)**

```javascript
// __tests__/services/voice/SileroVad.test.js
'use strict';
const { createSileroVadEngine } = require('../../../services/voice/SileroVad');

// Fake backend: an InferenceSession stand-in whose run() returns a scripted
// probability and echoes a mutated state so we can assert state is carried.
function fakeBackend(probSeq) {
  let i = 0;
  const session = {
    inputNames: ['input', 'state', 'sr'],
    outputNames: ['output', 'stateN'],
    run: async (feeds) => {
      // assert the caller passed our carried state back in
      session._lastStateIn = feeds.state.data.slice();
      const p = probSeq[Math.min(i, probSeq.length - 1)]; i += 1;
      return {
        output: { data: Float32Array.from([p]), dims: [1, 1] },
        stateN: { data: Float32Array.from({ length: 2 * 1 * 128 }, () => p), dims: [2, 1, 128] },
      };
    },
  };
  return {
    createSession: async () => session,
    tensor: (type, data, dims) => ({ type, data, dims }),
    _session: session,
  };
}

test('engine returns the model probability and carries state between frames', async () => {
  const backend = fakeBackend([0.9, 0.9]);
  const engine = createSileroVadEngine({ modelPath: 'x', sessionFactory: backend });
  await engine.ready();
  engine.process(new Int16Array(512));
  await engine.whenIdle();
  expect(engine.lastProb()).toBeCloseTo(0.9);
  // second frame must feed back the non-zero state produced by the first
  engine.process(new Int16Array(512));
  await engine.whenIdle();
  expect(backend._session._lastStateIn.some((v) => v !== 0)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --testPathPatterns="SileroVad"`
Expected: FAIL — `createSileroVadEngine is not a function` / module not found.

- [ ] **Step 3: Implement `SileroVad.js` (engine only)**

```javascript
// services/voice/SileroVad.js
'use strict';

const SAMPLE_RATE = 16000;
const WINDOW = 512;            // Silero v5 chunk @16k
const STATE_DIMS = [2, 1, 128];

// Tensor names — from models/silero/README.md (Task 1). Kept as consts so a
// model swap only edits here.
const IN_SAMPLES = 'input';
const IN_STATE = 'state';
const IN_SR = 'sr';
const OUT_PROB = 'output';
const OUT_STATE = 'stateN';

let _defaultBackend = null;
function defaultSessionFactory() {
  if (_defaultBackend) return _defaultBackend;
  const ort = require('onnxruntime-node'); // lazy: glibc-only native binding
  _defaultBackend = {
    createSession: (p) => ort.InferenceSession.create(p),
    tensor: (type, data, dims) => new ort.Tensor(type, data, dims),
  };
  return _defaultBackend;
}

// Module-level session cache keyed by backend identity + path (mirrors wakeword.js).
const _cacheByBackend = new WeakMap();
function _loadSession(backend, modelPath) {
  let byPath = _cacheByBackend.get(backend);
  if (!byPath) { byPath = new Map(); _cacheByBackend.set(backend, byPath); }
  let entry = byPath.get(modelPath);
  if (!entry) {
    entry = backend.createSession(modelPath);
    entry.catch(() => byPath.delete(modelPath));
    byPath.set(modelPath, entry);
  }
  return entry;
}

function preloadSileroVad({ modelPath, sessionFactory } = {}) {
  return _loadSession(sessionFactory || defaultSessionFactory(), modelPath);
}

function createSileroVadEngine({ modelPath, sessionFactory } = {}) {
  const backend = sessionFactory || defaultSessionFactory();
  let session = null;
  let state = new Float32Array(STATE_DIMS[0] * STATE_DIMS[1] * STATE_DIMS[2]); // zero
  let lastProb = -1;
  let generation = 0;
  let queue = [];
  let draining = false;
  let drainDone = Promise.resolve();

  const readyP = _loadSession(backend, modelPath).then((s) => { session = s; });

  async function runOne(int16Frame, gen) {
    if (gen !== generation || !session) return;
    const samples = new Float32Array(WINDOW);
    for (let i = 0; i < WINDOW && i < int16Frame.length; i++) samples[i] = int16Frame[i] / 32768;
    const feeds = {
      [IN_SAMPLES]: backend.tensor('float32', samples, [1, WINDOW]),
      [IN_STATE]: backend.tensor('float32', state.slice(), STATE_DIMS),
      [IN_SR]: backend.tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
    };
    const out = await session.run(feeds);
    if (gen !== generation) return; // reset() happened mid-inference
    lastProb = out[OUT_PROB].data[0];
    state = Float32Array.from(out[OUT_STATE].data);
  }

  function drain() {
    if (draining) return;
    draining = true;
    drainDone = (async () => {
      while (queue.length) { const { frame, gen } = queue.shift(); await runOne(frame, gen); }
      draining = false;
    })();
  }

  return {
    window: WINDOW,
    ready: () => readyP,
    process(int16Frame) {
      queue.push({ frame: int16Frame, gen: generation });
      drain();
      return lastProb;
    },
    whenIdle: async () => { await drainDone; },
    lastProb: () => lastProb,
    reset() {
      generation += 1;
      queue = [];
      state = new Float32Array(STATE_DIMS[0] * STATE_DIMS[1] * STATE_DIMS[2]);
      lastProb = -1;
    },
  };
}

module.exports = { createSileroVadEngine, preloadSileroVad, WINDOW };
```

> If Task 1 printed different tensor names, edit the `IN_*`/`OUT_*` consts to match. If `sr` must be a `[1]` tensor rather than scalar `[]`, adjust its `dims`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --testPathPatterns="SileroVad"`
Expected: PASS (both assertions).

- [ ] **Step 5: Commit**

```bash
git add services/voice/SileroVad.js __tests__/services/voice/SileroVad.test.js
git commit -m "feat(voice): Silero VAD engine (async ONNX, stateful, session-cached)"
```

---

### Task 3: `VoiceActivityGate` (rebuffer + threshold + hysteresis)

**Files:**
- Modify: `services/voice/SileroVad.js` (add `VoiceActivityGate` + export)
- Test: `__tests__/services/voice/SileroVad.test.js` (add gate tests)

**Interfaces:**
- Consumes: an engine with `process(int16Frame512) -> prob`, `whenIdle()`, `ready()`, `reset()`, `lastProb()`.
- Produces: `new VoiceActivityGate(engine, { threshold, minSpeechFrames, minSilenceFrames })` with:
  - `push(pcm16Buf) -> { speaking, justStarted, justEnded }` — accepts an s16le `Buffer` of ANY length, rebuffers to 512-sample windows, feeds the engine, and returns the gate state after consuming the buffer. `justStarted`/`justEnded` are edge flags (true only on the transition).
  - `speaking() -> bool`, `reset()`, `lastProb() -> number`, `frameStats() -> { windows }`.
- **Hysteresis:** enter `speaking` after `minSpeechFrames` consecutive windows ≥ `threshold`; leave after `minSilenceFrames` consecutive windows < `threshold`. Defaults: `threshold 0.5`, `minSpeechFrames 2` (~64 ms), `minSilenceFrames 24` (~768 ms).

- [ ] **Step 1: Write the failing gate test (injected fake engine, scripted probs)**

```javascript
// add to __tests__/services/voice/SileroVad.test.js
const { VoiceActivityGate } = require('../../../services/voice/SileroVad');

// Fake engine: returns the next scripted prob on each process() call.
function scriptedEngine(probs) {
  let i = 0;
  return {
    _consumed: 0,
    process() { this._consumed += 1; return probs[Math.min(i++, probs.length - 1)]; },
    whenIdle: async () => {}, ready: async () => {}, reset() { i = 0; }, lastProb: () => 0,
  };
}

test('gate opens after minSpeechFrames and closes after minSilenceFrames', () => {
  // 512 samples = 1024 bytes per window. Feed 6 windows worth in one buffer.
  const eng = scriptedEngine([0.9, 0.9, 0.1, 0.1, 0.1, 0.1]);
  const gate = new VoiceActivityGate(eng, { threshold: 0.5, minSpeechFrames: 2, minSilenceFrames: 3 });
  const buf = Buffer.alloc(512 * 2 * 6); // 6 windows of silence bytes; probs come from the fake
  const r = gate.push(buf);
  expect(eng._consumed).toBe(6);            // rebuffered into 6 windows
  expect(r.speaking).toBe(false);           // 2 speech then 4 silence -> opened then closed
  // opened on window 2, closed after 3 silence windows (5), so justEnded seen within this push
});

test('gate emits justStarted exactly on the opening transition', () => {
  const eng = scriptedEngine([0.9, 0.9]);
  const gate = new VoiceActivityGate(eng, { threshold: 0.5, minSpeechFrames: 2, minSilenceFrames: 3 });
  const r = gate.push(Buffer.alloc(512 * 2 * 2));
  expect(r.speaking).toBe(true);
  expect(r.justStarted).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --testPathPatterns="SileroVad"`
Expected: FAIL — `VoiceActivityGate is not a constructor`.

- [ ] **Step 3: Implement `VoiceActivityGate`**

```javascript
// add to services/voice/SileroVad.js (before module.exports)
class VoiceActivityGate {
  constructor(engine, { threshold = 0.5, minSpeechFrames = 2, minSilenceFrames = 24 } = {}) {
    this._engine = engine;
    this._threshold = threshold;
    this._minSpeech = minSpeechFrames;
    this._minSilence = minSilenceFrames;
    this._speaking = false;
    this._runSpeech = 0;   // consecutive speech windows
    this._runSilence = 0;  // consecutive silence windows
    this._carry = Buffer.alloc(0); // leftover < one window
    this._windows = 0;
  }

  push(pcm16Buf) {
    let started = false, ended = false;
    let buf = this._carry.length ? Buffer.concat([this._carry, pcm16Buf]) : pcm16Buf;
    const bytesPerWindow = WINDOW * 2;
    let off = 0;
    for (; off + bytesPerWindow <= buf.length; off += bytesPerWindow) {
      const frame = new Int16Array(WINDOW);
      for (let i = 0; i < WINDOW; i++) frame[i] = buf.readInt16LE(off + i * 2);
      const prob = this._engine.process(frame);
      this._windows += 1;
      const speechy = prob >= this._threshold;
      if (speechy) { this._runSpeech += 1; this._runSilence = 0; }
      else { this._runSilence += 1; this._runSpeech = 0; }
      if (!this._speaking && this._runSpeech >= this._minSpeech) { this._speaking = true; started = true; }
      else if (this._speaking && this._runSilence >= this._minSilence) { this._speaking = false; ended = true; }
    }
    this._carry = buf.subarray(off); // keep the sub-window remainder for next push
    return { speaking: this._speaking, justStarted: started, justEnded: ended };
  }

  speaking() { return this._speaking; }
  lastProb() { return typeof this._engine.lastProb === 'function' ? this._engine.lastProb() : null; }
  frameStats() { return { windows: this._windows }; }
  reset() {
    this._speaking = false; this._runSpeech = 0; this._runSilence = 0;
    this._carry = Buffer.alloc(0); this._windows = 0;
    if (this._engine.reset) this._engine.reset();
  }
}

module.exports = { createSileroVadEngine, preloadSileroVad, VoiceActivityGate, WINDOW };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --testPathPatterns="SileroVad"`
Expected: PASS (all gate + engine tests).

- [ ] **Step 5: Commit**

```bash
git add services/voice/SileroVad.js __tests__/services/voice/SileroVad.test.js
git commit -m "feat(voice): VoiceActivityGate — 512-window rebuffer + speech/silence hysteresis"
```

---

### Task 4: Config block + DI wiring (`config.js`, `bot.js`)

**Files:**
- Modify: `config/config.js` (voice block — add `vad`)
- Modify: `bot.js:258,284` (require, `makeVadGate`, preload)

**Interfaces:**
- Consumes: `VoiceActivityGate`, `createSileroVadEngine`, `preloadSileroVad` from Task 3.
- Produces: `config.voice.vad = { threshold, minSpeechFrames, minSilenceFrames, modelPath }`; `deps.makeVadGate()` returning a `VoiceActivityGate` over a real engine.

- [ ] **Step 1: Add the config block**

In `config/config.js`, inside the `voice: { ... }` object (near `speechEndSilenceMs`), add:

```javascript
    // Silero VAD (per-stream neural speech detection; replaces the fixed energy
    // gate). Frames <threshold are non-speech. min*Frames are 32ms windows.
    vad: {
      threshold: parseFloat(process.env.VOICE_VAD_THRESHOLD || '0.5'),
      minSpeechFrames: parseInt(process.env.VOICE_VAD_MIN_SPEECH_FRAMES || '2', 10),   // ~64ms
      minSilenceFrames: parseInt(process.env.VOICE_VAD_MIN_SILENCE_FRAMES || '24', 10), // ~768ms
      modelPath: process.env.VOICE_VAD_MODEL || require('path').join(__dirname, '..', 'models', 'silero', 'silero_vad.onnx'),
    },
```

- [ ] **Step 2: Wire the DI factory + preload in `bot.js`**

At `bot.js:258`, extend the require:

```javascript
        const { createOpenWakeWordEngine, WakeWordGate, preloadOpenWakeWord } = require('./services/voice/wakeword');
        const { createSileroVadEngine, VoiceActivityGate, preloadSileroVad } = require('./services/voice/SileroVad');
```

In the `deps: { ... }` object (near `makeWakeGate`, ~bot.js:284) add:

```javascript
            makeVadGate: () => new VoiceActivityGate(
              createSileroVadEngine({ modelPath: config.voice.vad.modelPath }),
              {
                threshold: config.voice.vad.threshold,
                minSpeechFrames: config.voice.vad.minSpeechFrames,
                minSilenceFrames: config.voice.vad.minSilenceFrames,
              },
            ),
```

Next to the existing `preloadOpenWakeWord(...)` warm-up call, add:

```javascript
        preloadSileroVad({ modelPath: config.voice.vad.modelPath }).catch((e) =>
          logger.warn(`voice: Silero VAD preload failed: ${e.message}`));
```

- [ ] **Step 3: Verify the app still boots (no test yet — smoke)**

Run: `node -e "require('./config/config'); console.log('config ok')"`
Expected: prints `config ok` (config parses; `require('path')` resolves the model path).

- [ ] **Step 4: Commit**

```bash
git add config/config.js bot.js
git commit -m "feat(voice): wire Silero VAD config + makeVadGate DI + preload"
```

---

### Task 5: Rewire `_handleUserPcm` active branch to VAD-driven turns

**Files:**
- Modify: `services/VoiceService.js` (`_handleUserPcm` active branch; `join` state init; `_endSession` + unhealthy reset)
- Test: `__tests__/services/VoiceService.test.js`

**Interfaces:**
- Consumes: `deps.makeVadGate()` (Task 4) producing a gate with `push(pcm16) -> {speaking, justStarted, justEnded}`, `reset()`.
- Produces: active-branch behavior — a turn opens on `justStarted`; **all** frames stream continuously while `g.turnActive`; `g.lastSpeechAt` refreshes whenever the gate reports `speaking`; the turn stops forwarding once the existing `_tick` debounce fires `audio_stream_end` (which also clears `g.turnActive`). Removes the `frameMeanAbs < REAL_SPEECH_MEANABS` drop.

- [ ] **Step 1: Write the failing behavior tests**

Add to `__tests__/services/VoiceService.test.js` (follow the file's existing harness for building a `VoiceService` with fakes; inject `deps.makeVadGate` returning a scriptable fake gate):

```javascript
// Fake VAD gate whose push() returns pre-scripted transition objects in order.
function fakeVadGate(sequence) {
  let i = 0;
  return { push: () => sequence[Math.min(i++, sequence.length - 1)], reset: () => { i = 0; }, speaking: () => false };
}

test('active turn streams ALL frames continuously once speech starts (incl. trailing silence)', async () => {
  // gate: frame1 opens the turn, frames 2-3 are silence but still forwarded
  const gate = fakeVadGate([
    { speaking: true, justStarted: true, justEnded: false },
    { speaking: false, justStarted: false, justEnded: false },
    { speaking: false, justStarted: false, justEnded: false },
  ]);
  const { svc, guildId, session } = buildActiveVoiceService({ makeVadGate: () => gate }); // helper per existing tests
  const frame = Buffer.alloc(320 * 2); // ~20ms @16k
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(frame));
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(frame));
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(frame));
  expect(session.sendAudio).toHaveBeenCalledTimes(3); // NO frame dropped, incl. the 2 silent ones
});

test('no frames are forwarded before speech starts (no ambient streaming between turns)', async () => {
  const gate = fakeVadGate([{ speaking: false, justStarted: false, justEnded: false }]);
  const { svc, guildId, session } = buildActiveVoiceService({ makeVadGate: () => gate });
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
  expect(session.sendAudio).not.toHaveBeenCalled();
});
```

> `buildActiveVoiceService`, `to48kStereo`, and the fake `session` mirror the existing test file's helpers (the file already builds an active-session VoiceService for the half-duplex/pre-roll tests). Reuse them; do not invent new infrastructure.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: FAIL — frames still gated by energy threshold / `turnActive` undefined.

- [ ] **Step 3: Add `vad`/`turnActive` state at join**

In `join` where the state object is built (`VoiceService.js:141`), add `vad: null` alongside `gate: null`, and `turnActive: false`. Where `state.gate = d.makeWakeGate();` is set (`:147`), add:

```javascript
    state.vad = d.makeVadGate ? d.makeVadGate() : null;
```

- [ ] **Step 4: Replace the active-branch energy gate**

In `_handleUserPcm`, replace the block from the `// active/hot: only forward REAL speech` comment through `(g.pending || (g.pending = [])).push(pcm16);` (lines ~266–285) with:

```javascript
    // active/hot: Silero VAD drives the turn. A turn opens on speech onset;
    // once open we stream EVERY frame continuously (including the user's pauses
    // and trailing silence) so Gemini's server VAD sees real end-of-speech as a
    // fallback -- the fix for the old energy-gate starvation. The turn stops
    // forwarding when _tick fires audio_stream_end (which clears g.turnActive).
    const v = g.vad ? g.vad.push(pcm16) : { speaking: true, justStarted: !g.turnActive, justEnded: false };
    if (v.justStarted) {
      g.turnActive = true;
      g.audioEndSent = false;
      await this._apply(guildId, g.machine.onUserSpeechStart(), { userId });
    }
    if (v.speaking) g.lastSpeechAt = this._deps.now();
    if (!g.turnActive) return; // between turns: forward nothing
    if (g.session) {
      g.session.sendAudio(pcm16);
    } else {
      (g.pending || (g.pending = [])).push(pcm16);
    }
```

- [ ] **Step 5: Clear `turnActive` when the turn finalizes**

In `_tick`, right after `g.audioEndSent = true;` (inside the `audio_stream_end` block, ~`VoiceService.js:471`), add:

```javascript
      g.turnActive = false; // stop forwarding until the next speech onset
```

In `_endSession` (~`:485`) and the unhealthy-reset path in `_startSession` (~`:319`), reset the VAD gate and turn flag next to the existing `g.gate.reset()` calls:

```javascript
    g.turnActive = false;
    if (g.vad && typeof g.vad.reset === 'function') g.vad.reset();
```

- [ ] **Step 6: Remove the now-dead energy constant usage**

Delete the `REAL_SPEECH_MEANABS` **drop** (already replaced in Step 4). Keep the `frameMeanAbs` helper and the `REAL_SPEECH_MEANABS` const ONLY if still referenced by diagnostics; otherwise remove both and the `DEFAULT_SPEECH_END_SILENCE_MS` stays. Verify no remaining references:

Run: `grep -n "REAL_SPEECH_MEANABS\|frameMeanAbs" services/VoiceService.js`
Expected: no references in the active path (remove the const + helper if the count is zero elsewhere).

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: PASS for the two new tests. Some existing energy-gate tests will now fail — that is expected; fix them in Task 6.

- [ ] **Step 8: Commit**

```bash
git add services/VoiceService.js __tests__/services/VoiceService.test.js
git commit -m "feat(voice): VAD-driven turns — stream continuously, drop the energy gate"
```

---

### Task 6: Reconcile existing VoiceService tests + verify interrupt-flush & audio_stream_end

**Files:**
- Modify: `__tests__/services/VoiceService.test.js`

**Interfaces:**
- Consumes: the rewired `_handleUserPcm` (Task 5).
- Produces: a green suite where energy-gate assertions are replaced by VAD-gate equivalents, plus explicit coverage that (a) `audio_stream_end` still fires after silence and (b) `interrupted` still flushes playback.

- [ ] **Step 1: Identify the failing legacy tests**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: FAIL list includes the old energy-gate tests (e.g. "real speech IS streamed", "gate+debounce", "barge-in enabled: real speech IS streamed while the bot is playing"). Note each failing test name.

- [ ] **Step 2: Rewrite each failing energy-gate test to drive the fake VAD gate**

For every test that previously asserted forwarding based on `meanAbs`, replace the audio-shaping with a `fakeVadGate([...])` transition script (Task 5 helper). Example — the half-duplex "barge-in enabled" test becomes:

```javascript
test('barge-in enabled (allowBargeIn): speech IS streamed while the bot is playing', async () => {
  const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
  const { svc, guildId, session } = buildActiveVoiceService({ makeVadGate: () => gate, allowBargeIn: true, playing: true });
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
  expect(session.sendAudio).toHaveBeenCalledTimes(1);
});
```

Half-duplex-default (playing, no barge-in) must still return early BEFORE the gate: assert `session.sendAudio` not called and `gate.push` not called.

- [ ] **Step 3: Add the audio_stream_end regression test**

```javascript
test('audio_stream_end fires speechEndSilenceMs after the last speaking frame', async () => {
  let t = 1000;
  const now = () => t;
  const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
  const { svc, guildId, session } = buildActiveVoiceService({ makeVadGate: () => gate, now, speechEndSilenceMs: 800 });
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2))); // lastSpeechAt = 1000
  t = 1900; // 900ms later, no new speech
  svc._tick(guildId);
  expect(session.sendAudioStreamEnd).toHaveBeenCalledTimes(1);
  const g = svc._guilds.get(guildId);
  expect(g.turnActive).toBe(false); // turn closed, stops forwarding
});
```

- [ ] **Step 4: Add the interrupt-flush regression test**

```javascript
test('interrupted server event flushes playback (stopPlayback)', async () => {
  const { svc, guildId, session, playerStop } = buildActiveVoiceService({});
  session.emit('interrupted');
  await new Promise((r) => setImmediate(r));
  expect(playerStop).toHaveBeenCalled(); // _stopPlayback -> player.stop()
});
```

> If the existing harness doesn't expose `playerStop`, assert on the playback stream being destroyed instead, matching how the file already tests `_stopPlayback`.

- [ ] **Step 5: Run the full voice suite**

Run: `npm test -- --testPathPatterns="VoiceService|SileroVad"`
Expected: PASS (all).

- [ ] **Step 6: Run the FULL suite (nothing else regressed)**

Run: `npm test`
Expected: PASS (all green).

- [ ] **Step 7: Commit**

```bash
git add __tests__/services/VoiceService.test.js
git commit -m "test(voice): VAD-gate test coverage + audio_stream_end/interrupt regressions"
```

---

### Task 7: Offline Layer-2 harness (`scripts/test-vad.js`)

**Files:**
- Create: `scripts/test-vad.js`

**Interfaces:**
- Consumes: the real `createSileroVadEngine` + `VoiceActivityGate` (Task 3), `downsampleTo16kMono` (audio.js), `ffmpeg`.
- Produces: a CLI that prints the speech-start/end timeline + per-window probs for an audio file, via BOTH the clean-16k path and the 48k→downsample path (localizes whether a miss is the model or our audio path — mirrors `scripts/test-wakeword.js`).

- [ ] **Step 1: Write the harness**

```javascript
#!/usr/bin/env node
'use strict';
// Offline Silero VAD tester: feed a real file through the ACTUAL engine+gate
// (no Discord) and print the speech timeline. Usage:
//   node scripts/test-vad.js [audioFile] [threshold]
const { execFileSync } = require('child_process');
const path = require('path');
const { createSileroVadEngine, VoiceActivityGate, WINDOW } = require('../services/voice/SileroVad');
const { downsampleTo16kMono } = require('../services/voice/audio');

const audioFile = process.argv[2] || path.join(__dirname, '..', 'Recording.m4a');
const threshold = parseFloat(process.argv[3] || '0.5');
const modelPath = path.join(__dirname, '..', 'models', 'silero', 'silero_vad.onnx');

function decode(file, { rate, channels }) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', String(channels),
    '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { maxBuffer: 1 << 28 });
}

async function run(label, pcm16Buf) {
  const gate = new VoiceActivityGate(createSileroVadEngine({ modelPath }),
    { threshold, minSpeechFrames: 2, minSilenceFrames: 24 });
  await gate._engine.ready();
  const bytesPerWindow = WINDOW * 2;
  let ms = 0;
  console.log(`\n[${label}] threshold=${threshold}`);
  for (let off = 0; off + bytesPerWindow <= pcm16Buf.length; off += bytesPerWindow) {
    const r = gate.push(pcm16Buf.subarray(off, off + bytesPerWindow));
    await gate._engine.whenIdle();
    ms += 32;
    if (r.justStarted) console.log(`  ${ms}ms  SPEECH START  (p=${gate.lastProb().toFixed(2)})`);
    if (r.justEnded) console.log(`  ${ms}ms  speech end    (p=${gate.lastProb().toFixed(2)})`);
  }
}

(async () => {
  await run('A: clean 16k mono', decode(audioFile, { rate: 16000, channels: 1 }));
  await run('B: 48k stereo -> downsampleTo16kMono', downsampleTo16kMono(decode(audioFile, { rate: 48000, channels: 2 })));
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it against the existing recording**

Run: `node scripts/test-vad.js`
Expected: both paths print a `SPEECH START` near the utterance onset and a `speech end` after it. If path B misses where A hits, that localizes an audio-path (downsample) issue, not a model issue. **This is the manual validation of "Silero copes with Discord-degraded audio."**

- [ ] **Step 3: Commit**

```bash
git add scripts/test-vad.js
git commit -m "test(voice): offline Silero VAD harness (clean-16k + downsample paths)"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md` (Voice sidecar section)
- Modify: `features.md`
- Modify: `docs/superpowers/specs/2026-08-13-multi-user-voice-vad-rework-design.md` (§5.7/§5.8 accuracy note)

**Interfaces:** none (docs).

- [ ] **Step 1: Update `CLAUDE.md` Voice section**

Replace the description of the fixed energy gate / `REAL_SPEECH_MEANABS` with: Silero VAD (per-stream, 512-sample/32 ms windows, `onnxruntime-node`) drives turn boundaries; audio streams continuously once a turn opens so Gemini's server VAD sees trailing silence (Hybrid VAD); `audio_stream_end` finalizes after `VOICE_SPEECH_END_SILENCE_MS`. Add the new tunables: `VOICE_VAD_THRESHOLD`, `VOICE_VAD_MIN_SPEECH_FRAMES`, `VOICE_VAD_MIN_SILENCE_FRAMES`, `VOICE_VAD_MODEL`.

- [ ] **Step 2: Update `features.md`**

Note under voice: neural VAD (Silero) replaced the energy gate; endpointing is now a correct Gemini Hybrid VAD.

- [ ] **Step 3: Correct the spec's frame-size note**

In the spec §5.7/§5.8, add a one-line correction: the pipeline already forwards ~20 ms per-Opus-packet chunks (the 1280/80 ms figure is openWakeWord's internal frame, rebuffered inside `WakeWordGate`), so Phase 1's only frame-size work is the Silero 512-sample rebuffer; no change to the Gemini forward chunk size was needed.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md features.md docs/superpowers/specs/2026-08-13-multi-user-voice-vad-rework-design.md
git commit -m "docs(voice): document Silero Hybrid VAD; correct frame-size note"
```

---

## Self-Review

**Spec coverage (Phase 1 scope):**
- §5.1 SileroVad → Tasks 1–3. ✓
- §5.3 endpointing (stop dropping frames; Silero-driven `audio_stream_end`; server VAD kept on) → Task 5 (continuous forward + turnActive) + Task 6 (audio_stream_end regression). Server VAD stays on (no sidecar change). ✓
- §5.7 interrupt-flush verification → Task 6 Step 4. ✓ Per-speaker wake / chunk-shrink: chunk already ~20 ms (documented Task 8); per-speaker wake is **Phase 2** (not this plan). ✓ (scoped out intentionally)
- §5.8 frame-size reconciliation → Task 3 (512 rebuffer) + Task 8 correction. openWakeWord 1280 rebuffer unchanged; Gemini forward already ~20 ms. ✓
- Guiding principle (compute over frugality) → per-stream engine, session-cached. ✓

**Placeholder scan:** No TBD/TODO. Task 1 `<name>`/`<DATE>` are explicitly filled from real introspection output (not left blank). Test helpers (`buildActiveVoiceService`, `to48kStereo`) are explicitly deferred to the existing test file's real helpers, not invented.

**Type consistency:** `createSileroVadEngine`, `VoiceActivityGate`, `preloadSileroVad`, `WINDOW` exported (Task 2/3) and consumed identically in `bot.js` (Task 4) and `scripts/test-vad.js` (Task 7). Gate `push()` returns `{speaking, justStarted, justEnded}` — same shape produced (Task 3) and consumed (Task 5, Task 6 fakes). `deps.makeVadGate` defined (Task 4) and consumed (Task 5 Step 3). Engine `process(int16Frame)`/`whenIdle()`/`ready()`/`reset()`/`lastProb()` consistent across Tasks 2, 3, 7.

**Known spike (flagged, not a placeholder):** Silero v5 tensor IO names/shapes are discovered in Task 1 and pasted into Task 2's `IN_*`/`OUT_*` consts + README; the `int64`/`sr` dims may need a `[1]` vs `[]` adjustment noted inline in Task 2.
