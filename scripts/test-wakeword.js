#!/usr/bin/env node
'use strict';
// Offline wake-word tester: feed a real audio file through the actual
// openWakeWord engine (no Discord, no frame-dropping) and report the peak score.
//
// Usage: node scripts/test-wakeword.js [audioFile] [threshold]
//   audioFile  path to any ffmpeg-decodable file (default: Recording.m4a)
//   threshold  wake threshold to report against (default: 0.5)
//
// It runs TWO paths so we can localize a wake failure:
//   (A) clean 16 kHz mono  -> engine            (tests the model itself)
//   (B) 48 kHz stereo -> downsampleTo16kMono -> engine  (tests OUR audio path)
// Frames are fed contiguously, awaiting each inference (whenIdle) so NOTHING is
// dropped -- the opposite of the production burst-drop bug under investigation.

const { execFileSync } = require('child_process');
const path = require('path');
const { createOpenWakeWordEngine } = require('../services/voice/wakeword');
const { downsampleTo16kMono } = require('../services/voice/audio');

const FRAME = 1280; // engine frame length (samples @ 16 kHz)
const audioFile = process.argv[2] || path.join(__dirname, '..', 'Recording.m4a');
const threshold = parseFloat(process.argv[3] || '0.5');
const models = path.join(__dirname, '..', 'models', 'openwakeword');
const paths = {
  wakeModelPath: path.join(models, 'hey_jarvis_v0.1.onnx'),
  melModelPath: path.join(models, 'melspectrogram.onnx'),
  embeddingModelPath: path.join(models, 'embedding_model.onnx'),
};

function decode(file, { rate, channels }) {
  // -> raw signed-16-bit little-endian PCM on stdout
  const out = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-ac', String(channels), '-ar', String(rate),
    '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
  ], { maxBuffer: 1 << 28 });
  return out;
}

function pcmStats(buf) {
  let peak = 0, sum = 0, n = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) { const s = Math.abs(buf.readInt16LE(i)); if (s > peak) peak = s; sum += s; n++; }
  return { peak, meanAbs: n ? Math.round(sum / n) : 0, samples: n };
}

async function runEngine(label, pcm16Buf) {
  const engine = createOpenWakeWordEngine({ ...paths, threshold });
  await engine.ready();
  const total = Math.floor(pcm16Buf.length / 2);
  const nFrames = Math.floor(total / FRAME);
  let fired = false, fireFrame = -1;
  for (let f = 0; f < nFrames; f++) {
    const frame = new Int16Array(FRAME);
    for (let i = 0; i < FRAME; i++) frame[i] = pcm16Buf.readInt16LE((f * FRAME + i) * 2);
    if (engine.process(frame) === 0 && !fired) { fired = true; fireFrame = f; }
    await engine.whenIdle(); // process every frame fully -- no drops
  }
  // whenIdle may lag the last inference by a tick; give it one more chance.
  await engine.whenIdle();
  const peakScore = engine.lastScore();
  const err = engine.lastError && engine.lastError();
  console.log(`\n[${label}]`);
  console.log(`  frames fed:        ${nFrames} (${(nFrames * FRAME / 16000).toFixed(2)}s @16k)`);
  console.log(`  peak wake score:   ${peakScore}`);
  console.log(`  fires @${threshold}?     ${peakScore >= threshold ? `YES (frame ${fireFrame})` : 'no'}`);
  if (err) console.log(`  engine error:      ${err.message}`);
}

(async () => {
  console.log(`audio: ${audioFile}\nthreshold: ${threshold}`);

  const pcm16 = decode(audioFile, { rate: 16000, channels: 1 });
  const s16 = pcmStats(pcm16);
  console.log(`\n16k mono: ${(s16.samples / 16000).toFixed(2)}s, peak ${s16.peak}/32767, meanAbs ${s16.meanAbs}`);
  await runEngine('A: clean 16k -> engine', pcm16);

  const pcm48 = decode(audioFile, { rate: 48000, channels: 2 });
  const down = downsampleTo16kMono(pcm48);
  const sd = pcmStats(down);
  console.log(`\n48k stereo -> downsampleTo16kMono: ${(sd.samples / 16000).toFixed(2)}s, peak ${sd.peak}/32767, meanAbs ${sd.meanAbs}`);
  await runEngine('B: 48k -> our downsample -> engine', down);
})().catch((e) => { console.error(e); process.exit(1); });
