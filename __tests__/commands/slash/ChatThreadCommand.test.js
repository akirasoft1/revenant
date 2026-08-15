// __tests__/commands/slash/ChatThreadCommand.test.js
// The degraded-reply notice on the thread surface. /chatthread rendered
// result.message and never read result.fallback, so a thread user got a
// substitute model (or a reply with no memory and no channel personality)
// with no notice at all — while mention chat announced exactly that.

jest.mock('../../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
}));

const ChatThreadSlashCommand = require('../../../commands/slash/ChatThreadCommand');

const DEGRADED = {
  occurred: true,
  reason: 'agent sidecar unavailable: boom',
  notice: 'Agent unavailable — answered with gpt-9-distinctive instead',
};

describe('ChatThreadSlashCommand degraded-reply notice', () => {
  let command;
  let mockChatService;
  let thread;

  beforeEach(() => {
    jest.clearAllMocks();

    mockChatService = {
      chat: jest.fn().mockResolvedValue({
        success: true,
        message: 'Hello from the thread!',
        images: [],
      }),
    };

    thread = {
      id: 'thread-1',
      send: jest.fn().mockResolvedValue({}),
      members: { add: jest.fn().mockResolvedValue({}) },
    };

    command = new ChatThreadSlashCommand(mockChatService);
  });

  function makeInteraction() {
    return {
      user: { id: 'user-1', tag: 'TestUser#1234' },
      channel: {
        id: 'channel-1',
        threads: { create: jest.fn().mockResolvedValue(thread) },
      },
      guild: { id: 'guild-1' },
      options: { getString: jest.fn().mockReturnValue('hello') },
      editReply: jest.fn().mockResolvedValue({}),
      deferReply: jest.fn().mockResolvedValue({}),
      reply: jest.fn().mockResolvedValue({}),
      followUp: jest.fn().mockResolvedValue({}),
      deferred: true,
      replied: false,
    };
  }

  function makeThreadMessage() {
    return {
      content: 'follow-up question',
      author: { id: 'user-1', bot: false, username: 'someuser' },
      channel: {
        id: 'thread-1',
        sendTyping: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue({}),
      },
      reply: jest.fn().mockResolvedValue({}),
    };
  }

  const sentToThread = () => thread.send.mock.calls.map((c) => c[0]).join('\n');

  it('announces a degraded opening reply', async () => {
    mockChatService.chat.mockResolvedValue({
      success: true,
      message: 'Hello from the thread!',
      images: [],
      fallback: DEGRADED,
    });

    await command.execute(makeInteraction(), {});

    expect(sentToThread()).toContain('Agent unavailable — answered with gpt-9-distinctive instead');
    expect(sentToThread()).toContain('Hello from the thread!');
  });

  it('announces nothing when the opening reply was not degraded', async () => {
    await command.execute(makeInteraction(), {});
    expect(sentToThread()).not.toContain('⚠️');
    expect(sentToThread()).toContain('Hello from the thread!');
  });

  it('announces a degraded follow-up reply inside the thread', async () => {
    command.activeThreads.set('thread-1', {
      personalityId: 'channel-voice',
      userId: 'user-1',
      channelId: 'channel-1',
      guildId: 'guild-1',
      createdAt: new Date(),
    });
    mockChatService.chat.mockResolvedValue({
      success: true,
      message: 'Follow-up answer.',
      images: [],
      fallback: DEGRADED,
    });

    const message = makeThreadMessage();
    await command.handleThreadMessage(message);

    const replied = message.reply.mock.calls[0][0].content;
    expect(replied).toContain('Agent unavailable — answered with gpt-9-distinctive instead');
    expect(replied).toContain('Follow-up answer.');
  });
});
