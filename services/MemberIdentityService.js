'use strict';

// Member identity registry: who each Discord member is, how to address them,
// and which other names refer to them. Backed by the `member_identities`
// MongoDB collection, one doc per Discord ID:
//   { _id: <discordId>, addressName: string|null, aliases: string[],
//     updatedBy: <discordId>, updatedAt: Date }
//
// The member set is ~a dozen, so the whole collection is cached in memory and
// every read (get/all) is synchronous -- it is consulted on every chat/voice
// turn and must never throw into one. The cache is reloaded at startup, after
// every write, and every `refreshMs` (default 60s). Mongo connects
// asynchronously after the bot is constructed, so a load before the connection
// lands just reports false and the next refresh picks it up.
//
// Spec: docs/superpowers/specs/2026-10-09-member-identity-design.md
const logger = require('../logger');
const { normalizeName, namesEqual, findHolder, MAX_ALIASES } = require('./identity/validation');

const COLLECTION = 'member_identities';

function toRecord(doc) {
  return {
    discordId: String(doc._id),
    addressName: typeof doc.addressName === 'string' && doc.addressName !== '' ? doc.addressName : null,
    aliases: Array.isArray(doc.aliases) ? doc.aliases.filter((a) => typeof a === 'string' && a !== '') : [],
  };
}

function copy(rec) {
  return { discordId: rec.discordId, addressName: rec.addressName, aliases: [...rec.aliases] };
}

class MemberIdentityService {
  constructor({ mongoService = null, refreshMs = 60000, now = () => new Date() } = {}) {
    this.mongoService = mongoService;
    this.refreshMs = refreshMs;
    this.now = now;
    this._cache = new Map();
    this._loaded = false;
    this._timer = null;
    this._warnedUnavailable = false;
  }

  _collection() {
    const db = this.mongoService && this.mongoService.db;
    if (!db || typeof db.collection !== 'function') return null;
    return db.collection(COLLECTION);
  }

  /**
   * (Re)load every identity doc into the cache. Resolves true on success,
   * false when Mongo is unavailable or the read fails (the previous cache is
   * kept). Never throws.
   */
  async load() {
    let col;
    try {
      col = this._collection();
    } catch (e) {
      logger.warn(`MemberIdentityService: could not get ${COLLECTION} collection: ${e.message}`);
      return false;
    }
    if (!col) {
      if (!this._warnedUnavailable) {
        logger.info('MemberIdentityService: MongoDB not connected yet; identity registry not loaded (will retry on refresh)');
        this._warnedUnavailable = true;
      }
      return false;
    }
    try {
      const docs = await col.find({}).toArray();
      const next = new Map();
      for (const doc of docs) {
        if (!doc || doc._id === undefined || doc._id === null) continue;
        const rec = toRecord(doc);
        next.set(rec.discordId, rec);
      }
      const firstLoad = !this._loaded;
      this._cache = next;
      this._loaded = true;
      if (firstLoad) logger.info(`MemberIdentityService: loaded ${next.size} member identities from ${COLLECTION}`);
      return true;
    } catch (e) {
      logger.warn(`MemberIdentityService: failed to load ${COLLECTION}; keeping previous cache (${this._cache.size} records): ${e.message}`);
      return false;
    }
  }

  /** Start the periodic refresh (immediate load, then every refreshMs). Idempotent. */
  start() {
    if (this._timer) return;
    this.load().catch(() => {});
    this._timer = setInterval(() => { this.load().catch(() => {}); }, this.refreshMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  isLoaded() {
    return this._loaded;
  }

  /** @returns {{discordId: string, addressName: string|null, aliases: string[]}|null} */
  get(discordId) {
    if (discordId === undefined || discordId === null || discordId === '') return null;
    const rec = this._cache.get(String(discordId));
    return rec ? copy(rec) : null;
  }

  all() {
    return [...this._cache.values()].map(copy);
  }

  async setAddressName(targetId, name, actorId) {
    const normalized = normalizeName(name);
    if (!targetId || !normalized) return { ok: false, reason: 'invalid' };
    return this._mutate(targetId, actorId, (current, records) => {
      const holderId = findHolder(records, normalized, String(targetId));
      if (holderId) return { ok: false, reason: 'taken', holderId };
      return { write: { addressName: normalized, aliases: current.aliases } };
    });
  }

  async addAlias(targetId, alias, actorId) {
    const normalized = normalizeName(alias);
    if (!targetId || !normalized) return { ok: false, reason: 'invalid' };
    return this._mutate(targetId, actorId, (current, records) => {
      const holderId = findHolder(records, normalized, String(targetId));
      if (holderId) return { ok: false, reason: 'taken', holderId };
      // Idempotent: already one of theirs (any case) -> success, no write.
      if (current.aliases.some((a) => namesEqual(a, normalized))) return { unchanged: true };
      if (current.aliases.length >= MAX_ALIASES) return { ok: false, reason: 'too_many' };
      return { write: { addressName: current.addressName, aliases: [...current.aliases, normalized] } };
    });
  }

  async removeAlias(targetId, alias, actorId) {
    // Match the sanitised form first (that is what was stored), then the raw
    // text, so removal works however the user typed it.
    const candidates = [normalizeName(alias), typeof alias === 'string' ? alias : null].filter(Boolean);
    return this._mutate(targetId, actorId, (current, records, exists) => {
      if (!exists || candidates.length === 0) return { ok: false, reason: 'not_found' };
      const keep = current.aliases.filter((a) => !candidates.some((c) => namesEqual(a, c)));
      if (keep.length === current.aliases.length) return { ok: false, reason: 'not_found' };
      return { write: { addressName: current.addressName, aliases: keep } };
    });
  }

  /**
   * Shared write path: refresh from Mongo (so collision checks see writes made
   * since the last refresh), let `decide` validate against the fresh records,
   * upsert the full doc, then refresh the cache again.
   */
  async _mutate(targetId, actorId, decide) {
    if (!targetId) return { ok: false, reason: 'not_found' };
    const id = String(targetId);
    let col;
    try {
      col = this._collection();
    } catch (_) {
      col = null;
    }
    if (!col || !(await this.load())) return { ok: false, reason: 'unavailable' };

    const existing = this._cache.get(id);
    const current = existing ? copy(existing) : { discordId: id, addressName: null, aliases: [] };
    const decision = decide(current, this.all(), !!existing);
    if (decision.ok === false) return decision;
    if (decision.unchanged) return { ok: true, record: current };

    const { addressName, aliases } = decision.write;
    try {
      await col.updateOne(
        { _id: id },
        { $set: { addressName, aliases, updatedBy: actorId ? String(actorId) : null, updatedAt: this.now() } },
        { upsert: true },
      );
    } catch (e) {
      logger.error(`MemberIdentityService: write to ${COLLECTION} failed for ${id} (actor ${actorId}): ${e.message}`);
      return { ok: false, reason: 'unavailable' };
    }
    logger.info(`MemberIdentityService: ${id} identity updated by ${actorId}: addressName=${JSON.stringify(addressName)} aliases=${JSON.stringify(aliases)}`);

    // Refresh the cache; if that refresh fails, still reflect our own write.
    if (!(await this.load())) {
      this._cache.set(id, { discordId: id, addressName, aliases: [...aliases] });
    }
    return { ok: true, record: this.get(id) };
  }
}

module.exports = MemberIdentityService;
module.exports.COLLECTION = COLLECTION;
