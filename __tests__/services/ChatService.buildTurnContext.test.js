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

test('buildTurnContext drops a trailing history turn that duplicates the current userMessage (already-persisted race)', async () => {
  const svc = makeChat();
  // Simulate bot.js's fire-and-forget persist of the incoming message having
  // already landed in channel_messages by the time buildTurnContext reads it —
  // the last doc is the CURRENT turn, with raw Discord mention markup intact.
  svc.mongoService.getRecentChannelMessages = async () => ([
    { authorName: 'alice', content: 'can you write something for me?', isBot: false },
    { authorName: 'bot', content: 'what document?', isBot: true },
    { authorName: 'alice', content: '<@1234567890> craft it from scratch', isBot: false },
  ]);

  const ctx = await svc.buildTurnContext({
    userId: 'u1', channelId: 'c1', userMessage: 'craft it from scratch', personalityId: 'channel-voice',
  });

  // Prior turns are preserved...
  expect(ctx.historyTurns).toEqual([
    { role: 'user', content: 'can you write something for me?' },
    { role: 'assistant', content: 'what document?' },
  ]);
  // ...but the duplicated current turn must not appear at all.
  const dupCount = ctx.historyTurns.filter((t) => t.role === 'user' && t.content.includes('craft it from scratch')).length;
  expect(dupCount).toBe(0);
});

test('buildTurnContext is a no-op when the current turn has NOT yet been persisted (no race)', async () => {
  const svc = makeChat();
  // History ends on the bot's prior reply — current user message never landed
  // in channel_messages yet. Nothing should be dropped.
  const ctx = await svc.buildTurnContext({
    userId: 'u1', channelId: 'c1', userMessage: 'craft it from scratch', personalityId: 'channel-voice',
  });

  expect(ctx.historyTurns).toEqual([
    { role: 'user', content: 'can you write something for me?' },
    { role: 'assistant', content: 'what document?' },
  ]);
});

test('buildTurnContext does not drop a real trailing user turn when userMessage is empty (voice path)', async () => {
  const svc = makeChat();
  svc.mongoService.getRecentChannelMessages = async () => ([
    { authorName: 'bot', content: 'what document?', isBot: true },
    { authorName: 'alice', content: 'the quarterly report', isBot: false },
  ]);

  const ctx = await svc.buildTurnContext({
    userId: 'u1', channelId: 'c1', userMessage: '', personalityId: 'channel-voice',
  });

  expect(ctx.historyTurns).toEqual([
    { role: 'assistant', content: 'what document?' },
    { role: 'user', content: 'the quarterly report' },
  ]);
});
