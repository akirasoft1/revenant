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
