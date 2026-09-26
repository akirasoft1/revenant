#!/usr/bin/env node
// Summarise the voice deferral measurement logs so VOICE_DEFERRAL_MIN_SPEECH_MS
// can be set from real data instead of guessed.
//
// Background — why this script exists rather than "just read the logs":
//
// The deferral feature (Phase 4) acknowledges someone who tried to speak while
// the bot was replying. A waiter only qualifies once their speech OVERLAPPING
// the bot's own audio exceeds VOICE_DEFERRAL_MIN_SPEECH_MS. The threshold is
// the feature's only guardrail against apologising to someone who coughed.
//
// The catch: SileroVad latches `speaking: true` until VOICE_VAD_MIN_SILENCE_FRAMES
// (24 frames x 32ms = 768ms) of sub-threshold audio has passed, and the accrual
// counts every chunk while that latch is open. So the logged figure is
// "time the gate was latched open", NOT "duration of speech". Measured against
// the real gate: 64ms of voiced speech accrues ~760ms. 64ms is also the MINIMUM
// that opens the gate (VOICE_VAD_MIN_SPEECH_FRAMES = 2).
//
// Consequence: at the shipped default of 700ms the threshold rejects NOTHING.
// Any utterance the VAD detects at all clears it. This script subtracts the
// hangover so you can see roughly how much real speech each row represents.
//
// Usage:
//   node scripts/analyze-deferral-logs.js --pod            # pull from the live pod
//   node scripts/analyze-deferral-logs.js --pod --since 24h
//   node scripts/analyze-deferral-logs.js path/to/logs.txt
//   kubectl logs deploy/discord-article-bot -n discord-article-bot | node scripts/analyze-deferral-logs.js
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

// Must match VOICE_VAD_MIN_SILENCE_FRAMES (24) x 32ms window. If you retune the
// VAD, retune this — the whole point of the script is that the raw number is
// inflated by exactly this much.
const VAD_HANGOVER_MS = 768;

const LINE = /withheld speech from (.+?) in guild (\d+): (\d+)ms \((\d+)ms of this utterance overlapping bot playback, longest single utterance of this turn (\d+)ms\) while (.+?) holds the floor, bot playback=(\S+)/;

function readInput() {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => !a.startsWith('--'));
  if (args.includes('--pod')) {
    const sinceIdx = args.indexOf('--since');
    const since = sinceIdx !== -1 ? args[sinceIdx + 1] : '168h';
    process.stderr.write(`Pulling logs from the live pod (--since ${since})...\n`);
    return execFileSync('kubectl', [
      'logs', 'deployment/discord-article-bot',
      '-n', 'discord-article-bot', `--since=${since}`,
    ], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  }
  if (fileArg) return fs.readFileSync(fileArg, 'utf8');
  if (process.stdin.isTTY) {
    process.stderr.write('No input. Use --pod, pass a file, or pipe kubectl logs in.\n');
    process.exit(2);
  }
  return fs.readFileSync(0, 'utf8');
}

function parse(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    rows.push({
      speaker: m[1],
      guildId: m[2],
      withheldMs: Number(m[3]),
      utteranceOverlapMs: Number(m[4]),
      turnPeakMs: Number(m[5]),
      holder: m[6],
      playback: m[7],
    });
  }
  return rows;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function main() {
  const rows = parse(readInput());

  if (rows.length === 0) {
    console.log('\nNo withheld-speech measurement lines found.\n');
    console.log('That means no second speaker talked while someone else held the floor');
    console.log('during the window you searched. Things to check:');
    console.log('  - LOG_LEVEL must be DEBUG (this line is logger.debug)');
    console.log('  - the data only appears when 2+ people are in voice and one');
    console.log('    interjects while another holds the floor');
    console.log('  - pod restarts drop history; widen with --since, e.g. --since 168h');
    return;
  }

  // The overlap figure is the one production thresholds on. Rows where the
  // speaker never overlapped the bot's audio are real interjections into
  // SILENCE -- interesting, but not what the deferral feature is about.
  const overlapping = rows.filter((r) => r.utteranceOverlapMs > 0);
  const silent = rows.length - overlapping.length;

  console.log(`\n${'='.repeat(78)}`);
  console.log('VOICE DEFERRAL MEASUREMENT');
  console.log('='.repeat(78));
  console.log(`\n${rows.length} withheld-speech utterance(s) across ${new Set(rows.map((r) => r.speaker)).size} speaker(s).`);
  console.log(`${overlapping.length} overlapped the bot's audio (what the threshold measures).`);
  if (silent) {
    console.log(`${silent} did NOT overlap — someone talking while the bot was silent.`);
    console.log('  Those can never qualify, by design: they are not interjections.');
  }

  console.log('\n--- Per speaker ---\n');
  console.log(`${pad('speaker', 22)}${padL('rows', 5)}${padL('overlap', 9)}${padL('max', 7)}${padL('~real', 8)}`);
  console.log('-'.repeat(51));
  const bySpeaker = new Map();
  for (const r of rows) {
    if (!bySpeaker.has(r.speaker)) bySpeaker.set(r.speaker, []);
    bySpeaker.get(r.speaker).push(r);
  }
  for (const [speaker, rs] of [...bySpeaker.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const ov = rs.filter((r) => r.utteranceOverlapMs > 0);
    const max = Math.max(0, ...rs.map((r) => r.utteranceOverlapMs));
    console.log(
      pad(speaker.slice(0, 21), 22) + padL(rs.length, 5) + padL(ov.length, 9)
      + padL(`${max}ms`, 7) + padL(`${Math.max(0, max - VAD_HANGOVER_MS)}ms`, 8),
    );
  }
  console.log('\n  "~real" subtracts the ~768ms VAD hangover from the max — a rough');
  console.log('  estimate of actually-voiced speech. It is a floor, not a measurement.');

  if (overlapping.length === 0) {
    console.log('\nNo overlapping speech recorded, so there is nothing to derive a');
    console.log('threshold from yet. Get two people into voice with one interrupting');
    console.log("the bot mid-reply, then re-run.\n");
    return;
  }

  const sorted = overlapping.map((r) => r.utteranceOverlapMs).sort((a, b) => a - b);
  console.log('\n--- Overlap distribution (the figure production compares) ---\n');
  console.log(`  min ${sorted[0]}ms   p50 ${pct(sorted, 50)}ms   p90 ${pct(sorted, 90)}ms   max ${sorted[sorted.length - 1]}ms`);

  console.log('\n--- How many would trigger an acknowledgment ---\n');
  console.log(`${pad('threshold', 14)}${padL('qualify', 9)}${padL('of', 4)}${padL('%', 7)}`);
  console.log('-'.repeat(34));
  for (const t of [700, 900, 1100, 1300, 1500, 1800, 2200]) {
    const n = sorted.filter((v) => v >= t).length;
    const flag = t === 700 ? '  <- shipped default' : '';
    console.log(
      pad(`${t}ms`, 14) + padL(n, 9) + padL(sorted.length, 4)
      + padL(`${Math.round((100 * n) / sorted.length)}%`, 7) + flag,
    );
  }

  const realistic = sorted.map((v) => Math.max(0, v - VAD_HANGOVER_MS));
  const suggested = Math.max(1300, Math.round((pct(realistic, 50) + VAD_HANGOVER_MS) / 100) * 100);
  console.log('\n--- Reading this ---\n');
  console.log(`  The ~${VAD_HANGOVER_MS}ms hangover is the NOISE FLOOR of these numbers. Any`);
  console.log('  threshold at or below ~800ms is equivalent to "acknowledge on any');
  console.log('  detected speech", which defeats the guardrail entirely.');
  console.log(`\n  Suggested starting point: ${suggested}ms`);
  console.log('  (median overlap plus the hangover, floored at 1300ms.)');
  console.log('\n  Sanity-check it against the table above: you want the count at your');
  console.log('  chosen threshold to match how many of these you would actually have');
  console.log('  wanted the bot to acknowledge. If every row qualifies, it is too low.');
  console.log('\n  Then set both, restart the pod, and verify with:');
  console.log('    VOICE_DEFERRAL_MIN_SPEECH_MS=<n>   VOICE_DEFERRAL_ENABLED=true');
  console.log('    node scripts/smoke-voice-identity.js --deferral\n');
}

main();
