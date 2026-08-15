// __tests__/commands/slash/ChatCommand.test.js
// Tests for ChatSlashCommand - channel-voice default, simplified response format

// Mock the logger
jest.mock('../../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn()
}));

// Mock personalities - only channel-voice matters now
jest.mock('../../../personalities', () => ({
  get: jest.fn((id) => {
    const personalities = {
      'channel-voice': {
        id: 'channel-voice',
        name: 'Channel Voice',
        emoji: '🗣️',
        description: 'Learned group communication style',
        systemPrompt: 'You speak in the style of the group.'
      }
    };
    return personalities[id] || null;
  }),
  list: jest.fn(() => [
    { id: 'channel-voice', name: 'Channel Voice', emoji: '🗣️', description: 'Learned group communication style' }
  ])
}));

// Mock LocalLlmService
jest.mock('../../../services/LocalLlmService', () => ({
  checkUncensoredAccess: jest.fn()
}));

const ChatSlashCommand = require('../../../commands/slash/ChatCommand');

describe('ChatSlashCommand', () => {
  let command;
  let mockChatService;
  let mockInteraction;

  beforeEach(() => {
    jest.clearAllMocks();

    mockChatService = {
      chat: jest.fn().mockResolvedValue({
        success: true,
        message: 'Hello! How can I help you today?',
        personality: {
          id: 'channel-voice',
          name: 'Channel Voice',
          emoji: '🗣️'
        },
        tokens: { input: 100, output: 50, total: 150 }
      })
    };

    mockInteraction = {
      user: { id: 'user123', tag: 'TestUser#1234' },
      channel: { id: 'channel123', nsfw: false },
      guild: { id: 'guild456' },
      options: {
        getString: jest.fn((name) => {
          if (name === 'message') return 'What is the meaning of life?';
          return null;
        }),
        getAttachment: jest.fn().mockReturnValue(null),
        getBoolean: jest.fn().mockReturnValue(false)
      },
      editReply: jest.fn().mockResolvedValue({}),
      deferReply: jest.fn().mockResolvedValue({}),
      reply: jest.fn().mockResolvedValue({}),
      followUp: jest.fn().mockResolvedValue({}),
      deferred: true,
      replied: false
    };

    command = new ChatSlashCommand(mockChatService);
  });

  describe('constructor', () => {
    it('should not have a personality option', () => {
      const options = command.data.options;
      const personalityOption = options.find(o => o.name === 'personality');
      expect(personalityOption).toBeUndefined();
    });

    it('should not have an uncensored option', () => {
      const options = command.data.options;
      const uncensoredOption = options.find(o => o.name === 'uncensored');
      expect(uncensoredOption).toBeUndefined();
    });

    it('should have a message option', () => {
      const options = command.data.options;
      const messageOption = options.find(o => o.name === 'message');
      expect(messageOption).toBeDefined();
    });

    it('should have an image option', () => {
      const options = command.data.options;
      const imageOption = options.find(o => o.name === 'image');
      expect(imageOption).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should always use channel-voice personality', async () => {
      await command.execute(mockInteraction, {});

      expect(mockChatService.chat).toHaveBeenCalledWith(
        'channel-voice',
        'What is the meaning of life?',
        expect.any(Object),
        'channel123',
        'guild456',
        null
      );
    });

    it('should include user prompt in response', async () => {
      await command.execute(mockInteraction, {});

      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('**Prompt:** What is the meaning of life?')
        })
      );
    });

    it('should include the AI response message', async () => {
      await command.execute(mockInteraction, {});

      const response = mockInteraction.editReply.mock.calls[0][0].content;
      expect(response).toContain('Hello! How can I help you today?');
    });

    it('should not include personality emoji/name header in response', async () => {
      await command.execute(mockInteraction, {});

      const response = mockInteraction.editReply.mock.calls[0][0].content;
      expect(response).not.toContain('🗣️ **Channel Voice**');
    });

    it('should format response as prompt then message only', async () => {
      await command.execute(mockInteraction, {});

      const response = mockInteraction.editReply.mock.calls[0][0].content;
      expect(response).toBe('**Prompt:** What is the meaning of life?\n\nHello! How can I help you today?');
    });

    it('should announce a degraded reply the way mention chat does', async () => {
      // This surface rendered result.message and never read result.fallback,
      // so a /chat user was handed a substitute model with no notice at all.
      mockChatService.chat.mockResolvedValue({
        success: true,
        message: 'Hello! How can I help you today?',
        personality: { id: 'channel-voice', name: 'Channel Voice', emoji: '🗣️' },
        tokens: { input: 1, output: 1, total: 2 },
        fallback: {
          occurred: true,
          reason: 'agent sidecar unavailable: boom',
          notice: 'Agent unavailable — answered with gpt-9-distinctive instead',
        },
      });

      await command.execute(mockInteraction, {});

      const response = mockInteraction.editReply.mock.calls[0][0].content;
      expect(response).toContain('Agent unavailable — answered with gpt-9-distinctive instead');
      expect(response).toContain('Hello! How can I help you today?');
    });

    it('should not announce anything when the reply was not degraded', async () => {
      await command.execute(mockInteraction, {});
      const response = mockInteraction.editReply.mock.calls[0][0].content;
      expect(response).not.toContain('⚠️');
    });

    it('should not include prompt line in error responses', async () => {
      mockChatService.chat.mockResolvedValue({
        success: false,
        error: 'Something went wrong'
      });

      await command.execute(mockInteraction, {});

      const response = mockInteraction.editReply.mock.calls[0][0].content;
      expect(response).not.toContain('**Prompt:**');
    });
  });
});
