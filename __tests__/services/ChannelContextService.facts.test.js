// __tests__/services/ChannelContextService.facts.test.js
// Unit tests for getChannelFactsRaw

jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
}));

const ChannelContextService = require('../../services/ChannelContextService');

describe('ChannelContextService.getChannelFactsRaw', () => {
  let svc;

  beforeEach(() => {
    svc = Object.create(ChannelContextService.prototype);
  });

  it('returns [] when mem0Service is not enabled', async () => {
    svc.mem0Service = { isEnabled: () => false };
    expect(await svc.getChannelFactsRaw('chan-1')).toEqual([]);
  });

  it('returns [] when mem0Service is absent', async () => {
    svc.mem0Service = null;
    expect(await svc.getChannelFactsRaw('chan-1')).toEqual([]);
  });

  it('returns the raw results array from getUserMemories', async () => {
    svc.mem0Service = {
      isEnabled: () => true,
      getUserMemories: jest.fn().mockResolvedValue({
        results: [{ id: '9', memory: 'x' }],
      }),
    };
    const out = await svc.getChannelFactsRaw('chan-1');
    expect(out).toEqual([{ id: '9', memory: 'x' }]);
    expect(svc.mem0Service.getUserMemories).toHaveBeenCalledWith('channel:chan-1', { limit: 5 });
  });

  it('returns [] when getUserMemories returns no results field', async () => {
    svc.mem0Service = {
      isEnabled: () => true,
      getUserMemories: jest.fn().mockResolvedValue({}),
    };
    expect(await svc.getChannelFactsRaw('chan-1')).toEqual([]);
  });

  it('returns [] and logs debug when getUserMemories throws', async () => {
    const logger = require('../../logger');
    svc.mem0Service = {
      isEnabled: () => true,
      getUserMemories: jest.fn().mockRejectedValue(new Error('mem0 down')),
    };
    const result = await svc.getChannelFactsRaw('chan-1');
    expect(result).toEqual([]);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('mem0 down'));
  });
});
