'use strict';

class WakeWordGate {
  constructor(engine) {
    this._engine = engine;
    this._frame = engine.frameLength;
    this._buf = new Int16Array(0);
  }

  push(pcmBuf) {
    // NOTE: deliberately NOT `new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, ...)`.
    // Node Buffers are slices of a shared pool and can have an odd byteOffset,
    // which throws `RangeError: start offset ... must be a multiple of 2` when
    // used directly as an Int16Array view. Decode with readInt16LE instead,
    // same pattern as services/voice/audio.js.
    const sampleCount = Math.floor(pcmBuf.length / 2);
    const incoming = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      incoming[i] = pcmBuf.readInt16LE(i * 2);
    }

    const merged = new Int16Array(this._buf.length + incoming.length);
    merged.set(this._buf); merged.set(incoming, this._buf.length);

    let offset = 0;
    let detected = false;
    while (merged.length - offset >= this._frame) {
      const frame = merged.subarray(offset, offset + this._frame);
      if (this._engine.process(frame) >= 0) detected = true;
      offset += this._frame;
    }
    this._buf = merged.subarray(offset).slice(); // keep remainder
    return detected;
  }

  reset() {
    this._buf = new Int16Array(0);
    // Propagate to the engine so stale/in-flight detections from the previous
    // listening period cannot surface in the next one (see engine.reset()).
    this._engine.reset?.();
  }

  // Diagnostic passthroughs (not part of the detection contract): let callers
  // surface *why* a listening period produced no wake -- an erroring ONNX chain
  // (lastError) vs. audio that scored below threshold (lastScore) vs. no audio
  // at all. Guarded so fake engines in tests without these methods return null.
  lastError() { return typeof this._engine.lastError === 'function' ? this._engine.lastError() : null; }
  lastScore() { return typeof this._engine.lastScore === 'function' ? this._engine.lastScore() : null; }
  frameStats() { return typeof this._engine.frameStats === 'function' ? this._engine.frameStats() : null; }
}

// --- openWakeWord ONNX engine -------------------------------------------------
//
// openWakeWord detects a wake phrase via a 3-stage ONNX chain on 16 kHz mono PCM:
//   1. melspectrogram model: 1280 raw audio samples -> 5 mel frames x 32 bins.
//      The mel output is rescaled (`x/10 + 2`) exactly as in the reference impls.
//   2. embedding model: a rolling 76-mel-frame window (stride 8) -> a 96-dim
//      embedding vector.
//   3. wake model (per phrase, e.g. hey_jarvis): the last N embeddings
//      ([1, N, 96], N inferred from the model, 16 for the pretrained phrases)
//      -> a score in [0, 1]; score >= threshold means the phrase was heard.
//
// Frontend/windowing (frame size 1280, 5 mels/frame, 76-frame window, stride 8,
// `/10 + 2` mel transform) is ported from the working reference implementation
// `openwakeword_wasm` (https://github.com/dnavarrom/openwakeword_wasm), adapted
// from onnxruntime-web to onnxruntime-node (near-identical APIs) and matched to
// the vendored ONNX models' actual tensor names/shapes. VAD is intentionally
// dropped -- it is optional in openWakeWord and not part of the gate contract.
//
// Audio is fed as int16-range float32 (NOT normalised to [-1, 1]) to match the
// Python openWakeWord training pipeline the models were trained with. Detection
// on the reference `hey_jarvis` sample scores ~0.998 this way (negative ~0.0003).
//
// onnxruntime-node's `session.run` is async, but the WakeWordGate contract calls
// `engine.process()` synchronously and expects a number back. Bridge design:
//
//   * Single in-flight, drop-when-busy. At most ONE inference runs at a time.
//     If `process()` is called while one is in flight, the frame is skipped
//     (no queue, no retained-Int16Array backlog) -- the models infer in
//     ~5-15 ms, far under the 80 ms frame interval, so this virtually never
//     drops in practice, and openWakeWord's rolling window tolerates the rare
//     skipped frame.
//   * Generation token ties a result to the CURRENT listening period. Each
//     scheduled inference captures `gen = generation`; on resolve it only sets
//     `detected = true` if `gen === generation` (and score >= threshold).
//   * `reset()` bumps `generation`, clears `detected`, and drops the mel/embed
//     buffers -- so any in-flight inference no-ops on resolve and no stale
//     detection can carry into the next period. WakeWordGate.reset() propagates
//     to it (and VoiceService._endSession already calls gate.reset()).
//
// `process()` stays synchronous and returns `0`/`-1` reflecting the latest
// resolved, current-generation decision -- a sub-frame (<80 ms) lag that is
// invisible for continuous wake-word gating. `whenIdle()`/`ready()` expose the
// in-flight promise for deterministic testing; they are not part of the gate
// contract.

const FRAME_LENGTH = 1280;   // audio samples per step (80 ms @ 16 kHz)
const MELS_PER_FRAME = 5;    // mel frames the mel model emits per 1280 samples
const MEL_BINS = 32;         // mel bins per frame
const MEL_WINDOW = 76;       // mel frames per embedding-model window
const MEL_STRIDE = 8;        // mel frames advanced between embeddings
const EMBEDDING_DIM = 96;    // embedding vector length
const DEFAULT_WAKE_WINDOW = 16; // embeddings per wake-model window (pretrained)

// Memoized so every production createOpenWakeWordEngine() call (which never
// passes sessionFactory) shares the SAME backend identity -- required for the
// module-level session cache below to actually hit across joins/preload
// instead of missing every time because it saw a fresh backend object.
let _defaultBackend = null;
function defaultSessionFactory() {
  if (_defaultBackend) return _defaultBackend;
  // Lazy require so unit tests (which inject a fake) never load the native
  // binding. onnxruntime-node ships glibc-only prebuilt binaries.
  const ort = require('onnxruntime-node');
  _defaultBackend = {
    createSession: (path) => ort.InferenceSession.create(path),
    tensor: (type, data, dims) => new ort.Tensor(type, data, dims),
  };
  return _defaultBackend;
}

// --- module-level ONNX session cache ------------------------------------------
//
// Root cause of the ~97s /voice join stall: sessions were created PER ENGINE
// (per join), so every join re-ran ort.InferenceSession.create() for all 3
// models, saturating the bot's 0.5-CPU limit and stalling the event loop.
//
// Sessions are safe to reuse across concurrent inferences, so cache the
// Promise<[melSession, embSession, wakeSession]> keyed by (backend identity,
// model paths). Keying on backend identity -- not just paths -- keeps unit
// tests isolated (each test's own fake backend gets its own cache slot even
// when path strings are reused across tests), while production always shares
// one backend (see `defaultSessionFactory` above), so real joins/preload
// share the cache.
const _sessionCacheByBackend = new WeakMap(); // backend -> Map(pathKey -> Promise<[mel, emb, wake]>)

function _pathKey({ melModelPath, embeddingModelPath, wakeModelPath }) {
  return `${melModelPath}::${embeddingModelPath}::${wakeModelPath}`;
}

function _loadSessions(backend, paths) {
  let byPathKey = _sessionCacheByBackend.get(backend);
  if (!byPathKey) {
    byPathKey = new Map();
    _sessionCacheByBackend.set(backend, byPathKey);
  }
  const key = _pathKey(paths);
  let entry = byPathKey.get(key);
  if (!entry) {
    entry = Promise.all([
      backend.createSession(paths.melModelPath),
      backend.createSession(paths.embeddingModelPath),
      backend.createSession(paths.wakeModelPath),
    ]);
    // Don't poison the cache with a failed load -- let the next caller retry.
    entry.catch(() => { byPathKey.delete(key); });
    byPathKey.set(key, entry);
  }
  return entry;
}

// Triggers/awaits the module-level session cache load so callers (bot.js at
// startup) can warm it off the request path -- the one-time ONNX load then
// happens at boot instead of on the first `/voice join`.
function preloadOpenWakeWord({ wakeModelPath, melModelPath, embeddingModelPath, sessionFactory } = {}) {
  const backend = sessionFactory || defaultSessionFactory();
  return _loadSessions(backend, { melModelPath, embeddingModelPath, wakeModelPath });
}

function inferWakeWindow(session) {
  const meta = session && session.inputMetadata;
  const name = session && session.inputNames && session.inputNames[0];
  if (!meta || !name) return undefined;
  let entry;
  if (Array.isArray(meta)) entry = meta.find((m) => m && m.name === name) || meta[0];
  else entry = meta[name];
  const shape = entry && entry.shape;
  const dim = Array.isArray(shape) ? shape[1] : undefined;
  return typeof dim === 'number' && Number.isFinite(dim) && dim > 0 ? dim : undefined;
}

function createOpenWakeWordEngine({
  wakeModelPath,
  melModelPath,
  embeddingModelPath,
  threshold = 0.5,
  sessionFactory,
} = {}) {
  const backend = sessionFactory || defaultSessionFactory();

  let melSession;
  let embSession;
  let wakeSession;
  let wakeWindow = DEFAULT_WAKE_WINDOW;
  let melBuffer = [];          // Float32Array(MEL_BINS) per mel frame
  let embHistory = [];         // Float32Array(EMBEDDING_DIM) per embedding
  let detected = false;
  let maxScore = 0;            // highest wake score since the last reset() (diagnostic)
  let inferScheduled = 0;      // frames actually run through the ONNX chain (diagnostic)
  let inferDroppedBusy = 0;    // frames skipped because an inference was in flight (diagnostic)
  let lastError = null;
  let closed = false;
  let generation = 0;          // bumped on reset(); ties results to a period
  let inFlight = null;         // the single pending inference promise, or null

  const readyPromise = (async () => {
    // Shared, module-level cache: reuses sessions across engines (joins) that
    // share the same backend + model paths instead of reloading per-engine.
    [melSession, embSession, wakeSession] = await _loadSessions(backend, {
      melModelPath, embeddingModelPath, wakeModelPath,
    });
    wakeWindow = inferWakeWindow(wakeSession) || DEFAULT_WAKE_WINDOW;
    embHistory = [];
    for (let i = 0; i < wakeWindow; i++) embHistory.push(new Float32Array(EMBEDDING_DIM));
  })();

  readyPromise.catch((e) => { lastError = e; });

  // Runs the mel -> embedding -> wake chain for one frame. `gen` is the
  // generation captured at schedule time; buffer mutations and the detection
  // flag are only applied while it is still the current generation, so a reset()
  // mid-flight makes this a no-op on the model state it would otherwise touch.
  async function runChain(int16Frame, gen) {
    if (!melSession || !embSession || !wakeSession) return;
    if (gen !== generation) return; // reset() happened before we started

    // int16-range float32 (Python openWakeWord training convention).
    const audio = new Float32Array(FRAME_LENGTH);
    for (let i = 0; i < FRAME_LENGTH && i < int16Frame.length; i++) audio[i] = int16Frame[i];

    const melOut = await melSession.run({
      [melSession.inputNames[0]]: backend.tensor('float32', audio, [1, FRAME_LENGTH]),
    });
    if (gen !== generation) return; // reset() during mel inference
    const md = melOut[melSession.outputNames[0]].data;
    for (let j = 0; j < MELS_PER_FRAME; j++) {
      const frame = new Float32Array(MEL_BINS);
      for (let k = 0; k < MEL_BINS; k++) frame[k] = md[j * MEL_BINS + k] / 10 + 2;
      melBuffer.push(frame);
    }

    while (melBuffer.length >= MEL_WINDOW) {
      const flat = new Float32Array(MEL_WINDOW * MEL_BINS);
      for (let j = 0; j < MEL_WINDOW; j++) flat.set(melBuffer[j], j * MEL_BINS);
      const embOut = await embSession.run({
        [embSession.inputNames[0]]: backend.tensor('float32', flat, [1, MEL_WINDOW, MEL_BINS, 1]),
      });
      if (gen !== generation) return; // reset() during embedding inference
      const emb = new Float32Array(embOut[embSession.outputNames[0]].data);

      embHistory.shift();
      embHistory.push(emb);

      const wf = new Float32Array(wakeWindow * EMBEDDING_DIM);
      for (let j = 0; j < wakeWindow; j++) wf.set(embHistory[j], j * EMBEDDING_DIM);
      const wakeOut = await wakeSession.run({
        [wakeSession.inputNames[0]]: backend.tensor('float32', wf, [1, wakeWindow, EMBEDDING_DIM]),
      });
      if (gen !== generation) return; // reset() during wake inference
      const score = wakeOut[wakeSession.outputNames[0]].data[0];
      if (score > maxScore) maxScore = score;
      if (score >= threshold) detected = true;

      melBuffer.splice(0, MEL_STRIDE);
    }
  }

  function schedule(int16Frame) {
    if (inFlight) { inferDroppedBusy += 1; return; } // single in-flight: drop this frame, one is running
    inferScheduled += 1;
    // Copy: the gate hands out a subarray view into a buffer it reuses.
    const copy = new Int16Array(int16Frame.length);
    copy.set(int16Frame);
    const gen = generation;
    inFlight = readyPromise
      .then(() => runChain(copy, gen))
      .catch((e) => { lastError = e; })
      .finally(() => { inFlight = null; });
  }

  return {
    frameLength: FRAME_LENGTH,

    process(int16Frame) {
      if (closed) return -1;
      schedule(int16Frame);
      const fired = detected;
      detected = false;
      return fired ? 0 : -1;
    },

    // Invalidate the current listening period: any in-flight inference no-ops on
    // resolve (generation check), the detection flag is cleared, and the mel/
    // embedding buffers are dropped so the next period starts clean.
    reset() {
      generation += 1;
      detected = false;
      maxScore = 0;
      inferScheduled = 0;
      inferDroppedBusy = 0;
      melBuffer = [];
      embHistory = [];
      for (let i = 0; i < wakeWindow; i++) embHistory.push(new Float32Array(EMBEDDING_DIM));
    },

    // --- non-contract helpers (testing / lifecycle) ---
    ready() { return readyPromise; },
    whenIdle() { return Promise.resolve(inFlight); },
    lastError() { return lastError; },
    lastScore() { return maxScore; },
    // Diagnostic: how many frames actually ran the ONNX chain vs. were skipped
    // because an inference was still in flight. Heavy skipping starves the
    // rolling wake window and tanks scores.
    frameStats() { return { scheduled: inferScheduled, droppedBusy: inferDroppedBusy }; },
    close() { closed = true; },
  };
}

module.exports = { WakeWordGate, createOpenWakeWordEngine, preloadOpenWakeWord };
