// __tests__/services/ChatService.test.js
const ChatService = require('../../services/ChatService');

// Mock the logger
jest.mock('../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn()
}));

// Mock the token counter
jest.mock('../../utils/tokenCounter', () => ({
  countTokens: jest.fn(() => 10),
  wouldExceedLimit: jest.fn(() => false)
}));

// Mock the local LLM service
jest.mock('../../services/LocalLlmService', () => ({
  isAvailable: jest.fn().mockReturnValue(false),
  isEnabled: jest.fn().mockReturnValue(false),
  generateCompletion: jest.fn(),
  isConnectionError: jest.fn().mockReturnValue(false),
  markUnavailable: jest.fn(),
  markAvailable: jest.fn()
}));

// Mock the personality manager
jest.mock('../../personalities', () => ({
  get: jest.fn((id) => {
    if (id === 'test-personality') {
      return {
        id: 'test-personality',
        name: 'Test Character',
        emoji: '🧪',
        description: 'A test personality',
        systemPrompt: 'You are a test character.'
      };
    }
    return null;
  }),
  getRaw: jest.fn((id) => {
    if (id === 'test-personality') {
      return {
        id: 'test-personality',
        name: 'Test Character',
        emoji: '🧪',
        description: 'A test personality',
        systemPrompt: 'You are a test character.'
      };
    }
    return null;
  }),
  list: jest.fn(() => [
    { id: 'test-personality', name: 'Test Character', emoji: '🧪', description: 'A test personality' }
  ]),
  exists: jest.fn((id) => id === 'test-personality'),
  checkAvailability: jest.fn((id) => {
    if (id === 'test-personality') {
      return { exists: true, available: true, reason: null };
    }
    return { exists: false, available: false, reason: null };
  }),
  getSystemPrompt: jest.fn((id, useUncensored) => {
    if (id === 'test-personality') {
      return 'You are a test character.';
    }
    return null;
  })
}));

describe('ChatService', () => {
  let chatService;
  let mockOpenAIClient;
  let mockMongoService;
  let mockConfig;

  beforeEach(() => {
    jest.clearAllMocks();

    mockOpenAIClient = {
      responses: {
        create: jest.fn().mockResolvedValue({
          output_text: 'Test response from personality',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150
          }
        })
      }
    };

    mockMongoService = {
      recordTokenUsage: jest.fn().mockResolvedValue(true),
      getConversationStatus: jest.fn().mockResolvedValue({ exists: false }),
      getOrCreateConversation: jest.fn().mockResolvedValue({
        conversationId: 'channel123_test-personality',
        channelId: 'channel123',
        personalityId: 'test-personality',
        messages: [],
        status: 'active',
        messageCount: 0,
        totalTokens: 0
      }),
      addMessageToConversation: jest.fn().mockResolvedValue(true),
      isConversationIdle: jest.fn().mockResolvedValue(false),
      expireConversation: jest.fn().mockResolvedValue(true),
      resumeConversation: jest.fn().mockResolvedValue(true),
      resetConversation: jest.fn().mockResolvedValue(true)
    };

    mockConfig = {
      openai: {
        model: 'gpt-5.1'
      }
    };

    chatService = new ChatService(mockOpenAIClient, mockConfig, mockMongoService);
  });

  describe('chat - stateless mode (backwards compatibility)', () => {
    const mockUser = {
      id: 'user123',
      username: 'TestUser',
      tag: 'TestUser#1234'
    };

    it('should return a response without channelId (stateless)', async () => {
      const result = await chatService.chat('test-personality', 'Hello!', mockUser);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Test response from personality');
      expect(result.personality.id).toBe('test-personality');
      expect(result.personality.name).toBe('Test Character');
      expect(result.tokens.input).toBe(100);
      expect(result.tokens.output).toBe(50);
    });

    it('should record token usage in stateless mode', async () => {
      await chatService.chat('test-personality', 'Hello!', mockUser);

      expect(mockMongoService.recordTokenUsage).toHaveBeenCalledWith(
        'user123',
        'TestUser#1234',
        100,
        50,
        'chat_test-personality',
        'gpt-5.1'
      );
    });

    it('should return error for unknown personality', async () => {
      const result = await chatService.chat('unknown-personality', 'Hello!', mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown personality');
    });
  });

  describe('chat - with conversation memory', () => {
    const mockUser = {
      id: 'user123',
      username: 'TestUser',
      tag: 'TestUser#1234'
    };

    it('should use conversation history when channelId provided', async () => {
      mockMongoService.getOrCreateConversation.mockResolvedValue({
        conversationId: 'channel123_test-personality',
        messages: [
          { role: 'user', username: 'OtherUser', content: 'Previous message' },
          { role: 'assistant', content: 'Previous response' }
        ],
        status: 'active',
        messageCount: 2,
        totalTokens: 100
      });

      const result = await chatService.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      expect(result.success).toBe(true);
      // Verify responses API was called with input text containing history
      expect(mockOpenAIClient.responses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.1',
          instructions: expect.stringContaining('You are a test character'),
          input: expect.stringContaining('[OtherUser]: Previous message')
        })
      );
      // Verify input also contains the new message
      const callArgs = mockOpenAIClient.responses.create.mock.calls[0][0];
      expect(callArgs.input).toContain('[TestUser]: Hello!');
      expect(callArgs.input).toContain('Previous response');
    });

    it('should store messages in conversation', async () => {
      await chatService.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // User message stored
      expect(mockMongoService.addMessageToConversation).toHaveBeenCalledWith(
        'channel123',
        'test-personality',
        'user',
        'Hello!',
        'user123',
        'TestUser',
        expect.any(Number)
      );

      // Assistant message stored
      expect(mockMongoService.addMessageToConversation).toHaveBeenCalledWith(
        'channel123',
        'test-personality',
        'assistant',
        'Test response from personality',
        null,
        null,
        50
      );
    });

    it('should return conversation stats', async () => {
      const result = await chatService.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      expect(result.success).toBe(true);
      expect(result.conversation).toBeDefined();
      expect(result.conversation.messageCount).toBe(2); // 0 + 2 new messages
    });
  });

  describe('chat - limit enforcement', () => {
    const mockUser = { id: 'user123', username: 'TestUser' };

    it('should start fresh when conversation is expired', async () => {
      mockMongoService.getConversationStatus.mockResolvedValue({
        exists: true,
        status: 'expired',
        messageCount: 10,
        totalTokens: 1000
      });

      const result = await chatService.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // Should reset the expired conversation and start fresh
      expect(mockMongoService.resetConversation).toHaveBeenCalledWith('channel123', 'test-personality');
      expect(result.success).toBe(true);
    });

    it('should block chat when message limit reached', async () => {
      mockMongoService.getConversationStatus.mockResolvedValue({
        exists: true,
        status: 'active',
        messageCount: 100,
        totalTokens: 50000,
        lastActivity: new Date()
      });

      const result = await chatService.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('message_limit');
      expect(result.error).toContain('100 messages');
    });

    it('should block chat when token limit reached', async () => {
      mockMongoService.getConversationStatus.mockResolvedValue({
        exists: true,
        status: 'active',
        messageCount: 50,
        totalTokens: 150000,
        lastActivity: new Date()
      });

      const result = await chatService.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('token_limit');
      expect(result.error).toContain('token limit');
    });

    it('should expire idle conversation and start fresh', async () => {
      mockMongoService.getConversationStatus.mockResolvedValue({
        exists: true,
        status: 'active',
        messageCount: 10,
        totalTokens: 1000,
        lastActivity: new Date()
      });
      mockMongoService.isConversationIdle.mockResolvedValue(true);

      const result = await chatService.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // Should expire and then reset to start fresh
      expect(mockMongoService.expireConversation).toHaveBeenCalled();
      expect(mockMongoService.resetConversation).toHaveBeenCalledWith('channel123', 'test-personality');
      expect(result.success).toBe(true);
    });
  });

  describe('resumeChat', () => {
    const mockUser = { id: 'user123', username: 'TestUser' };

    it('should resume expired conversation', async () => {
      mockMongoService.getConversationStatus.mockResolvedValueOnce({
        exists: true,
        status: 'expired',
        messageCount: 10,
        totalTokens: 1000
      }).mockResolvedValueOnce({
        exists: false // For the subsequent chat call limit check
      });

      const result = await chatService.resumeChat('test-personality', 'Continue!', mockUser, 'channel123', 'guild456');

      expect(mockMongoService.resumeConversation).toHaveBeenCalledWith('channel123', 'test-personality');
    });

    it('should return error if no conversation exists', async () => {
      mockMongoService.getConversationStatus.mockResolvedValue({ exists: false });

      const result = await chatService.resumeChat('test-personality', 'Continue!', mockUser, 'channel123', 'guild456');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No conversation found');
    });

    it('should return error if conversation is active', async () => {
      mockMongoService.getConversationStatus.mockResolvedValue({
        exists: true,
        status: 'active'
      });

      const result = await chatService.resumeChat('test-personality', 'Continue!', mockUser, 'channel123', 'guild456');

      expect(result.success).toBe(false);
      expect(result.error).toContain('still active');
    });

    it('should return error if conversation was reset', async () => {
      mockMongoService.getConversationStatus.mockResolvedValue({
        exists: true,
        status: 'reset'
      });

      const result = await chatService.resumeChat('test-personality', 'Continue!', mockUser, 'channel123', 'guild456');

      expect(result.success).toBe(false);
      expect(result.error).toContain('reset');
    });
  });

  describe('resetConversation', () => {
    it('should reset existing conversation', async () => {
      mockMongoService.getConversationStatus.mockResolvedValue({
        exists: true,
        status: 'active'
      });

      const result = await chatService.resetConversation('channel123', 'test-personality');

      expect(result.success).toBe(true);
      expect(result.message).toContain('reset');
      expect(mockMongoService.resetConversation).toHaveBeenCalledWith('channel123', 'test-personality');
    });

    it('should return error if no conversation exists', async () => {
      mockMongoService.getConversationStatus.mockResolvedValue({ exists: false });

      const result = await chatService.resetConversation('channel123', 'test-personality');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No conversation found');
    });

    it('should return error for unknown personality', async () => {
      const result = await chatService.resetConversation('channel123', 'unknown-personality');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown personality');
    });
  });

  describe('listPersonalities', () => {
    it('should return list of personalities', () => {
      const list = chatService.listPersonalities();

      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      expect(list[0]).toHaveProperty('id');
      expect(list[0]).toHaveProperty('name');
    });
  });

  describe('getPersonality', () => {
    it('should return personality for valid ID', () => {
      const personality = chatService.getPersonality('test-personality');

      expect(personality).not.toBeNull();
      expect(personality.id).toBe('test-personality');
    });

    it('should return null for invalid ID', () => {
      const personality = chatService.getPersonality('invalid');

      expect(personality).toBeNull();
    });
  });

  describe('personalityExists', () => {
    it('should return true for existing personality', () => {
      expect(chatService.personalityExists('test-personality')).toBe(true);
    });

    it('should return false for non-existent personality', () => {
      expect(chatService.personalityExists('fake')).toBe(false);
    });
  });

  describe('getConversationInfo', () => {
    it('should return conversation info', async () => {
      mockMongoService.getConversationStatus.mockResolvedValue({
        exists: true,
        status: 'active',
        messageCount: 10,
        totalTokens: 500
      });

      const result = await chatService.getConversationInfo('channel123', 'test-personality');

      expect(result.personality).toBeDefined();
      expect(result.personality.id).toBe('test-personality');
      expect(result.exists).toBe(true);
      expect(result.status).toBe('active');
      expect(result.limits).toBeDefined();
    });
  });

  describe('listUserConversations', () => {
    it('should return empty array when no mongoService', async () => {
      const noMongoService = new ChatService(mockOpenAIClient, mockConfig, null);
      const result = await noMongoService.listUserConversations('user123');
      expect(result).toEqual([]);
    });

    it('should return enriched conversations with personality info', async () => {
      mockMongoService.getUserConversations = jest.fn().mockResolvedValue([
        {
          channelId: 'channel123',
          personalityId: 'test-personality',
          status: 'expired',
          messageCount: 10,
          totalTokens: 500,
          lastActivity: new Date(),
          lastUserMessage: 'Hello there'
        }
      ]);

      const result = await chatService.listUserConversations('user123', 'guild123');

      expect(result).toHaveLength(1);
      expect(result[0].personality).toBeDefined();
      expect(result[0].personality.id).toBe('test-personality');
      expect(result[0].personality.name).toBe('Test Character');
      expect(result[0].personality.emoji).toBe('🧪');
      expect(result[0].channelId).toBe('channel123');
      expect(result[0].status).toBe('expired');
    });

    it('should handle unknown personalities gracefully', async () => {
      mockMongoService.getUserConversations = jest.fn().mockResolvedValue([
        {
          channelId: 'channel456',
          personalityId: 'deleted-personality',
          status: 'reset',
          messageCount: 5,
          totalTokens: 200,
          lastActivity: new Date(),
          lastUserMessage: null
        }
      ]);

      const result = await chatService.listUserConversations('user123');

      expect(result).toHaveLength(1);
      expect(result[0].personality.id).toBe('deleted-personality');
      expect(result[0].personality.name).toBe('deleted-personality');
      expect(result[0].personality.emoji).toBe('🎭');
    });
  });

  describe('Mem0 integration', () => {
    let mockMem0Service;
    let chatServiceWithMem0;
    const mockUser = { id: 'user123', username: 'TestUser', tag: 'TestUser#1234' };

    beforeEach(() => {
      mockMem0Service = {
        isEnabled: jest.fn().mockReturnValue(true),
        searchMemories: jest.fn().mockResolvedValue({
          results: [
            { id: 'mem-1', memory: 'User prefers dark mode' },
            { id: 'mem-2', memory: 'User is a Python developer' }
          ]
        }),
        addMemory: jest.fn().mockResolvedValue({
          results: [{ id: 'new-mem', memory: 'Some new fact' }]
        }),
        formatMemoriesForContext: jest.fn().mockReturnValue(
          '\n\nRelevant things you remember about this user:\n- User prefers dark mode\n- User is a Python developer\n'
        )
      };

      chatServiceWithMem0 = new ChatService(mockOpenAIClient, mockConfig, mockMongoService, mockMem0Service);
    });

    it('should accept mem0Service as optional fourth constructor argument', () => {
      const service = new ChatService(mockOpenAIClient, mockConfig, mockMongoService, mockMem0Service);
      expect(service.mem0Service).toBe(mockMem0Service);
    });

    it('should work without mem0Service (backwards compatibility)', () => {
      const service = new ChatService(mockOpenAIClient, mockConfig, mockMongoService);
      expect(service.mem0Service).toBeNull();
    });

    it('should search for both personality and explicit memories during chat', async () => {
      await chatServiceWithMem0.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // Should search for personality-specific memories
      expect(mockMem0Service.searchMemories).toHaveBeenCalledWith(
        'Hello!',
        'user123',
        expect.objectContaining({
          personalityId: 'test-personality',
          limit: 3
        })
      );

      // Should also search for explicit memories from !remember command
      expect(mockMem0Service.searchMemories).toHaveBeenCalledWith(
        'Hello!',
        'user123',
        expect.objectContaining({
          personalityId: 'explicit_memory',
          limit: 3
        })
      );

      // Total of 2 searches
      expect(mockMem0Service.searchMemories).toHaveBeenCalledTimes(2);
    });

    it('should include memories in system prompt context', async () => {
      await chatServiceWithMem0.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // Should format the combined memories
      expect(mockMem0Service.formatMemoriesForContext).toHaveBeenCalled();

      // Verify the system prompt includes the memory context
      const callArgs = mockOpenAIClient.responses.create.mock.calls[0][0];
      expect(callArgs.instructions).toContain('User prefers dark mode');
    });

    it('should combine explicit and personality memories without duplicates', async () => {
      // Set up mock to return different memories for each search
      mockMem0Service.searchMemories
        .mockResolvedValueOnce({
          results: [
            { id: 'personality-1', memory: 'User likes Python from chat' }
          ]
        })
        .mockResolvedValueOnce({
          results: [
            { id: 'explicit-1', memory: 'User prefers dark mode' },
            { id: 'explicit-2', memory: 'User is a software engineer' }
          ]
        });

      await chatServiceWithMem0.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // formatMemoriesForContext should receive combined, deduplicated memories
      // Explicit memories come first (prioritized)
      const formatCall = mockMem0Service.formatMemoriesForContext.mock.calls[0][0];
      expect(formatCall).toHaveLength(3);
      // Explicit memories first
      expect(formatCall[0].id).toBe('explicit-1');
      expect(formatCall[1].id).toBe('explicit-2');
      // Then personality memories
      expect(formatCall[2].id).toBe('personality-1');
    });

    it('should deduplicate memories by ID', async () => {
      // Same memory ID returned by both searches
      mockMem0Service.searchMemories
        .mockResolvedValueOnce({
          results: [
            { id: 'shared-mem', memory: 'Same memory' }
          ]
        })
        .mockResolvedValueOnce({
          results: [
            { id: 'shared-mem', memory: 'Same memory' },
            { id: 'unique-mem', memory: 'Unique explicit memory' }
          ]
        });

      await chatServiceWithMem0.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      const formatCall = mockMem0Service.formatMemoriesForContext.mock.calls[0][0];
      // Should have 2 memories, not 3 (deduplicated)
      expect(formatCall).toHaveLength(2);
    });

    it('should store new memories after chat response', async () => {
      await chatServiceWithMem0.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      expect(mockMem0Service.addMemory).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'Hello!' }),
          expect.objectContaining({ role: 'assistant', content: 'Test response from personality' })
        ]),
        'user123',
        expect.objectContaining({
          channelId: 'channel123',
          personalityId: 'test-personality',
          guildId: 'guild456'
        })
      );
    });

    it('should handle mem0 search errors gracefully', async () => {
      mockMem0Service.searchMemories.mockRejectedValue(new Error('Qdrant unavailable'));

      const result = await chatServiceWithMem0.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // Chat should still succeed even if memory search fails
      expect(result.success).toBe(true);
      expect(result.message).toBe('Test response from personality');
    });

    it('should handle mem0 addMemory errors gracefully', async () => {
      mockMem0Service.addMemory.mockRejectedValue(new Error('Storage failed'));

      const result = await chatServiceWithMem0.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // Chat should still succeed even if memory storage fails
      expect(result.success).toBe(true);
      expect(result.message).toBe('Test response from personality');
    });

    it('should not use mem0 when service is disabled', async () => {
      mockMem0Service.isEnabled.mockReturnValue(false);

      await chatServiceWithMem0.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      expect(mockMem0Service.searchMemories).not.toHaveBeenCalled();
      expect(mockMem0Service.addMemory).not.toHaveBeenCalled();
    });

    it('should skip mem0 in stateless mode', async () => {
      // No channelId = stateless mode
      await chatServiceWithMem0.chat('test-personality', 'Hello!', mockUser);

      // In stateless mode, mem0 should not be used as there's no user context
      expect(mockMem0Service.searchMemories).not.toHaveBeenCalled();
      expect(mockMem0Service.addMemory).not.toHaveBeenCalled();
    });

    it('should pass correct metadata to addMemory', async () => {
      await chatServiceWithMem0.chat('test-personality', 'My favorite color is blue', mockUser, 'channel123', 'guild456');

      const addMemoryCall = mockMem0Service.addMemory.mock.calls[0];
      const metadata = addMemoryCall[2];

      expect(metadata.channelId).toBe('channel123');
      expect(metadata.personalityId).toBe('test-personality');
      expect(metadata.guildId).toBe('guild456');
      expect(metadata.channelName).toBeUndefined(); // Not available in this context
    });
  });

  describe('_extractGeneratedImages', () => {
    it('should extract completed image generation calls from response', () => {
      const mockResponse = {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Here is your image' }] },
          {
            type: 'image_generation_call',
            id: 'img-123',
            status: 'completed',
            result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
          }
        ]
      };

      const images = chatService._extractGeneratedImages(mockResponse);

      expect(images).toHaveLength(1);
      expect(images[0].id).toBe('img-123');
      expect(images[0].base64).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
    });

    it('should ignore in-progress image generation calls', () => {
      const mockResponse = {
        output: [
          {
            type: 'image_generation_call',
            id: 'img-123',
            status: 'in_progress',
            result: null
          }
        ]
      };

      const images = chatService._extractGeneratedImages(mockResponse);

      expect(images).toHaveLength(0);
    });

    it('should ignore failed image generation calls', () => {
      const mockResponse = {
        output: [
          {
            type: 'image_generation_call',
            id: 'img-123',
            status: 'failed',
            result: null
          }
        ]
      };

      const images = chatService._extractGeneratedImages(mockResponse);

      expect(images).toHaveLength(0);
    });

    it('should handle responses with no output array', () => {
      const images = chatService._extractGeneratedImages({});
      expect(images).toHaveLength(0);

      const imagesNull = chatService._extractGeneratedImages(null);
      expect(imagesNull).toHaveLength(0);
    });

    it('should handle responses with empty output array', () => {
      const images = chatService._extractGeneratedImages({ output: [] });
      expect(images).toHaveLength(0);
    });

    it('should extract multiple completed images', () => {
      const mockResponse = {
        output: [
          {
            type: 'image_generation_call',
            id: 'img-1',
            status: 'completed',
            result: 'base64data1'
          },
          {
            type: 'image_generation_call',
            id: 'img-2',
            status: 'completed',
            result: 'base64data2'
          }
        ]
      };

      const images = chatService._extractGeneratedImages(mockResponse);

      expect(images).toHaveLength(2);
      expect(images[0].id).toBe('img-1');
      expect(images[1].id).toBe('img-2');
    });

    it('should filter out non-image output items', () => {
      const mockResponse = {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
          { type: 'web_search_call', id: 'search-1' },
          {
            type: 'image_generation_call',
            id: 'img-1',
            status: 'completed',
            result: 'base64data'
          }
        ]
      };

      const images = chatService._extractGeneratedImages(mockResponse);

      expect(images).toHaveLength(1);
      expect(images[0].id).toBe('img-1');
    });
  });

  // ========== SHARED CHANNEL MEMORIES (3-WAY SEARCH) ==========

  describe('Shared Channel Memory Integration', () => {
    let chatServiceWithSharedMem;
    let mockMem0ServiceWithShared;
    const mockUser = {
      id: 'user123',
      username: 'TestUser',
      tag: 'TestUser#1234'
    };

    beforeEach(() => {
      mockMem0ServiceWithShared = {
        isEnabled: jest.fn().mockReturnValue(true),
        searchMemories: jest.fn().mockResolvedValue({
          results: [{ id: 'personal-1', memory: 'User prefers dark mode' }]
        }),
        searchSharedChannelMemories: jest.fn().mockResolvedValue({
          results: [{ id: 'shared-1', memory: 'Team uses React for frontend' }]
        }),
        addMemory: jest.fn().mockResolvedValue({ results: [] }),
        formatMemoriesForContext: jest.fn().mockReturnValue('\n\nRelevant things: User prefers dark mode\n'),
        formatSharedMemoriesForContext: jest.fn().mockReturnValue('\n\nShared knowledge: Team uses React\n'),
      };

      chatServiceWithSharedMem = new ChatService(
        mockOpenAIClient,
        mockConfig,
        mockMongoService,
        mockMem0ServiceWithShared
      );
    });

    it('should perform 3-way parallel search when channel ID is provided', async () => {
      mockMem0ServiceWithShared.searchMemories
        .mockResolvedValueOnce({ results: [{ id: 'personality-1', memory: 'From personality' }] })
        .mockResolvedValueOnce({ results: [{ id: 'explicit-1', memory: 'From explicit' }] });

      await chatServiceWithSharedMem.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // Should search personality memories
      expect(mockMem0ServiceWithShared.searchMemories).toHaveBeenCalledWith(
        'Hello!',
        'user123',
        expect.objectContaining({ personalityId: 'test-personality' })
      );

      // Should search explicit memories
      expect(mockMem0ServiceWithShared.searchMemories).toHaveBeenCalledWith(
        'Hello!',
        'user123',
        expect.objectContaining({ personalityId: 'explicit_memory' })
      );

      // Should search shared channel memories
      expect(mockMem0ServiceWithShared.searchSharedChannelMemories).toHaveBeenCalledWith(
        'Hello!',
        'channel123',
        expect.objectContaining({ limit: 2 })
      );
    });

    it('should combine shared channel memories with personal memories', async () => {
      mockMem0ServiceWithShared.searchMemories
        .mockResolvedValueOnce({ results: [{ id: 'personality-1', memory: 'User likes Python' }] })
        .mockResolvedValueOnce({ results: [{ id: 'explicit-1', memory: 'User prefers dark mode' }] });
      mockMem0ServiceWithShared.searchSharedChannelMemories.mockResolvedValue({
        results: [{ id: 'shared-1', memory: 'Team uses React' }]
      });

      await chatServiceWithSharedMem.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // Should format personal memories
      expect(mockMem0ServiceWithShared.formatMemoriesForContext).toHaveBeenCalled();

      // Should format shared channel memories
      expect(mockMem0ServiceWithShared.formatSharedMemoriesForContext).toHaveBeenCalled();
    });

    it('should include shared memories in system prompt', async () => {
      mockMem0ServiceWithShared.searchMemories.mockResolvedValue({ results: [] });
      mockMem0ServiceWithShared.searchSharedChannelMemories.mockResolvedValue({
        results: [{ id: 'shared-1', memory: 'Team uses React' }]
      });
      mockMem0ServiceWithShared.formatMemoriesForContext.mockReturnValue('');
      mockMem0ServiceWithShared.formatSharedMemoriesForContext.mockReturnValue('\n\nShared: Team uses React\n');

      await chatServiceWithSharedMem.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      const callArgs = mockOpenAIClient.responses.create.mock.calls[0][0];
      expect(callArgs.instructions).toContain('Shared: Team uses React');
    });

    it('should gracefully handle shared memory search errors', async () => {
      mockMem0ServiceWithShared.searchMemories.mockResolvedValue({ results: [] });
      mockMem0ServiceWithShared.searchSharedChannelMemories.mockRejectedValue(new Error('Qdrant down'));

      const result = await chatServiceWithSharedMem.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // Chat should still succeed
      expect(result.success).toBe(true);
    });

    it('should skip shared memory search when mem0 is disabled', async () => {
      mockMem0ServiceWithShared.isEnabled.mockReturnValue(false);

      await chatServiceWithSharedMem.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      expect(mockMem0ServiceWithShared.searchSharedChannelMemories).not.toHaveBeenCalled();
    });

    it('should deduplicate across all three memory sources', async () => {
      // Same ID appears in multiple sources
      mockMem0ServiceWithShared.searchMemories
        .mockResolvedValueOnce({ results: [{ id: 'shared-id', memory: 'Same fact' }] })
        .mockResolvedValueOnce({ results: [{ id: 'shared-id', memory: 'Same fact' }] });
      mockMem0ServiceWithShared.searchSharedChannelMemories.mockResolvedValue({
        results: [{ id: 'shared-id', memory: 'Same fact' }]
      });

      await chatServiceWithSharedMem.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      // formatMemoriesForContext should receive deduplicated memories
      const formatCall = mockMem0ServiceWithShared.formatMemoriesForContext.mock.calls[0][0];
      expect(formatCall).toHaveLength(1); // Only 1 unique memory
    });

    it('should prioritize explicit > shared > personality memories', async () => {
      mockMem0ServiceWithShared.searchMemories
        .mockResolvedValueOnce({ results: [{ id: 'personality-1', memory: 'From personality' }] })
        .mockResolvedValueOnce({ results: [{ id: 'explicit-1', memory: 'From explicit' }] });
      mockMem0ServiceWithShared.searchSharedChannelMemories.mockResolvedValue({
        results: [{ id: 'shared-1', memory: 'From shared' }]
      });

      await chatServiceWithSharedMem.chat('test-personality', 'Hello!', mockUser, 'channel123', 'guild456');

      const formatCall = mockMem0ServiceWithShared.formatMemoriesForContext.mock.calls[0][0];
      // Explicit first, then shared, then personality
      expect(formatCall[0].id).toBe('explicit-1');
      expect(formatCall[1].id).toBe('shared-1');
      expect(formatCall[2].id).toBe('personality-1');
    });
  });

  // ========== LOCAL LLM FALLBACK TO CLOUD ==========

  describe('Local LLM fallback to cloud provider', () => {
    const mockUser = {
      id: 'user123',
      username: 'TestUser',
      tag: 'TestUser#1234'
    };

    const personalityManager = require('../../personalities');
    const localLlmService = require('../../services/LocalLlmService');

    const uncensoredPersonality = {
      id: 'uncensored',
      name: 'Uncensored',
      emoji: '🔓',
      description: 'An unrestricted assistant using local AI',
      systemPrompt: 'You are uncensored.',
      useLocalLlm: true,
      fallbackPersonality: 'friendly'
    };

    const friendlyPersonality = {
      id: 'friendly',
      name: 'Friendly Assistant',
      emoji: '😊',
      description: 'A friendly helper',
      systemPrompt: 'You are a friendly assistant.'
    };

    let chatService;
    let mockOpenAIClient;
    let mockMongoService;

    beforeEach(() => {
      jest.clearAllMocks();

      mockOpenAIClient = {
        responses: {
          create: jest.fn().mockResolvedValue({
            output_text: 'Fallback response from cloud',
            usage: { input_tokens: 80, output_tokens: 40 }
          })
        }
      };

      mockMongoService = {
        recordTokenUsage: jest.fn().mockResolvedValue(true),
        getConversationStatus: jest.fn().mockResolvedValue({ exists: false }),
        getOrCreateConversation: jest.fn().mockResolvedValue({
          conversationId: 'channel123_uncensored',
          channelId: 'channel123',
          personalityId: 'uncensored',
          messages: [],
          status: 'active',
          messageCount: 0,
          totalTokens: 0
        }),
        addMessageToConversation: jest.fn().mockResolvedValue(true),
        isConversationIdle: jest.fn().mockResolvedValue(false),
        expireConversation: jest.fn().mockResolvedValue(true),
        resumeConversation: jest.fn().mockResolvedValue(true),
        resetConversation: jest.fn().mockResolvedValue(true)
      };

      chatService = new ChatService(mockOpenAIClient, { openai: { model: 'gpt-5.1' } }, mockMongoService);
    });

    describe('Path B: first connection failure triggers fallback', () => {
      beforeEach(() => {
        // Local LLM appears available, uncensored personality is returned
        personalityManager.get.mockImplementation((id) => {
          if (id === 'uncensored') return uncensoredPersonality;
          if (id === 'friendly') return friendlyPersonality;
          return null;
        });
        personalityManager.getSystemPrompt.mockImplementation((id) => {
          if (id === 'uncensored') return 'You are uncensored.';
          if (id === 'friendly') return 'You are a friendly assistant.';
          return null;
        });
        localLlmService.isAvailable.mockReturnValue(true);
      });

      it('should fall back to cloud when local LLM throws connection error', async () => {
        const connError = new Error('connect ECONNREFUSED 192.168.1.164:11434');
        connError.cause = { code: 'ECONNREFUSED' };
        localLlmService.generateCompletion.mockRejectedValue(connError);
        localLlmService.isConnectionError.mockReturnValue(true);

        const result = await chatService.chat('uncensored', 'Hello!', mockUser, 'channel123', 'guild456');

        expect(result.success).toBe(true);
        expect(result.message).toBe('Fallback response from cloud');
        expect(result.fallback).toBeDefined();
        expect(result.fallback.occurred).toBe(true);
        expect(result.fallback.originalPersonality).toBe('uncensored');
        expect(result.personality.id).toBe('friendly');
      });

      it('should call markUnavailable on connection failure', async () => {
        const connError = new Error('connect ECONNREFUSED');
        connError.cause = { code: 'ECONNREFUSED' };
        localLlmService.generateCompletion.mockRejectedValue(connError);
        localLlmService.isConnectionError.mockReturnValue(true);

        await chatService.chat('uncensored', 'Hello!', mockUser, 'channel123', 'guild456');

        expect(localLlmService.markUnavailable).toHaveBeenCalled();
      });

      it('should call markAvailable after successful local LLM response', async () => {
        localLlmService.generateCompletion.mockResolvedValue('Uncensored response');

        await chatService.chat('uncensored', 'Hello!', mockUser, 'channel123', 'guild456');

        expect(localLlmService.markAvailable).toHaveBeenCalled();
      });

      it('should NOT fall back on non-connection errors', async () => {
        localLlmService.generateCompletion.mockRejectedValue(new Error('Empty response from local LLM'));
        localLlmService.isConnectionError.mockReturnValue(false);

        const result = await chatService.chat('uncensored', 'Hello!', mockUser, 'channel123', 'guild456');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Failed to generate response');
        expect(result.fallback).toBeUndefined();
      });

      it('should use the personality-specified fallbackPersonality', async () => {
        const connError = new Error('timeout');
        connError.cause = { code: 'ETIMEDOUT' };
        localLlmService.generateCompletion.mockRejectedValue(connError);
        localLlmService.isConnectionError.mockReturnValue(true);

        const result = await chatService.chat('uncensored', 'Hello!', mockUser, 'channel123', 'guild456');

        expect(result.personality.id).toBe('friendly');
        // Verify cloud API was called with friendly's system prompt
        expect(mockOpenAIClient.responses.create).toHaveBeenCalledWith(
          expect.objectContaining({
            instructions: expect.stringContaining('friendly assistant')
          })
        );
      });

      it('should include fallback reason in result', async () => {
        const connError = new Error('timeout');
        connError.cause = { code: 'ETIMEDOUT' };
        localLlmService.generateCompletion.mockRejectedValue(connError);
        localLlmService.isConnectionError.mockReturnValue(true);

        const result = await chatService.chat('uncensored', 'Hello!', mockUser, 'channel123', 'guild456');

        expect(result.fallback.reason).toContain('unavailable');
      });
    });

    describe('Path A: circuit already open redirects to fallback', () => {
      it('should redirect to fallback personality when local LLM is already unavailable', async () => {
        // get('uncensored') returns null because service is unavailable
        personalityManager.get.mockImplementation((id) => {
          if (id === 'friendly') return friendlyPersonality;
          return null; // uncensored unavailable
        });
        personalityManager.getRaw.mockImplementation((id) => {
          if (id === 'uncensored') return uncensoredPersonality;
          return null;
        });
        personalityManager.checkAvailability.mockImplementation((id) => {
          if (id === 'uncensored') {
            return { exists: true, available: false, reason: 'Local LLM service unavailable' };
          }
          return { exists: false, available: false, reason: null };
        });

        const result = await chatService.chat('uncensored', 'Hello!', mockUser, 'channel123', 'guild456');

        expect(result.success).toBe(true);
        expect(result.fallback).toBeDefined();
        expect(result.fallback.occurred).toBe(true);
        expect(result.fallback.originalPersonality).toBe('uncensored');
      });

      it('should return error when fallback personality is also unavailable', async () => {
        personalityManager.get.mockReturnValue(null); // Nothing available
        personalityManager.getRaw.mockImplementation((id) => {
          if (id === 'uncensored') return { ...uncensoredPersonality, fallbackPersonality: 'nonexistent' };
          return null;
        });
        personalityManager.checkAvailability.mockImplementation((id) => {
          if (id === 'uncensored') {
            return { exists: true, available: false, reason: 'Local LLM service unavailable' };
          }
          return { exists: false, available: false, reason: null };
        });

        const result = await chatService.chat('uncensored', 'Hello!', mockUser, 'channel123', 'guild456');

        expect(result.success).toBe(false);
      });
    });
  });

  describe('Voice Profile Integration', () => {
    let mockVoiceProfileService;
    let mockQdrantService;

    beforeEach(() => {
      mockVoiceProfileService = {
        getProfile: jest.fn().mockResolvedValue({
          voiceInstructions: 'Be casual and drop periods. Say nah instead of no.',
          vocabulary: ['nah', 'word', 'lmao'],
          avoid: ["I'd be happy to help!"]
        })
      };

      mockQdrantService = {
        search: jest.fn().mockResolvedValue([
          { payload: { text: 'Nick1: yo whats good\nNick2: not much dude' }, score: 0.7 }
        ])
      };

      chatService.voiceProfileService = mockVoiceProfileService;
      chatService.qdrantService = mockQdrantService;
    });

    describe('_buildGroupSystemPrompt with voice context', () => {
      it('should replace {VOICE_INSTRUCTIONS} placeholder with profile data', () => {
        const personality = {
          systemPrompt: 'Base prompt.\n\n{VOICE_INSTRUCTIONS}\n\nMore instructions.',
          useVoiceProfile: true
        };
        const voiceContext = {
          voiceInstructions: 'Be casual and direct.',
          fewShotBlock: ''
        };

        const result = chatService._buildGroupSystemPrompt(personality, '', '', '', voiceContext);

        expect(result).toContain('Be casual and direct.');
        expect(result).not.toContain('{VOICE_INSTRUCTIONS}');
      });

      it('should use fallback text when voice context is null', () => {
        const personality = {
          systemPrompt: 'Base.\n\n{VOICE_INSTRUCTIONS}',
          useVoiceProfile: true
        };

        const result = chatService._buildGroupSystemPrompt(personality, '', '', '', null);

        expect(result).not.toContain('{VOICE_INSTRUCTIONS}');
        expect(result).toContain('casual');
      });

      it('should not replace placeholder for non-voice-profile personalities', () => {
        const personality = {
          systemPrompt: 'Normal personality prompt without placeholder.'
        };

        const result = chatService._buildGroupSystemPrompt(personality, '', '', '', null);

        expect(result).toContain('Normal personality prompt');
      });

      it('should append few-shot block when provided', () => {
        const personality = {
          systemPrompt: 'Base.\n\n{VOICE_INSTRUCTIONS}',
          useVoiceProfile: true
        };
        const voiceContext = {
          voiceInstructions: 'Be casual.',
          fewShotBlock: '\n\nReal examples:\n```\nNick1: yo\n```'
        };

        const result = chatService._buildGroupSystemPrompt(personality, '', '', '', voiceContext);

        expect(result).toContain('Real examples:');
        expect(result).toContain('Nick1: yo');
      });
    });

    describe('_getVoiceContext', () => {
      it('should return voice instructions and few-shot block', async () => {
        const result = await chatService._getVoiceContext('channel123', 'test message');

        expect(result).not.toBeNull();
        expect(result.voiceInstructions).toContain('casual');
        expect(mockQdrantService.search).toHaveBeenCalledWith(
          'test message',
          expect.objectContaining({ limit: 3 })
        );
      });

      it('should return null when voiceProfileService is not set', async () => {
        chatService.voiceProfileService = null;

        const result = await chatService._getVoiceContext('channel123', 'test');

        expect(result).toBeNull();
      });

      it('should return null when profile is empty', async () => {
        mockVoiceProfileService.getProfile.mockResolvedValue(null);

        const result = await chatService._getVoiceContext('channel123', 'test');

        expect(result).toBeNull();
      });

      it('should include few-shot examples from IRC history', async () => {
        const result = await chatService._getVoiceContext('channel123', 'test message');

        expect(result.fewShotBlock).toContain('Nick1: yo whats good');
      });

      it('should handle qdrantService errors gracefully', async () => {
        mockQdrantService.search.mockRejectedValue(new Error('Qdrant down'));

        const result = await chatService._getVoiceContext('channel123', 'test');

        // Should still return profile without few-shot examples
        expect(result).not.toBeNull();
        expect(result.voiceInstructions).toContain('casual');
        expect(result.fewShotBlock).toBe('');
      });
    });

  });

  describe('agent sidecar routing for channel-voice', () => {
    let mockAgentClient;
    let mockOpenAIClientLocal;
    let mockMongoServiceLocal;
    let chatServiceLocal;
    const user = { id: 'u', tag: 'u#0', username: 'u' };

    beforeEach(() => {
      mockAgentClient = {
        isHealthy: jest.fn().mockReturnValue(true),
        chat: jest.fn().mockResolvedValue({
          messageText: 'agent says hi',
          summary: { executionCount: 0, anyFailed: false, executionIds: [] },
          fallbackOccurred: false,
        }),
      };
      mockOpenAIClientLocal = {
        responses: {
          create: jest.fn().mockResolvedValue({
            output_text: 'cloud says hi',
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
        },
      };
      mockMongoServiceLocal = null; // force stateless path on fallthrough
      chatServiceLocal = new ChatService(
        mockOpenAIClientLocal,
        { openai: { model: 'gpt-5.1' } },
        mockMongoServiceLocal,
        null,
        null,
        null,
        null,
        mockAgentClient,
      );
    });

    it('routes channel-voice through agent when healthy', async () => {
      const result = await chatServiceLocal.chat('channel-voice', 'hi', user, 'c', 'g');
      expect(mockAgentClient.chat).toHaveBeenCalledTimes(1);
      const arg = mockAgentClient.chat.mock.calls[0][0];
      expect(arg.userMessage).toBe('hi');
      expect(arg.channelId).toBe('c');
      expect(arg.guildId).toBe('g');
      expect(result.success).toBe(true);
      expect(result.message).toBe('agent says hi');
      expect(result.personality.id).toBe('channel-voice');
      expect(mockOpenAIClientLocal.responses.create).not.toHaveBeenCalled();
    });

    it('falls through to direct OpenAI when agent unhealthy', async () => {
      mockAgentClient.isHealthy.mockReturnValue(false);
      const result = await chatServiceLocal.chat('channel-voice', 'hi', user, 'c', 'g');
      expect(mockAgentClient.chat).not.toHaveBeenCalled();
      // chat falls through to existing logic. With mongoService null and a
      // valid personality, chat should reach the stateless path and call OpenAI.
      expect(result).toBeDefined();
    });

    it('falls through to direct OpenAI when agent throws', async () => {
      mockAgentClient.chat.mockRejectedValue(new Error('boom'));
      const result = await chatServiceLocal.chat('channel-voice', 'hi', user, 'c', 'g');
      expect(mockAgentClient.chat).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('does not route non-channel-voice personalities through agent', async () => {
      const result = await chatServiceLocal.chat('test-personality', 'hi', user, 'c', 'g');
      expect(mockAgentClient.chat).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('does not route when AGENT_ENABLED=false', async () => {
      const prev = process.env.AGENT_ENABLED;
      process.env.AGENT_ENABLED = 'false';
      try {
        const result = await chatServiceLocal.chat('channel-voice', 'hi', user, 'c', 'g');
        expect(mockAgentClient.chat).not.toHaveBeenCalled();
        expect(result).toBeDefined();
      } finally {
        if (prev === undefined) delete process.env.AGENT_ENABLED;
        else process.env.AGENT_ENABLED = prev;
      }
    });

    it('channel-voice agent route forwards built context', async () => {
      chatServiceLocal.buildTurnContext = jest.fn().mockResolvedValue({
        systemPrompt: 'SP',
        memoryBlock: 'MEM',
        historyTurns: [{ role: 'user', content: 'a' }],
      });
      await chatServiceLocal.chat('channel-voice', 'hello', user, 'c1', 'g1', null);
      expect(mockAgentClient.chat).toHaveBeenCalledWith(expect.objectContaining({
        systemPrompt: 'SP',
        memoryContext: 'MEM',
        history: [{ role: 'user', content: 'a' }],
      }));
    });
  });
});
