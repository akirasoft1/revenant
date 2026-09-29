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
// Discord replies carry their referenced bot message. The reply target is
// named EXPLICITLY on the current turn via a `[Replying to your earlier
// message: "…"]` prefix (`currentTurn`), on every turn with a usable
// reference — whether or not the target is in the history window. History is
// never reordered or appended to.
//
// 2026-09-29 incident: the reply target WAS in the window, followed by a
// newer, unrelated question from another user. The old logic was a no-op for
// in-window targets, so the model resolved "they" to the newest topic (Ruin
// Station) instead of the replied-to message (Levski).
// ---------------------------------------------------------------------------
describe('buildTurnContext referencedMessage -> currentTurn prefix', () => {
  const REF = { id: 'bot-msg-9', content: 'Aaron Halo is the best spot for Aluminum.', authorId: 'bot-id' };
  const prefixed = (refText, msg) => `[Replying to your earlier message: "${refText}"]\n${msg}`;

  const LEVSKI_Q = 'are there any ship parts or fps equipment that are unique to Levski that you cannot buy anywhere else?';
  const LEVSKI_A = 'yeah, uex has dozens of exclusives logged there — e.g. the FS-9 LMG variant, a couple of armor sets, and several ship components you won\'t find in Stanton.';
  const PASTED = 'Levski shops:\n- Teach\'s Ship Shop\n- Conscientious Objects\n- Cousin Crow\'s';
  const RUIN_Q = 'what are unique items only available for purchase at Ruin Station in Pyro?';
  const CURRENT = 'Are they unique just due to their look or name or do these item have unique improved stats?';

  test('2026-09-29 regression: in-window target + newer unrelated question -> history chronological, currentTurn names the Levski message in full', async () => {
    const svc = makeChat();
    const docs = [
      { messageId: 'u1', content: LEVSKI_Q, isBot: false, authorId: 'user-a' },
      { messageId: '1554284024082731139', content: LEVSKI_A, isBot: true },
      { messageId: 'u2', content: PASTED, isBot: false, authorId: 'user-a' },
      { messageId: 'u3', content: RUIN_Q, isBot: false, authorId: 'user-b' },
      { messageId: 'cur', content: CURRENT, isBot: false, authorId: 'user-a' },
    ];
    svc.mongoService.getRecentChannelMessages = async () => docs;
    const ctx = await svc.buildTurnContext({
      userId: 'user-a', channelId: 'c1', userMessage: CURRENT,
      referencedMessage: { id: '1554284024082731139', content: LEVSKI_A, authorId: 'bot-id' },
    });
    // History: chronological, unchanged except the deduped current turn.
    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: LEVSKI_Q },
      { role: 'assistant', content: LEVSKI_A },
      { role: 'user', content: PASTED },
      { role: 'user', content: RUIN_Q },
    ]);
    expect(ctx.currentTurn).toBe(prefixed(LEVSKI_A, CURRENT));
  });

  test('does not truncate a long referenced message', async () => {
    const svc = makeChat();
    const long = 'x'.repeat(5000) + ' END';
    const ctx = await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'why?', referencedMessage: { id: 'r', content: long },
    });
    expect(ctx.currentTurn).toBe(prefixed(long, 'why?'));
  });

  test('out-of-window reference -> prefix, and NO assistant turn appended to history', async () => {
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
    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: 'unrelated chatter' },
      { role: 'assistant', content: 'unrelated bot reply' },
    ]);
    expect(ctx.currentTurn).toBe(prefixed(REF.content, 'and where would it be best to refine it?'));
  });

  test('dedupe still compares against the RAW userMessage (prefix applied after _dropDuplicatedCurrentTurn)', async () => {
    const svc = makeChat();
    svc.mongoService.getRecentChannelMessages = async () => ([
      { messageId: 'bot-msg-9', content: 'Aaron Halo.', isBot: true },
      { messageId: 'cur', content: '<@123> refine it where?', isBot: false },
    ]);
    const ctx = await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'refine it where?', referencedMessage: REF,
    });
    expect(ctx.historyTurns).toEqual([{ role: 'assistant', content: 'Aaron Halo.' }]);
    expect(ctx.currentTurn).toBe(prefixed(REF.content, 'refine it where?'));
  });

  test('strips display-only decoration (fallback banner, <url> wrapping) from the prefix', async () => {
    const svc = makeChat();
    svc.mongoService.getRecentChannelMessages = async () => ([]);
    const ctx = await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'more?',
      referencedMessage: {
        id: 'x',
        content: '> *⚠️ Memory and channel personality unavailable — answered without them*\n\nSee <https://example.com/a> and [wiki](<https://w.example/b>).',
      },
    });
    expect(ctx.historyTurns).toEqual([]);
    expect(ctx.currentTurn).toBe(prefixed('See https://example.com/a and [wiki](https://w.example/b).', 'more?'));
  });

  test('no referencedMessage -> currentTurn equals userMessage, history unchanged', async () => {
    const ctx = await makeChat().buildTurnContext({ userId: 'u1', channelId: 'c1', userMessage: 'hi' });
    expect(ctx.currentTurn).toBe('hi');
    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: 'can you write something for me?' },
      { role: 'assistant', content: 'what document?' },
    ]);
  });

  test('empty/whitespace (or decoration-only) referenced content -> no prefix, history unchanged', async () => {
    const base = await makeChat().buildTurnContext({ userId: 'u1', channelId: 'c1', userMessage: 'hi' });
    for (const content of ['   ', '', '> *⚠️ fallback*\n\n', null]) {
      const ctx = await makeChat().buildTurnContext({
        userId: 'u1', channelId: 'c1', userMessage: 'hi', referencedMessage: { id: 'z', content },
      });
      expect(ctx.currentTurn).toBe('hi');
      expect(ctx.historyTurns).toEqual(base.historyTurns);
    }
  });

  test('prefixes even when the history lookup failed', async () => {
    const svc = makeChat();
    svc.mongoService.getRecentChannelMessages = async () => { throw new Error('mongo down'); };
    const ctx = await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'refine?', referencedMessage: REF,
    });
    expect(ctx.historyTurns).toEqual([]);
    expect(ctx.currentTurn).toBe(prefixed(REF.content, 'refine?'));
  });

  test('recall is queried with the RAW user text, not the annotated turn', async () => {
    const svc = makeChat();
    const spy = jest.spyOn(svc, '_composeRecallContexts');
    await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'refine?', referencedMessage: REF,
    });
    expect(spy.mock.calls[0][1]).toBe('refine?');
  });
});

describe('chat() forwards options.referencedMessage to buildTurnContext', () => {
  function makeAgentChat(ctx = { systemPrompt: 's', memoryBlock: '', historyTurns: [] }) {
    const svc = makeChat();
    svc.agentClient = {
      isHealthy: () => true,
      chat: jest.fn(async () => ({ messageText: 'ok', summary: null, fallbackOccurred: false })),
    };
    jest.spyOn(svc, 'buildTurnContext').mockResolvedValue(ctx);
    return svc;
  }

  test('passes the referenced message through', async () => {
    const svc = makeAgentChat();
    const ref = { id: 'r1', content: 'prior answer', authorId: 'bot' };
    await svc.chat('channel-voice', 'follow up', { id: 'u1', username: 'a' }, 'c1', 'g1', null, { referencedMessage: ref });
    expect(svc.buildTurnContext).toHaveBeenCalledWith(expect.objectContaining({ referencedMessage: ref }));
    // buildTurnContext itself receives the RAW text (recall + dedupe key).
    expect(svc.buildTurnContext.mock.calls[0][0].userMessage).toBe('follow up');
  });

  test('omitting options passes no referenced message', async () => {
    const svc = makeAgentChat();
    await svc.chat('channel-voice', 'hi', { id: 'u1', username: 'a' }, 'c1', 'g1');
    expect(svc.buildTurnContext.mock.calls[0][0].referencedMessage).toBeNull();
  });

  test('sends buildTurnContext\'s annotated currentTurn as the agent userMessage', async () => {
    const svc = makeAgentChat({
      systemPrompt: 's', memoryBlock: '', historyTurns: [],
      currentTurn: '[Replying to your earlier message: "prior answer"]\nfollow up',
    });
    await svc.chat('channel-voice', 'follow up', { id: 'u1', username: 'a' }, 'c1', 'g1', null,
      { referencedMessage: { id: 'r1', content: 'prior answer' } });
    expect(svc.agentClient.chat.mock.calls[0][0].userMessage)
      .toBe('[Replying to your earlier message: "prior answer"]\nfollow up');
  });

  test('end-to-end (real buildTurnContext): agentClient.chat gets the annotated turn and chronological history', async () => {
    const svc = makeChat();
    svc.agentClient = {
      isHealthy: () => true,
      chat: jest.fn(async () => ({ messageText: 'ok', summary: null, fallbackOccurred: false })),
    };
    svc.mongoService.getRecentChannelMessages = async () => ([
      { messageId: 'b1', content: 'Levski has exclusives.', isBot: true },
      { messageId: 'u3', content: 'what about Ruin Station?', isBot: false },
      { messageId: 'cur', content: 'are they unique stats?', isBot: false },
    ]);
    await svc.chat('channel-voice', 'are they unique stats?', { id: 'u1', username: 'a' }, 'c1', 'g1', null,
      { referencedMessage: { id: 'b1', content: 'Levski has exclusives.' } });
    const sent = svc.agentClient.chat.mock.calls[0][0];
    expect(sent.userMessage).toBe('[Replying to your earlier message: "Levski has exclusives."]\nare they unique stats?');
    expect(sent.history).toEqual([
      { role: 'assistant', content: 'Levski has exclusives.' },
      { role: 'user', content: 'what about Ruin Station?' },
    ]);
  });

  test('buildTurnContext throws (degraded path) -> raw userMessage is still sent', async () => {
    const svc = makeAgentChat();
    svc.buildTurnContext.mockRejectedValue(new Error('boom'));
    await svc.chat('channel-voice', 'follow up', { id: 'u1', username: 'a' }, 'c1', 'g1', null,
      { referencedMessage: { id: 'r1', content: 'prior answer' } });
    expect(svc.agentClient.chat.mock.calls[0][0].userMessage).toBe('follow up');
  });

  test('a context without currentTurn (older mocks/shape) falls back to the raw userMessage', async () => {
    const svc = makeAgentChat();
    await svc.chat('channel-voice', 'hi', { id: 'u1', username: 'a' }, 'c1', 'g1');
    expect(svc.agentClient.chat.mock.calls[0][0].userMessage).toBe('hi');
  });
});
