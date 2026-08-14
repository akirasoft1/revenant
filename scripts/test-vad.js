#!/usr/bin/env node
'use strict';
// Offline Silero VAD tester: feed a real file through the ACTUAL engine+gate
// (no Discord) and print the speech timeline. Usage:
//   node scripts/test-vad.js [audioFile] [threshold]
const { execFileSync } = require('child_process');
const path = require('path');
const { createSileroVadEngine, VoiceActivityGate, WINDOW } = require('../services/voice/SileroVad');
const { downsampleTo16kMono } = require('../services/voice/audio');

const audioFile = process.argv[2] || path.join(__dirname, '..', 'Recording.m4a');
const threshold = parseFloat(process.argv[3] || '0.5');
const modelPath = path.join(__dirname, '..', 'models', 'silero', 'silero_vad.onnx');

function decode(file, { rate, channels }) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', String(channels),
    '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { maxBuffer: 1 << 28 });
}

async function run(label, pcm16Buf) {
  const gate = new VoiceActivityGate(createSileroVadEngine({ modelPath }),
    { threshold, minSpeechFrames: 2, minSilenceFrames: 24 });
  await gate._engine.ready();
  const bytesPerWindow = WINDOW * 2;
  let ms = 0;
  console.log(`\n[${label}] threshold=${threshold}`);
  for (let off = 0; off + bytesPerWindow <= pcm16Buf.length; off += bytesPerWindow) {
    const r = gate.push(pcm16Buf.subarray(off, off + bytesPerWindow));
    await gate._engine.whenIdle();
    ms += 32;
    if (r.justStarted) console.log(`  ${ms}ms  SPEECH START  (p=${gate.lastProb().toFixed(2)})`);
    if (r.justEnded) console.log(`  ${ms}ms  speech end    (p=${gate.lastProb().toFixed(2)})`);
  }
}

(async () => {
  await run('A: clean 16k mono', decode(audioFile, { rate: 16000, channels: 1 }));
  await run('B: 48k stereo -> downsampleTo16kMono', downsampleTo16kMono(decode(audioFile, { rate: 48000, channels: 2 })));
})().catch((e) => { console.error(e); process.exit(1); });
