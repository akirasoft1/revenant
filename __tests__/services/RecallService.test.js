// __tests__/services/RecallService.test.js
jest.mock('../../logger', () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }));
const RecallService = require('../../services/RecallService');

const baseConfig = {
  recall: {
    perSourceLimit: 10, maxItems: 8, tokenBudget: 1000,
    halfLifeDays: 14, accessBoostAlpha: 0.1,
    importanceSeed: 0.5, importanceSeedExplicit: 0.7, importanceNudge: 0.02, importanceMax: 1.0,
    queryStrategy: 'last-message', queryWindow: 3,
    sourceWeights: { 'mem0:explicit': 1.3, 'mem0:shared': 1.1, 'channel:facts': 1.0, 'mem0:personal': 1.0, 'channel:semantic': 0.8 },
  },
};

function makeService(overrides = {}) {
  return new RecallService({
    mem0Service: {
      isEnabled: () => true,
      searchMemories: jest.fn().mockResolvedValue({ results: [{ id: '1', memory: 'likes net-30', score: 0.8 }] }),
      searchSharedChannelMemories: jest.fn().mockResolvedValue({ results: [] }),
    },
    channelContextService: { isChannelTracked: () => false, getChannelFacts: jest.fn().mockResolvedValue([]) },
    mongoService: { getRecallLedger: jest.fn().mockResolvedValue({}), bumpRecallAccess: jest.fn().mockResolvedValue() },
    config: baseConfig,
    ...overrides,
  });
}

describe('RecallService.recall', () => {
  it('returns a Memory Context block from candidates', async () => {
    const svc = makeService();
    const out = await svc.recall({ recentMessages: ['tell me about acme'], scope: { userId: 'u', channelId: 'c', personalityId: 'p' } });
    expect(out.block).toContain('## Memory Context');
    expect(out.block).toContain('likes net-30');
    expect(out.candidates).toHaveLength(1);
  });

  it('drops candidates whose contentHash is excluded', async () => {
    const { contentHash } = require('../../services/recall/ranking');
    const svc = makeService();
    const out = await svc.recall({
      recentMessages: ['q'],
      scope: { userId: 'u', channelId: 'c', personalityId: 'p' },
      excludeHashes: [contentHash('likes net-30')],
    });
    expect(out.candidates).toHaveLength(0);
    expect(out.block).toBe('');
  });

  it('returns empty block when query is empty', async () => {
    const svc = makeService();
    const out = await svc.recall({ recentMessages: [], scope: {} });
    expect(out.block).toBe('');
  });

  it('still returns a block when the ledger read fails', async () => {
    const svc = makeService({ mongoService: { getRecallLedger: jest.fn().mockRejectedValue(new Error('mongo down')), bumpRecallAccess: jest.fn() } });
    const out = await svc.recall({ recentMessages: ['q'], scope: { userId: 'u' } });
    expect(out.block).toContain('likes net-30');
  });
});

describe('RecallService ledger bump', () => {
  it('does not reject the turn when bumpRecallAccess throws', async () => {
    const bump = jest.fn().mockRejectedValue(new Error('write fail'));
    const svc = makeService({ mongoService: { getRecallLedger: jest.fn().mockResolvedValue({}), bumpRecallAccess: bump } });
    const out = await svc.recall({ recentMessages: ['q'], scope: { userId: 'u' } });
    expect(out.block).toContain('likes net-30'); // turn succeeds
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget settle
    expect(bump).toHaveBeenCalled();
  });

  it('bumps the ledger for injected candidates with correct seed', async () => {
    const bump = jest.fn().mockResolvedValue();
    const svc = makeService({ mongoService: { getRecallLedger: jest.fn().mockResolvedValue({}), bumpRecallAccess: bump } });
    await svc.recall({ recentMessages: ['q'], scope: { userId: 'u', channelId: 'c' } });
    await new Promise((r) => setImmediate(r));
    const entries = bump.mock.calls[0][0];
    expect(entries[0]).toMatchObject({ memoryKey: 'mem0:personal:1', source: 'mem0:personal', importanceSeed: 0.5 });
  });
});

