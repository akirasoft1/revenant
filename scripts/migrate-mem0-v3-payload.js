#!/usr/bin/env node
// scripts/migrate-mem0-v3-payload.js
//
// One-time Qdrant payload migration for the mem0ai 2.x -> 3.x upgrade.
//
// mem0ai 2.x stored a memory's owner in camelCase payload keys (userId, agentId,
// runId). mem0ai 3.x writes AND filters on snake_case (user_id, agent_id,
// run_id). Without this migration every memory written before the upgrade is
// invisible to search()/getAll()/deleteAll() — no error, just empty recall.
//
// The migration only ADDS the snake_case keys; the legacy camelCase keys are
// left in place so rolling back to a 2.x image keeps working. It is idempotent
// (points that already have the snake_case keys are skipped).
//
// Usage (dry run by default):
//   kubectl port-forward svc/qdrant 6333:6333 -n discord-article-bot &
//   node scripts/migrate-mem0-v3-payload.js            # report only
//   node scripts/migrate-mem0-v3-payload.js --apply    # write
//
// Env: QDRANT_HOST (localhost), QDRANT_PORT (6333),
//      MEM0_COLLECTION_NAME (discord_memories)

const LEGACY_TO_V3 = { userId: 'user_id', agentId: 'agent_id', runId: 'run_id' };

/**
 * The payload patch that brings one point up to the mem0ai v3 schema, or null
 * when nothing needs to change. Never overwrites an existing snake_case key.
 */
function legacyEntityPatch(payload) {
  if (!payload) return null;
  const patch = {};
  for (const [legacy, v3] of Object.entries(LEGACY_TO_V3)) {
    if (payload[legacy] !== undefined && payload[legacy] !== null && payload[v3] === undefined) {
      patch[v3] = payload[legacy];
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

async function migrateCollection(client, collectionName, { apply = false, pageSize = 256, log = () => {} } = {}) {
  const stats = { scanned: 0, needsMigration: 0, migrated: 0 };
  let offset;
  do {
    const page = await client.scroll(collectionName, {
      limit: pageSize,
      with_payload: true,
      with_vector: false,
      ...(offset !== undefined && { offset }),
    });
    for (const point of page.points) {
      stats.scanned++;
      const patch = legacyEntityPatch(point.payload);
      if (!patch) continue;
      stats.needsMigration++;
      if (apply) {
        await client.setPayload(collectionName, { payload: patch, points: [point.id], wait: true });
        stats.migrated++;
      }
    }
    log(`  scanned ${stats.scanned}, needing migration ${stats.needsMigration}, migrated ${stats.migrated}`);
    offset = page.next_page_offset ?? undefined;
  } while (offset !== undefined);
  return stats;
}

async function main() {
  const { QdrantClient } = require('@qdrant/js-client-rest');
  const host = process.env.QDRANT_HOST || 'localhost';
  const port = parseInt(process.env.QDRANT_PORT || '6333', 10);
  const collection = process.env.MEM0_COLLECTION_NAME || 'discord_memories';
  const apply = process.argv.includes('--apply');

  const client = new QdrantClient({ host, port });
  console.log(`${apply ? 'MIGRATING' : 'DRY RUN'}: ${collection} on ${host}:${port}`);
  const stats = await migrateCollection(client, collection, { apply, log: console.log });
  console.log(JSON.stringify(stats));
  if (!apply && stats.needsMigration > 0) {
    console.log('Re-run with --apply to write the snake_case keys.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { legacyEntityPatch, migrateCollection };
