#!/usr/bin/env node
/*
 * review-recall-shadows.js
 *
 * Quick CLI to review the recall A/B shadow log (`recall_comparisons`).
 * For each recorded turn it shows the query, the OLD (legacy) memory block,
 * the NEW (v2 ranked) block, and a content delta (items only-in-new /
 * only-in-old / shared), plus a roll-up summary across the sample.
 *
 * READ-ONLY. Never writes.
 *
 * Connection: reads process.env.MONGO_URI. Collections live in the `discord`
 * database (MongoService uses client.db('discord') regardless of the URI
 * path), so we target `discord` by default — override with RECALL_DB.
 *
 * Usage:
 *   # one-time: forward the in-cluster mongo and build a URI with the real password
 *   kubectl port-forward svc/mongodb 27017:27017 -n discord-article-bot &
 *   PW=$(kubectl get secret discord-article-bot-secrets -n discord-article-bot \
 *         -o jsonpath='{.data.MONGO_PASSWORD}' | base64 -d)
 *   export MONGO_URI="mongodb://admin:${PW}@localhost:27017/discord-bot?authSource=admin"
 *
 *   node scripts/review-recall-shadows.js                 # latest 10
 *   node scripts/review-recall-shadows.js --limit 25
 *   node scripts/review-recall-shadows.js --channel 1381989568185765908
 *   node scripts/review-recall-shadows.js --full          # show full blocks (no truncation)
 */

const { MongoClient } = require('mongodb');

function parseArgs(argv) {
  const opts = { limit: 10, channel: null, full: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') opts.limit = parseInt(argv[++i], 10) || opts.limit;
    else if (a === '--channel') opts.channel = argv[++i];
    else if (a === '--full') opts.full = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

// Extract comparable items from a memory block, stripping list/tag prefixes so
// legacy "- fact" lines and v2 "[tag] fact" lines compare on content.
function items(block) {
  return String(block || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('##') && !/^relevant things you remember/i.test(l) && !/^things you remember/i.test(l))
    .map((l) => l.replace(/^- /, '').replace(/^\[[^\]]*\]\s*/, '').trim().toLowerCase())
    .filter(Boolean);
}

function delta(oldBlock, newBlock) {
  const o = new Set(items(oldBlock));
  const n = new Set(items(newBlock));
  const onlyNew = [...n].filter((x) => !o.has(x));
  const onlyOld = [...o].filter((x) => !n.has(x));
  const shared = [...n].filter((x) => o.has(x));
  return { onlyNew, onlyOld, shared, oldCount: o.size, newCount: n.size };
}

function trunc(block, full) {
  const text = String(block || '').trim();
  if (!text) return '(empty)';
  if (full) return text;
  const lines = text.split('\n');
  if (lines.length <= 12) return text;
  return lines.slice(0, 12).join('\n') + `\n  … (${lines.length - 12} more lines; use --full)`;
}

function indent(s, pad = '    ') {
  return String(s).split('\n').map((l) => pad + l).join('\n');
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('Usage: node scripts/review-recall-shadows.js [--limit N] [--channel ID] [--full]');
    return;
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Port-forward mongo and export MONGO_URI — see the header of this file.');
    process.exit(1);
  }
  const dbName = process.env.RECALL_DB || 'discord';

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const col = client.db(dbName).collection('recall_comparisons');
    const filter = opts.channel ? { 'scope.channelId': opts.channel } : {};
    const docs = await col.find(filter).sort({ ts: -1 }).limit(opts.limit).toArray();
    const total = await col.countDocuments(filter);

    if (docs.length === 0) {
      console.log(`No recall_comparisons found in db "${dbName}"${opts.channel ? ` for channel ${opts.channel}` : ''}.`);
      console.log('Shadow logging only records when RECALL_SHADOW_ENABLED=true AND a channel-voice chat happens. Give it some traffic.');
      return;
    }

    console.log(`recall_comparisons — showing ${docs.length} of ${total} (newest first)${opts.channel ? `, channel ${opts.channel}` : ''}\n`);

    const agg = { addedTotal: 0, droppedTotal: 0, sharedTotal: 0, newEmpty: 0, newItemsTotal: 0 };

    docs.forEach((d, i) => {
      const dl = delta(d.oldBlock, d.newBlock);
      agg.addedTotal += dl.onlyNew.length;
      agg.droppedTotal += dl.onlyOld.length;
      agg.sharedTotal += dl.shared.length;
      agg.newItemsTotal += dl.newCount;
      if (dl.newCount === 0) agg.newEmpty += 1;

      const when = d.ts instanceof Date ? d.ts.toISOString() : String(d.ts);
      console.log('─'.repeat(78));
      console.log(`#${i + 1}  ${when}  channel=${d.scope?.channelId || '?'}  user=${d.scope?.userId || '?'}  strategy=${d.strategy || '?'}`);
      console.log(`query:        ${JSON.stringify(d.query)}`);
      if (d.derivedQuery && d.derivedQuery !== d.query) console.log(`derivedQuery: ${JSON.stringify(d.derivedQuery)}`);
      console.log(`Δ items:      +${dl.onlyNew.length} new-only / -${dl.onlyOld.length} old-only / ${dl.shared.length} shared  (old=${dl.oldCount}, new=${dl.newCount})`);
      if (dl.onlyNew.length) console.log('  new surfaced:\n' + indent(dl.onlyNew.map((x) => '+ ' + x).join('\n'), '    '));
      if (dl.onlyOld.length) console.log('  legacy-only:\n' + indent(dl.onlyOld.map((x) => '- ' + x).join('\n'), '    '));
      console.log('  OLD (legacy, injected):');
      console.log(indent(trunc(d.oldBlock, opts.full)));
      console.log('  NEW (v2 ranked, shadow):');
      console.log(indent(trunc(d.newBlock, opts.full)));
      console.log('');
    });

    console.log('═'.repeat(78));
    console.log('Summary over sample:');
    console.log(`  comparisons shown:        ${docs.length}`);
    console.log(`  avg new items/turn:       ${(agg.newItemsTotal / docs.length).toFixed(1)}`);
    console.log(`  avg surfaced-by-new/turn: ${(agg.addedTotal / docs.length).toFixed(1)}`);
    console.log(`  avg dropped-vs-old/turn:  ${(agg.droppedTotal / docs.length).toFixed(1)}`);
    console.log(`  turns where new was empty: ${agg.newEmpty}/${docs.length}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`review-recall-shadows failed: ${err.message}`);
  process.exit(1);
});
