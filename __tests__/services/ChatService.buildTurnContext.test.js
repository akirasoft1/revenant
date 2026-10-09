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
  // Every current turn now carries the speaker label (member identity
  // grounding). makeChat() has no speakerNames/registry and these calls pass
  // no userTag, so the u1 speaker resolves to 'Unknown'.
  const u1 = (msg) => `[Unknown · u1]: ${msg}`;

  const LEVSKI_Q = 'are there any ship parts or fps equipment that are unique to Levski that you cannot buy anywhere else?';
  const LEVSKI_A = 'yeah, uex has dozens of exclusives logged there — e.g. the FS-9 LMG variant, a couple of armor sets, and several ship components you won\'t find in Stanton.';
  const PASTED = 'Levski shops:\n- Teach\'s Ship Shop\n- Conscientious Objects\n- Cousin Crow\'s';
  const RUIN_Q = 'what are unique items only available for purchase at Ruin Station in Pyro?';
  const CURRENT = 'Are they unique just due to their look or name or do these item have unique improved stats?';

  test('2026-09-29 regression: in-window target + newer unrelated question -> history chronological, currentTurn names the Levski message in full', async () => {
    const svc = makeChat();
    const docs = [
      { messageId: 'u1', content: LEVSKI_Q, isBot: false, authorId: 'user-a', authorName: 'Ann' },
      { messageId: '1554284024082731139', content: LEVSKI_A, isBot: true },
      { messageId: 'u2', content: PASTED, isBot: false, authorId: 'user-a', authorName: 'Ann' },
      { messageId: 'u3', content: RUIN_Q, isBot: false, authorId: 'user-b', authorName: 'Ben' },
      { messageId: 'cur', content: CURRENT, isBot: false, authorId: 'user-a', authorName: 'Ann' },
    ];
    svc.mongoService.getRecentChannelMessages = async () => docs;
    const ctx = await svc.buildTurnContext({
      userId: 'user-a', channelId: 'c1', userMessage: CURRENT,
      referencedMessage: { id: '1554284024082731139', content: LEVSKI_A, authorId: 'bot-id' },
    });
    // History: chronological, unchanged except the deduped current turn.
    // User turns now carry `[Name · ID]: ` speaker labels.
    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: `[Ann · user-a]: ${LEVSKI_Q}` },
      { role: 'assistant', content: LEVSKI_A },
      { role: 'user', content: `[Ann · user-a]: ${PASTED}` },
      { role: 'user', content: `[Ben · user-b]: ${RUIN_Q}` },
    ]);
    expect(ctx.currentTurn).toBe(prefixed(LEVSKI_A, `[Ann · user-a]: ${CURRENT}`));
  });

  test('does not truncate a long referenced message', async () => {
    const svc = makeChat();
    const long = 'x'.repeat(5000) + ' END';
    const ctx = await svc.buildTurnContext({
      userId: 'u1', channelId: 'c1', userMessage: 'why?', referencedMessage: { id: 'r', content: long },
    });
    expect(ctx.currentTurn).toBe(prefixed(long, u1('why?')));
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
    expect(ctx.currentTurn).toBe(prefixed(REF.content, u1('and where would it be best to refine it?')));
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
    expect(ctx.currentTurn).toBe(prefixed(REF.content, u1('refine it where?')));
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
    expect(ctx.currentTurn).toBe(prefixed('See https://example.com/a and [wiki](https://w.example/b).', u1('more?')));
  });

  test('no referencedMessage -> currentTurn is just the labelled userMessage, history unchanged', async () => {
    const ctx = await makeChat().buildTurnContext({ userId: 'u1', channelId: 'c1', userMessage: 'hi' });
    expect(ctx.currentTurn).toBe(u1('hi'));
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
      expect(ctx.currentTurn).toBe(u1('hi'));
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
    expect(ctx.currentTurn).toBe(prefixed(REF.content, u1('refine?')));
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
    // chat() passes the Discord user as the speaker -> username 'a'.
    expect(sent.userMessage).toBe('[Replying to your earlier message: "Levski has exclusives."]\n[a · u1]: are they unique stats?');
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

// ---------------------------------------------------------------------------
// Member identity grounding: every user history turn and the current turn are
// labelled `[Name · Discord ID]: …`, and a scoped "People in this
// conversation" roster is appended to the system prompt.
//
// Incident: someone wrote "Akira …" in a message to the bot, Akira then
// replied, and the bot did not know the replier IS Akira.
// ---------------------------------------------------------------------------
describe('buildTurnContext member identity grounding', () => {
  const { createSpeakerNames } = require('../../services/SpeakerNames');
  const AKIRA = '161644375040983040';
  const BOB = '222333444555666777';
  const CAROL = '888999000111222333';
  const RECORDS = [
    { discordId: AKIRA, addressName: 'Akira', aliases: ['Akirasoft', 'Phalabala'] },
    { discordId: CAROL, addressName: 'Carol', aliases: ['Caz'] },
  ];
  const ROSTER_HEAD = '\n\n## People in this conversation\nMessages are labelled [Name · Discord ID]. "I", "me" and "my" mean the labelled speaker of that message. Use this list only to work out who is who; don\'t mention these aliases unless it matters. Never start your own replies with a label.\n';

  function makeIdentity(records = RECORDS) {
    const byId = new Map(records.map((r) => [r.discordId, r]));
    return { get: (id) => byId.get(id) || null, all: () => records.slice(), isLoaded: () => true };
  }

  function makeIdentityChat(docs, { identity = makeIdentity() } = {}) {
    const svc = makeChat();
    svc.memberIdentity = identity;
    svc.speakerNames = createSpeakerNames({ overrides: {}, identity });
    svc.mongoService.getRecentChannelMessages = async () => docs;
    return svc;
  }

  test('incident replay: an alias mentioned by another user maps to the current speaker', async () => {
    const svc = makeIdentityChat([
      { authorId: BOB, authorName: 'bob', content: 'Akira, did you ever fit the Scorpius with the new shields?', isBot: false },
      { authorId: 'bot-id', authorName: 'Revenant', content: 'Not that I know of.', isBot: true },
      { authorId: AKIRA, authorName: 'akirasoft', content: 'yeah I did, last night', isBot: false },
    ]);
    const ctx = await svc.buildTurnContext({
      userId: AKIRA, userTag: 'akirasoft', channelId: 'c1', userMessage: 'yeah I did, last night',
      speaker: { id: AKIRA, username: 'akirasoft', globalName: 'Akirasoft' },
    });

    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: `[bob · ${BOB}]: Akira, did you ever fit the Scorpius with the new shields?` },
      { role: 'assistant', content: 'Not that I know of.' },
    ]);
    expect(ctx.currentTurn).toBe(`[Akira · ${AKIRA}]: yeah I did, last night`);
    expect(ctx.systemPrompt.endsWith(
      `${ROSTER_HEAD}- Akira (Discord ${AKIRA}) — also called Akirasoft, Phalabala; address as Akira  ← current speaker\n- bob (Discord ${BOB})`,
    )).toBe(true);
    // Non-participant registry member (Carol) is never listed.
    expect(ctx.systemPrompt).not.toContain(CAROL);
  });

  test('a registry member mentioned by alias (whole word) is listed even when not a participant', async () => {
    const svc = makeIdentityChat([
      { authorId: BOB, authorName: 'bob', content: 'ask Caz about mining', isBot: false },
    ]);
    const ctx = await svc.buildTurnContext({ userId: BOB, userTag: 'bob', channelId: 'c1', userMessage: 'well?' });
    expect(ctx.systemPrompt).toContain(`- Carol (Discord ${CAROL}) — also called Caz; address as Carol`);
    expect(ctx.systemPrompt).toContain(`- bob (Discord ${BOB})  ← current speaker`);
    expect(ctx.systemPrompt).not.toContain(AKIRA);
  });

  test('whole-word only: "Caz" inside "Cazzle" does not pull Carol in', async () => {
    const svc = makeIdentityChat([{ authorId: BOB, authorName: 'bob', content: 'Cazzle is a game', isBot: false }]);
    const ctx = await svc.buildTurnContext({ userId: BOB, userTag: 'bob', channelId: 'c1', userMessage: 'hmm' });
    expect(ctx.systemPrompt).not.toContain(CAROL);
  });

  test('bot turns stay unlabelled; rows without authorId stay unlabelled', async () => {
    const svc = makeIdentityChat([
      { content: 'legacy row with no author', isBot: false },
      { authorId: 'bot', authorName: 'Revenant', content: 'voice bot reply', isBot: true },
    ]);
    const ctx = await svc.buildTurnContext({ userId: BOB, userTag: 'bob', channelId: 'c1', userMessage: 'hi' });
    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: 'legacy row with no author' },
      { role: 'assistant', content: 'voice bot reply' },
    ]);
    expect(ctx.currentTurn).toBe(`[bob · ${BOB}]: hi`);
  });

  test('dedupe still compares RAW text before labelling, and history/doc alignment survives the drop', async () => {
    const svc = makeIdentityChat([
      { authorId: BOB, authorName: 'bob', content: 'first', isBot: false },
      { authorId: AKIRA, authorName: 'akirasoft', content: '<@1> current msg', isBot: false },
    ]);
    const ctx = await svc.buildTurnContext({ userId: AKIRA, userTag: 'akirasoft', channelId: 'c1', userMessage: 'current msg' });
    expect(ctx.historyTurns).toEqual([{ role: 'user', content: `[bob · ${BOB}]: first` }]);
    expect(ctx.currentTurn).toBe(`[Akira · ${AKIRA}]: current msg`);
  });

  test('reply prefix composes as prefix line, then the labelled message', async () => {
    const svc = makeIdentityChat([]);
    const ctx = await svc.buildTurnContext({
      userId: AKIRA, userTag: 'akirasoft', channelId: 'c1', userMessage: 'are they unique?',
      referencedMessage: { id: 'b1', content: 'Levski has exclusives.' },
    });
    expect(ctx.currentTurn).toBe(`[Replying to your earlier message: "Levski has exclusives."]\n[Akira · ${AKIRA}]: are they unique?`);
  });

  test('registry unavailable (throws) -> no crash, labels fall back to stored authorName, no aliases', async () => {
    const broken = { get: () => { throw new Error('boom'); }, all: () => { throw new Error('boom'); }, isLoaded: () => false };
    const svc = makeIdentityChat([
      { authorId: BOB, authorName: 'bob', content: 'Akira, you there?', isBot: false },
      { authorId: AKIRA, authorName: 'akirasoft', content: 'older', isBot: false },
    ], { identity: broken });
    const ctx = await svc.buildTurnContext({ userId: AKIRA, userTag: 'akirasoft', channelId: 'c1', userMessage: 'yes' });
    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: `[bob · ${BOB}]: Akira, you there?` },
      { role: 'user', content: `[akirasoft · ${AKIRA}]: older` },
    ]);
    expect(ctx.currentTurn).toBe(`[akirasoft · ${AKIRA}]: yes`);
    expect(ctx.systemPrompt).toContain(`- akirasoft (Discord ${AKIRA})  ← current speaker`);
    expect(ctx.systemPrompt).not.toContain('also called');
  });

  test('no memberIdentity/speakerNames at all -> stored authorName labels, userTag for the current speaker', async () => {
    const svc = makeChat();
    svc.mongoService.getRecentChannelMessages = async () => ([
      { authorId: BOB, authorName: 'bob', content: 'yo', isBot: false },
    ]);
    const ctx = await svc.buildTurnContext({ userId: AKIRA, userTag: 'akirasoft', channelId: 'c1', userMessage: 'hey' });
    expect(ctx.historyTurns).toEqual([{ role: 'user', content: `[bob · ${BOB}]: yo` }]);
    expect(ctx.currentTurn).toBe(`[akirasoft · ${AKIRA}]: hey`);
    expect(ctx.systemPrompt).toContain(`- akirasoft (Discord ${AKIRA})  ← current speaker\n- bob (Discord ${BOB})`);
  });

  test('voice-style call (userMessage: \'\') -> labelled history + roster with the session opener as current speaker', async () => {
    const svc = makeIdentityChat([
      { authorId: BOB, authorName: 'bob', content: 'what is Phalabala up to?', isBot: false },
      { authorId: 'bot', authorName: 'Revenant', content: 'no idea', isBot: true },
    ]);
    const ctx = await svc.buildTurnContext({
      userId: CAROL, userTag: '', channelId: 'c1', guildId: 'g1', userMessage: '', personalityId: 'channel-voice',
    });
    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: `[bob · ${BOB}]: what is Phalabala up to?` },
      { role: 'assistant', content: 'no idea' },
    ]);
    expect(ctx.currentTurn).toBe('');
    expect(ctx.systemPrompt).toContain(`${ROSTER_HEAD}- Carol (Discord ${CAROL}) — also called Caz; address as Carol  ← current speaker\n- bob (Discord ${BOB})\n- Akira (Discord ${AKIRA}) — also called Akirasoft, Phalabala; address as Akira`);
  });

  test('one name per person: registry name, then stored authorName, then Discord names (history + current turn agree)', async () => {
    // Bob has no registry record; his stored authorName is 'Bobby' and his
    // Discord globalName 'Robert'. Akira's registry name beats both.
    const svc = makeIdentityChat([
      { authorId: BOB, authorName: 'Bobby', content: 'earlier', isBot: false },
      { authorId: AKIRA, authorName: 'akirasoft', content: 'hey', isBot: false },
    ]);
    const ctx = await svc.buildTurnContext({
      userId: BOB, userTag: 'robert1', channelId: 'c1', userMessage: 'again',
      speaker: { id: BOB, username: 'robert1', globalName: 'Robert' },
    });
    expect(ctx.historyTurns).toEqual([
      { role: 'user', content: `[Bobby · ${BOB}]: earlier` },
      { role: 'user', content: `[Akira · ${AKIRA}]: hey` },
    ]);
    expect(ctx.currentTurn).toBe(`[Bobby · ${BOB}]: again`);
    expect(ctx.systemPrompt).not.toContain('Robert');

    // No stored row for the speaker -> Discord names via resolve(speaker).
    const svc2 = makeIdentityChat([]);
    const ctx2 = await svc2.buildTurnContext({
      userId: BOB, userTag: 'robert1', channelId: 'c1', userMessage: 'hi',
      speaker: { id: BOB, username: 'robert1', globalName: 'Robert' },
    });
    expect(ctx2.currentTurn).toBe(`[Robert · ${BOB}]: hi`);
  });

  test('recall is still queried with the RAW text', async () => {
    const svc = makeIdentityChat([]);
    const spy = jest.spyOn(svc, '_composeRecallContexts');
    await svc.buildTurnContext({ userId: AKIRA, channelId: 'c1', userMessage: 'raw text' });
    expect(spy.mock.calls[0][1]).toBe('raw text');
  });

  test('chat() passes the Discord user as the speaker', async () => {
    const svc = makeChat();
    svc.agentClient = {
      isHealthy: () => true,
      chat: jest.fn(async () => ({ messageText: 'ok', summary: null, fallbackOccurred: false })),
    };
    const spy = jest.spyOn(svc, 'buildTurnContext');
    const user = { id: AKIRA, username: 'akirasoft', globalName: 'Akirasoft' };
    await svc.chat('channel-voice', 'hi', user, 'c1', 'g1');
    expect(spy.mock.calls[0][0].speaker).toBe(user);
    expect(svc.agentClient.chat.mock.calls[0][0].userMessage).toBe(`[Akirasoft · ${AKIRA}]: hi`);
  });
});
