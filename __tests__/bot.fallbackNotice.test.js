// The degraded-mode notice the user actually sees. It used to hardcode
// "Local LLM unavailable" for EVERY fallback, so an agent-sidecar failure was
// reported as a problem in a different feature entirely.
jest.mock('../services/Mem0Service', () => jest.fn().mockImplementation(() => ({
  isEnabled: () => false,
})));

const DiscordBot = require('../bot');

describe('DiscordBot _handleMentionChat - fallback notice', () => {
  let fakeThis;
  let message;
  let sentReply;

  const replyContent = () => message.reply.mock.calls[0][0].content;

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

  test('renders no notice when nothing degraded', async () => {
    await DiscordBot.prototype._handleMentionChat.call(fakeThis, message);
    expect(replyContent()).toBe('Hello there, human!');
  });

  test('renders the supplied notice, not the local-LLM boilerplate', async () => {
    fakeThis.chatService.chat.mockResolvedValue({
      success: true,
      message: 'Hello there, human!',
      images: [],
      executionSummary: { executionIds: [] },
      fallback: {
        occurred: true,
        reason: 'agent sidecar unavailable: sidecar unhealthy',
        notice: 'Agent unavailable — answered with gpt-5.1 instead',
      },
    });

    await DiscordBot.prototype._handleMentionChat.call(fakeThis, message);

    const content = replyContent();
    expect(content).toContain('Agent unavailable — answered with gpt-5.1 instead');
    expect(content).not.toContain('Local LLM');
    expect(content).toContain('Hello there, human!');
  });

  test('still describes a local-LLM fallback correctly', async () => {
    fakeThis.chatService.chat.mockResolvedValue({
      success: true,
      message: 'Hello there, human!',
      images: [],
      executionSummary: { executionIds: [] },
      fallback: {
        occurred: true,
        reason: 'Local LLM unavailable',
        notice: 'Local LLM unavailable — responded with cloud fallback instead',
      },
    });

    await DiscordBot.prototype._handleMentionChat.call(fakeThis, message);
    expect(replyContent()).toContain('Local LLM unavailable — responded with cloud fallback instead');
  });

  test('falls back to the reason when no notice text was supplied', async () => {
    fakeThis.chatService.chat.mockResolvedValue({
      success: true,
      message: 'Hello there, human!',
      images: [],
      executionSummary: { executionIds: [] },
      fallback: { occurred: true, reason: 'agent ran without the channel-voice personality' },
    });

    await DiscordBot.prototype._handleMentionChat.call(fakeThis, message);

    const content = replyContent();
    expect(content).toContain('agent ran without the channel-voice personality');
    expect(content).not.toContain('Local LLM');
  });
});
