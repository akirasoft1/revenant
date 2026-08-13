'use strict';
const { createSileroVadEngine, VoiceActivityGate } = require('../../../services/voice/SileroVad');

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
