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
      // Copy: process() is a public API and a caller (e.g. the gate) may hand
      // us a subarray view into a buffer it reuses across calls — same hazard
      // documented in wakeword.js's schedule().
      queue.push({ frame: Int16Array.from(int16Frame), gen: generation });
      drain();
      // Async chain (queue+drain): `lastProb` here is the PRIOR completed
      // inference's probability, not this frame's -- the decision at window N
      // reflects window N-1's result, a ~1-window (~32ms @ WINDOW=512/16kHz)
      // detection lag. Mirrors the equivalent note in wakeword.js's process().
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
    // Copy (not a view): `buf` may be `pcm16Buf` itself, a Node Buffer slice of
    // a shared pool that the caller can mutate/reuse after push() returns.
    // NOTE: unlike TypedArray#slice() (used by WakeWordGate.push() on its
    // Int16Array _buf), Buffer.prototype.slice() is legacy-overridden to
    // return a VIEW into the same memory, identical to subarray() — it does
    // NOT copy. Use Buffer.from() instead, which does.
    this._carry = Buffer.from(buf.subarray(off)); // keep the sub-window remainder for next push
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
