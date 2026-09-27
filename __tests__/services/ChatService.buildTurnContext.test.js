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

test('buildTurnContext preserves a trailing user turn that merely ENDS WITH userMessage but is not an exact match', async () => {
  const svc = makeChat();
  // Prior turn is a genuinely different message that happens to end with the
  // short current userMessage ("ok"). A fuzzy endsWith match would wrongly
  // drop this real turn; exact normalized-equality must not.
  svc.mongoService.getRecentChannelMessages = async () => ([
    { authorName: 'bot', content: 'let me know if that\'s ok', isBot: true },
    { authorName: 'alice', content: 'sounds ok', isBot: false },
  ]);

  const ctx = await svc.buildTurnContext({
    userId: 'u1', channelId: 'c1', userMessage: 'ok', personalityId: 'channel-voice',
  });

  expect(ctx.historyTurns).toEqual([
    { role: 'assistant', content: 'let me know if that\'s ok' },
    { role: 'user', content: 'sounds ok' },
  ]);
});

// ---------------------------------------------------------------------------
// Discord replies carry their referenced bot message. A reply's explicit
// target used to be dropped whenever it had scrolled out of the
// promptRecentCount history window, so "and where would it be best to refine
// it?" was answered from unrelated history.
// ---------------------------------------------------------------------------
describe('buildTurnContext referencedMessage injection', () => {
  const REF = { id: 'bot-msg-9', content: 'Aaron Halo is the best spot for Aluminum.', authorId: 'bot-id' };

  test('injects the referenced bot message as an assistant turn when it is outside the window, right before the current turn', async () => {
    const svc = makeChat();
    svc.mongoService.getRecentChannelMessages = async () => ([
      { messageId: 'm1', content: 'unrelated chatter', isBot: false },
      { messageId: 'm2', content: 'unrelated bot reply', isBot: true },
      { messageId: 'cur', content: 'and where would it be best to refine it?', isBot: false },
    ]);
    const ctx = await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'and where would it be best to refine it?',
      referencedMessage: REF,
    });
    // Current turn deduped away, referenced message appended last (i.e.
    // immediately before the separately-forwarded current user turn).
    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: 'unrelated chatter' },
      { role: 'assistant', content: 'unrelated bot reply' },
      { role: 'assistant', content: REF.content },
    ]);
  });

  test('does NOT inject when the referenced message is already in the window (matched by messageId)', async () => {
    const svc = makeChat();
    svc.mongoService.getRecentChannelMessages = async () => ([
      { messageId: 'u-q', content: 'best place for Aluminum?', isBot: false },
      // Stored content is the raw model output; the Discord message differs.
      { messageId: 'bot-msg-9', content: 'Aaron Halo.', isBot: true },
    ]);
    const ctx = await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'refine it where?', referencedMessage: REF,
    });
    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: 'best place for Aluminum?' },
      { role: 'assistant', content: 'Aaron Halo.' },
    ]);
  });

  test('does NOT inject when an in-window row has the exact same content (rows without messageId)', async () => {
    const svc = makeChat();
    svc.mongoService.getRecentChannelMessages = async () => ([
      { content: REF.content, isBot: true },
    ]);
    const ctx = await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'refine it where?', referencedMessage: REF,
    });
    expect(ctx.historyTurns).toEqual([{ role: 'assistant', content: REF.content }]);
  });

  test('strips display-only decoration (fallback banner, <url> wrapping) from the injected content', async () => {
    const svc = makeChat();
    svc.mongoService.getRecentChannelMessages = async () => ([]);
    const ctx = await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'more?',
      referencedMessage: {
        id: 'x',
        content: '> *⚠️ Memory and channel personality unavailable — answered without them*\n\nSee <https://example.com/a> and [wiki](<https://w.example/b>).',
      },
    });
    expect(ctx.historyTurns).toEqual([
      { role: 'assistant', content: 'See https://example.com/a and [wiki](https://w.example/b).' },
    ]);
  });

  test('no referencedMessage (or an empty one) -> history unchanged', async () => {
    const base = await makeChat().buildTurnContext({ userId: 'u1', channelId: 'c1', userMessage: 'hi' });
    const withEmpty = await makeChat().buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'hi', referencedMessage: { id: 'z', content: '   ' },
    });
    expect(withEmpty.historyTurns).toEqual(base.historyTurns);
  });

  test('injects even when the history lookup failed', async () => {
    const svc = makeChat();
    svc.mongoService.getRecentChannelMessages = async () => { throw new Error('mongo down'); };
    const ctx = await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'refine?', referencedMessage: REF,
    });
    expect(ctx.historyTurns).toEqual([{ role: 'assistant', content: REF.content }]);
  });
});

describe('chat() forwards options.referencedMessage to buildTurnContext', () => {
  function makeAgentChat() {
    const svc = makeChat();
    svc.agentClient = {
      isHealthy: () => true,
      chat: jest.fn(async () => ({ messageText: 'ok', summary: null, fallbackOccurred: false })),
    };
    jest.spyOn(svc, 'buildTurnContext').mockResolvedValue({ systemPrompt: 's', memoryBlock: '', historyTurns: [] });
    return svc;
  }

  test('passes the referenced message through', async () => {
    const svc = makeAgentChat();
    const ref = { id: 'r1', content: 'prior answer', authorId: 'bot' };
    await svc.chat('channel-voice', 'follow up', { id: 'u1', username: 'a' }, 'c1', 'g1', null, { referencedMessage: ref });
    expect(svc.buildTurnContext).toHaveBeenCalledWith(expect.objectContaining({ referencedMessage: ref }));
  });

  test('omitting options passes no referenced message', async () => {
    const svc = makeAgentChat();
    await svc.chat('channel-voice', 'hi', { id: 'u1', username: 'a' }, 'c1', 'g1');
    expect(svc.buildTurnContext.mock.calls[0][0].referencedMessage).toBeNull();
  });
});
