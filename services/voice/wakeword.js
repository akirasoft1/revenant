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

  reset() { this._buf = new Int16Array(0); }
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
// `engine.process()` synchronously and expects a number back. We therefore run
// the ONNX chain on an async queue and surface detections via a flag that
// `process()` reads (and clears) on each call: a detection is reported on the
// next `process()` after the chain completes -- a sub-frame (<80 ms) lag that is
// invisible for continuous wake-word gating. `whenIdle()`/`ready()` expose the
// internal queue for deterministic testing; they are not part of the gate
// contract.

const FRAME_LENGTH = 1280;   // audio samples per step (80 ms @ 16 kHz)
const MELS_PER_FRAME = 5;    // mel frames the mel model emits per 1280 samples
const MEL_BINS = 32;         // mel bins per frame
const MEL_WINDOW = 76;       // mel frames per embedding-model window
const MEL_STRIDE = 8;        // mel frames advanced between embeddings
const EMBEDDING_DIM = 96;    // embedding vector length
const DEFAULT_WAKE_WINDOW = 16; // embeddings per wake-model window (pretrained)

function defaultSessionFactory() {
  // Lazy require so unit tests (which inject a fake) never load the native
  // binding. onnxruntime-node ships glibc-only prebuilt binaries.
  const ort = require('onnxruntime-node');
  return {
    createSession: (path) => ort.InferenceSession.create(path),
    tensor: (type, data, dims) => new ort.Tensor(type, data, dims),
  };
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
  let lastError = null;
  let closed = false;

  const readyPromise = (async () => {
    [melSession, embSession, wakeSession] = await Promise.all([
      backend.createSession(melModelPath),
      backend.createSession(embeddingModelPath),
      backend.createSession(wakeModelPath),
    ]);
    wakeWindow = inferWakeWindow(wakeSession) || DEFAULT_WAKE_WINDOW;
    embHistory = [];
    for (let i = 0; i < wakeWindow; i++) embHistory.push(new Float32Array(EMBEDDING_DIM));
  })();

  let queue = readyPromise.catch((e) => { lastError = e; });

  async function runChain(int16Frame) {
    if (!melSession || !embSession || !wakeSession) return;

    // int16-range float32 (Python openWakeWord training convention).
    const audio = new Float32Array(FRAME_LENGTH);
    for (let i = 0; i < FRAME_LENGTH && i < int16Frame.length; i++) audio[i] = int16Frame[i];

    const melOut = await melSession.run({
      [melSession.inputNames[0]]: backend.tensor('float32', audio, [1, FRAME_LENGTH]),
    });
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
      const emb = new Float32Array(embOut[embSession.outputNames[0]].data);

      embHistory.shift();
      embHistory.push(emb);

      const wf = new Float32Array(wakeWindow * EMBEDDING_DIM);
      for (let j = 0; j < wakeWindow; j++) wf.set(embHistory[j], j * EMBEDDING_DIM);
      const wakeOut = await wakeSession.run({
        [wakeSession.inputNames[0]]: backend.tensor('float32', wf, [1, wakeWindow, EMBEDDING_DIM]),
      });
      const score = wakeOut[wakeSession.outputNames[0]].data[0];
      if (score >= threshold) detected = true;

      melBuffer.splice(0, MEL_STRIDE);
    }
  }

  return {
    frameLength: FRAME_LENGTH,

    process(int16Frame) {
      if (closed) return -1;
      // Copy: the gate passes a subarray view into a buffer it reuses, and the
      // chain runs asynchronously after process() returns.
      const copy = new Int16Array(int16Frame.length);
      copy.set(int16Frame);
      queue = queue.then(() => runChain(copy)).catch((e) => { lastError = e; });
      const fired = detected;
      detected = false;
      return fired ? 0 : -1;
    },

    // --- non-contract helpers (testing / lifecycle) ---
    ready() { return readyPromise; },
    whenIdle() { return queue; },
    lastError() { return lastError; },
    close() { closed = true; },
  };
}

module.exports = { WakeWordGate, createOpenWakeWordEngine };
