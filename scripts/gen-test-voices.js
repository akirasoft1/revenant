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

const MODEL = 'gemini-2.5-flash-preview-tts';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const OUT_DIR = path.join(__dirname, '..', 'voice-fixtures');
const SAMPLE_RATE = 24000; // matches audio/L16;rate=24000 returned by the TTS endpoint

// voice -> utterance. Distinct prebuilt voices so the two clips are
// trivially distinguishable by ear when spot-checking fixtures.
const CLIPS = [
  { voice: 'Charon', file: 'charon-weather.wav', text: "Hey Jarvis, what's the weather like today?" },
  { voice: 'Kore', file: 'kore-joke.wav', text: 'Hey Jarvis, tell me a joke about robots.' },
  { voice: 'Aoede', file: 'aoede-pizza.wav', text: 'I think we should order pizza tonight.' },
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
  if (inlineData.mimeType && !/^audio\/L16;.*\brate=\d+/i.test(inlineData.mimeType)) {
    console.warn(`  [warn] unexpected mimeType "${inlineData.mimeType}" for voice=${voice} -- assuming L16 PCM anyway`);
  }
  return Buffer.from(inlineData.data, 'base64');
}

(async () => {
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
      const pcm = await generateClip(apiKey, clip);
      const wav = pcmToWav(pcm, { sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16 });
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
})();
