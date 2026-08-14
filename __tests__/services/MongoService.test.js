// __tests__/services/MongoService.test.js
const MongoService = require('../../services/MongoService');

// Mock the MongoDB client
jest.mock('mongodb', () => {
  const mockCollection = {
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'test-id' }),
    createIndex: jest.fn().mockResolvedValue('idx'),
    aggregate: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([])
    })
  };

  const mockDb = {
    collection: jest.fn().mockReturnValue(mockCollection)
  };

  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    db: jest.fn().mockReturnValue(mockDb)
  };

  return {
    MongoClient: jest.fn().mockImplementation(() => mockClient)
  };
});

// Mock the logger
jest.mock('../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn()
}));

describe('MongoService', () => {
  let mongoService;
  let mockCollection;

  beforeEach(async () => {
    jest.clearAllMocks();
    mongoService = new MongoService('mongodb://localhost:27017/test');
    // Wait for connection
    await new Promise(resolve => setTimeout(resolve, 10));
    // Get reference to mock collection
    mockCollection = mongoService.db.collection('token_usage');
  });

  describe('recordTokenUsage', () => {
    it('should record token usage successfully', async () => {
      const result = await mongoService.recordTokenUsage(
        'user123',
        'TestUser',
        100,
        50,
        'summarize',
        'gpt-5.1'
      );

      expect(result).toBe(true);
      expect(mockCollection.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user123',
          username: 'TestUser',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          commandType: 'summarize',
          model: 'gpt-5.1',
          timestamp: expect.any(Date)
        })
      );
    });

    it('should use default model if not specified', async () => {
      await mongoService.recordTokenUsage(
        'user123',
        'TestUser',
        100,
        50,
        'chat'
      );

      expect(mockCollection.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.1'
        })
      );
    });

    it('should return false if db is not connected', async () => {
      mongoService.db = null;
      const result = await mongoService.recordTokenUsage(
        'user123',
        'TestUser',
        100,
        50,
        'summarize'
      );

      expect(result).toBe(false);
    });
  });

  describe('getUserTokenUsage', () => {
    it('should return empty stats for user with no usage', async () => {
      mockCollection.aggregate.mockReturnValue({
        toArray: jest.fn().mockResolvedValue([])
      });

      const result = await mongoService.getUserTokenUsage('user123');

      expect(result).toEqual({
        userId: 'user123',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        commandBreakdown: {}
      });
    });

    it('should return aggregated stats for user with usage', async () => {
      mockCollection.aggregate.mockReturnValue({
        toArray: jest.fn().mockResolvedValue([{
          _id: 'user123',
          totalInputTokens: 500,
          totalOutputTokens: 250,
          totalTokens: 750,
          requestCount: 5,
          byCommand: [
            { commandType: 'summarize', tokens: 300 },
            { commandType: 'summarize', tokens: 200 },
            { commandType: 'chat', tokens: 250 }
          ]
        }])
      });

      const result = await mongoService.getUserTokenUsage('user123');

      expect(result).toEqual({
        userId: 'user123',
        totalInputTokens: 500,
        totalOutputTokens: 250,
        totalTokens: 750,
        requestCount: 5,
        commandBreakdown: {
          summarize: { count: 2, tokens: 500 },
          chat: { count: 1, tokens: 250 }
        }
      });
    });

    it('should return null if db is not connected', async () => {
      mongoService.db = null;
      const result = await mongoService.getUserTokenUsage('user123');

      expect(result).toBe(null);
    });
  });

  describe('getTokenUsageLeaderboard', () => {
    it('should return empty array when no usage data', async () => {
      mockCollection.aggregate.mockReturnValue({
        toArray: jest.fn().mockResolvedValue([])
      });

      const result = await mongoService.getTokenUsageLeaderboard();

      expect(result).toEqual([]);
    });

    it('should return formatted leaderboard data', async () => {
      mockCollection.aggregate.mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { _id: 'user1', username: 'TopUser', totalTokens: 10000, requestCount: 50 },
          { _id: 'user2', username: 'SecondUser', totalTokens: 5000, requestCount: 25 }
        ])
      });

      const result = await mongoService.getTokenUsageLeaderboard(30, 10);

      expect(result).toEqual([
        { userId: 'user1', username: 'TopUser', totalTokens: 10000, requestCount: 50 },
        { userId: 'user2', username: 'SecondUser', totalTokens: 5000, requestCount: 25 }
      ]);
    });

    it('should return empty array if db is not connected', async () => {
      mongoService.db = null;
      const result = await mongoService.getTokenUsageLeaderboard();

      expect(result).toEqual([]);
    });
  });

  // ========== Chat Conversation Memory Tests ==========

  describe('Chat Conversation Memory', () => {
    beforeEach(() => {
      // Reset mock for conversation tests
      mockCollection.findOne = jest.fn();
      mockCollection.updateOne = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    });

    describe('_getConversationId', () => {
      it('should generate composite ID from channel and personality', () => {
        const id = mongoService._getConversationId('channel123', 'noir-detective');
        expect(id).toBe('channel123_noir-detective');
      });
    });

    describe('getOrCreateConversation', () => {
      it('should return existing active conversation', async () => {
        const existingConversation = {
          conversationId: 'channel123_noir-detective',
          channelId: 'channel123',
          personalityId: 'noir-detective',
          status: 'active',
          messages: [{ role: 'user', content: 'Hello' }]
        };
        mockCollection.findOne.mockResolvedValue(existingConversation);

        const result = await mongoService.getOrCreateConversation('channel123', 'noir-detective', 'guild456');

        expect(result).toEqual(existingConversation);
        expect(mockCollection.insertOne).not.toHaveBeenCalled();
      });

      it('should create new conversation if none exists', async () => {
        mockCollection.findOne.mockResolvedValue(null);

        const result = await mongoService.getOrCreateConversation('channel123', 'noir-detective', 'guild456');

        expect(result).toMatchObject({
          conversationId: 'channel123_noir-detective',
          channelId: 'channel123',
          guildId: 'guild456',
          personalityId: 'noir-detective',
          messages: [],
          status: 'active',
          messageCount: 0,
          totalTokens: 0
        });
        expect(mockCollection.insertOne).toHaveBeenCalled();
      });

      it('should return null if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.getOrCreateConversation('channel123', 'noir-detective', 'guild456');
        expect(result).toBeNull();
      });
    });

    describe('addMessageToConversation', () => {
      it('should add user message with userId and username', async () => {
        const result = await mongoService.addMessageToConversation(
          'channel123',
          'noir-detective',
          'user',
          'Hello detective!',
          'user789',
          'Alice',
          50
        );

        expect(result).toBe(true);
        expect(mockCollection.updateOne).toHaveBeenCalledWith(
          { conversationId: 'channel123_noir-detective', status: 'active' },
          expect.objectContaining({
            $push: { messages: expect.objectContaining({
              role: 'user',
              content: 'Hello detective!',
              userId: 'user789',
              username: 'Alice'
            })},
            $inc: { messageCount: 1, totalTokens: 50 }
          })
        );
      });

      it('should add assistant message without userId', async () => {
        const result = await mongoService.addMessageToConversation(
          'channel123',
          'noir-detective',
          'assistant',
          'The rain fell hard that night...',
          null,
          null,
          75
        );

        expect(result).toBe(true);
        expect(mockCollection.updateOne).toHaveBeenCalledWith(
          { conversationId: 'channel123_noir-detective', status: 'active' },
          expect.objectContaining({
            $push: { messages: expect.objectContaining({
              role: 'assistant',
              content: 'The rain fell hard that night...'
            })}
          })
        );
      });

      it('should return false if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.addMessageToConversation(
          'channel123', 'noir-detective', 'user', 'Hello', 'user789', 'Alice'
        );
        expect(result).toBe(false);
      });
    });

    describe('getConversationHistory', () => {
      it('should return conversation with messages', async () => {
        const conversation = {
          conversationId: 'channel123_noir-detective',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' }
          ]
        };
        mockCollection.findOne.mockResolvedValue(conversation);

        const result = await mongoService.getConversationHistory('channel123', 'noir-detective');

        expect(result).toEqual(conversation);
      });

      it('should return null if no conversation exists', async () => {
        mockCollection.findOne.mockResolvedValue(null);

        const result = await mongoService.getConversationHistory('channel123', 'noir-detective');

        expect(result).toBeNull();
      });
    });

    describe('getConversationStatus', () => {
      it('should return status info for existing conversation', async () => {
        const conversation = {
          status: 'active',
          lastActivity: new Date('2024-01-15T10:30:00Z'),
          messageCount: 5,
          totalTokens: 500
        };
        mockCollection.findOne.mockResolvedValue(conversation);

        const result = await mongoService.getConversationStatus('channel123', 'noir-detective');

        expect(result).toEqual({
          exists: true,
          status: 'active',
          lastActivity: expect.any(Date),
          messageCount: 5,
          totalTokens: 500
        });
      });

      it('should return exists: false for non-existent conversation', async () => {
        mockCollection.findOne.mockResolvedValue(null);

        const result = await mongoService.getConversationStatus('channel123', 'noir-detective');

        expect(result).toEqual({ exists: false });
      });
    });

    describe('resetConversation', () => {
      it('should mark conversation as reset', async () => {
        const result = await mongoService.resetConversation('channel123', 'noir-detective');

        expect(result).toBe(true);
        expect(mockCollection.updateOne).toHaveBeenCalledWith(
          { conversationId: 'channel123_noir-detective', status: 'active' },
          { $set: { status: 'reset', resetAt: expect.any(Date) } }
        );
      });
    });

    describe('expireConversation', () => {
      it('should mark conversation as expired', async () => {
        const result = await mongoService.expireConversation('channel123', 'noir-detective');

        expect(result).toBe(true);
        expect(mockCollection.updateOne).toHaveBeenCalledWith(
          { conversationId: 'channel123_noir-detective', status: 'active' },
          { $set: { status: 'expired', expiredAt: expect.any(Date) } }
        );
      });
    });

    describe('resumeConversation', () => {
      it('should reactivate expired conversation', async () => {
        mockCollection.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

        const result = await mongoService.resumeConversation('channel123', 'noir-detective');

        expect(result).toBe(true);
        expect(mockCollection.updateOne).toHaveBeenCalledWith(
          { conversationId: 'channel123_noir-detective', status: 'expired' },
          {
            $set: { status: 'active', resumedAt: expect.any(Date) },
            $unset: { expiredAt: '' }
          }
        );
      });

      it('should return false if no expired conversation found', async () => {
        mockCollection.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

        const result = await mongoService.resumeConversation('channel123', 'noir-detective');

        expect(result).toBe(false);
      });
    });

    describe('isConversationIdle', () => {
      it('should return false for non-existent conversation', async () => {
        mockCollection.findOne.mockResolvedValue(null);

        const result = await mongoService.isConversationIdle('channel123', 'noir-detective');

        expect(result).toBe(false);
      });

      it('should return true for already expired conversation', async () => {
        mockCollection.findOne.mockResolvedValue({
          status: 'expired',
          lastActivity: new Date()
        });

        const result = await mongoService.isConversationIdle('channel123', 'noir-detective');

        expect(result).toBe(true);
      });

      it('should return true if last activity exceeds timeout', async () => {
        const oldDate = new Date();
        oldDate.setMinutes(oldDate.getMinutes() - 45); // 45 minutes ago
        mockCollection.findOne.mockResolvedValue({
          status: 'active',
          lastActivity: oldDate,
          messageCount: 5,
          totalTokens: 500
        });

        const result = await mongoService.isConversationIdle('channel123', 'noir-detective', 30);

        expect(result).toBe(true);
      });

      it('should return false if last activity within timeout', async () => {
        const recentDate = new Date();
        recentDate.setMinutes(recentDate.getMinutes() - 10); // 10 minutes ago
        mockCollection.findOne.mockResolvedValue({
          status: 'active',
          lastActivity: recentDate,
          messageCount: 5,
          totalTokens: 500
        });

        const result = await mongoService.isConversationIdle('channel123', 'noir-detective', 30);

        expect(result).toBe(false);
      });
    });
  });

  // ========== Image Generation Tracking Tests ==========

  describe('Image Generation Tracking', () => {
    beforeEach(() => {
      mockCollection.find = jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([])
          })
        })
      });
    });

    describe('recordImageGeneration', () => {
      it('should record successful image generation', async () => {
        const result = await mongoService.recordImageGeneration(
          'user123',
          'TestUser',
          'A beautiful sunset',
          '16:9',
          'gemini-3-pro-image-preview',
          true,
          null,
          524288
        );

        expect(result).toBe(true);
        expect(mockCollection.insertOne).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'user123',
            username: 'TestUser',
            prompt: 'A beautiful sunset',
            aspectRatio: '16:9',
            model: 'gemini-3-pro-image-preview',
            success: true,
            error: null,
            imageSizeBytes: 524288,
            timestamp: expect.any(Date)
          })
        );
      });

      it('should record failed image generation with error', async () => {
        const result = await mongoService.recordImageGeneration(
          'user123',
          'TestUser',
          'Something bad',
          '1:1',
          'gemini-3-pro-image-preview',
          false,
          'Safety filter blocked',
          0
        );

        expect(result).toBe(true);
        expect(mockCollection.insertOne).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: 'Safety filter blocked',
            imageSizeBytes: 0
          })
        );
      });

      it('should return false if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.recordImageGeneration(
          'user123',
          'TestUser',
          'A sunset',
          '1:1',
          'gemini-3-pro-image-preview',
          true
        );

        expect(result).toBe(false);
      });
    });

    describe('getImageGenerationStats', () => {
      it('should return empty stats for user with no generations', async () => {
        mockCollection.aggregate.mockReturnValue({
          toArray: jest.fn().mockResolvedValue([])
        });

        const result = await mongoService.getImageGenerationStats('user123');

        expect(result).toEqual({
          totalGenerations: 0,
          successfulGenerations: 0,
          failedGenerations: 0,
          totalBytes: 0
        });
      });

      it('should return aggregated stats for user with generations', async () => {
        mockCollection.aggregate.mockReturnValue({
          toArray: jest.fn().mockResolvedValue([{
            _id: null,
            totalGenerations: 10,
            successfulGenerations: 8,
            failedGenerations: 2,
            totalBytes: 5242880
          }])
        });

        const result = await mongoService.getImageGenerationStats('user123', 30);

        expect(result).toEqual({
          totalGenerations: 10,
          successfulGenerations: 8,
          failedGenerations: 2,
          totalBytes: 5242880
        });
      });

      it('should return empty stats if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.getImageGenerationStats('user123');

        expect(result).toEqual({
          totalGenerations: 0,
          successfulGenerations: 0,
          failedGenerations: 0,
          totalBytes: 0
        });
      });
    });

    describe('getRecentImageGenerations', () => {
      it('should return empty array for user with no generations', async () => {
        const result = await mongoService.getRecentImageGenerations('user123');

        expect(result).toEqual([]);
      });

      it('should return recent generations for user', async () => {
        const mockGenerations = [
          { prompt: 'Sunset', success: true, timestamp: new Date() },
          { prompt: 'Mountain', success: true, timestamp: new Date() }
        ];
        mockCollection.find.mockReturnValue({
          sort: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue(mockGenerations)
            })
          })
        });

        const result = await mongoService.getRecentImageGenerations('user123', 10);

        expect(result).toEqual(mockGenerations);
        expect(mockCollection.find).toHaveBeenCalledWith({ userId: 'user123' });
      });

      it('should return empty array if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.getRecentImageGenerations('user123');

        expect(result).toEqual([]);
      });
    });
  });

  describe('Video Generation Tracking', () => {
    describe('recordVideoGeneration', () => {
      it('should record video generation successfully', async () => {
        const videoCollection = mongoService.db.collection('video_generations');

        const result = await mongoService.recordVideoGeneration(
          'user123',
          'TestUser#1234',
          'A flower blooming',
          8,
          '16:9',
          'veo-3.1-fast-generate-001',
          true,
          null,
          5000000
        );

        expect(result).toBe(true);
        expect(videoCollection.insertOne).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'user123',
            username: 'TestUser#1234',
            prompt: 'A flower blooming',
            duration: 8,
            aspectRatio: '16:9',
            model: 'veo-3.1-fast-generate-001',
            success: true,
            error: null,
            videoSizeBytes: 5000000
          })
        );
      });

      it('should record failed video generation', async () => {
        const videoCollection = mongoService.db.collection('video_generations');

        const result = await mongoService.recordVideoGeneration(
          'user456',
          'FailUser#5678',
          'Bad prompt',
          6,
          '9:16',
          'veo-3.1-fast-generate-001',
          false,
          'Safety filter blocked',
          0
        );

        expect(result).toBe(true);
        expect(videoCollection.insertOne).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'user456',
            success: false,
            error: 'Safety filter blocked',
            videoSizeBytes: 0
          })
        );
      });

      it('should return false if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.recordVideoGeneration(
          'user123', 'TestUser', 'prompt', 8, '16:9', 'model', true, null, 1000
        );

        expect(result).toBe(false);
      });
    });

    describe('getVideoGenerationStats', () => {
      it('should return stats for user', async () => {
        const mockStats = [{
          totalGenerations: 5,
          successfulGenerations: 4,
          failedGenerations: 1,
          totalBytes: 25000000,
          totalDurationSeconds: 36
        }];

        const videoCollection = mongoService.db.collection('video_generations');
        videoCollection.aggregate.mockReturnValue({
          toArray: jest.fn().mockResolvedValue(mockStats)
        });

        const result = await mongoService.getVideoGenerationStats('user123', 30);

        expect(result.totalGenerations).toBe(5);
        expect(result.successfulGenerations).toBe(4);
        expect(result.failedGenerations).toBe(1);
        expect(result.totalBytes).toBe(25000000);
        expect(result.totalDurationSeconds).toBe(36);
      });

      it('should return zeros if no generations found', async () => {
        const videoCollection = mongoService.db.collection('video_generations');
        videoCollection.aggregate.mockReturnValue({
          toArray: jest.fn().mockResolvedValue([])
        });

        const result = await mongoService.getVideoGenerationStats('newuser', 30);

        expect(result.totalGenerations).toBe(0);
        expect(result.successfulGenerations).toBe(0);
        expect(result.totalDurationSeconds).toBe(0);
      });

      it('should return default stats if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.getVideoGenerationStats('user123');

        expect(result).toEqual({
          totalGenerations: 0,
          successfulGenerations: 0,
          failedGenerations: 0,
          totalBytes: 0
        });
      });
    });

    describe('getRecentVideoGenerations', () => {
      it('should return recent generations for user', async () => {
        const mockGenerations = [
          { prompt: 'Video 1', duration: 8 },
          { prompt: 'Video 2', duration: 6 }
        ];

        const videoCollection = mongoService.db.collection('video_generations');
        videoCollection.find = jest.fn().mockReturnValue({
          sort: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue(mockGenerations)
            })
          })
        });

        const result = await mongoService.getRecentVideoGenerations('user123', 10);

        expect(result).toEqual(mockGenerations);
        expect(videoCollection.find).toHaveBeenCalledWith({ userId: 'user123' });
      });

      it('should return empty array if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.getRecentVideoGenerations('user123');

        expect(result).toEqual([]);
      });
    });
  });

  describe('catch-me-up data methods', () => {
    describe('getRecentArticleSummaries', () => {
      it('should return recent article summaries within time range', async () => {
        const mockArticles = [
          { url: 'https://example.com/1', title: 'Article 1', topic: 'Tech', summary: 'Summary 1', createdAt: new Date() },
          { url: 'https://example.com/2', title: 'Article 2', topic: 'Science', summary: 'Summary 2', createdAt: new Date() }
        ];

        const articlesCollection = {
          find: jest.fn().mockReturnValue({
            sort: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                toArray: jest.fn().mockResolvedValue(mockArticles)
              })
            })
          })
        };
        mongoService.db.collection.mockReturnValue(articlesCollection);

        const result = await mongoService.getRecentArticleSummaries(7);

        expect(mongoService.db.collection).toHaveBeenCalledWith('articles');
        expect(result).toEqual(mockArticles);
        expect(articlesCollection.find).toHaveBeenCalledWith(
          expect.objectContaining({
            createdAt: expect.objectContaining({ $gte: expect.any(Date) })
          })
        );
      });

      it('should return empty array if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.getRecentArticleSummaries(7);
        expect(result).toEqual([]);
      });
    });

    describe('recordUserActivity', () => {
      it('should upsert user activity record', async () => {
        const activityCollection = {
          updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
        };
        mongoService.db.collection.mockReturnValue(activityCollection);

        await mongoService.recordUserActivity('user123', 'guild456', 'channel789');

        expect(mongoService.db.collection).toHaveBeenCalledWith('user_activity');
        expect(activityCollection.updateOne).toHaveBeenCalledWith(
          { userId: 'user123', guildId: 'guild456' },
          expect.objectContaining({
            $set: expect.objectContaining({
              userId: 'user123',
              guildId: 'guild456',
              lastSeenAt: expect.any(Date)
            }),
            $addToSet: { activeChannels: 'channel789' }
          }),
          { upsert: true }
        );
      });

      it('should not throw if db is not connected', async () => {
        mongoService.db = null;
        await expect(mongoService.recordUserActivity('user123', 'guild456', 'channel789')).resolves.not.toThrow();
      });
    });

    describe('getUserLastSeen', () => {
      it('should return user activity record', async () => {
        const mockActivity = {
          userId: 'user123',
          guildId: 'guild456',
          lastSeenAt: new Date('2026-04-09'),
          activeChannels: ['channel1', 'channel2']
        };

        const activityCollection = {
          findOne: jest.fn().mockResolvedValue(mockActivity)
        };
        mongoService.db.collection.mockReturnValue(activityCollection);

        const result = await mongoService.getUserLastSeen('user123', 'guild456');

        expect(result).toEqual(mockActivity);
        expect(activityCollection.findOne).toHaveBeenCalledWith({
          userId: 'user123',
          guildId: 'guild456'
        });
      });

      it('should return null if no record exists', async () => {
        const activityCollection = {
          findOne: jest.fn().mockResolvedValue(null)
        };
        mongoService.db.collection.mockReturnValue(activityCollection);

        const result = await mongoService.getUserLastSeen('newuser', 'guild456');
        expect(result).toBeNull();
      });

      it('should return null if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.getUserLastSeen('user123', 'guild456');
        expect(result).toBeNull();
      });
    });

    describe('recordChannelMessage', () => {
      it('should insert a message document', async () => {
        const msgCollection = {
          insertOne: jest.fn().mockResolvedValue({ insertedId: 'msg-id' })
        };
        mongoService.db.collection.mockReturnValue(msgCollection);

        await mongoService.recordChannelMessage({
          messageId: 'msg123',
          channelId: 'channel456',
          guildId: 'guild789',
          authorId: 'user123',
          authorName: 'Alice',
          content: 'Hello world',
          timestamp: new Date()
        });

        expect(mongoService.db.collection).toHaveBeenCalledWith('channel_messages');
        expect(msgCollection.insertOne).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: 'msg123',
            channelId: 'channel456',
            authorName: 'Alice',
            content: 'Hello world'
          })
        );
      });

      it('should not throw if db is not connected', async () => {
        mongoService.db = null;
        await expect(mongoService.recordChannelMessage({ messageId: 'x' })).resolves.not.toThrow();
      });
    });

    describe('getChannelMessages', () => {
      it('should return messages for a channel since a given time', async () => {
        const mockMessages = [
          { authorName: 'Alice', content: 'Hello', timestamp: new Date() },
          { authorName: 'Bob', content: 'Hi there', timestamp: new Date() }
        ];

        const msgCollection = {
          find: jest.fn().mockReturnValue({
            sort: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                toArray: jest.fn().mockResolvedValue(mockMessages)
              })
            })
          })
        };
        mongoService.db.collection.mockReturnValue(msgCollection);

        const since = new Date('2026-04-10T00:00:00Z');
        const result = await mongoService.getChannelMessages('channel456', since, 50);

        expect(mongoService.db.collection).toHaveBeenCalledWith('channel_messages');
        expect(msgCollection.find).toHaveBeenCalledWith({
          channelId: 'channel456',
          timestamp: { $gte: since }
        });
        expect(result).toEqual(mockMessages);
      });

      it('should query multiple channels when array is provided', async () => {
        const msgCollection = {
          find: jest.fn().mockReturnValue({
            sort: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                toArray: jest.fn().mockResolvedValue([])
              })
            })
          })
        };
        mongoService.db.collection.mockReturnValue(msgCollection);

        await mongoService.getChannelMessages(['ch1', 'ch2'], new Date());

        expect(msgCollection.find).toHaveBeenCalledWith(
          expect.objectContaining({
            channelId: { $in: ['ch1', 'ch2'] }
          })
        );
      });

      it('should return empty array if db is not connected', async () => {
        mongoService.db = null;
        const result = await mongoService.getChannelMessages('ch1', new Date());
        expect(result).toEqual([]);
      });
    });
  });
});

describe('MongoService.getRecentChannelMessages', () => {
  let svc;
  let mockCollection;

  beforeEach(async () => {
    svc = new MongoService('mongodb://test/test');
    await new Promise(resolve => setTimeout(resolve, 10));
    mockCollection = {
      find: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn(),
    };
    svc.db = { collection: jest.fn(() => mockCollection) };
  });

  test('returns messages sorted ascending (oldest first) regardless of DB return order', async () => {
    // DB returns DESC (newest first); we reverse to ascending
    mockCollection.toArray.mockResolvedValueOnce([
      { messageId: '3', timestamp: new Date('2026-05-16T03:00:00Z'), content: 'c' },
      { messageId: '2', timestamp: new Date('2026-05-16T02:00:00Z'), content: 'b' },
      { messageId: '1', timestamp: new Date('2026-05-16T01:00:00Z'), content: 'a' },
    ]);
    const out = await svc.getRecentChannelMessages('chan-1', 100);
    expect(svc.db.collection).toHaveBeenCalledWith('channel_messages');
    expect(mockCollection.find).toHaveBeenCalledWith({ channelId: 'chan-1' });
    expect(mockCollection.sort).toHaveBeenCalledWith({ timestamp: -1 });
    expect(mockCollection.limit).toHaveBeenCalledWith(100);
    expect(out.map(m => m.messageId)).toEqual(['1', '2', '3']);
  });

  test('returns empty array when db is null', async () => {
    svc.db = null;
    const out = await svc.getRecentChannelMessages('chan-1', 100);
    expect(out).toEqual([]);
  });

  test('returns empty array when query throws', async () => {
    mockCollection.toArray.mockRejectedValueOnce(new Error('boom'));
    const out = await svc.getRecentChannelMessages('chan-1', 100);
    expect(out).toEqual([]);
  });

  test('honors the limit parameter', async () => {
    mockCollection.toArray.mockResolvedValueOnce([]);
    await svc.getRecentChannelMessages('chan-1', 5);
    expect(mockCollection.limit).toHaveBeenCalledWith(5);
  });
});

describe('MongoService connect retry', () => {
  test('retries with backoff when the initial connect fails, then sets db on success', async () => {
    jest.useFakeTimers();
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(); // shared mock client instance
    client.connect.mockReset();
    // First connect rejects (Mongo not up yet, e.g. outage restart); retry succeeds.
    client.connect.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue(undefined);

    const svc = new MongoService('mongodb://x:27017/test');
    await Promise.resolve(); await Promise.resolve();
    expect(svc.db).toBeNull();                 // failed initial connect leaves db null...
    expect(client.connect).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1100);            // ...but a retry is scheduled (1s backoff)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(svc.db).not.toBeNull();             // reconnected on its own

    jest.useRealTimers();
  });
});
