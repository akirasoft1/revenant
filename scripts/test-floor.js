#!/usr/bin/env node
'use strict';
// Offline multi-stream floor-control tester: feed TWO independent PCM
// streams through TWO real VoiceActivityGate instances + one shared
// FloorControl, and print who holds the floor and who gets withheld.
// Mirrors scripts/test-vad.js (single-stream Silero harness) but drives
// FloorControl arbitration with two streams -- faithful to production,
// where Discord hands the bot one per-speaker audio stream per user.
//
// Usage:
//   node scripts/test-floor.js [fileA] [fileB] [threshold]
//
// With no args, looks for two generated fixtures in voice-fixtures/
// (see scripts/gen-test-voices.js). If fixtures are missing (e.g. no
// GEMINI_API_KEY was available to generate them), falls back to two
// synthesized PCM buffers (loud "speech" bursts vs. silence) so the floor
// timeline still prints and the FloorControl/gate coordination logic is
// still exercised end-to-end.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createSileroVadEngine, VoiceActivityGate, WINDOW } = require('../services/voice/SileroVad');
const FloorControl = require('../services/voice/FloorControl');

const FIXTURE_DIR = path.join(__dirname, '..', 'voice-fixtures');
const modelPath = path.join(__dirname, '..', 'models', 'silero', 'silero_vad.onnx');
const BYTES_PER_WINDOW = WINDOW * 2;
const SAMPLE_RATE = 16000;

function decode16kMono(file) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1',
    '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { maxBuffer: 1 << 28 });
}

/** Silence-pad the front of a PCM buffer by `ms` milliseconds, so two clips
 * played on the same clock overlap instead of playing back-to-back. */
function padFront(buf, ms) {
  const padSamples = Math.round((ms / 1000) * SAMPLE_RATE);
  return Buffer.concat([Buffer.alloc(padSamples * 2), buf]);
}

// --- Synthetic fallback -----------------------------------------------
// A tiny energy-based "VAD" used ONLY when no real TTS fixtures are
// available. Real Silero is a trained speech model -- synthetic tone/noise
// bursts do NOT register as speech to it (verified empirically), so a
// synthetic run needs its own acoustic stand-in. It implements the exact
// engine interface VoiceActivityGate expects (process/whenIdle/lastProb/
// reset), so the SAME VoiceActivityGate + FloorControl coordination logic
// under test still runs unmodified -- only the acoustic model is fake.
function createEnergyMockEngine() {
  let lastProb = -1;
  return {
    window: WINDOW,
    ready: async () => {},
    process(int16Frame) {
      let sumSq = 0;
      for (let i = 0; i < int16Frame.length; i++) sumSq += int16Frame[i] * int16Frame[i];
      const rms = Math.sqrt(sumSq / int16Frame.length);
      lastProb = Math.min(1, rms / 6000); // loud synthetic "speech" bursts ~= 8000 amplitude -> prob ~1.0
      return lastProb;
    },
    whenIdle: async () => {},
    lastProb: () => lastProb,
    reset() { lastProb = -1; },
  };
}

/** Build a synthetic PCM buffer: alternating loud "speech" bursts and silence. */
function synthUtterance({ burstsMs = [[300, 900], [1200, 1800]], totalMs = 2200, amplitude = 8000, freq = 220 }) {
  const totalSamples = Math.round((totalMs / 1000) * SAMPLE_RATE);
  const buf = Buffer.alloc(totalSamples * 2);
  const inBurst = (ms) => burstsMs.some(([start, end]) => ms >= start && ms < end);
  for (let i = 0; i < totalSamples; i++) {
    const ms = (i / SAMPLE_RATE) * 1000;
    let v = 0;
    if (inBurst(ms)) v = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE));
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

async function run(threshold) {
  const argA = process.argv[2];
  const argB = process.argv[3];
  const thresholdArg = parseFloat(process.argv[4] || String(threshold));

  let fileA = argA;
  let fileB = argB;
  if (!fileA || !fileB) {
    const fixtures = fs.existsSync(FIXTURE_DIR)
      ? fs.readdirSync(FIXTURE_DIR).filter((f) => f.toLowerCase().endsWith('.wav')).sort()
      : [];
    if (fixtures.length >= 2) {
      fileA = fileA || path.join(FIXTURE_DIR, fixtures[0]);
      fileB = fileB || path.join(FIXTURE_DIR, fixtures[1]);
    }
  }

  let pcmA, pcmB, engineA, engineB, sourceLabel;
  const OFFSET_MS = 700; // stagger B so its speech lands mid-way through A's -> overlap

  if (fileA && fileB && fs.existsSync(fileA) && fs.existsSync(fileB)) {
    sourceLabel = `real fixtures (${path.basename(fileA)} / ${path.basename(fileB)}), Silero VAD, threshold=${thresholdArg}`;
    pcmA = decode16kMono(fileA);
    pcmB = padFront(decode16kMono(fileB), OFFSET_MS);
    engineA = createSileroVadEngine({ modelPath });
    engineB = createSileroVadEngine({ modelPath });
    await Promise.all([engineA.ready(), engineB.ready()]);
  } else {
    sourceLabel = 'synthesized PCM (no voice-fixtures found -- run scripts/gen-test-voices.js with GEMINI_API_KEY to use real audio), energy-based mock VAD';
    // Leave >=1s of trailing silence after each burst so minSilenceFrames
    // (24 windows * 32ms = 768ms) has room to fire a justEnded before the
    // buffer runs out.
    pcmA = synthUtterance({ burstsMs: [[200, 1400]], totalMs: 2800, freq: 220 });
    pcmB = padFront(synthUtterance({ burstsMs: [[300, 1600]], totalMs: 2800, freq: 330 }), OFFSET_MS);
    engineA = createEnergyMockEngine();
    engineB = createEnergyMockEngine();
  }

  const gateA = new VoiceActivityGate(engineA, { threshold: thresholdArg, minSpeechFrames: 2, minSilenceFrames: 24 });
  const gateB = new VoiceActivityGate(engineB, { threshold: thresholdArg, minSpeechFrames: 2, minSilenceFrames: 24 });
  const floor = new FloorControl();

  console.log(`\n[floor timeline] source: ${sourceLabel}\n`);

  const stateStr = () => `(holder=${floor.holder() || 'none'}, waiting=[${floor.waiting().join(',')}])`;

  function handleEvent(speaker, r) {
    if (r.justStarted) {
      const got = floor.grant(speaker);
      if (got) {
        console.log(`  SPEAKER ${speaker} START -> floor=${floor.holder()}  ${stateStr()}`);
      } else {
        floor.noteWaiting(speaker);
        console.log(`  SPEAKER ${speaker} START -> withheld (waiting)  ${stateStr()}`);
      }
    }
    if (r.justEnded) {
      if (floor.isHolder(speaker)) {
        floor.release();
        console.log(`  SPEAKER ${speaker} END   -> floor released  ${stateStr()}`);
      } else {
        // FloorControl exposes no "un-wait" API (by design -- waiting is a
        // durable signal for a future handoff phase, not cleared just
        // because the waiter briefly went quiet). Just log it here.
        console.log(`  SPEAKER ${speaker} END   -> (was waiting, still queued)  ${stateStr()}`);
      }
    }
  }

  const maxLen = Math.max(pcmA.length, pcmB.length);
  let ms = 0;
  for (let off = 0; off < maxLen; off += BYTES_PER_WINDOW) {
    ms += 32; // WINDOW=512 samples @ 16kHz = 32ms per window

    if (off + BYTES_PER_WINDOW <= pcmA.length) {
      const rA = gateA.push(pcmA.subarray(off, off + BYTES_PER_WINDOW));
      await engineA.whenIdle();
      if (rA.justStarted || rA.justEnded) { process.stdout.write(`${ms}ms `); handleEvent('A', rA); }
    }
    if (off + BYTES_PER_WINDOW <= pcmB.length) {
      const rB = gateB.push(pcmB.subarray(off, off + BYTES_PER_WINDOW));
      await engineB.whenIdle();
      if (rB.justStarted || rB.justEnded) { process.stdout.write(`${ms}ms `); handleEvent('B', rB); }
    }
  }

  console.log(`\nfinal state: ${stateStr()}`);
}

run(0.5).catch((e) => { console.error(e); process.exit(1); });
