// __tests__/utils/openaiModels.test.js
// Pins the model-selection + request-param helpers every OpenAI call site uses.

const {
  DEFAULT_OPENAI_MODEL,
  isReasoningModel,
  reasoningParams,
  getTokenPricing,
  TOKEN_PRICING_PER_MTOK
} = require('../../utils/openaiModels');

describe('openaiModels', () => {
  test('default model is gpt-6-luna (gpt-5.x / 4.x are deprecated)', () => {
    expect(DEFAULT_OPENAI_MODEL).toBe('gpt-6-luna');
  });

  describe('isReasoningModel', () => {
    test.each(['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5', 'gpt-5-mini', 'gpt-5.1', 'o3-mini', 'o4-mini'])(
      '%s is a reasoning model', (m) => {
        expect(isReasoningModel(m)).toBe(true);
      });

    test.each(['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4o', 'llama3', '', null, undefined])(
      '%s is not a reasoning model', (m) => {
        expect(isReasoningModel(m)).toBe(false);
      });
  });

  describe('reasoningParams', () => {
    test('returns a reasoning block for reasoning models', () => {
      expect(reasoningParams('gpt-6-luna', 'low')).toEqual({ reasoning: { effort: 'low' } });
      expect(reasoningParams('gpt-6-sol', 'none')).toEqual({ reasoning: { effort: 'none' } });
    });

    test('returns nothing for non-reasoning models (they reject the param)', () => {
      expect(reasoningParams('gpt-4.1-mini', 'low')).toEqual({});
    });

    test('returns nothing when no effort is given (model default applies)', () => {
      expect(reasoningParams('gpt-6-luna')).toEqual({});
      expect(reasoningParams('gpt-6-luna', '')).toEqual({});
    });

    test('rejects an unknown effort rather than sending a 400-bound request', () => {
      expect(reasoningParams('gpt-6-luna', 'turbo')).toEqual({});
    });
  });

  describe('token pricing', () => {
    test('has the gpt-6 family at the published per-MTok prices', () => {
      expect(TOKEN_PRICING_PER_MTOK['gpt-6-luna']).toMatchObject({ input: 0.10, output: 0.50 });
      expect(TOKEN_PRICING_PER_MTOK['gpt-6-sol']).toMatchObject({ input: 2, output: 10 });
      expect(TOKEN_PRICING_PER_MTOK['gpt-6-astra']).toMatchObject({ input: 10, output: 50 });
    });

    test('keeps historical models (Mongo rows reference them)', () => {
      for (const m of ['gpt-5.1', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini']) {
        expect(TOKEN_PRICING_PER_MTOK[m]).toBeDefined();
      }
    });

    test('getTokenPricing returns per-token rates', () => {
      const p = getTokenPricing('gpt-6-luna');
      expect(p.input).toBeCloseTo(0.10 / 1_000_000, 15);
      expect(p.output).toBeCloseTo(0.50 / 1_000_000, 15);
      expect(p.cachedInput).toBeLessThanOrEqual(p.input);
    });

    test('getTokenPricing falls back to the default model for unknown ids', () => {
      expect(getTokenPricing('some-future-model')).toEqual(getTokenPricing(DEFAULT_OPENAI_MODEL));
      expect(getTokenPricing(undefined)).toEqual(getTokenPricing(DEFAULT_OPENAI_MODEL));
    });
  });
});
