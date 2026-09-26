const CostService = require('../../services/CostService');

describe('CostService.recordMediaGen', () => {
  let svc;
  beforeEach(() => {
    svc = new CostService();
  });

  test('records a known model and updates cumulative.media', () => {
    const result = svc.recordMediaGen('lyria-3-pro-preview', { id: 'u1', tag: 'alice' });
    expect(result.success).toBe(true);
    expect(result.cost).toBeCloseTo(0.06, 5);
    expect(svc.cumulative.media.total).toBeCloseTo(0.06, 5);
    expect(svc.cumulative.media.calls).toBe(1);
    expect(svc.cumulative.media.byModel['lyria-3-pro-preview']).toBeCloseTo(0.06, 5);
    expect(result.modelKey).toBe('lyria-3-pro-preview');
  });

  test('multiple records accumulate', () => {
    svc.recordMediaGen('lyria-3-pro-preview', { id: 'u1' });
    svc.recordMediaGen('lyria-3-pro-preview', { id: 'u2' });
    expect(svc.cumulative.media.total).toBeCloseTo(0.12, 5);
    expect(svc.cumulative.media.calls).toBe(2);
  });

  test('unknown model returns success:false and does not update cumulative', () => {
    const result = svc.recordMediaGen('not-a-real-model', { id: 'u1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown model/i);
    expect(svc.cumulative.media.total).toBe(0);
    expect(svc.cumulative.media.calls).toBe(0);
  });

  test('null user is tolerated', () => {
    const result = svc.recordMediaGen('lyria-3-pro-preview', null);
    expect(result.success).toBe(true);
    expect(svc.cumulative.media.calls).toBe(1);
  });

  test('byModel accumulates per model independently', () => {
    // Add a second model to the pricing map for the duration of this test
    svc.mediaPricing['fake-model-x'] = 0.10;
    svc.recordMediaGen('lyria-3-pro-preview', { id: 'u1' });
    svc.recordMediaGen('fake-model-x', { id: 'u1' });
    svc.recordMediaGen('lyria-3-pro-preview', { id: 'u2' });

    expect(svc.cumulative.media.calls).toBe(3);
    expect(svc.cumulative.media.total).toBeCloseTo(0.22, 5);
    expect(svc.cumulative.media.byModel['lyria-3-pro-preview']).toBeCloseTo(0.12, 5);
    expect(svc.cumulative.media.byModel['fake-model-x']).toBeCloseTo(0.10, 5);
  });
});

describe('CostService.recordMediaGen - ElevenLabs', () => {
  let svc;
  beforeEach(() => {
    svc = new CostService();
  });

  test('records elevenlabs-music-v1 successfully', () => {
    const result = svc.recordMediaGen('elevenlabs-music-v1', { id: 'u1', tag: 'alice' });
    expect(result.success).toBe(true);
    expect(result.cost).toBeCloseTo(0.10, 5);
    expect(svc.cumulative.media.byModel['elevenlabs-music-v1']).toBeCloseTo(0.10, 5);
  });
});

describe('CostService.recordMediaGen - Lyria 3.5', () => {
  test('prices lyria-3.5 at the published $0.08 per song', () => {
    const svc = new CostService();
    const result = svc.recordMediaGen('lyria-3.5', { id: 'u1' });
    expect(result.success).toBe(true);
    expect(result.cost).toBeCloseTo(0.08, 5);
  });
});

describe('CostService.calculateCosts (per-model token pricing)', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, input_tokens_details: { cached_tokens: 0 } };

  test('prices gpt-6-luna at $0.10 in / $0.50 out per MTok', () => {
    const costs = new CostService().calculateCosts(usage, 'gpt-6-luna');
    expect(costs.input).toBeCloseTo(0.10, 6);
    expect(costs.output).toBeCloseTo(0.50, 6);
    expect(costs.total).toBeCloseTo(0.60, 6);
  });

  test('prices gpt-6-sol at $2 in / $10 out per MTok', () => {
    const costs = new CostService().calculateCosts(usage, 'gpt-6-sol');
    expect(costs.total).toBeCloseTo(12, 6);
  });

  test('still prices historical gpt-4.1-mini rows correctly', () => {
    const costs = new CostService().calculateCosts(usage, 'gpt-4.1-mini');
    expect(costs.input).toBeCloseTo(0.40, 6);
    expect(costs.output).toBeCloseTo(1.60, 6);
  });

  test('without a model, uses the default model (gpt-6-luna) pricing', () => {
    const costs = new CostService().calculateCosts(usage);
    expect(costs.total).toBeCloseTo(0.60, 6);
  });

  test('cached tokens are billed at the cached rate', () => {
    const costs = new CostService().calculateCosts(
      { input_tokens: 1_000_000, output_tokens: 0, input_tokens_details: { cached_tokens: 1_000_000 } },
      'gpt-6-luna'
    );
    expect(costs.input).toBeCloseTo(0.01, 6);
    expect(costs.cached).toBe(1_000_000);
  });
});
