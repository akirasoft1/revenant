#!/usr/bin/env node
// scripts/seed-member-identities.js
//
// One-time seed of the member identity registry (`member_identities`) from the
// VOICE_SPEAKER_NAMES configmap table: each `{"<discordId>":"<spoken name>"}`
// entry becomes that member's `addressName`, for IDs that have NO record yet.
// Existing records are never overwritten (members may already have set their
// own name via /whois), and the configmap stays in place as a fallback layer
// in SpeakerNames.
//
// Names go through the same validation as /whois (sanitised, must contain a
// letter, must not already be held by another member) -- entries the registry
// would reject are reported and skipped.
//
// Usage (dry run by default):
//   kubectl port-forward svc/mongodb 27017:27017 -n discord-article-bot &
//   export MONGO_PASSWORD=...   # if MONGO_URI contains ${MONGO_PASSWORD}
//   export MONGO_URI='mongodb://admin:${MONGO_PASSWORD}@localhost:27017/discord?authSource=admin'
//   export VOICE_SPEAKER_NAMES='{"1616...":"Mike"}'
//   node scripts/seed-member-identities.js            # report only
//   node scripts/seed-member-identities.js --apply    # insert
//
// A dry run with MONGO_URI unset plans against an empty collection.
// Spec: docs/superpowers/specs/2026-10-09-member-identity-design.md

const { parseSpeakerNames } = require('../services/SpeakerNames');
const { normalizeName, findHolder } = require('../services/identity/validation');

const COLLECTION = 'member_identities';
const DB_NAME = 'discord'; // same database MongoService uses
const SEED_ACTOR = 'seed';

/**
 * Decide what to insert. Pure: `overrides` is the parsed VOICE_SPEAKER_NAMES
 * table, `existingDocs` the current collection contents.
 * @returns {{inserts: Array<{_id, addressName}>, skipped: Array<{_id, name, reason, holderId?}>}}
 */
function planSeed(overrides, existingDocs) {
  const inserts = [];
  const skipped = [];
  if (!overrides || typeof overrides !== 'object') return { inserts, skipped };

  const docs = Array.isArray(existingDocs) ? existingDocs : [];
  const existingIds = new Set(docs.map((d) => String(d._id)));
  // Records for collision checks: existing ones plus what this run will add.
  const records = docs.map((d) => ({
    discordId: String(d._id),
    addressName: d.addressName || null,
    aliases: Array.isArray(d.aliases) ? d.aliases : [],
  }));

  for (const [rawId, rawName] of Object.entries(overrides)) {
    const id = String(rawId);
    const name = typeof rawName === 'string' ? rawName : String(rawName);
    if (existingIds.has(id)) { skipped.push({ _id: id, name, reason: 'exists' }); continue; }
    const addressName = normalizeName(rawName);
    if (!addressName) { skipped.push({ _id: id, name, reason: 'invalid' }); continue; }
    const holderId = findHolder(records, addressName, id);
    if (holderId) { skipped.push({ _id: id, name, reason: 'taken', holderId }); continue; }
    inserts.push({ _id: id, addressName });
    records.push({ discordId: id, addressName, aliases: [] });
  }
  return { inserts, skipped };
}

/**
 * Insert the planned docs. insertOne (never upsert/replace), so a record that
 * appeared since planning is left alone and counted as a duplicate.
 */
async function applySeed(collection, inserts, { now = () => new Date() } = {}) {
  let inserted = 0;
  let duplicates = 0;
  for (const { _id, addressName } of inserts) {
    try {
      await collection.insertOne({ _id, addressName, aliases: [], updatedBy: SEED_ACTOR, updatedAt: now() });
      inserted++;
    } catch (e) {
      if (e && e.code === 11000) { duplicates++; continue; }
      throw e;
    }
  }
  return { inserted, duplicates };
}

function mongoUriFromEnv() {
  const uri = process.env.MONGO_URI;
  if (!uri) return null;
  return uri.replace('${MONGO_PASSWORD}', process.env.MONGO_PASSWORD);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const overrides = parseSpeakerNames(process.env.VOICE_SPEAKER_NAMES);
  const uri = mongoUriFromEnv();

  let client = null;
  let collection = null;
  let existing = [];
  if (uri) {
    const { MongoClient } = require('mongodb');
    client = new MongoClient(uri);
    await client.connect();
    collection = client.db(DB_NAME).collection(COLLECTION);
    existing = await collection.find({}).toArray();
  } else if (apply) {
    console.error('MONGO_URI is not set; --apply needs a database. See the header of this file.');
    process.exit(1);
  } else {
    console.log('MONGO_URI is not set: planning against an EMPTY collection.');
  }

  try {
    const { inserts, skipped } = planSeed(overrides, existing);
    console.log(`${apply ? 'SEEDING' : 'DRY RUN'}: ${Object.keys(overrides).length} VOICE_SPEAKER_NAMES entries, ${existing.length} existing ${COLLECTION} records`);
    for (const i of inserts) console.log(`  insert ${i._id} addressName=${JSON.stringify(i.addressName)}`);
    for (const s of skipped) {
      console.log(`  skip   ${s._id} name=${JSON.stringify(s.name)} reason=${s.reason}${s.holderId ? ` holder=${s.holderId}` : ''}`);
    }
    if (apply) {
      const res = await applySeed(collection, inserts);
      console.log(JSON.stringify(res));
    } else if (inserts.length > 0) {
      console.log('Re-run with --apply to insert.');
    }
  } finally {
    if (client) await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { planSeed, applySeed, mongoUriFromEnv };
