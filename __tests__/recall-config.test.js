// __tests__/recall-config.test.js
describe('recall config', () => {
  beforeEach(() => { jest.resetModules(); });

  afterEach(() => {
    delete process.env.RECALL_V2_ENABLED;
    delete process.env.RECALL_MAX_ITEMS;
  });

  it('provides sane defaults', () => {
    delete process.env.RECALL_V2_ENABLED;
    const config = require('../config/config');
    expect(config.recall.enabled).toBe(false);
    expect(config.recall.maxItems).toBe(8);
    expect(config.recall.halfLifeDays).toBe(14);
    expect(config.recall.queryStrategy).toBe('recent-window');
    expect(config.recall.sourceWeights['mem0:explicit']).toBeGreaterThan(
      config.recall.sourceWeights['channel:semantic']
    );
  });

  it('reads overrides from env', () => {
    process.env.RECALL_V2_ENABLED = 'true';
    process.env.RECALL_MAX_ITEMS = '12';
    const config = require('../config/config');
    expect(config.recall.enabled).toBe(true);
    expect(config.recall.maxItems).toBe(12);
  });
});
