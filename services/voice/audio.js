'use strict';

const FRAME_SAMPLES_16K = 512; // audio-pipeline chunk @ 16 kHz (WakeWordGate rebuffers to the engine frame length)

/** 48 kHz stereo s16le -> 16 kHz mono s16le (stereo avg, 3-tap low-pass, 3:1 decimation). */
function downsampleTo16kMono(buf) {
  const stereoFrames = Math.floor(buf.length / 4); // 2 ch * 2 bytes
  const mono = new Int16Array(stereoFrames);
  for (let i = 0; i < stereoFrames; i++) {
    const l = buf.readInt16LE(i * 4);
    const r = buf.readInt16LE(i * 4 + 2);
    mono[i] = (l + r) >> 1;
  }
  const outLen = Math.floor(stereoFrames / 3);
  const out = Buffer.alloc(outLen * 2);
  // Average each group of 3 mono samples before decimating -- a cheap 3-tap FIR
  // low-pass that attenuates >8 kHz energy which would otherwise ALIAS into the
  // passband on the 48k->16k drop. Point-picking every 3rd sample (no filter)
  // folds sibilants / channel noise / Opus artifacts back down and hurts
  // wake-word accuracy on real, noisy channel audio (clean recordings hide it).
  for (let i = 0; i < outLen; i++) {
    const a = mono[i * 3], b = mono[i * 3 + 1], c = mono[i * 3 + 2];
    out.writeInt16LE(Math.round((a + b + c) / 3), i * 2);
  }
  return out;
}

/** 24 kHz mono s16le -> 48 kHz stereo s16le (2x linear upsample, duplicate to stereo). */
function upsample24kMonoTo48kStereo(buf) {
  const inSamples = Math.floor(buf.length / 2);
  const out = Buffer.alloc(inSamples * 2 * 2 * 2); // 2x samples, 2 channels, 2 bytes
  let w = 0;
  for (let i = 0; i < inSamples; i++) {
    const cur = buf.readInt16LE(i * 2);
    const next = i + 1 < inSamples ? buf.readInt16LE((i + 1) * 2) : cur;
    const mid = (cur + next) >> 1;
    for (const s of [cur, mid]) {
      out.writeInt16LE(s, w); out.writeInt16LE(s, w + 2); w += 4; // L,R
    }
  }
  return out;
}

module.exports = { downsampleTo16kMono, upsample24kMonoTo48kStereo, FRAME_SAMPLES_16K };
