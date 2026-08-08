// __tests__/services/ChatService.buildTurnContext.test.js
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../utils/tokenCounter', () => ({ countTokens: () => 10, wouldExceedLimit: () => false }));
jest.mock('../../personalities', () => ({
  get: () => ({ id: 'channel-voice', name: 'Channel Voice', emoji: '🗣️',
    useVoiceProfile: true, systemPrompt: 'BASE {VOICE_INSTRUCTIONS} END' }),
  getSystemPrompt: () => 'BASE {VOICE_INSTRUCTIONS} END',
}));
const ChatService = require('../../services/ChatService');

function makeChat() {
  const svc = Object.create(ChatService.prototype);
  svc.config = {
    recall: { enabled: true, promptMaxTokens: 4000 },
    channelContext: { promptRecentCount: 10 },
  };
  svc.channelContextService = {
    isChannelTracked: () => true,
    // Only feeds the recall query/excludeHashes machinery inside
    // _getRecallContext — NOT the source for historyTurns (that's Mongo;
    // see svc.mongoService below). Deliberately user-only here to prove
    // buildTurnContext doesn't (mistakenly) source history from this buffer.
    getRecentMessagesRaw: () => ([{ authorName: 'alice', content: 'hey', isBot: false }]),
    buildRecentContext: async () => '\n\nRecent channel conversation:\n[alice]: hey',
  };
  svc.voiceProfileService = { getProfile: () => ({ voiceInstructions: 'TALK LIKE THE CREW' }) };
  svc.qdrantService = { search: async () => [] };
  svc.recallService = { recall: async () => ({ block: '\n\n## Memory Context\nalice likes nmap', candidates: [{}], query: 'q' }) };
  svc.mem0Service = { isEnabled: () => false };
  // Bot-inclusive history source (mirrors MongoService.getRecentChannelMessages:
  // channel_messages docs, oldest->newest, isBot present on bot replies).
  svc.mongoService = {
    getRecentChannelMessages: async () => ([
      { authorName: 'alice', content: 'can you write something for me?', isBot: false },
      { authorName: 'bot', content: 'what document?', isBot: true },
    ]),
  };
  return svc;
}

test('buildTurnContext resolves voice profile, returns separate memory + history', async () => {
  const svc = makeChat();
  const ctx = await svc.buildTurnContext({
    userId: 'u1', channelId: 'c1', userMessage: 'craft it from scratch', personalityId: 'channel-voice',
  });
  expect(ctx.systemPrompt).toContain('TALK LIKE THE CREW');   // dynamic voice profile substituted
  expect(ctx.systemPrompt).not.toContain('{VOICE_INSTRUCTIONS}'); // no leftover placeholder
  expect(ctx.systemPrompt).not.toContain('## Memory Context');    // memory kept separate
  expect(ctx.memoryBlock).toContain('alice likes nmap');
  // Both sides of the conversation must survive, oldest->newest, including
  // the bot's own prior reply mapped to 'assistant' — proving history is
  // sourced from a bot-inclusive store, not the user-only in-memory buffer.
  expect(ctx.historyTurns).toEqual([
    { role: 'user', content: 'can you write something for me?' },
    { role: 'assistant', content: 'what document?' },
  ]);
  expect(ctx.historyTurns.some((t) => t.role === 'assistant')).toBe(true);
});
