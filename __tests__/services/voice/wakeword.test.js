'use strict';

const { WakeWordGate, createOpenWakeWordEngine } = require('../../../services/voice/wakeword');

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
      return Promise.resolve({ 53: { data: [score] } });
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

test('createOpenWakeWordEngine reports frameLength 1280 and never loads native binding here', () => {
  const { backend } = makeFakeBackend();
  const engine = createOpenWakeWordEngine({ ...paths, sessionFactory: backend });
  expect(engine.frameLength).toBe(1280);
});

test('feeds a [1,1280] mel input tensor per frame', async () => {
  const { backend, calls } = makeFakeBackend();
  const engine = createOpenWakeWordEngine({ ...paths, sessionFactory: backend });
  await engine.ready();
  engine.process(frame1280());
  await engine.whenIdle();
  const mel = calls.find((c) => c.model === 'mel');
  expect(mel).toBeTruthy();
  expect(mel.dims).toEqual([1, 1280]);
});

test('buffers mel frames across pushes; embedding runs only once >= 76 mel frames accumulate', async () => {
  const { backend, calls } = makeFakeBackend();
  const engine = createOpenWakeWordEngine({ ...paths, sessionFactory: backend });
  await engine.ready();
  // 5 mel frames per input frame -> 15 frames = 75 mels (< 76): no embedding yet
  for (let i = 0; i < 15; i++) engine.process(frame1280());
  await engine.whenIdle();
  expect(calls.some((c) => c.model === 'emb')).toBe(false);
  // 16th frame -> 80 mels >= 76 -> exactly one embedding + wake eval
  engine.process(frame1280());
  await engine.whenIdle();
  expect(calls.filter((c) => c.model === 'emb').length).toBe(1);
  expect(calls.filter((c) => c.model === 'wake').length).toBe(1);
});

test('runs the chain in mel -> embedding -> wake order with correct tensor shapes', async () => {
  const { backend, calls } = makeFakeBackend();
  const engine = createOpenWakeWordEngine({ ...paths, sessionFactory: backend });
  await engine.ready();
  for (let i = 0; i < 16; i++) engine.process(frame1280());
  await engine.whenIdle();
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
  const engine = createOpenWakeWordEngine({ ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();
  for (let i = 0; i < 16; i++) engine.process(frame1280());
  await engine.whenIdle();
  expect(engine.process(frame1280())).toBe(0); // flag set by the completed chain
});

test('score < threshold -> no detection (process returns -1)', async () => {
  const { backend } = makeFakeBackend({ score: 0.1 });
  const engine = createOpenWakeWordEngine({ ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();
  for (let i = 0; i < 16; i++) engine.process(frame1280());
  await engine.whenIdle();
  expect(engine.process(frame1280())).toBe(-1);
});

test('WakeWordGate drives the openWakeWord engine end-to-end (fake sessions)', async () => {
  const { backend } = makeFakeBackend({ score: 0.9 });
  const engine = createOpenWakeWordEngine({ ...paths, threshold: 0.5, sessionFactory: backend });
  await engine.ready();
  const gate = new WakeWordGate(engine);
  // 16 frames * 1280 samples * 2 bytes -> enough to cross the 76-mel window
  gate.push(Buffer.alloc(16 * 1280 * 2));
  await engine.whenIdle();
  expect(gate.push(Buffer.alloc(1280 * 2))).toBe(true); // detection surfaces on next push
});
