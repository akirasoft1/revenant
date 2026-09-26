// utils/openaiModels.js
// Single source of truth for OpenAI model defaults, reasoning-model request
// params, and per-model token pricing.
//
// Every current OpenAI chat model (gpt-6-luna / gpt-6-sol / gpt-6-astra) is a
// reasoning model. Reasoning models reject `temperature` (other than 1),
// `top_p`, `max_tokens` and the penalty params, and reasoning tokens are
// charged against max_output_tokens / max_completion_tokens — so call sites
// must not send those, and short utility calls should pin a low effort
// instead of inheriting the model default (medium).

const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

// Interactive chat (direct-OpenAI fallback path) — latency matters, and the
// web_search tool already supplies grounding. Override via OPENAI_REASONING_EFFORT.
const DEFAULT_CHAT_REASONING_EFFORT = 'low';

const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

// gpt-5*, gpt-6*, and the o-series are reasoning models; gpt-4.x / gpt-4o are not.
const REASONING_MODEL_RE = /^(gpt-5|gpt-6|o\d)/i;

function isReasoningModel(model) {
  return typeof model === 'string' && REASONING_MODEL_RE.test(model);
}

/**
 * Request params that pin a reasoning effort on a Responses API call.
 * Returns {} for non-reasoning models (which reject the `reasoning` param),
 * when no effort is requested, or for an unknown effort value.
 * @param {string} model
 * @param {string} [effort] - none|low|medium|high|xhigh|max
 * @returns {Object} params to spread into responses.create()
 */
function reasoningParams(model, effort) {
  if (!effort || !REASONING_EFFORTS.has(effort) || !isReasoningModel(model)) return {};
  return { reasoning: { effort } };
}

// USD per 1M tokens. Keep historical entries: MongoDB token_usage rows
// reference the models that actually served them.
// gpt-6 cached-input rates are not published in our probe notes; they assume
// OpenAI's usual 90% cached-input discount.
const TOKEN_PRICING_PER_MTOK = {
  'gpt-6-luna': { input: 0.10, cachedInput: 0.01, output: 0.50 },
  'gpt-6-sol': { input: 2.00, cachedInput: 0.20, output: 10.00 },
  'gpt-6-astra': { input: 10.00, cachedInput: 1.00, output: 50.00 },
  // Historical (deprecated as of 2026-09)
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10.00 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.00 },
  'gpt-4.1-mini': { input: 0.40, cachedInput: 0.10, output: 1.60 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.60 },
};

/**
 * Per-token pricing for a model; unknown models fall back to the default model.
 * @param {string} model
 * @returns {{input:number, cachedInput:number, output:number}} USD per token
 */
function getTokenPricing(model) {
  const p = TOKEN_PRICING_PER_MTOK[model] || TOKEN_PRICING_PER_MTOK[DEFAULT_OPENAI_MODEL];
  return {
    input: p.input / 1_000_000,
    cachedInput: p.cachedInput / 1_000_000,
    output: p.output / 1_000_000,
  };
}

module.exports = {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_CHAT_REASONING_EFFORT,
  REASONING_EFFORTS,
  isReasoningModel,
  reasoningParams,
  TOKEN_PRICING_PER_MTOK,
  getTokenPricing,
};
