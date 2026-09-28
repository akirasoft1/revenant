#!/usr/bin/env node
'use strict';
// Regenerates distinct-voice TTS fixtures for the multi-stream floor-control
// harness (scripts/test-floor.js). Each fixture uses a different Gemini
// prebuilt voice so two clips played "at once" sound like two different
// speakers -- faithful to production, where Discord hands the bot one
// per-speaker audio stream per user.
//
// Usage:
//   GEMINI_API_KEY=... node scripts/gen-test-voices.js
//
// Requires GEMINI_API_KEY in env (loaded from .env via dotenv if present).
// Writes 24kHz mono 16-bit WAVs to voice-fixtures/ (gitignored -- never
// commit generated audio; re-run this script to regenerate).
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

// gemini-2.5-flash-preview-tts (previous model) returned raw audio/L16 PCM;
// gemini-3.8-flash-tts returns a full audio/wav. audioToWav() handles both.
const MODEL = 'gemini-3.8-flash-tts';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const OUT_DIR = path.join(__dirname, '..', 'voice-fixtures');
const SAMPLE_RATE = 24000; // TTS output rate (both L16 and WAV responses are 24kHz mono 16-bit)

// voice -> utterance. Distinct prebuilt voices so the two clips are
// trivially distinguishable by ear when spot-checking fixtures.
const CLIPS = [
  { voice: 'Charon', file: 'charon-weather.wav', text: "Hey Jarvis, what's the weather like today?" },
  { voice: 'Kore', file: 'kore-joke.wav', text: 'Hey Jarvis, tell me a joke about robots.' },
  { voice: 'Aoede', file: 'aoede-pizza.wav', text: 'I think we should order pizza tonight.' },
  // Star Citizen knowledge voice smoke test (scripts/smoke-voice-sc.js) --
  // single speaker, wording matches the "canonical questions" in
  // agent-sidecar/eval/sc_eval_set.py plus the Scorpius ship-purchase check.
  { voice: 'Puck', file: 'sc-v801-radar.wav', text: 'Where can we purchase a V801-12 radar?' },
  { voice: 'Puck', file: 'sc-shield-size2.wav', text: 'What is the most powerful Size 2 shield generator?' },
  { voice: 'Puck', file: 'sc-foxwell-rep.wav', text: 'What is an optimal way to grind Foxwell Enforcement reputation?' },
  { voice: 'Puck', file: 'sc-mic-l5-routes.wav', text: 'What are some currently profitable trade routes from MIC-L5?' },
  { voice: 'Puck', file: 'sc-scorpius-buy.wav', text: 'Where can I buy a Scorpius?' },
  // Voice control commands smoke test (scripts/smoke-voice-control.js) --
  // single speaker. Two positive fixtures (go quiet / end conversation) and
  // one NEGATIVE fixture asserting the model does NOT fire a control tool
  // for a merely superficial phrase-lookalike ("that's all I know about X"),
  // per the Task 1 review ruling in
  // .superpowers/sdd/2026-09-27-voice-control-commands/progress.md.
  { voice: 'Puck', file: 'ctl-quiet.wav', text: 'Hey Jarvis, go quiet for two minutes.' },
  { voice: 'Puck', file: 'ctl-end.wav', text: "Thanks Jarvis, that's all." },
  { voice: 'Puck', file: 'ctl-negative.wav', text: "Hey Jarvis, that's all I know about shields, what do you think?" },
];

/** Wrap raw 16-bit PCM into a WAV (RIFF) container. */
function pcmToWav(pcmBuf, { sampleRate = SAMPLE_RATE, channels = 1, bitsPerSample = 16 } = {}) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format: 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBuf.length, 40);
  return Buffer.concat([header, pcmBuf]);
}

/**
 * Normalize a TTS response payload to a 24kHz mono 16-bit WAV.
 * Already-WAV payloads (RIFF magic) pass through; raw L16 PCM is wrapped.
 */
function audioToWav(buf, mimeType) {
  const isWav = buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
  if (isWav) {
    const rate = buf.readUInt32LE(24);
    const channels = buf.readUInt16LE(22);
    const bits = buf.readUInt16LE(34);
    if (rate !== SAMPLE_RATE || channels !== 1 || bits !== 16) {
      throw new Error(`TTS returned WAV at ${rate}Hz/${channels}ch/${bits}-bit; voice fixtures expect ${SAMPLE_RATE}Hz mono 16-bit`);
    }
    return buf;
  }
  if (mimeType && !/^audio\/L16;.*\brate=\d+/i.test(mimeType)) {
    console.warn(`  [warn] unexpected mimeType "${mimeType}" -- assuming L16 PCM`);
  }
  return pcmToWav(buf, { sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16 });
}

async function generateClip(apiKey, { voice, text }) {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '<unreadable body>');
    throw new Error(`Gemini TTS request failed (voice=${voice}): ${res.status} ${res.statusText} -- ${errText}`);
  }
  const json = await res.json();
  const part = json?.candidates?.[0]?.content?.parts?.[0];
  const inlineData = part?.inlineData;
  if (!inlineData?.data) {
    throw new Error(`Gemini TTS response missing candidates[0].content.parts[0].inlineData.data (voice=${voice}): ${JSON.stringify(json)}`);
  }
  return audioToWav(Buffer.from(inlineData.data, 'base64'), inlineData.mimeType);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('ERROR: GEMINI_API_KEY is not set. Export it or add it to .env before running this script.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Generating ${CLIPS.length} TTS fixture(s) with model ${MODEL}...`);
  for (const clip of CLIPS) {
    process.stdout.write(`  [${clip.voice}] "${clip.text}" -> voice-fixtures/${clip.file} ... `);
    try {
      const wav = await generateClip(apiKey, clip);
      const outPath = path.join(OUT_DIR, clip.file);
      fs.writeFileSync(outPath, wav);
      console.log(`done (${wav.length} bytes)`);
    } catch (err) {
      console.log('FAILED');
      console.error(err);
      process.exit(1);
    }
  }
  console.log(`\nAll fixtures written to ${OUT_DIR}/ (gitignored -- not committed).`);
}

if (require.main === module) {
  main();
}

module.exports = { MODEL, SAMPLE_RATE, pcmToWav, audioToWav };
