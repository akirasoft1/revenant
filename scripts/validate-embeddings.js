#!/usr/bin/env node
// scripts/validate-embeddings.js
// Data quality validation for Qdrant embedding collections
//
// Usage:
//   # Via kubectl port-forward:
//   kubectl port-forward svc/qdrant 6333:6333 -n discord-article-bot
//   node scripts/validate-embeddings.js
//
//   # Or with custom host:
//   QDRANT_HOST=localhost QDRANT_PORT=6333 node scripts/validate-embeddings.js
//
//   # Fix issues (delete expired points):
//   node scripts/validate-embeddings.js --fix

const { QdrantClient } = require('@qdrant/js-client-rest');

const QDRANT_HOST = process.env.QDRANT_HOST || 'localhost';
const QDRANT_PORT = parseInt(process.env.QDRANT_PORT || '6333', 10);
const FIX_MODE = process.argv.includes('--fix');

// Validation thresholds
const EXPIRED_RATIO_WARN = 0.05;   // Warn if >5% expired
const EXPIRED_RATIO_FAIL = 0.20;   // Fail if >20% expired
const MIN_IRC_POINTS = 100000;     // Expect at least 100k IRC records
const MIN_PAYLOAD_COVERAGE = 0.95; // Expect 95% of points to have required fields

let exitCode = 0;
const results = [];

function pass(check, detail) {
  results.push({ status: 'PASS', check, detail });
  console.log(`  ✓ ${check}: ${detail}`);
}

function warn(check, detail) {
  results.push({ status: 'WARN', check, detail });
  console.log(`  ⚠ ${check}: ${detail}`);
}

function fail(check, detail) {
  exitCode = 1;
  results.push({ status: 'FAIL', check, detail });
  console.log(`  ✗ ${check}: ${detail}`);
}

async function countWithFilter(client, collection, filter) {
  const result = await client.count(collection, { filter, exact: true });
  return result.count;
}

// ==================== Collection: channel_conversations ====================

async function validateChannelConversations(client) {
  console.log('\n── channel_conversations ──');

  let info;
  try {
    info = await client.getCollection('channel_conversations');
  } catch {
    fail('collection_exists', 'channel_conversations collection not found');
    return;
  }

  const total = info.points_count;
  pass('collection_exists', `${total.toLocaleString()} points`);

  // Check for expired points
  const now = new Date().toISOString();
  const expiredCount = await countWithFilter(client, 'channel_conversations', {
    must: [{ key: 'expiresAt', range: { lt: now } }]
  });

  const expiredRatio = total > 0 ? expiredCount / total : 0;
  const pct = (expiredRatio * 100).toFixed(1);

  if (expiredRatio > EXPIRED_RATIO_FAIL) {
    fail('expired_points', `${expiredCount.toLocaleString()} expired (${pct}%) — exceeds ${(EXPIRED_RATIO_FAIL * 100)}% threshold`);
  } else if (expiredRatio > EXPIRED_RATIO_WARN) {
    warn('expired_points', `${expiredCount.toLocaleString()} expired (${pct}%) — exceeds ${(EXPIRED_RATIO_WARN * 100)}% warning threshold`);
  } else {
    pass('expired_points', `${expiredCount.toLocaleString()} expired (${pct}%)`);
  }

  // Fix: delete expired points
  if (FIX_MODE && expiredCount > 0) {
    console.log(`    → Deleting ${expiredCount.toLocaleString()} expired points...`);
    await client.delete('channel_conversations', {
      filter: { must: [{ key: 'expiresAt', range: { lt: now } }] }
    });
    const afterCount = (await client.getCollection('channel_conversations')).points_count;
    console.log(`    → Done. Points remaining: ${afterCount.toLocaleString()}`);
  }

  // Check required payload fields (sample-based)
  const sample = await client.scroll('channel_conversations', {
    limit: 100, with_payload: true, with_vector: false
  });

  const requiredFields = ['channelId', 'content', 'authorName', 'timestamp', 'expiresAt'];
  const missingFieldCounts = {};
  let emptyContentCount = 0;

  for (const point of sample.points) {
    for (const field of requiredFields) {
      if (!point.payload[field]) {
        missingFieldCounts[field] = (missingFieldCounts[field] || 0) + 1;
      }
    }
    if (point.payload.content && point.payload.content.trim().length < 5) {
      emptyContentCount++;
    }
  }

  const hasMissing = Object.keys(missingFieldCounts).length > 0;
  if (hasMissing) {
    const detail = Object.entries(missingFieldCounts)
      .map(([f, c]) => `${f}: ${c}/${sample.points.length}`)
      .join(', ');
    fail('required_fields', `Missing fields in sample: ${detail}`);
  } else {
    pass('required_fields', `All ${requiredFields.length} required fields present in ${sample.points.length}-point sample`);
  }

  if (emptyContentCount > sample.points.length * 0.1) {
    warn('content_quality', `${emptyContentCount}/${sample.points.length} sampled points have very short content (<5 chars)`);
  } else {
    pass('content_quality', `${emptyContentCount}/${sample.points.length} sampled points with short content`);
  }

  // Check indexing status
  if (info.indexed_vectors_count < info.points_count) {
    const unindexed = info.points_count - info.indexed_vectors_count;
    warn('indexing', `${unindexed.toLocaleString()} vectors not yet indexed`);
  } else {
    pass('indexing', 'All vectors indexed');
  }
}

// ==================== Collection: irc_history ====================

async function validateIrcHistory(client) {
  console.log('\n── irc_history ──');

  let info;
  try {
    info = await client.getCollection('irc_history');
  } catch {
    fail('collection_exists', 'irc_history collection not found');
    return;
  }

  const total = info.points_count;
  if (total < MIN_IRC_POINTS) {
    fail('collection_size', `Only ${total.toLocaleString()} points (expected ≥${MIN_IRC_POINTS.toLocaleString()})`);
  } else {
    pass('collection_size', `${total.toLocaleString()} points`);
  }

  // Check required payload fields coverage via schema
  const schema = info.payload_schema || {};
  const expectedFields = ['text', 'participants', 'channel', 'year'];
  for (const field of expectedFields) {
    if (!schema[field]) {
      fail(`field_${field}`, `Payload field "${field}" not in schema`);
    } else {
      const coverage = schema[field].points / total;
      if (coverage < MIN_PAYLOAD_COVERAGE) {
        warn(`field_${field}`, `${schema[field].points.toLocaleString()}/${total.toLocaleString()} points (${(coverage * 100).toFixed(1)}% coverage)`);
      } else {
        pass(`field_${field}`, `${(coverage * 100).toFixed(1)}% coverage (${schema[field].points.toLocaleString()} points)`);
      }
    }
  }

  // Indexing status
  if (info.indexed_vectors_count < info.points_count) {
    const unindexed = info.points_count - info.indexed_vectors_count;
    warn('indexing', `${unindexed.toLocaleString()} vectors not yet indexed`);
  } else {
    pass('indexing', 'All vectors indexed');
  }

  // Sample-based content check
  const sample = await client.scroll('irc_history', {
    limit: 50, with_payload: true, with_vector: false
  });

  let emptyText = 0;
  let noParticipants = 0;
  for (const point of sample.points) {
    if (!point.payload.text || point.payload.text.trim().length === 0) emptyText++;
    if (!point.payload.participants || point.payload.participants.length === 0) noParticipants++;
  }

  if (emptyText > 0) {
    warn('content_quality', `${emptyText}/${sample.points.length} sampled points have empty text`);
  } else {
    pass('content_quality', 'All sampled points have text content');
  }

  if (noParticipants > 0) {
    warn('participants', `${noParticipants}/${sample.points.length} sampled points have no participants`);
  } else {
    pass('participants', 'All sampled points have participants');
  }
}

// ==================== Collection: discord_memories ====================

async function validateDiscordMemories(client) {
  console.log('\n── discord_memories ──');

  let info;
  try {
    info = await client.getCollection('discord_memories');
  } catch {
    fail('collection_exists', 'discord_memories collection not found');
    return;
  }

  const total = info.points_count;
  pass('collection_exists', `${total.toLocaleString()} points`);

  // Sample and categorize by type
  const sample = await client.scroll('discord_memories', {
    limit: 200, with_payload: true, with_vector: false
  });

  let channelMemories = 0;
  let userMemories = 0;
  let missingData = 0;
  let shortData = 0;
  let duplicateHashes = new Map();

  for (const point of sample.points) {
    const p = point.payload;

    // mem0ai v3 writes user_id; v2-era points carry userId (see migrate-mem0-v3-payload.js).
    const ownerId = p.user_id ?? p.userId;
    if (ownerId && ownerId.startsWith('channel:')) {
      channelMemories++;
    } else {
      userMemories++;
    }

    if (!p.data) {
      missingData++;
    } else if (p.data.length < 10) {
      shortData++;
    }

    if (p.hash) {
      duplicateHashes.set(p.hash, (duplicateHashes.get(p.hash) || 0) + 1);
    }
  }

  pass('memory_breakdown', `${channelMemories} channel / ${userMemories} user memories (in ${sample.points.length}-point sample)`);

  if (missingData > 0) {
    fail('data_field', `${missingData}/${sample.points.length} memories missing "data" field`);
  } else {
    pass('data_field', 'All sampled memories have "data" field');
  }

  if (shortData > sample.points.length * 0.1) {
    warn('data_quality', `${shortData}/${sample.points.length} memories have very short data (<10 chars)`);
  } else {
    pass('data_quality', `${shortData}/${sample.points.length} memories with short data`);
  }

  const dupes = [...duplicateHashes.values()].filter(c => c > 1).length;
  if (dupes > sample.points.length * 0.05) {
    warn('duplicates', `${dupes} duplicate hashes found in ${sample.points.length}-point sample`);
  } else {
    pass('duplicates', `${dupes} duplicate hashes in sample`);
  }

  // Indexing status
  if (info.indexed_vectors_count < info.points_count && info.points_count > 20000) {
    warn('indexing', `${info.indexed_vectors_count.toLocaleString()}/${info.points_count.toLocaleString()} vectors indexed (HNSW threshold not met)`);
  } else {
    pass('indexing', `${info.indexed_vectors_count.toLocaleString()}/${info.points_count.toLocaleString()} vectors indexed`);
  }
}

// ==================== Main ====================

async function main() {
  console.log(`\nQdrant Embedding Validation — ${QDRANT_HOST}:${QDRANT_PORT}`);
  if (FIX_MODE) console.log('Mode: FIX (will attempt to repair issues)');
  console.log('═'.repeat(50));

  const client = new QdrantClient({ host: QDRANT_HOST, port: QDRANT_PORT });

  // Verify connectivity
  try {
    const collections = await client.getCollections();
    pass('connectivity', `Connected. ${collections.collections.length} collections found`);
  } catch (error) {
    fail('connectivity', `Cannot connect to Qdrant: ${error.message}`);
    console.log('\nHint: Run "kubectl port-forward svc/qdrant 6333:6333 -n discord-article-bot" first');
    process.exit(1);
  }

  await validateChannelConversations(client);
  await validateIrcHistory(client);
  await validateDiscordMemories(client);

  // Summary
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const r of results) counts[r.status]++;

  console.log('\n' + '═'.repeat(50));
  console.log(`Summary: ${counts.PASS} passed, ${counts.WARN} warnings, ${counts.FAIL} failures`);

  if (counts.FAIL > 0 && !FIX_MODE) {
    console.log('Run with --fix to attempt automatic repairs');
  }

  process.exit(exitCode);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
