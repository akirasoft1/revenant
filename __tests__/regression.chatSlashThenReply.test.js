// Regression: the reported context-loss bug, end-to-end at the unit level.
//
// 1. `/chat what would be the best place to mine high quality Aluminum in star citizen?`
//    -> correct answer.
// 2. The user Discord-REPLIES to that bot message: "and where would it be best to refine it?"
//    -> the bot answered from unrelated older history; the Aluminum Q&A was gone.
//
// Root cause: agent history comes ONLY from channel_messages, /chat recorded
// neither side of its exchange, and the reply fall-through dropped the
// referenced message. This wires the REAL ChatSlashCommand, the REAL
// ChatService.buildTurnContext / chat, and the REAL bot reply path against an
// in-memory channel_messages store, and asserts what the agent actually receives.
jest.mock('../services/Mem0Service', () => jest.fn().mockImplementation(() => ({
  isEnabled: () => false,
})));

const DiscordBot = require('../bot');
const ChatService = require('../services/ChatService');
const ChatSlashCommand = require('../commands/slash/ChatCommand');

const Q = 'what would be the best place to mine high quality Aluminum in star citizen?';
const A = 'Aaron Halo quantanium belt — look for high-quality Aluminum deposits there.';
const FOLLOW_UP = 'and where would it be best to refine it?';

function makeStore() {
  const rows = [];
  return {
    rows,
    recordChannelMessage: jest.fn(async (doc) => { rows.push(doc); }),
    getRecentChannelMessages: jest.fn(async (channelId, limit) =>
      rows.filter((r) => r.channelId === channelId).slice(-limit)),
  };
}

function makeChatService(mongoService, agentReplies) {
  const svc = Object.create(ChatService.prototype);
  svc.config = { channelContext: { promptRecentCount: 10 } };
  svc.mongoService = mongoService;
  // Recall/prompt composition is out of scope here; history is the subject.
  svc._composeRecallContexts = async () => ({});
  svc._buildGroupSystemPrompt = () => 'SYSTEM';
  svc.agentClient = {
    isHealthy: () => true,
    chat: jest.fn(async () => ({ messageText: agentReplies.shift(), summary: null, fallbackOccurred: false })),
  };
  return svc;
}

describe('regression: /chat Q&A then a Discord reply follow-up keeps the context', () => {
  const botUser = { id: 'bot-id', username: 'RevenantBot' };
  let store;
  let chatService;
  let bot;
  let slashReply;

  async function runSlashChat() {
    const cmd = new ChatSlashCommand(chatService, {
      mongoService: store,
      speakerNames: { resolve: () => 'Mike' },
      getBotUser: () => botUser,
    });
    slashReply = { id: 'bot-slash-reply', content: `**Prompt:** ${Q}\n\n${A}`, author: botUser };
    await cmd.execute({
      id: 'interaction-1',
      user: { id: 'user-1', username: 'inc1067' },
      member: null,
      channel: { id: 'chan-1' },
      guild: { id: 'guild-1' },
      options: { getString: () => Q, getAttachment: () => null },
      editReply: jest.fn(async () => slashReply),
      followUp: jest.fn(),
      deferred: true,
      replied: false,
    }, {});
  }

  function followUpMessage() {
    // bot.js's messageCreate recorder persists the reply BEFORE chat runs.
    store.rows.push({
      messageId: 'msg-followup', channelId: 'chan-1', guildId: 'guild-1',
      authorId: 'user-1', authorName: 'Mike', content: FOLLOW_UP, timestamp: new Date(),
    });
    return {
      id: 'msg-followup',
      content: FOLLOW_UP,
      author: { id: 'user-1', username: 'inc1067', tag: 'inc1067' },
      guild: { id: 'guild-1' },
      channel: { id: 'chan-1', sendTyping: jest.fn(async () => {}), send: jest.fn() },
      reply: jest.fn(async () => ({ id: 'bot-followup-reply' })),
    };
  }

  beforeEach(() => {
    store = makeStore();
    chatService = makeChatService(store, [A, 'Refine it at a refinery deck, e.g. ARC-L1.']);
    bot = {
      client: { user: botUser },
      mongoService: store,
      chatService,
      replyHandler: { handleReply: jest.fn(async () => false) },
      _createImageAttachments: () => [],
      _splitMessage: jest.fn(),
      _recordBotReply: DiscordBot.prototype._recordBotReply,
    };
    bot._handleMentionChat = DiscordBot.prototype._handleMentionChat.bind(bot);
  });

  test('the /chat Q&A is recorded and reaches the follow-up turn as history', async () => {
    await runSlashChat();

    // The /chat turn itself did not see its own prompt twice.
    const firstCall = chatService.agentClient.chat.mock.calls[0][0];
    expect(firstCall.userMessage).toBe(Q);
    expect(firstCall.history.filter((t) => t.content === Q)).toHaveLength(0);

    // Both sides are in channel_messages.
    expect(store.rows.map((r) => [!!r.isBot, r.content])).toEqual([[false, Q], [true, A]]);

    const msg = followUpMessage();
    await DiscordBot.prototype._handleReplyToBot.call(bot, msg, slashReply);

    const second = chatService.agentClient.chat.mock.calls[1][0];
    expect(second.userMessage).toBe(FOLLOW_UP);
    expect(second.history).toEqual([
      { role: 'user', content: Q },
      { role: 'assistant', content: A },
    ]);
  });

  test('even when the Q&A has scrolled out of the window, the replied-to answer is injected', async () => {
    await runSlashChat();
    for (let i = 0; i < 12; i++) {
      store.rows.push({ messageId: `noise-${i}`, channelId: 'chan-1', content: `unrelated ${i}`, timestamp: new Date() });
    }

    const msg = followUpMessage();
    await DiscordBot.prototype._handleReplyToBot.call(bot, msg, slashReply);

    const history = chatService.agentClient.chat.mock.calls[1][0].history;
    expect(history.some((t) => t.content === A)).toBe(false); // Q&A rows are out of the 10-row window...
    // ...but the referenced message (the /chat reply as Discord shows it,
    // prompt header included) sits right before the current turn.
    expect(history[history.length - 1]).toEqual({ role: 'assistant', content: `**Prompt:** ${Q}\n\n${A}` });
    expect(history.filter((t) => t.content === FOLLOW_UP)).toHaveLength(0);
  });
});
