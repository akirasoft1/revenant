'use strict';

// REAL-AUDIO correctness gate for the openWakeWord engine: runs actual PCM
// through the REAL vendored ONNX models and asserts the mel-frontend params are
// right (a positive "hey jarvis" sample fires; a non-wake sample does not).
// This is what proves the port is numerically correct -- plumbing tests with
// fakes cannot.
//
// It is run via a spawned real `node` subprocess (scripts/wake-detect.js), NOT
// in-process: jest's VM sandbox gives test files a different Float32Array realm
// than the native onnxruntime-node addon, whose C++ tensor type-check then
// rejects the data ("must be type of Float32Array"). That is a jest artifact
// only -- the engine works correctly under a real node runtime, which is what
// this subprocess exercises. See scripts/wake-detect.js.
//
// Gated to skip (not fail) when onnxruntime-node or the model/audio fixtures are
// unavailable, so `npm test` stays green on machines without them.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const MODELS = path.join(ROOT, 'models', 'openwakeword');
const FIXTURES = path.join(ROOT, '__tests__', 'fixtures', 'voice');
const SCRIPT = path.join(ROOT, 'scripts', 'wake-detect.js');
const POS = path.join(FIXTURES, 'hey_jarvis_16k_mono.pcm');
const NEG = path.join(FIXTURES, 'negative_16k_mono.pcm');

const required = [
  path.join(MODELS, 'melspectrogram.onnx'),
  path.join(MODELS, 'embedding_model.onnx'),
  path.join(MODELS, 'hey_jarvis_v0.1.onnx'),
  POS, NEG, SCRIPT,
];
// require.resolve (not require) so we don't load the native addon's thread pool
// into this jest worker -- the real binding is exercised in the subprocess.
let ortAvailable = false;
try { require.resolve('onnxruntime-node'); ortAvailable = true; } catch { /* skip below */ }
const filesPresent = required.every((f) => fs.existsSync(f));
const runIt = ortAvailable && filesPresent ? test : test.skip;

if (!ortAvailable) console.warn('[wakeword.integration] SKIPPED: onnxruntime-node not loadable');
if (!filesPresent) console.warn('[wakeword.integration] SKIPPED: model/audio fixtures missing');

// Returns true if the detector subprocess reported DETECTED (exit 0).
function detect(pcmPath) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, pcmPath], { encoding: 'utf8' });
    return /DETECTED/.test(out) && !/NOT_DETECTED/.test(out);
  } catch (e) {
    // exit 1 == NOT_DETECTED (expected for the negative case); exit 2 == error.
    if (e.status === 1) return false;
    throw new Error(`wake-detect failed (status ${e.status}): ${e.stderr || e.message}`);
  }
}

runIt('REAL "hey jarvis" audio fires detection through the real ONNX chain', () => {
  expect(detect(POS)).toBe(true);
}, 60000);

runIt('REAL non-wake speech does NOT fire detection', () => {
  expect(detect(NEG)).toBe(false);
}, 60000);
