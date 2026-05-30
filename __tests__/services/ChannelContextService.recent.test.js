// __tests__/services/ChannelContextService.recent.test.js
//
// Tests for ChannelContextService.buildRecentContext — the v2 recall path
// helper that returns ONLY the participant list + recent in-memory buffer,
// without semantic hits or channel facts.
//
// Real accessor shapes (verified from services/ChannelContextService.js):
//   getRecentContext(channelId, limit) → string  (already formatted "[author]: content\n...")
//   getParticipantContext(channelId, windowMinutes) → string  (already formatted participant list)
//
// The plan draft guessed getRecentContext → array-of-objects and
// getActiveParticipants → array-of-strings; both were wrong. We use the real
// string-returning accessors instead, matching how buildHybridContext uses them.

jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({}))
}));
jest.mock('../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn()
}));

const ChannelContextService = require('../../services/ChannelContextService');

describe('buildRecentContext', () => {
  let svc;

  beforeEach(() => {
    svc = Object.create(ChannelContextService.prototype);
    // getRecentContext returns a formatted string (the real method does this directly)
    svc.getRecentContext = jest.fn(() =>
      '[anna]: morning\n[bob]: deploy time?'
    );
    // getParticipantContext returns a formatted participant string (used by buildHybridContext too)
    svc.getParticipantContext = jest.fn(() =>
      'Active participants in this channel:\n- anna (2 messages)\n- bob (1 messages)'
    );
  });

  it('includes participants and recent messages, not semantic/facts', async () => {
    // Spy on semantic/facts methods to confirm buildRecentContext never calls them
    const searchSpy = jest.spyOn(svc, 'searchRelevantHistory').mockResolvedValue([]);
    const factsSpy = jest.spyOn(svc, 'getChannelFacts').mockResolvedValue('');
    const out = await svc.buildRecentContext('c1');
    expect(out).toContain('anna');
    expect(out).toContain('deploy time?');
    // Must NOT call any semantic search or facts method
    expect(searchSpy).not.toHaveBeenCalled();
    expect(factsSpy).not.toHaveBeenCalled();
  });

  it('uses getParticipantContext and getRecentContext accessors', async () => {
    await svc.buildRecentContext('c1');
    expect(svc.getParticipantContext).toHaveBeenCalledWith('c1');
    expect(svc.getRecentContext).toHaveBeenCalledWith('c1');
  });

  it('returns empty string when there is no recent activity and no participants', async () => {
    svc.getRecentContext = jest.fn(() => '');
    svc.getParticipantContext = jest.fn(() => '');
    expect(await svc.buildRecentContext('c1')).toBe('');
  });

  it('returns context with only participants when buffer is empty', async () => {
    svc.getRecentContext = jest.fn(() => '');
    svc.getParticipantContext = jest.fn(() =>
      'Active participants in this channel:\n- anna (3 messages)'
    );
    const out = await svc.buildRecentContext('c1');
    expect(out).toContain('anna');
    expect(out).not.toBe('');
  });

  it('returns context with only recent messages when there are no participants', async () => {
    svc.getRecentContext = jest.fn(() => '[anna]: solo message');
    svc.getParticipantContext = jest.fn(() => '');
    const out = await svc.buildRecentContext('c1');
    expect(out).toContain('solo message');
    expect(out).not.toBe('');
  });
});
