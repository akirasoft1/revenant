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

function createPorcupineEngine({ accessKey, keyword, sensitivity = 0.5 }) {
  // Lazy require so unit tests never load the native binding.
  const { Porcupine, BuiltinKeyword } = require('@picovoice/porcupine-node');
  const kw = BuiltinKeyword[keyword] !== undefined ? BuiltinKeyword[keyword] : keyword;
  return new Porcupine(accessKey, [kw], [sensitivity]);
}

module.exports = { WakeWordGate, createPorcupineEngine };
