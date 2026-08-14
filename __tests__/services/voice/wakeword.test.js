'use strict';

const { WakeWordGate, createOpenWakeWordEngine, preloadOpenWakeWord } = require('../../../services/voice/wakeword');

class FakeEngine {
  constructor(detectAtCall) { this.frameLength = 4; this._n = 0; this._at = detectAtCall; }
  process() { this._n += 1; return this._n === this._at ? 0 : -1; }
}
function pcm(n) { return Buffer.alloc(n * 2); } // n samples of silence

test('detects on the frame where engine fires', () => {
  const gate = new WakeWordGate(new FakeEngine(2)); // fires on 2nd frame
  expect(gate.push(pcm(4))).toBe(false);            // frame 1
  expect(gate.push(pcm(4))).toBe(true);             // frame 2 -> detect
});

test('buffers partial frames across pushes', () => {
  const gate = new WakeWordGate(new FakeEngine(1));
  expect(gate.push(pcm(2))).toBe(false);            // half a frame, no process yet
  expect(gate.push(pcm(2))).toBe(true);             // completes frame 1 -> detect
});

test('reset clears buffered partial frame', () => {
  const gate = new WakeWordGate(new FakeEngine(1));
  expect(gate.push(pcm(2))).toBe(false); // half a frame buffered
  gate.reset();
  expect(gate.push(pcm(2))).toBe(false); // still half a frame, buffer was cleared not completed
  expect(gate.push(pcm(2))).toBe(true);  // now completes -> detect
});

test('handles an unaligned buffer (odd byteOffset) without throwing', () => {
  // Simulate a Node Buffer slice from a shared pool with an odd byteOffset.
  const gate = new WakeWordGate(new FakeEngine(1));
  const backing = Buffer.alloc(9); // 1 padding byte + 8 bytes (4 samples) of PCM
  const unaligned = backing.subarray(1); // byteOffset === 1, NOT a multiple of 2
  expect(unaligned.byteOffset).toBe(1);
  expect(() => gate.push(unaligned)).not.toThrow();
});

test('unaligned buffer still decodes samples correctly and detects', () => {
  const gate = new WakeWordGate(new FakeEngine(1));
  const backing = Buffer.alloc(1 + 8); // 1 padding byte + 4 samples (frameLength=4)
  backing.writeInt16LE(1234, 1);
  backing.writeInt16LE(-5678, 3);
  backing.writeInt16LE(42, 5);
  backing.writeInt16LE(-42, 7);
  const unaligned = backing.subarray(1);
  expect(gate.push(unaligned)).toBe(true); // full frame processed -> engine fires on 1st call
});

// --- openWakeWord engine (injected fake sessions, NO native binding) ---------

// Builds a fake onnxruntime backend that records the order of model runs and
// lets the test control the wake score. Mirrors the real models' tensor
// names/shapes: mel -> 5x32 mels, embedding -> 96 dims, wake -> [1,16,96] -> scalar.
function makeFakeBackend({ score = 0, calls = [] } = {}) {
  const melSession = {
    inputNames: ['input'], outputNames: ['output'],
    run(feeds) {
      calls.push({ model: 'mel', dims: feeds.input.dims });
      return Promise.resolve({ output: { data: new Float32Array(5 * 32) } }); // 5 mel frames x 32
    },
  };
  const embSession = {
    inputNames: ['input_1'], outputNames: ['conv2d_19'],
    run(feeds) {
      calls.push({ model: 'emb', dims: feeds.input_1.dims });
      return Promise.resolve({ conv2d_19: { data: new Float32Array(96) } });
    },
  };
  const wakeSession = {
    inputNames: ['x.1'], outputNames: ['53'],
    inputMetadata: [{ name: 'x.1', isTensor: true, type: 'float32', shape: [1, 16, 96] }],
    run(feeds) {
      calls.push({ model: 'wake', dims: feeds['x.1'].dims });
      // `score` may be a number OR a Promise<number> (for deferred-resolution
      // race tests): Promise.resolve adopts a thenable.
      return Promise.resolve(score).then((v) => ({ 53: { data: [v] } }));
    },
  };
  const backend = {
    createSession: (path) => {
      if (/mel/i.test(path)) return Promise.resolve(melSession);
      if (/embed/i.test(path)) return Promise.resolve(embSession);
      return Promise.resolve(wakeSession);
    },
    tensor: (type, data, dims) => ({ type, data, dims }),
  };
  return { backend, calls };
}

const paths = {
  wakeModelPath: 'hey_jarvis.onnx',
  melModelPath: 'melspectrogram.onnx',
  embeddingModelPath: 'embedding_model.onnx',
};

function frame1280() { return new Int16Array(1280); }

// Let the event loop turn (flushes ALL pending microtasks in Node), mirroring
// the spacing between decoder 'data' events in production -- WITHOUT serializing
// on the engine's own whenIdle() signal.
function tick() { return new Promise((r) => setImmediate(r)); }

// Serialized feed for plumbing tests: process one frame and let its (single
// in-flight) inference fully resolve before the next, so every frame is
// actually processed rather than dropped by the busy-guard.
async function feed(engine, n) {
  for (let i = 0; i < n; i++) { engine.process(frame1280()); await engine.whenIdle(); }
}

test('createOpenWakeWordEngine reports frameLength 1280 and never loads native binding here', () => {
  const { backend } = makeFakeBackend();
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, sessionFactory: backend });
  expect(engine.frameLength).toBe(1280);
});

test('feeds a [1,1280] mel input tensor per frame', async () => {
  const { backend, calls } = makeFakeBackend();
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, sessionFactory: backend });
  await engine.ready();
  await feed(engine, 1);
  const mel = calls.find((c) => c.model === 'mel');
  expect(mel).toBeTruthy();
  expect(mel.dims).toEqual([1, 1280]);
});

test('buffers mel frames across frames; embedding runs only once >= 76 mel frames accumulate', async () => {
  const { backend, calls } = makeFakeBackend();
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, sessionFactory: backend });
  await engine.ready();
  // 5 mel frames per input frame -> 15 frames = 75 mels (< 76): no embedding yet
  await feed(engine, 15);
  expect(calls.some((c) => c.model === 'emb')).toBe(false);
  // 16th frame -> 80 mels >= 76 -> exactly one embedding + wake eval
  await feed(engine, 1);
  expect(calls.filter((c) => c.model === 'emb').length).toBe(1);
  expect(calls.filter((c) => c.model === 'wake').length).toBe(1);
});

test('runs the chain in mel -> embedding -> wake order with correct tensor shapes', async () => {
  const { backend, calls } = makeFakeBackend();
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, sessionFactory: backend });
  await engine.ready();
  await feed(engine, 16);
  const embIdx = calls.findIndex((c) => c.model === 'emb');
  const wakeIdx = calls.findIndex((c) => c.model === 'wake');
  expect(embIdx).toBeGreaterThan(0);
  expect(calls.slice(0, embIdx).every((c) => c.model === 'mel')).toBe(true); // mels precede
  expect(wakeIdx).toBe(embIdx + 1); // wake immediately after its embedding
  expect(calls[embIdx].dims).toEqual([1, 76, 32, 1]);
  expect(calls[wakeIdx].dims).toEqual([1, 16, 96]); // window inferred from metadata
});

test('score >= threshold -> detection (process returns 0)', async () => {
  const { backend } = makeFakeBackend({ score: 0.9 });
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();
  await feed(engine, 16);
  expect(engine.process(frame1280())).toBe(0); // flag set by the completed chain
});

test('score < threshold -> no detection (process returns -1)', async () => {
  const { backend } = makeFakeBackend({ score: 0.1 });
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();
  await feed(engine, 16);
  expect(engine.process(frame1280())).toBe(-1);
});

// --- async-bridge race coverage (NON-serialized, production calling pattern) --

test('real wake IS detected when frames flow with natural event-loop spacing (no whenIdle serialization)', async () => {
  const { backend } = makeFakeBackend({ score: 0.9 });
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();
  let fired = false;
  // Mirror VoiceService._handleUserPcm: one frame per decoder-event tick, never
  // awaiting the engine's whenIdle(). Detection surfaces once >=16 frames flow.
  for (let i = 0; i < 20 && !fired; i++) {
    if (engine.process(frame1280()) === 0) fired = true;
    await tick();
  }
  if (!fired) fired = engine.process(frame1280()) === 0;
  expect(fired).toBe(true);
});

test('a synchronous burst of process() queues and processes ALL frames in order (no drops)', async () => {
  // Root-cause fix: openWakeWord needs contiguous frames. The gate delivers
  // frames in synchronous bursts; the old drop-when-busy design ran ONE and
  // dropped the rest, starving the wake window (verified live at ~70% dropped ->
  // score ~0 on audio that scores ~0.99 when fed contiguously). The queue must
  // now process every frame.
  const { backend, calls } = makeFakeBackend({ score: 0.9 });
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();
  for (let i = 0; i < 50; i++) engine.process(frame1280()); // no yield between calls
  await engine.whenIdle();
  expect(calls.filter((c) => c.model === 'mel').length).toBe(50); // ALL processed, none dropped
  expect(engine.frameStats().droppedBusy).toBe(0);
});

test('queue overflow drops the OLDEST frame and counts it (bounded memory)', async () => {
  // Never-resolving inferences so the queue can only grow -> exercises the cap.
  const backend = {
    createSession: () => Promise.resolve({
      inputNames: ['x'], outputNames: ['y'],
      inputMetadata: [{ name: 'x', isTensor: true, type: 'float32', shape: [1, 16, 96] }],
      run: () => new Promise(() => {}), // never resolves -> drainer parks on the 1st frame
    }),
    tensor: (t, d, dims) => ({ t, d, dims }),
  };
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();
  for (let i = 0; i < 300; i++) engine.process(frame1280()); // 300 > MAX_QUEUE (256)
  const fs = engine.frameStats();
  expect(fs.scheduled).toBe(300);
  expect(fs.droppedBusy).toBeGreaterThan(0); // overflow shed the oldest
});

test('REGRESSION: an inference that resolves high AFTER reset() does NOT surface a spurious wake', async () => {
  let resolveScore;
  const scoreP = new Promise((r) => { resolveScore = r; });
  const { backend, calls } = makeFakeBackend({ score: scoreP });
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();

  await feed(engine, 15);              // 75 mels buffered, all drained, no wake eval yet
  engine.process(frame1280());         // 16th frame -> chain reaches wake.run and blocks on scoreP
  await tick();                        // let the chain advance to the pending wake inference
  expect(calls.some((c) => c.model === 'wake')).toBe(true); // it IS mid-flight at the wake stage

  engine.reset();                      // new listening period begins (generation++)
  resolveScore(0.9);                   // the stale inference now resolves HIGH, after reset
  await engine.whenIdle();

  expect(engine.process(frame1280())).toBe(-1); // no wake carried into the new period
});

test('reset() clears a already-set detection flag', async () => {
  const { backend } = makeFakeBackend({ score: 0.9 });
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();
  await feed(engine, 16);        // detection flag now set by the resolved chain
  engine.reset();               // must clear it
  expect(engine.process(frame1280())).toBe(-1);
});

test('WakeWordGate.reset() propagates to the engine', () => {
  let called = 0;
  const fakeEngine = { frameLength: 4, process: () => -1, reset: () => { called += 1; } };
  const gate = new WakeWordGate(fakeEngine);
  gate.reset();
  expect(called).toBe(1);
});

test('WakeWordGate drives the openWakeWord engine end-to-end (fake sessions)', async () => {
  const { backend } = makeFakeBackend({ score: 0.9 });
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();
  const gate = new WakeWordGate(engine);
  // One frame per push with the inference draining between (single in-flight),
  // mirroring the decoder feeding the gate over successive events.
  for (let i = 0; i < 16; i++) { gate.push(Buffer.alloc(1280 * 2)); await engine.whenIdle(); }
  expect(gate.push(Buffer.alloc(1280 * 2))).toBe(true); // detection surfaces on next push
});

// --- module-level session cache (join-latency fix) ---------------------------
//
// Root cause of the ~97s /voice join stall: sessions were created PER ENGINE,
// so every join() re-ran ort.InferenceSession.create() for all 3 models.
// The fix caches created sessions at module scope, keyed by (paths, backend
// identity), so repeated createOpenWakeWordEngine() calls with the SAME
// sessionFactory + paths reuse the already-loaded sessions instead of
// reloading them. Keying includes backend identity (not just paths) so that
// two DIFFERENT fake backends in two different tests -- which happen to reuse
// the same literal `paths` strings above -- never collide.

test('module-level cache: two engines with the same paths + same sessionFactory load sessions ONCE (3 creates, not 6)', async () => {
  const calls = [];
  const melSession = { inputNames: ['input'], outputNames: ['output'],
    run: () => Promise.resolve({ output: { data: new Float32Array(5 * 32) } }) };
  const embSession = { inputNames: ['input_1'], outputNames: ['conv2d_19'],
    run: () => Promise.resolve({ conv2d_19: { data: new Float32Array(96) } }) };
  const wakeSession = { inputNames: ['x.1'], outputNames: ['53'],
    inputMetadata: [{ name: 'x.1', isTensor: true, type: 'float32', shape: [1, 16, 96] }],
    run: () => Promise.resolve({ 53: { data: [0] } }) };
  const backend = {
    createSession: (path) => {
      calls.push(path);
      if (/mel/i.test(path)) return Promise.resolve(melSession);
      if (/embed/i.test(path)) return Promise.resolve(embSession);
      return Promise.resolve(wakeSession);
    },
    tensor: (type, data, dims) => ({ type, data, dims }),
  };

  const engine1 = createOpenWakeWordEngine({ warmupMs: 0, ...paths, sessionFactory: backend });
  const engine2 = createOpenWakeWordEngine({ warmupMs: 0, ...paths, sessionFactory: backend });
  await Promise.all([engine1.ready(), engine2.ready()]);

  expect(calls.length).toBe(3); // NOT 6 -- engine2 reused engine1's cached sessions
});

test('preloadOpenWakeWord resolves and warms the cache for a later createOpenWakeWordEngine using the same factory', async () => {
  const calls = [];
  const melSession = { inputNames: ['input'], outputNames: ['output'],
    run: () => Promise.resolve({ output: { data: new Float32Array(5 * 32) } }) };
  const embSession = { inputNames: ['input_1'], outputNames: ['conv2d_19'],
    run: () => Promise.resolve({ conv2d_19: { data: new Float32Array(96) } }) };
  const wakeSession = { inputNames: ['x.1'], outputNames: ['53'],
    inputMetadata: [{ name: 'x.1', isTensor: true, type: 'float32', shape: [1, 16, 96] }],
    run: () => Promise.resolve({ 53: { data: [0] } }) };
  const backend = {
    createSession: (path) => {
      calls.push(path);
      if (/mel/i.test(path)) return Promise.resolve(melSession);
      if (/embed/i.test(path)) return Promise.resolve(embSession);
      return Promise.resolve(wakeSession);
    },
    tensor: (type, data, dims) => ({ type, data, dims }),
  };

  await expect(preloadOpenWakeWord({ ...paths, sessionFactory: backend })).resolves.toBeDefined();
  expect(calls.length).toBe(3);

  // A subsequent engine creation with the SAME backend + paths must not
  // trigger any additional createSession calls -- the preload already warmed
  // the cache off the request path.
  const engine = createOpenWakeWordEngine({ warmupMs: 0, ...paths, sessionFactory: backend });
  await engine.ready();
  expect(calls.length).toBe(3);
});
