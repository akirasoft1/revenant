// __tests__/services/recall/adapters.test.js
const adapters = require('../../../services/recall/adapters');

describe('recall adapters', () => {
  it('mem0PersonalAdapter normalizes results', async () => {
    const mem0 = {
      isEnabled: () => true,
      searchMemories: jest.fn().mockResolvedValue({ results: [{ id: '1', memory: 'likes net-30', score: 0.8 }] }),
    };
    const out = await adapters.mem0PersonalAdapter(mem0, { query: 'q', userId: 'u', personalityId: 'p', limit: 10 });
    expect(out[0]).toMatchObject({ key: 'mem0:personal:1', source: 'mem0:personal', type: 'fact', text: 'likes net-30', similarity: 0.8 });
    expect(out[0].contentHash).toBeDefined();
    expect(out[0].provenance.tag).toBe('fact');
  });

  it('mem0 adapters return [] when service disabled or throwing', async () => {
    expect(await adapters.mem0PersonalAdapter({ isEnabled: () => false }, {})).toEqual([]);
    const boom = { isEnabled: () => true, searchMemories: jest.fn().mockRejectedValue(new Error('x')) };
    expect(await adapters.mem0PersonalAdapter(boom, {})).toEqual([]);
  });

  it('channelSemanticAdapter maps history hits with timestamp + author provenance', async () => {
    const svc = {
      isChannelTracked: () => true,
      searchRelevantHistory: jest.fn().mockResolvedValue([
        { authorName: 'anna', content: 'shipping tonight', timestamp: '2026-05-18T09:00:00Z', score: 0.7 },
      ]),
    };
    const [c] = await adapters.channelSemanticAdapter(svc, { query: 'q', channelId: 'c', limit: 10 });
    expect(c).toMatchObject({ source: 'channel:semantic', type: 'message', text: 'shipping tonight', similarity: 0.7 });
    expect(c.provenance).toMatchObject({ tag: 'history', when: '2026-05-18', who: '@anna' });
    expect(c.key.startsWith('hash:')).toBe(true);
  });

  it('channelSemanticAdapter returns [] when channel not tracked', async () => {
    expect(await adapters.channelSemanticAdapter({ isChannelTracked: () => false }, { channelId: 'c' })).toEqual([]);
  });

  it('channelFactsAdapter normalizes channel facts', async () => {
    const svc = { getChannelFacts: jest.fn().mockResolvedValue([{ id: '9', memory: 'toaster = build-01' }]) };
    const [c] = await adapters.channelFactsAdapter(svc, { channelId: 'c' });
    expect(c).toMatchObject({ key: 'channel:facts:9', source: 'channel:facts', type: 'channel-fact', text: 'toaster = build-01' });
    expect(c.provenance.tag).toBe('channel');
  });
});
