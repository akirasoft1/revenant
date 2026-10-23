// @mention / reply-to-bot chat shows progress for the WHOLE turn. It used to
// call channel.sendTyping() once — Discord drops that indicator after ~10s —
// so a multi-minute turn (grounded web search: 220s observed 2026-10-23)
// showed nothing at all, and users resent, assuming the bot had given up.
// Now: typing is kept alive until the reply is sent, and a turn past ~30s
// gets a ⏳ reaction on the user's message, removed when the answer posts.
jest.mock('../services/Mem0Service', () => jest.fn().mockImplementation(() => ({
  isEnabled: () => false,
})));

const DiscordBot = require('../bot');

describe('DiscordBot _handleMentionChat progress signals', () => {
  let fakeThis;
  let message;
  let reaction;
  let order;

  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const advance = async (ms) => { jest.advanceTimersByTime(ms); await flush(); };

  beforeEach(() => {
    jest.useFakeTimers();
    order = [];
    reaction = { users: { remove: jest.fn(async () => { order.push('unreact'); }) } };
    fakeThis = {
      client: { user: { id: 'bot-id-1', username: 'RevenantBot' } },
      mongoService: { recordChannelMessage: jest.fn().mockResolvedValue(undefined) },
      chatService: { chat: jest.fn() },
      _createImageAttachments: jest.fn().mockReturnValue([]),
      _splitMessage: jest.fn(),
      _recordBotReply: jest.fn().mockResolvedValue(undefined),
    };
    message = {
      id: 'msg-1',
      content: '<@bot-id-1> compare the S4 Revenant Gatling and the AD4B',
      author: { id: 'user-1', username: 'someuser', tag: 'someuser#0001' },
      guild: { id: 'guild-1' },
      channel: { id: 'chan-1', sendTyping: jest.fn().mockResolvedValue(undefined), send: jest.fn() },
      reply: jest.fn(async () => { order.push('reply'); return { id: 'reply-1' }; }),
      react: jest.fn(async () => { order.push('react'); return reaction; }),
    };
  });

  afterEach(() => jest.useRealTimers());

  test('a slow turn keeps typing alive, reacts ⏳ at 30s, and removes it after replying', async () => {
    let finish;
    fakeThis.chatService.chat.mockReturnValue(new Promise(r => { finish = r; }));
    const run = DiscordBot.prototype._handleMentionChat.call(fakeThis, message);
    await flush();
    expect(message.channel.sendTyping).toHaveBeenCalledTimes(1);

    await advance(24000);
    expect(message.channel.sendTyping).toHaveBeenCalledTimes(4);   // 0, 8, 16, 24s
    expect(message.react).not.toHaveBeenCalled();

    await advance(6000);
    expect(message.react).toHaveBeenCalledWith('⏳');

    finish({ success: true, message: 'Gatling for sustained fire.', images: [] });
    await run;
    expect(order).toEqual(['react', 'reply', 'unreact']);
    expect(reaction.users.remove).toHaveBeenCalledWith('bot-id-1');

    const typingCalls = message.channel.sendTyping.mock.calls.length;
    await advance(60000);
    expect(message.channel.sendTyping.mock.calls.length).toBe(typingCalls);
  });

  test('a fast turn gets no reaction', async () => {
    fakeThis.chatService.chat.mockResolvedValue({ success: true, message: 'Quick answer.', images: [] });
    await DiscordBot.prototype._handleMentionChat.call(fakeThis, message);
    await advance(60000);
    expect(message.react).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalled();
    expect(message.channel.sendTyping).toHaveBeenCalledTimes(1);
  });

  test('a failed slow turn still removes the reaction and stops typing', async () => {
    let fail;
    fakeThis.chatService.chat.mockReturnValue(new Promise((_, rej) => { fail = rej; }));
    const run = DiscordBot.prototype._handleMentionChat.call(fakeThis, message);
    await flush();
    await advance(31000);
    expect(message.react).toHaveBeenCalled();

    fail(new Error('boom'));
    await expect(run).rejects.toThrow('boom');
    expect(reaction.users.remove).toHaveBeenCalled();
    const typingCalls = message.channel.sendTyping.mock.calls.length;
    await advance(60000);
    expect(message.channel.sendTyping.mock.calls.length).toBe(typingCalls);
  });

  test('a reaction the bot cannot add (missing permission) never breaks the reply', async () => {
    message.react.mockRejectedValue(new Error('Missing Permissions'));
    let finish;
    fakeThis.chatService.chat.mockReturnValue(new Promise(r => { finish = r; }));
    const run = DiscordBot.prototype._handleMentionChat.call(fakeThis, message);
    await flush();
    await advance(31000);
    finish({ success: true, message: 'Answer.', images: [] });
    await expect(run).resolves.toBeUndefined();
    expect(message.reply).toHaveBeenCalled();
  });

  test('an unsuccessful chat result is replied to and the reaction removed', async () => {
    let finish;
    fakeThis.chatService.chat.mockReturnValue(new Promise(r => { finish = r; }));
    const run = DiscordBot.prototype._handleMentionChat.call(fakeThis, message);
    await flush();
    await advance(31000);
    finish({ success: false, error: 'Conversation expired.' });
    await run;
    expect(order).toEqual(['react', 'reply', 'unreact']);
  });
});
