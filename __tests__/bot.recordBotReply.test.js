// Mem0Service pulls in mem0ai/oss -> sqlite3's native binding, which is built
// against a newer glibc than this environment ships (unrelated to this
// change). Stub it out so requiring bot.js for this unit test doesn't
// transitively load that native module.
jest.mock('../services/Mem0Service', () => jest.fn().mockImplementation(() => ({
  isEnabled: () => false,
})));

const DiscordBot = require('../bot');

describe('DiscordBot _handleMentionChat - bot reply persistence', () => {
  let fakeThis;
  let message;
  let sentReply;

  beforeEach(() => {
    sentReply = { id: 'reply-123', channel: { id: 'chan-1' }, guild: { id: 'guild-1' } };

    fakeThis = {
      client: { user: { id: 'bot-id-1', username: 'RevenantBot' } },
      mongoService: { recordChannelMessage: jest.fn().mockResolvedValue(undefined) },
      chatService: {
        chat: jest.fn().mockResolvedValue({
          success: true,
          message: 'Hello there, human!',
          images: [],
          executionSummary: { executionIds: [] },
        }),
      },
      _createImageAttachments: jest.fn().mockReturnValue([]),
      _splitMessage: jest.fn(),
      // Bind the real prototype method under test onto the fake `this`.
      _recordBotReply: DiscordBot.prototype._recordBotReply,
    };

    message = {
      content: '<@bot-id-1> hello bot',
      author: { id: 'user-1', username: 'someuser', tag: 'someuser#0001' },
      guild: { id: 'guild-1' },
      channel: {
        id: 'chan-1',
        sendTyping: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(sentReply),
      },
      mentions: { has: jest.fn().mockReturnValue(true) },
      reply: jest.fn().mockResolvedValue(sentReply),
    };
  });

  test('persists the bot reply exactly once with isBot: true', async () => {
    await DiscordBot.prototype._handleMentionChat.call(fakeThis, message);

    expect(fakeThis.mongoService.recordChannelMessage).toHaveBeenCalledTimes(1);
    expect(fakeThis.mongoService.recordChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        isBot: true,
        content: 'Hello there, human!',
        channelId: 'chan-1',
        guildId: 'guild-1',
        authorId: 'bot-id-1',
        authorName: 'RevenantBot',
        messageId: 'reply-123',
      })
    );
  });

  test('includes executionIds when the turn produced sandbox executions, still exactly one record call', async () => {
    fakeThis.chatService.chat.mockResolvedValue({
      success: true,
      message: 'Ran the code for you.',
      images: [],
      executionSummary: { executionIds: ['exec-1', 'exec-2'] },
    });

    await DiscordBot.prototype._handleMentionChat.call(fakeThis, message);

    expect(fakeThis.mongoService.recordChannelMessage).toHaveBeenCalledTimes(1);
    expect(fakeThis.mongoService.recordChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        isBot: true,
        executionIds: ['exec-1', 'exec-2'],
      })
    );
  });

  test('omits executionIds when the turn produced none', async () => {
    await DiscordBot.prototype._handleMentionChat.call(fakeThis, message);

    const doc = fakeThis.mongoService.recordChannelMessage.mock.calls[0][0];
    expect(doc.executionIds).toBeUndefined();
  });

  test('a persistence failure does not throw out of the reply path and the reply is still sent', async () => {
    fakeThis.mongoService.recordChannelMessage = jest.fn().mockRejectedValue(new Error('mongo down'));

    await expect(
      DiscordBot.prototype._handleMentionChat.call(fakeThis, message)
    ).resolves.not.toThrow();

    expect(message.reply).toHaveBeenCalled();
  });
});
