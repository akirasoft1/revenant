// services/RecallService.js
const logger = require('../logger');
const { dedupeCandidates, enrichWithLedger, rankAndBound, formatMemoryBlock } = require('./recall/ranking');
const { buildQuery } = require('./recall/queryBuilder');
const adapters = require('./recall/adapters');

class RecallService {
  /**
   * @param {Object} deps
   * @param {Object} deps.mem0Service
   * @param {Object} deps.channelContextService
   * @param {Object} deps.mongoService
   * @param {Object} deps.config - full config object (uses config.recall)
   * @param {Function} [deps.condenser] - optional async (text)=>query for llm-condense
   */
  constructor({ mem0Service, channelContextService, mongoService, config, condenser = null }) {
    this.mem0Service = mem0Service;
    this.channelContextService = channelContextService;
    this.mongoService = mongoService;
    this.config = config.recall;
    this.condenser = condenser;
  }

  async recall({ recentMessages, scope = {}, excludeHashes = [] }) {
    const cfg = this.config;

    const query = await buildQuery(recentMessages, {
      strategy: cfg.queryStrategy,
      windowSize: cfg.queryWindow,
      condenser: cfg.queryStrategy === 'llm-condense' ? this.condenser : undefined,
    });
    if (!query) return { block: '', candidates: [], query: '' };

    const limit = cfg.perSourceLimit;
    const { userId, channelId, personalityId } = scope;

    const results = await Promise.all([
      adapters.mem0PersonalAdapter(this.mem0Service, { query, userId, personalityId, limit }),
      adapters.mem0ExplicitAdapter(this.mem0Service, { query, userId, limit }),
      adapters.mem0SharedAdapter(this.mem0Service, { query, channelId, limit }),
      adapters.channelSemanticAdapter(this.channelContextService, { query, channelId, limit }),
      adapters.channelFactsAdapter(this.channelContextService, { channelId }),
    ]);

    const exclude = new Set(excludeHashes);
    let candidates = results.flat().filter((c) => !exclude.has(c.contentHash));
    candidates = dedupeCandidates(candidates);
    if (candidates.length === 0) return { block: '', candidates: [], query };

    let ledgerByKey = {};
    try {
      ledgerByKey = await this.mongoService.getRecallLedger(candidates.map((c) => c.key));
    } catch (e) {
      logger.debug(`recall ledger read failed: ${e.message}`);
    }

    const enriched = enrichWithLedger(candidates, ledgerByKey, {
      importanceSeed: cfg.importanceSeed,
      importanceSeedExplicit: cfg.importanceSeedExplicit,
    });

    const selected = rankAndBound(enriched, {
      maxItems: cfg.maxItems,
      tokenBudget: cfg.tokenBudget,
      sourceWeights: cfg.sourceWeights,
      halfLifeDays: cfg.halfLifeDays,
      accessBoostAlpha: cfg.accessBoostAlpha,
    });

    const block = formatMemoryBlock(selected);

    // fire-and-forget: never block or fail the turn on ledger writes
    this._bumpLedger(selected, scope).catch((e) => logger.debug(`recall ledger bump failed: ${e.message}`));

    return { block, candidates: selected, query };
  }

  async _bumpLedger(selected, scope) {
    if (!selected.length) return;
    const entries = selected.map((c) => ({
      memoryKey: c.key,
      scope,
      source: c.source,
      contentHash: c.contentHash,
      importanceSeed: c.source === 'mem0:explicit' ? this.config.importanceSeedExplicit : this.config.importanceSeed,
    }));
    await this.mongoService.bumpRecallAccess(entries, {
      nudge: this.config.importanceNudge,
      importanceMax: this.config.importanceMax,
    });
  }
}

module.exports = RecallService;
