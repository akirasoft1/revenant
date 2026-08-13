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
