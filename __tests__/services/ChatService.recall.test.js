// __tests__/services/ChatService.recall.test.js
// Tests for the v2 centralized ranked recall integration in ChatService:
// flag-gated path selection, raw-buffer exclusion, A/B shadow logging, and
// the cross-block prompt-size guard.
jest.mock('../../logger', () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }));
const ChatService = require('../../services/ChatService');
const { contentHash } = require('../../services/recall/ranking');

// ---- _getRecallContext (v2 path) -------------------------------------------

function makeChat(recallEnabled) {
  const svc = Object.create(ChatService.prototype);
  svc.config = { recall: { enabled: recallEnabled, shadowEnabled: false } };
  svc.recallService = {
    recall: jest.fn().mockResolvedValue({
      block: '\n\n## Memory Context\n[fact] x',
      candidates: [{ key: 'k' }],
      query: 'q',
    }),
  };
  svc.channelContextService = {
    isChannelTracked: () => true,
    // Raw accessor returns buffered message objects (NOT a formatted string).
    getRecentMessagesRaw: jest.fn(() => [{ authorName: 'anna', content: 'hi' }]),
    buildRecentContext: jest.fn().mockResolvedValue('\n\nRecent conversation:\n[anna]: hi'),
    buildHybridContext: jest.fn().mockResolvedValue('LEGACY-CHANNEL'),
  };
  svc._getRelevantMemories = jest.fn().mockResolvedValue({ context: 'LEGACY-MEM', sharedContext: 'LEGACY-SHARED' });
  return svc;
}

describe('ChatService._getRecallContext', () => {
  it('uses RecallService and buildRecentContext when flag is on', async () => {
    const svc = makeChat(true);
    const out = await svc._getRecallContext('chan', 'hello', { id: 'u' }, 'p');
    expect(svc.recallService.recall).toHaveBeenCalled();
    expect(out.memoryContext).toContain('## Memory Context');
    expect(out.channelContext).toContain('Recent conversation');
    expect(out.sharedContext).toBe('');
  });

  it('passes recent-buffer hashes as excludeHashes and ends recentMessages with the current message', async () => {
    const svc = makeChat(true);
    await svc._getRecallContext('chan', 'hello', { id: 'u' }, 'p');
    const arg = svc.recallService.recall.mock.calls[0][0];
    expect(arg.excludeHashes).toContain(contentHash('hi'));
    expect(arg.recentMessages[arg.recentMessages.length - 1]).toBe('hello');
    expect(arg.scope).toMatchObject({ userId: 'u', channelId: 'chan', personalityId: 'p' });
  });

  it('exposes the raw recall result as recallDebug', async () => {
    const svc = makeChat(true);
    const out = await svc._getRecallContext('chan', 'hello', { id: 'u' }, 'p');
    expect(out.recallDebug.query).toBe('q');
    expect(out.recallDebug.candidates).toEqual([{ key: 'k' }]);
  });
});

// ---- _getLegacyContext -----------------------------------------------------

describe('ChatService._getLegacyContext', () => {
  it('returns memory/shared from _getRelevantMemories and channel from _getChannelContext', async () => {
    const svc = Object.create(ChatService.prototype);
    svc._getRelevantMemories = jest.fn().mockResolvedValue({ context: 'MEM', sharedContext: 'SHARED' });
    svc._getChannelContext = jest.fn().mockResolvedValue('CHANNEL');
    const out = await svc._getLegacyContext('chan', 'hi', { id: 'u' }, 'p');
    expect(out).toEqual({ memoryContext: 'MEM', sharedContext: 'SHARED', channelContext: 'CHANNEL' });
    expect(svc._getRelevantMemories).toHaveBeenCalledWith('hi', 'u', 'p', 'chan');
    expect(svc._getChannelContext).toHaveBeenCalledWith('chan', 'hi');
  });
});

// ---- _composeRecallContexts: path selection + shadow -----------------------

describe('ChatService._composeRecallContexts', () => {
  function makeComposeChat({ enabled, shadowEnabled, shadowInject }) {
    const svc = Object.create(ChatService.prototype);
    svc.config = { recall: { enabled, shadowEnabled, shadowInject, queryStrategy: 'recent-window' } };
    svc.mongoService = { recordRecallComparison: jest.fn().mockResolvedValue() };
    svc.recallService = {
      recall: jest.fn().mockResolvedValue({
        block: '\n\n## Memory Context\n[fact] NEW',
        candidates: [{ key: 'k' }],
        query: 'derived-q',
      }),
    };
    svc.channelContextService = {
      isChannelTracked: () => true,
      getRecentMessagesRaw: jest.fn(() => []),
      buildRecentContext: jest.fn().mockResolvedValue('RECENT'),
      buildHybridContext: jest.fn().mockResolvedValue('LEGACY-CHANNEL'),
    };
    svc._getRelevantMemories = jest.fn().mockResolvedValue({ context: 'LEGACY-MEM', sharedContext: 'LEGACY-SHARED' });
    svc._getChannelContext = jest.fn().mockResolvedValue('LEGACY-CHANNEL');
    return svc;
  }

  it('flag off + shadow off: uses legacy path, never calls recall', async () => {
    const svc = makeComposeChat({ enabled: false, shadowEnabled: false, shadowInject: 'old' });
    const out = await svc._composeRecallContexts('chan', 'hi', { id: 'u' }, 'p', { useVoiceProfile: false });
    expect(svc.recallService.recall).not.toHaveBeenCalled();
    expect(out.memoryContext).toBe('LEGACY-MEM');
    expect(out.sharedContext).toBe('LEGACY-SHARED');
    expect(out.channelContext).toBe('LEGACY-CHANNEL');
    expect(svc.mongoService.recordRecallComparison).not.toHaveBeenCalled();
  });

  it('flag on + shadow off: uses recall path, never calls legacy memories', async () => {
    const svc = makeComposeChat({ enabled: true, shadowEnabled: false, shadowInject: 'old' });
    const out = await svc._composeRecallContexts('chan', 'hi', { id: 'u' }, 'p', { useVoiceProfile: false });
    expect(svc.recallService.recall).toHaveBeenCalled();
    expect(svc._getRelevantMemories).not.toHaveBeenCalled();
    expect(out.memoryContext).toContain('NEW');
    expect(out.channelContext).toBe('RECENT');
  });

  it('shadow on, inject=old: computes both, logs comparison, injects legacy', async () => {
    const svc = makeComposeChat({ enabled: false, shadowEnabled: true, shadowInject: 'old' });
    const out = await svc._composeRecallContexts('chan', 'hi', { id: 'u' }, 'p', { useVoiceProfile: false });
    expect(svc.recallService.recall).toHaveBeenCalled();
    expect(svc._getRelevantMemories).toHaveBeenCalled();
    expect(out.memoryContext).toBe('LEGACY-MEM'); // injected old
    await new Promise((r) => setImmediate(r));
    expect(svc.mongoService.recordRecallComparison).toHaveBeenCalled();
    const logged = svc.mongoService.recordRecallComparison.mock.calls[0][0];
    expect(logged.newBlock).toContain('NEW');
    expect(logged.oldBlock).toContain('LEGACY-MEM');
    expect(logged.derivedQuery).toBe('derived-q');
    expect(logged.newKeys).toEqual(['k']);
  });

  it('shadow on, inject=new: computes both, logs comparison, injects new', async () => {
    const svc = makeComposeChat({ enabled: true, shadowEnabled: true, shadowInject: 'new' });
    const out = await svc._composeRecallContexts('chan', 'hi', { id: 'u' }, 'p', { useVoiceProfile: false });
    expect(out.memoryContext).toContain('NEW');
    await new Promise((r) => setImmediate(r));
    expect(svc.mongoService.recordRecallComparison).toHaveBeenCalled();
  });

  it('carries voiceContext through when personality uses a voice profile', async () => {
    const svc = makeComposeChat({ enabled: true, shadowEnabled: false, shadowInject: 'old' });
    svc._getVoiceContext = jest.fn().mockResolvedValue({ voiceInstructions: 'VOICE', fewShotBlock: '' });
    const out = await svc._composeRecallContexts('chan', 'hi', { id: 'u' }, 'p', { useVoiceProfile: true });
    expect(svc._getVoiceContext).toHaveBeenCalledWith('chan', 'hi');
    expect(out.voiceContext).toMatchObject({ voiceInstructions: 'VOICE' });
  });
});

// ---- _composeRecallContexts: null guard (recallService unwired) -------------

describe('ChatService._composeRecallContexts null-recallService guard', () => {
  it('falls back to legacy path and does not throw when recallService is null', async () => {
    const svc = Object.create(ChatService.prototype);
    svc.config = { recall: { enabled: true, shadowEnabled: false } };
    // recallService explicitly missing (simulates bot.js wiring not yet deployed)
    svc.recallService = null;
    const SENTINEL = { memoryContext: 'LEGACY-SENTINEL', sharedContext: 'SHARED-SENTINEL', channelContext: 'CHANNEL-SENTINEL' };
    svc._getLegacyContext = jest.fn().mockResolvedValue(SENTINEL);
    svc._getVoiceContext = jest.fn();

    const out = await svc._composeRecallContexts('chan', 'hello', { id: 'u' }, 'p', { useVoiceProfile: false });

    expect(svc._getLegacyContext).toHaveBeenCalledWith('chan', 'hello', { id: 'u' }, 'p');
    expect(svc._getVoiceContext).not.toHaveBeenCalled();
    expect(out.memoryContext).toBe('LEGACY-SENTINEL');
    expect(out.sharedContext).toBe('SHARED-SENTINEL');
    expect(out.channelContext).toBe('CHANNEL-SENTINEL');
    expect(out.voiceContext).toBeNull();
  });

  it('still fetches voice context in the null-guard path when personality uses voice profile', async () => {
    const svc = Object.create(ChatService.prototype);
    svc.config = { recall: { enabled: true, shadowEnabled: false } };
    svc.recallService = null;
    const SENTINEL = { memoryContext: 'MEM', sharedContext: '', channelContext: '' };
    svc._getLegacyContext = jest.fn().mockResolvedValue(SENTINEL);
    svc._getVoiceContext = jest.fn().mockResolvedValue({ voiceInstructions: 'VOICE', fewShotBlock: '' });

    const out = await svc._composeRecallContexts('chan', 'hello', { id: 'u' }, 'p', { useVoiceProfile: true });

    expect(svc._getVoiceContext).toHaveBeenCalledWith('chan', 'hello');
    expect(out.voiceContext).toMatchObject({ voiceInstructions: 'VOICE' });
    expect(out.memoryContext).toBe('MEM');
  });
});

// ---- prompt-size guard (Task 14b) ------------------------------------------

describe('ChatService prompt-size guard', () => {
  it('trims the memory block first when the assembled prompt is too large', () => {
    const svc = Object.create(ChatService.prototype);
    svc.config = { recall: { promptMaxTokens: 50 } };
    const personality = { systemPrompt: 'BASE', useVoiceProfile: false };
    const bigMemory = '\n\n## Memory Context\n' + Array.from({ length: 200 }, (_, i) => `[fact] item ${i}`).join('\n');
    const recent = '\n\nRecent conversation:\n[anna]: hi';
    const out = svc._buildGroupSystemPrompt(personality, bigMemory, recent, '', null);
    expect(out).toContain('Recent conversation'); // recency preserved
    expect(out.length).toBeLessThan(('BASE' + bigMemory).length); // memory trimmed
  });

  it('does not trim when under the budget', () => {
    const svc = Object.create(ChatService.prototype);
    svc.config = { recall: { promptMaxTokens: 4000 } };
    const personality = { systemPrompt: 'BASE', useVoiceProfile: false };
    const memory = '\n\n## Memory Context\n[fact] one fact';
    const out = svc._buildGroupSystemPrompt(personality, memory, '', '', null);
    expect(out).toContain('one fact');
  });

  it('is a no-op when config has no recall block (legacy callers)', () => {
    const svc = Object.create(ChatService.prototype);
    // no svc.config at all
    const personality = { systemPrompt: 'BASE', useVoiceProfile: false };
    const memory = '\n\n## Memory Context\n[fact] one fact';
    const out = svc._buildGroupSystemPrompt(personality, memory, '', '', null);
    expect(out).toContain('one fact');
  });
});
