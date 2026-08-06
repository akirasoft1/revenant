'use strict';

const { WakeWordGate } = require('../../../services/voice/wakeword');

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
