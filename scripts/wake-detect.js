#!/usr/bin/env node
'use strict';

// Offline openWakeWord detector: runs the REAL vendored ONNX chain over a raw
// 16 kHz mono s16le PCM file and reports whether the wake phrase fired. Used
// by the integration test (spawned in a real node process to avoid jest's
// typed-array realm mismatch with the native onnxruntime addon) and handy for
// manual verification.
//
//   node scripts/wake-detect.js <path-to-16k-mono-s16le.pcm> [threshold]
//
// Prints "score=<max> DETECTED" or "score=<max> NOT_DETECTED" and exits 0 if
// the phrase was detected, 1 if not, 2 on error.

const fs = require('fs');
const path = require('path');
const { WakeWordGate, createOpenWakeWordEngine } = require('../services/voice/wakeword');

async function main() {
  const pcmPath = process.argv[2];
  const threshold = parseFloat(process.argv[3] || '0.5');
  if (!pcmPath) { console.error('usage: wake-detect.js <pcm> [threshold]'); process.exit(2); }

  const models = path.join(__dirname, '..', 'models', 'openwakeword');
  const engine = createOpenWakeWordEngine({
    wakeModelPath: path.join(models, 'hey_jarvis_v0.1.onnx'),
    melModelPath: path.join(models, 'melspectrogram.onnx'),
    embeddingModelPath: path.join(models, 'embedding_model.onnx'),
    threshold,
  });
  await engine.ready();

  // Pad with 1 s silence either side so the ~1 s utterance sits inside the
  // wake model's ~2 s (16-embedding) context window.
  const raw = fs.readFileSync(pcmPath);
  const n = Math.floor(raw.length / 2);
  const pad = 16000;
  const pcm = Buffer.alloc((pad * 2) + (n * 2) + (pad * 2));
  raw.copy(pcm, pad * 2, 0, n * 2);

  const gate = new WakeWordGate(engine);
  let detected = false;
  const chunk = 1280; // bytes (640 samples) -> exercise gate rebuffering
  for (let off = 0; off < pcm.length; off += chunk) {
    if (gate.push(pcm.subarray(off, Math.min(off + chunk, pcm.length)))) detected = true;
    await engine.whenIdle(); // drain the async ONNX pipeline
  }
  for (let k = 0; k < 4 && !detected; k++) {           // flush trailing detection flag
    if (gate.push(Buffer.alloc(1280))) detected = true;
    await engine.whenIdle();
  }
  if (engine.lastError()) { console.error('engine error:', engine.lastError().message); process.exit(2); }
  console.log(detected ? 'DETECTED' : 'NOT_DETECTED');
  process.exit(detected ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
