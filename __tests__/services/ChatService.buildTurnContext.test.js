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
  svc.config = { recall: { enabled: true, promptMaxTokens: 4000 } };
  svc.channelContextService = {
    isChannelTracked: () => true,
    getRecentMessagesRaw: () => ([
      { authorName: 'alice', content: 'hey', isBot: false },
      { authorName: 'bot', content: 'hi', isBot: true },
    ]),
    buildRecentContext: async () => '\n\nRecent channel conversation:\n[alice]: hey',
  };
  svc.voiceProfileService = { getProfile: () => ({ voiceInstructions: 'TALK LIKE THE CREW' }) };
  svc.qdrantService = { search: async () => [] };
  svc.recallService = { recall: async () => ({ block: '\n\n## Memory Context\nalice likes nmap', candidates: [{}], query: 'q' }) };
  svc.mem0Service = { isEnabled: () => false };
  return svc;
}

test('buildTurnContext resolves voice profile, returns separate memory + history', async () => {
  const svc = makeChat();
  const ctx = await svc.buildTurnContext({
    userId: 'u1', channelId: 'c1', userMessage: 'what did alice say?', personalityId: 'channel-voice',
  });
  expect(ctx.systemPrompt).toContain('TALK LIKE THE CREW');   // dynamic voice profile substituted
  expect(ctx.systemPrompt).not.toContain('{VOICE_INSTRUCTIONS}'); // no leftover placeholder
  expect(ctx.systemPrompt).not.toContain('## Memory Context');    // memory kept separate
  expect(ctx.memoryBlock).toContain('alice likes nmap');
  expect(ctx.historyTurns).toEqual([
    { role: 'user', content: 'hey' },
    { role: 'assistant', content: 'hi' },
  ]);
});
