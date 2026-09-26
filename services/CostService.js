// ===== services/CostService.js =====
const logger = require('../logger');
const { DEFAULT_OPENAI_MODEL, getTokenPricing } = require('../utils/openaiModels');

class CostService {
  constructor() {
    // Default-model token pricing (per token). Per-model rates live in
    // utils/openaiModels.js; calculateCosts() takes the serving model.
    this.pricing = getTokenPricing(DEFAULT_OPENAI_MODEL);

    // Flat per-call pricing for media generation models (USD per call).
    // Old keys are kept so historical/pinned models still price.
    this.mediaPricing = {
      'lyria-3.5': 0.08, // Lyria 3.5 (full song) — Gemini API pricing, $0.08/song
      'lyria-3-pro-preview': 0.06, // legacy placeholder
      'elevenlabs-music-v1': 0.10
    };

    // Track cumulative costs
    this.cumulative = {
      input: 0,
      output: 0,
      total: 0,
      requests: 0,
      media: { total: 0, calls: 0, byModel: {} }
    };
  }

  calculateCosts(tokenUsage, model = null) {
    const { input_tokens, output_tokens, input_tokens_details } = tokenUsage;
    const cachedTokens = input_tokens_details?.cached_tokens || 0;
    const regularInputTokens = input_tokens - cachedTokens;
    const pricing = model ? getTokenPricing(model) : this.pricing;

    const inputCost = (regularInputTokens * pricing.input) + (cachedTokens * pricing.cachedInput);
    const outputCost = output_tokens * pricing.output;
    const totalCost = inputCost + outputCost;
    
    return {
      input: inputCost,
      output: outputCost,
      total: totalCost,
      cached: cachedTokens,
      regular: regularInputTokens
    };
  }

  formatCost(cost) {
    if (cost < 0.01) {
      return `${(cost * 100).toFixed(4)}¢`;
    }
    return `$${cost.toFixed(4)}`;
  }

  formatCostBreakdown(costs) {
    return {
      input: this.formatCost(costs.input),
      output: this.formatCost(costs.output),
      total: this.formatCost(costs.total)
    };
  }

  updateCumulative(costs) {
    this.cumulative.input += costs.input;
    this.cumulative.output += costs.output;
    this.cumulative.total += costs.total;
    this.cumulative.requests += 1;

    // Log cumulative costs every 10 requests or if total exceeds $1
    if (this.cumulative.requests % 10 === 0 || this.cumulative.total >= 1) {
      this.logCumulative();
    }
  }

  recordMediaGen(modelKey, user) {
    const cost = this.mediaPricing[modelKey];
    if (typeof cost !== 'number') {
      const error = `Unknown model for media generation cost: ${modelKey}`;
      logger.warn(error);
      return { success: false, error };
    }

    this.cumulative.media.total += cost;
    this.cumulative.media.calls += 1;
    this.cumulative.media.byModel[modelKey] = (this.cumulative.media.byModel[modelKey] || 0) + cost;

    const userLabel = user?.tag || user?.id || 'unknown';
    logger.info(`Media gen recorded - model: ${modelKey}, user: ${userLabel}, cost: ${this.formatCost(cost)}, cumulative: ${this.formatCost(this.cumulative.media.total)} over ${this.cumulative.media.calls} calls`);

    return { success: true, cost, modelKey };
  }

  logCostBreakdown(costs, tokenCounts) {
    logger.info(
      `Cost breakdown - Input: ${this.formatCost(costs.input)} ` +
      `(${tokenCounts.regular} regular + ${tokenCounts.cached} cached), ` +
      `Output: ${this.formatCost(costs.output)}, ` +
      `Total: ${this.formatCost(costs.total)}`
    );
  }

  logCumulative() {
    logger.info(
      `Cumulative costs (${this.cumulative.requests} requests) - ` +
      `Input: ${this.formatCost(this.cumulative.input)}, ` +
      `Output: ${this.formatCost(this.cumulative.output)}, ` +
      `Total: ${this.formatCost(this.cumulative.total)}` +
      (this.cumulative.media.calls > 0
        ? `, Media gen: ${this.formatCost(this.cumulative.media.total)} (${this.cumulative.media.calls} calls)`
        : '')
    );
  }
}

module.exports = CostService;