#!/usr/bin/env node
// scripts/prompt-tuning/run.js
// Prompt tuning tool — see docs/superpowers/specs/2026-05-16-prompt-tuning-tool-design.md
//
// Designed to run from two locations:
//   1. Local checkout: scripts/prompt-tuning/run.js — relative requires work as-is
//   2. Inside the bot pod, staged under /tmp/prompt-tuning/ — the host filesystem
//      (/usr/src/app) is read-only, so the wrapper copies us into /tmp. Set
//      BOT_APP_ROOT=/usr/src/app and we use createRequire to resolve the bot's
//      config, services, personalities, and npm modules from there.

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const APP_ROOT = process.env.BOT_APP_ROOT || path.resolve(__dirname, '..', '..');
const appRequire = createRequire(path.join(APP_ROOT, 'package.json'));

const config = appRequire('./config/config');
const { DEFAULT_OPENAI_MODEL, getTokenPricing, isReasoningModel } = appRequire('./utils/openaiModels');

function parseArgs(argv) {
  const args = { n: 20, days: 7, baseline: path.resolve(APP_ROOT, 'personalities', 'channel-voice.js') };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--candidate':
        args.candidate = path.resolve(next);
        i++;
        break;
      case '--n':
        args.n = parseInt(next, 10);
        i++;
        break;
      case '--label':
        args.label = next;
        i++;
        break;
      case '--channel':
        args.channel = next;
        i++;
        break;
      case '--days':
        args.days = parseInt(next, 10);
        i++;
        break;
      case '--baseline':
        args.baseline = path.resolve(next);
        i++;
        break;
      case '--model':
        args.model = next;
        i++;
        break;
      case '--seed':
        args.seed = parseInt(next, 10);
        i++;
        break;
      case '--help':
      case '-h':
        printHelpAndExit();
        break;
      default:
        if (flag.startsWith('--')) {
          console.error(`ERROR: unknown flag ${flag}`);
          process.exit(1);
        }
    }
  }

  if (!args.candidate) {
    console.error('ERROR: --candidate <path> is required');
    process.exit(1);
  }
  if (!fs.existsSync(args.candidate)) {
    console.error(`ERROR: candidate file not found at ${args.candidate}`);
    process.exit(1);
  }
  if (!fs.existsSync(args.baseline)) {
    console.error(`ERROR: baseline file not found at ${args.baseline}`);
    process.exit(1);
  }
  if (!args.label) {
    args.label = path.basename(args.candidate, path.extname(args.candidate));
  }
  if (!args.model) {
    args.model = config.openai?.model || DEFAULT_OPENAI_MODEL;
  }
  if (!Number.isFinite(args.n) || args.n <= 0) {
    console.error('ERROR: --n must be a positive integer');
    process.exit(1);
  }
  if (!Number.isFinite(args.days) || args.days <= 0) {
    console.error('ERROR: --days must be a positive integer');
    process.exit(1);
  }
  return args;
}

function printHelpAndExit() {
  console.log(`Usage: node scripts/prompt-tuning/run.js --candidate <path> [--n N] [--label LABEL] [--channel ID] [--days D] [--baseline PATH] [--model NAME] [--seed N]

Replays the last --n user messages from MongoDB against the candidate AND baseline
systemPrompt templates, then writes a markdown side-by-side comparison report.

See docs/superpowers/specs/2026-05-16-prompt-tuning-tool-design.md for the full spec.`);
  process.exit(0);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!config.openai?.apiKey) {
    console.error('ERROR: OPENAI_API_KEY is not set');
    process.exit(1);
  }
  if (!config.mongo?.uri) {
    console.error('ERROR: MONGO_URI is not set');
    process.exit(1);
  }
  console.log('Args:', { ...args, candidate: path.basename(args.candidate), baseline: path.basename(args.baseline) });

  const candidateModule = require(args.candidate);
  const baselineModule = require(args.baseline);

  for (const [name, mod] of [['candidate', candidateModule], ['baseline', baselineModule]]) {
    if (!mod || typeof mod.systemPrompt !== 'string') {
      console.error(`ERROR: ${name} (${name === 'candidate' ? args.candidate : args.baseline}) must export a personality module with a 'systemPrompt' string field`);
      process.exit(1);
    }
    if (!mod.systemPrompt.includes('{VOICE_INSTRUCTIONS}')) {
      console.warn(`WARN: ${name} systemPrompt does not contain {VOICE_INSTRUCTIONS} — voice profile will not be substituted`);
    }
  }

  const MongoService = appRequire('./services/MongoService');
  const mongoService = new MongoService(config.mongo.uri);
  await mongoService.connect();

  let voiceProfile;
  try {
    const collection = mongoService.db.collection('voice_profiles');
    voiceProfile = await collection.findOne({}, { sort: { version: -1 } });
  } catch (err) {
    console.warn(`WARN: failed to load voice_profiles: ${err.message}`);
  }

  let voiceInstructions = '[no voice profile available]';
  let voiceProfileMeta = { version: null, generatedAt: null };
  if (voiceProfile?.voiceInstructions) {
    voiceInstructions = voiceProfile.voiceInstructions;
    voiceProfileMeta = { version: voiceProfile.version, generatedAt: voiceProfile.generatedAt };
    console.log(`Loaded voice profile v${voiceProfile.version} (generated ${voiceProfile.generatedAt})`);
  } else {
    console.warn('WARN: no voice profile found in MongoDB — using stub placeholder');
  }

  console.log('voiceInstructions length:', voiceInstructions.length);

  // Sample input messages
  const messagesCollection = mongoService.db.collection('channel_messages');
  const sinceMs = Date.now() - (args.days * 24 * 60 * 60 * 1000);
  const sinceDate = new Date(sinceMs);

  const botUserId = config.discord?.clientId;
  if (!botUserId) {
    console.warn('WARN: config.discord.clientId is not set — bot replies will not be filtered out of the sample');
  }

  const filter = {
    timestamp: { $gte: sinceDate },
    content: { $exists: true, $type: 'string', $not: /^\/\w/ } // reject slash-command invocations
  };
  if (botUserId) {
    filter.authorId = { $ne: botUserId };
  }
  if (args.channel) {
    filter.channelId = args.channel;
  }

  const sampled = await messagesCollection
    .find(filter, { projection: { content: 1, authorId: 1, authorName: 1, channelId: 1, timestamp: 1 } })
    .sort({ timestamp: -1 })
    .limit(args.n)
    .toArray();

  if (sampled.length === 0) {
    const where = args.channel ? ` in channel ${args.channel}` : '';
    console.error(`ERROR: no eligible messages found for last ${args.days} days${where}`);
    await mongoService.client.close();
    process.exit(1);
  }

  // Reverse so report shows oldest first (more natural reading order)
  sampled.reverse();
  console.log(`Sampled ${sampled.length} messages`);

  // Pre-flight cost estimate (rough): assume ~300 tokens in (system) + ~50 tokens out per call
  const ESTIMATED_IN_PER_CALL = 600;   // system+user; conservative
  const ESTIMATED_OUT_PER_CALL = 100;  // response; conservative
  // Per-1M-token rates from the shared table (unknown models -> default model's rate)
  const pricingPre = getTokenPricing(args.model);
  const rate_pre = { in: pricingPre.input * 1_000_000, out: pricingPre.output * 1_000_000 };
  const callsTotal = sampled.length * 2;
  const estCost = ((ESTIMATED_IN_PER_CALL * rate_pre.in) + (ESTIMATED_OUT_PER_CALL * rate_pre.out)) / 1_000_000 * callsTotal;
  console.log(`Estimated cost: $${estCost.toFixed(4)} for ${callsTotal} OpenAI calls`);

  if (estCost > 1 && process.env.PROMPT_TUNING_CONFIRM_COST !== '1') {
    console.error(`ERROR: estimated cost $${estCost.toFixed(4)} exceeds $1 guardrail. Re-run with PROMPT_TUNING_CONFIRM_COST=1 to proceed.`);
    process.exit(1);
  }

  await mongoService.client.close();
  const OpenAI = appRequire('openai');
  const openai = new OpenAI({ apiKey: config.openai.apiKey });

  const baselineSystem = baselineModule.systemPrompt.replace('{VOICE_INSTRUCTIONS}', voiceInstructions);
  const candidateSystem = candidateModule.systemPrompt.replace('{VOICE_INSTRUCTIONS}', voiceInstructions);

  async function callOnce(systemPrompt, userContent) {
    try {
      const params = {
        model: args.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ]
      };
      if (typeof args.seed === 'number') params.seed = args.seed;
      // Mirror the bot's direct-OpenAI chat effort (gpt-6-* are reasoning models)
      if (isReasoningModel(args.model) && config.openai?.reasoningEffort) params.reasoning_effort = config.openai.reasoningEffort;
      const resp = await openai.chat.completions.create(params);
      return {
        ok: true,
        text: resp.choices?.[0]?.message?.content || '',
        usage: resp.usage || null
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  // Batch with concurrency 4
  const BATCH = 4;
  const results = new Array(sampled.length);
  let completed = 0;
  for (let i = 0; i < sampled.length; i += BATCH) {
    const slice = sampled.slice(i, i + BATCH);
    const sliceResults = await Promise.all(slice.map(async (msg) => {
      const [base, cand] = await Promise.all([
        callOnce(baselineSystem, msg.content),
        callOnce(candidateSystem, msg.content)
      ]);
      return { msg, baseline: base, candidate: cand };
    }));
    sliceResults.forEach((r, j) => {
      results[i + j] = r;
      completed++;
      console.log(`[${completed}/${sampled.length}] case complete`);
    });
  }

  // Compute diff summary
  const sumLen = (r) => (r.ok ? r.text.length : 0);
  const sumTokens = (r) => (r.ok && r.usage?.completion_tokens) || 0;
  const totalBaseLen = results.reduce((s, r) => s + sumLen(r.baseline), 0);
  const totalCandLen = results.reduce((s, r) => s + sumLen(r.candidate), 0);
  const totalBaseTokens = results.reduce((s, r) => s + sumTokens(r.baseline), 0);
  const totalCandTokens = results.reduce((s, r) => s + sumTokens(r.candidate), 0);
  const exactMatches = results.filter((r) => r.baseline.ok && r.candidate.ok && r.baseline.text === r.candidate.text).length;
  const avgBaseLen = Math.round(totalBaseLen / results.length);
  const avgCandLen = Math.round(totalCandLen / results.length);
  const lenDelta = avgBaseLen > 0 ? Math.round(((avgCandLen - avgBaseLen) / avgBaseLen) * 100) : 0;

  // Rough cost: model.pricing × tokens, per-1M rates from the shared table.
  const pricing = getTokenPricing(args.model);
  const rate = { in: pricing.input * 1_000_000, out: pricing.output * 1_000_000 };
  const totalBaseIn = results.reduce((s, r) => s + ((r.baseline.ok && r.baseline.usage?.prompt_tokens) || 0), 0);
  const totalCandIn = results.reduce((s, r) => s + ((r.candidate.ok && r.candidate.usage?.prompt_tokens) || 0), 0);
  const baseCost = ((totalBaseIn * rate.in) + (totalBaseTokens * rate.out)) / 1_000_000;
  const candCost = ((totalCandIn * rate.in) + (totalCandTokens * rate.out)) / 1_000_000;

  // Build report
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const reportPath = path.join(__dirname, 'runs', `${stamp}-${args.label}.md`);

  const lines = [];
  lines.push(`# Prompt tuning run: ${args.label}`);
  lines.push('');
  lines.push(`**Date:** ${now.toISOString().replace('T', ' ').slice(0, 16)} UTC`);
  lines.push(`**Candidate:** \`${path.relative(path.join(__dirname, '..', '..'), args.candidate)}\``);
  lines.push(`**Baseline:** \`${path.relative(path.join(__dirname, '..', '..'), args.baseline)}\``);
  lines.push(`**Model:** ${args.model}`);
  if (voiceProfileMeta.version != null) {
    lines.push(`**Voice profile:** v${voiceProfileMeta.version} (generated ${voiceProfileMeta.generatedAt})`);
  } else {
    lines.push(`**Voice profile:** none (stub placeholder used)`);
  }
  const where = args.channel ? `, channel ${args.channel}` : '';
  lines.push(`**Sampled:** ${results.length} user messages from last ${args.days} days${where}`);
  lines.push(`**Seed:** ${args.seed != null ? args.seed : 'none'}`);
  lines.push(`**Cost:** $${baseCost.toFixed(4)} baseline + $${candCost.toFixed(4)} candidate = $${(baseCost + candCost).toFixed(4)} total`);
  lines.push('');
  lines.push('## Diff summary');
  lines.push(`- Avg response length: baseline ${avgBaseLen} chars, candidate ${avgCandLen} chars (${lenDelta >= 0 ? '+' : ''}${lenDelta}%)`);
  lines.push(`- Tokens per response: baseline avg ${Math.round(totalBaseTokens / results.length)}, candidate avg ${Math.round(totalCandTokens / results.length)}`);
  lines.push(`- Exact-match (same wording): ${exactMatches} / ${results.length}`);
  lines.push('');
  lines.push('## Per-case results');
  lines.push('');

  results.forEach((r, idx) => {
    const channelLabel = r.msg.channelId || 'unknown-channel';
    const author = r.msg.authorName || r.msg.authorId || 'unknown';
    lines.push(`### Case ${idx + 1}`);
    lines.push(`**Channel:** #${channelLabel} (${author})`);
    lines.push('**User input:**');
    r.msg.content.split('\n').forEach((line) => lines.push(`> ${line}`));
    lines.push('');
    lines.push('**Baseline response:**');
    const baselineText = r.baseline.ok ? r.baseline.text : `[OPENAI ERROR: ${r.baseline.error}]`;
    baselineText.split('\n').forEach((line) => lines.push(`> ${line}`));
    lines.push('');
    lines.push('**Candidate response:**');
    const candidateText = r.candidate.ok ? r.candidate.text : `[OPENAI ERROR: ${r.candidate.error}]`;
    candidateText.split('\n').forEach((line) => lines.push(`> ${line}`));
    lines.push('');
    lines.push('---');
  });

  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`\nReport written: ${reportPath}`);
  console.log(`Total cost: $${(baseCost + candCost).toFixed(4)}`);
}

main().catch((err) => {
  console.error('FATAL:', err.stack || err);
  process.exit(1);
});
