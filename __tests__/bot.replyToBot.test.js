// A Discord reply to a bot message that ReplyHandler doesn't claim falls
// through to mention-chat. It used to drop the referenced message on the
// floor, so the reply's explicit target was lost whenever it had scrolled out
// of the recent-history window.
jest.mock('../services/Mem0Service', () => jest.fn().mockImplementation(() => ({
  isEnabled: () => false,
})));

const DiscordBot = require('../bot');

describe('DiscordBot _handleReplyToBot', () => {
  let fakeThis;
  let message;
  let referencedMessage;

  beforeEach(() => {
    fakeThis = {
      replyHandler: { handleReply: jest.fn().mockResolvedValue(false) },
      _handleMentionChat: jest.fn().mockResolvedValue(undefined),
    };
    message = {
      id: 'msg-2',
      content: 'and where would it be best to refine it?',
      author: { id: 'user-1', username: 'someuser', tag: 'someuser#0001' },
      channel: { id: 'chan-1' },
    };
    referencedMessage = {
      id: 'bot-msg-1',
      content: '**Prompt:** best Aluminum?\n\nAaron Halo.',
      author: { id: 'bot-id-1', username: 'RevenantBot' },
    };
  });

  test('unclaimed reply falls through to mention chat WITH the referenced bot message', async () => {
    await DiscordBot.prototype._handleReplyToBot.call(fakeThis, message, referencedMessage);

    expect(fakeThis.replyHandler.handleReply).toHaveBeenCalledWith(message, referencedMessage);
    expect(fakeThis._handleMentionChat).toHaveBeenCalledWith(message, {
      referencedMessage: {
        id: 'bot-msg-1',
        content: '**Prompt:** best Aluminum?\n\nAaron Halo.',
        authorId: 'bot-id-1',
      },
    });
  });

  test('a reply ReplyHandler claims (summarization/imagegen) does not reach mention chat', async () => {
    fakeThis.replyHandler.handleReply.mockResolvedValue(true);
    await DiscordBot.prototype._handleReplyToBot.call(fakeThis, message, referencedMessage);
    expect(fakeThis._handleMentionChat).not.toHaveBeenCalled();
  });
});

describe('DiscordBot _handleMentionChat forwards the referenced message to ChatService', () => {
  let fakeThis;
  let message;

  beforeEach(() => {
    const sentReply = { id: 'reply-123' };
    fakeThis = {
      client: { user: { id: 'bot-id-1', username: 'RevenantBot' } },
      mongoService: { recordChannelMessage: jest.fn().mockResolvedValue(undefined) },
      chatService: {
        chat: jest.fn().mockResolvedValue({ success: true, message: 'Refine at Lorville.', images: [] }),
      },
      _createImageAttachments: jest.fn().mockReturnValue([]),
      _splitMessage: jest.fn(),
      _recordBotReply: DiscordBot.prototype._recordBotReply,
    };
    message = {
      id: 'msg-2',
      content: 'and where would it be best to refine it?',
      author: { id: 'user-1', username: 'someuser', tag: 'someuser#0001' },
      guild: { id: 'guild-1' },
      channel: { id: 'chan-1', sendTyping: jest.fn().mockResolvedValue(undefined), send: jest.fn() },
      reply: jest.fn().mockResolvedValue(sentReply),
    };
  });

  test('passes { referencedMessage } as ChatService.chat options', async () => {
    const ref = { id: 'bot-msg-1', content: 'Aaron Halo.', authorId: 'bot-id-1' };
    await DiscordBot.prototype._handleMentionChat.call(fakeThis, message, { referencedMessage: ref });
    expect(fakeThis.chatService.chat).toHaveBeenCalledWith(
      'channel-voice',
      'and where would it be best to refine it?',
      message.author,
      'chan-1',
      'guild-1',
      null,
      { referencedMessage: ref }
    );
  });

  test('a plain mention (no reply) calls ChatService exactly as before', async () => {
    await DiscordBot.prototype._handleMentionChat.call(fakeThis, message);
    expect(fakeThis.chatService.chat.mock.calls[0]).toEqual([
      'channel-voice', 'and where would it be best to refine it?', message.author, 'chan-1', 'guild-1',
    ]);
  });
});
