
const { MongoClient } = require('mongodb');
const logger = require('../logger');
const { withSpan } = require('../tracing');
const { DB, ERROR } = require('../tracing-attributes');

class MongoService {
    constructor(mongoUri) {
        logger.info('Initializing MongoDB Service...');
        if (!mongoUri) {
            const errorMessage = 'mongoUri parameter is not provided to MongoService constructor';
            logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        logger.info('Attempting to connect to MongoDB...');
        this.client = new MongoClient(mongoUri);
        this.db = null;
        this.connect();
    }

    /**
     * Wrap a database operation with tracing
     * @param {string} operation - Operation name (e.g., 'insertOne', 'find')
     * @param {string} collection - Collection name
     * @param {Function} fn - Async function to execute
     * @returns {Promise<*>} Result of the operation
     * @private
     */
    async _traced(operation, collection, fn) {
        return withSpan(`mongodb.${operation}`, {
            [DB.SYSTEM]: 'mongodb',
            [DB.NAME]: 'discord',
            [DB.OPERATION]: operation,
            [DB.COLLECTION]: collection,
            [DB.NAMESPACE]: `discord.${collection}`,
        }, async (span) => {
            try {
                const result = await fn(span);
                return result;
            } catch (error) {
                span.setAttributes({
                    [ERROR.TYPE]: error.name || 'MongoError',
                    [ERROR.MESSAGE]: error.message,
                });
                throw error;
            }
        });
    }

    async connect(attempt = 1) {
        try {
            await this.client.connect();
            this.db = this.client.db('discord');
            logger.info(`Successfully connected to MongoDB${attempt > 1 ? ` (attempt ${attempt})` : ''}.`);

            // Ensure indexes for time-range queries
            this.db.collection('channel_messages').createIndex(
              { channelId: 1, timestamp: 1 }
            ).catch(err => logger.debug(`Index creation (channel_messages): ${err.message}`));
            this.db.collection('recall_ledger').createIndex(
              { memoryKey: 1 }, { unique: true }
            ).catch(err => logger.debug(`Index creation (recall_ledger): ${err.message}`));
            this.db.collection('recall_ledger').createIndex(
              { expiresAt: 1 }
            ).catch(err => logger.debug(`Index creation (recall_ledger.expiresAt): ${err.message}`));
            this.db.collection('recall_ledger').createIndex(
              { contentHash: 1 }
            ).catch(err => logger.debug(`Index creation (recall_ledger.contentHash): ${err.message}`));
            this.db.collection('recall_comparisons').createIndex(
              { ts: 1 }
            ).catch(err => logger.debug(`Index creation (recall_comparisons): ${err.message}`));
        } catch (error) {
            // Retry with capped exponential backoff. Without this, an outage
            // restart that races MongoDB's own startup leaves this.db null
            // forever (observed: voice profile / recall / history all broken
            // until a manual restart). Retrying reconnects on its own once
            // MongoDB is reachable again.
            const delayMs = Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5));
            logger.error(`Error connecting to MongoDB (attempt ${attempt}); retrying in ${delayMs}ms: ${error.message}`);
            const t = setTimeout(() => this.connect(attempt + 1), delayMs);
            if (t.unref) t.unref();
        }
    }

    async persistData(data) {
        if (!this.db) {
            logger.error('Cannot persist data: Not connected to MongoDB.');
            return;
        }
        return this._traced('insertOne', 'articles', async (span) => {
            const collection = this.db.collection('articles');
            const articleData = {
                ...data,
                createdAt: new Date(),
                followUpStatus: 'none', // 'none', 'pending', 'completed'
                followUpUsers: [], // Array of user IDs who want follow-ups
                reactions: {}, // Store reactions for controversy meter
            };
            const result = await collection.insertOne(articleData);
            span.setAttribute(DB.DOCUMENTS_AFFECTED, result.insertedId ? 1 : 0);
            return result;
        });
    }

    async updateFollowUpStatus(url, status) {
        if (!this.db) {
            logger.error('Cannot update follow-up status: Not connected to MongoDB.');
            return;
        }
        try {
            const collection = this.db.collection('articles');
            await collection.updateOne({ url }, { $set: { followUpStatus: status } });
        } catch (error) {
            logger.error('Error updating follow-up status in MongoDB:', error);
        }
    }

    async addFollowUpUser(url, userId) {
        if (!this.db) {
            logger.error('Cannot add follow-up user: Not connected to MongoDB.');
            return;
        }
        try {
            const collection = this.db.collection('articles');
            await collection.updateOne({ url }, { $addToSet: { followUpUsers: userId } });
        } catch (error) {
            logger.error('Error adding follow-up user in MongoDB:', error);
        }
    }

    async updateArticleReactions(url, emoji, count) {
        if (!this.db) {
            logger.error('Cannot update article reactions: Not connected to MongoDB.');
            return;
        }
        try {
            const collection = this.db.collection('articles');
            const updateField = `reactions.${emoji}`;
            await collection.updateOne({ url }, { $set: { [updateField]: count } });
            logger.info(`Updated reactions for ${url}: ${emoji} = ${count}`);
        } catch (error) {
            logger.error(`Error updating reactions for article ${url} in MongoDB: ${error.message}`);
        }
    }

    async getArticlesForFollowUp() {
        if (!this.db) {
            logger.error('Cannot get articles for follow-up: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('articles');
            return await collection.find({ followUpStatus: 'pending' }).toArray();
        } catch (error) {
            logger.error('Error getting articles for follow-up in MongoDB:', error);
            return [];
        }
    }

    async subscribeUserToTopic(userId, topic) {
        if (!this.db) {
            logger.error('Cannot subscribe user: Not connected to MongoDB.');
            return;
        }
        try {
            const collection = this.db.collection('users');
            await collection.updateOne(
                { userId },
                { $addToSet: { subscribedTopics: topic } },
                { upsert: true }
            );
            logger.info(`User ${userId} subscribed to topic: ${topic}`);
        } catch (error) {
            logger.error(`Error subscribing user ${userId} to topic ${topic}: ${error.message}`);
        }
    }

    async unsubscribeUserFromTopic(userId, topic) {
        if (!this.db) {
            logger.error('Cannot unsubscribe user: Not connected to MongoDB.');
            return;
        }
        try {
            const collection = this.db.collection('users');
            await collection.updateOne(
                { userId },
                { $pull: { subscribedTopics: topic } }
            );
            logger.info(`User ${userId} unsubscribed from topic: ${topic}`);
        } catch (error) {
            logger.error(`Error unsubscribing user ${userId} from topic ${topic}: ${error.message}`);
        }
    }

    async getUserSubscriptions(userId) {
        if (!this.db) {
            logger.error('Cannot get user subscriptions: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('users');
            const user = await collection.findOne({ userId });
            return user ? user.subscribedTopics || [] : [];
        } catch (error) {
            logger.error(`Error getting subscriptions for user ${userId}: ${error.message}`);
            return [];
        }
    }

    async getUsersSubscribedToTopic(topic) {
        if (!this.db) {
            logger.error('Cannot get users subscribed to topic: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('users');
            const users = await collection.find({ subscribedTopics: topic }).toArray();
            return users.map(user => user.userId);
        } catch (error) {
            logger.error(`Error getting users subscribed to topic ${topic}: ${error.message}`);
            return [];
        }
    }

    async getArticleTrends(days = 7) {
        if (!this.db) {
            logger.error('Cannot get article trends: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('articles');
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - days);

            const trends = await collection.aggregate([
                { $match: { createdAt: { $gte: sevenDaysAgo }, topic: { $ne: null } } },
                { $group: { _id: '$topic', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 5 }
            ]).toArray();
            return trends;
        } catch (error) {
            logger.error(`Error getting article trends from MongoDB: ${error.message}`);
            return [];
        }
    }

    async findArticleByUrl(url) {
        if (!this.db) {
            logger.error('Cannot find article: Not connected to MongoDB.');
            return null;
        }
        try {
            const collection = this.db.collection('articles');
            return await collection.findOne({ url });
        } catch (error) {
            logger.error('Error finding article in MongoDB:', error);
            return null;
        }
    }

    async findRelatedArticles(topic, currentUrl, limit = 3) {
        if (!this.db) {
            logger.error('Cannot find related articles: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('articles');
            const query = {
                topic: topic,
                url: { $ne: currentUrl } // Exclude the current article
            };
            return await collection.find(query).sort({ createdAt: -1 }).limit(limit).toArray();
        } catch (error) {
            logger.error('Error finding related articles in MongoDB:', error);
            return [];
        }
    }

    async getUserReadingCount(userId, days = 30) {
        if (!this.db) {
            logger.error('Cannot get user reading count: Not connected to MongoDB.');
            return 0;
        }
        try {
            const collection = this.db.collection('articles');
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - days);

            const count = await collection.countDocuments({
                userId: userId,
                createdAt: { $gte: thirtyDaysAgo }
            });
            return count;
        } catch (error) {
            logger.error(`Error getting reading count for user ${userId}: ${error.message}`);
            return 0;
        }
    }

    async getPopularSources(days = 30) {
        if (!this.db) {
            logger.error('Cannot get popular sources: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('articles');
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - days);

            const sources = await collection.aggregate([
                { $match: { createdAt: { $gte: thirtyDaysAgo }, source: { $ne: null } } },
                { $group: { _id: '$source', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 5 }
            ]).toArray();
            return sources;
        } catch (error) {
            logger.error(`Error getting popular sources from MongoDB: ${error.message}`);
            return [];
        }
    }

    async getControversialArticles(days = 7, minReactions = 5) {
        if (!this.db) {
            logger.error('Cannot get controversial articles: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('articles');
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - days);

            const controversialArticles = await collection.aggregate([
                { $match: { createdAt: { $gte: sevenDaysAgo }, 'reactions.total': { $gte: minReactions } } },
                { $sort: { 'reactions.total': -1 } },
                { $limit: 5 }
            ]).toArray();
            return controversialArticles;
        } catch (error) {
            logger.error(`Error getting controversial articles from MongoDB: ${error.message}`);
            return [];
        }
    }

    // ========== Token Usage Tracking ==========

    /**
     * Record token usage for a Discord user
     * @param {string} userId - Discord user ID
     * @param {string} username - Discord username
     * @param {number} inputTokens - Number of input tokens used
     * @param {number} outputTokens - Number of output tokens used
     * @param {string} commandType - Type of command (e.g., 'summarize', 'chat', 'personality')
     * @param {string} model - Model used (e.g., 'gpt-5.1')
     */
    async recordTokenUsage(userId, username, inputTokens, outputTokens, commandType, model = 'gpt-5.1') {
        if (!this.db) {
            logger.error('Cannot record token usage: Not connected to MongoDB.');
            return false;
        }
        return this._traced('insertOne', 'token_usage', async (span) => {
            span.setAttributes({
                'token_usage.user_id': userId,
                'token_usage.command_type': commandType,
                'token_usage.model': model,
                'token_usage.input_tokens': inputTokens,
                'token_usage.output_tokens': outputTokens,
                'token_usage.total_tokens': inputTokens + outputTokens,
            });
            const collection = this.db.collection('token_usage');
            await collection.insertOne({
                userId,
                username,
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                commandType,
                model,
                timestamp: new Date()
            });
            logger.debug(`Recorded token usage for user ${username}: ${inputTokens} in, ${outputTokens} out`);
            span.setAttribute(DB.DOCUMENTS_AFFECTED, 1);
            return true;
        });
    }

    /**
     * Get token usage statistics for a specific user
     * @param {string} userId - Discord user ID
     * @param {number} days - Number of days to look back (default: 30)
     * @returns {Object} Usage statistics
     */
    async getUserTokenUsage(userId, days = 30) {
        if (!this.db) {
            logger.error('Cannot get user token usage: Not connected to MongoDB.');
            return null;
        }
        try {
            const collection = this.db.collection('token_usage');
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);

            const stats = await collection.aggregate([
                {
                    $match: {
                        userId,
                        timestamp: { $gte: startDate }
                    }
                },
                {
                    $group: {
                        _id: '$userId',
                        totalInputTokens: { $sum: '$inputTokens' },
                        totalOutputTokens: { $sum: '$outputTokens' },
                        totalTokens: { $sum: '$totalTokens' },
                        requestCount: { $sum: 1 },
                        byCommand: {
                            $push: {
                                commandType: '$commandType',
                                tokens: '$totalTokens'
                            }
                        }
                    }
                }
            ]).toArray();

            if (stats.length === 0) {
                return {
                    userId,
                    totalInputTokens: 0,
                    totalOutputTokens: 0,
                    totalTokens: 0,
                    requestCount: 0,
                    commandBreakdown: {}
                };
            }

            // Calculate command breakdown
            const commandBreakdown = {};
            for (const item of stats[0].byCommand) {
                if (!commandBreakdown[item.commandType]) {
                    commandBreakdown[item.commandType] = { count: 0, tokens: 0 };
                }
                commandBreakdown[item.commandType].count++;
                commandBreakdown[item.commandType].tokens += item.tokens;
            }

            return {
                userId,
                totalInputTokens: stats[0].totalInputTokens,
                totalOutputTokens: stats[0].totalOutputTokens,
                totalTokens: stats[0].totalTokens,
                requestCount: stats[0].requestCount,
                commandBreakdown
            };
        } catch (error) {
            logger.error(`Error getting token usage for user ${userId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Get token usage leaderboard (top users by token consumption)
     * @param {number} days - Number of days to look back (default: 30)
     * @param {number} limit - Number of users to return (default: 10)
     * @returns {Array} Top users by token usage
     */
    async getTokenUsageLeaderboard(days = 30, limit = 10) {
        if (!this.db) {
            logger.error('Cannot get token leaderboard: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('token_usage');
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);

            const leaderboard = await collection.aggregate([
                {
                    $match: {
                        timestamp: { $gte: startDate }
                    }
                },
                {
                    $group: {
                        _id: '$userId',
                        username: { $first: '$username' },
                        totalTokens: { $sum: '$totalTokens' },
                        requestCount: { $sum: 1 }
                    }
                },
                { $sort: { totalTokens: -1 } },
                { $limit: limit }
            ]).toArray();

            return leaderboard.map(entry => ({
                userId: entry._id,
                username: entry.username,
                totalTokens: entry.totalTokens,
                requestCount: entry.requestCount
            }));
        } catch (error) {
            logger.error(`Error getting token leaderboard: ${error.message}`);
            return [];
        }
    }

    // ========== Chat Conversation Memory ==========

    /**
     * Generate conversation ID from channel and personality
     * @param {string} channelId - Discord channel ID
     * @param {string} personalityId - Personality identifier
     * @returns {string} Composite conversation ID
     */
    _getConversationId(channelId, personalityId) {
        return `${channelId}_${personalityId}`;
    }

    /**
     * Get or create a conversation for a channel + personality
     * @param {string} channelId - Discord channel ID
     * @param {string} personalityId - Personality identifier
     * @param {string} guildId - Discord guild/server ID
     * @returns {Object} Conversation document
     */
    async getOrCreateConversation(channelId, personalityId, guildId) {
        if (!this.db) {
            logger.error('Cannot get/create conversation: Not connected to MongoDB.');
            return null;
        }
        return this._traced('getOrCreate', 'chat_conversations', async (span) => {
            span.setAttributes({
                'conversation.channel_id': channelId,
                'conversation.personality_id': personalityId,
            });
            const collection = this.db.collection('chat_conversations');
            const conversationId = this._getConversationId(channelId, personalityId);

            // Try to find existing active conversation
            let conversation = await collection.findOne({
                conversationId,
                status: 'active'
            });

            if (!conversation) {
                // Create new conversation
                const newConversation = {
                    conversationId,
                    channelId,
                    guildId,
                    personalityId,
                    messages: [],
                    status: 'active',
                    lastActivity: new Date(),
                    messageCount: 0,
                    totalTokens: 0,
                    createdAt: new Date()
                };
                await collection.insertOne(newConversation);
                conversation = newConversation;
                logger.info(`Created new conversation: ${conversationId}`);
                span.setAttribute('conversation.created', true);
            } else {
                span.setAttribute('conversation.created', false);
            }

            span.setAttribute(DB.DOCUMENTS_RETURNED, 1);
            return conversation;
        });
    }

    /**
     * Add a message to a conversation
     * @param {string} channelId - Discord channel ID
     * @param {string} personalityId - Personality identifier
     * @param {string} role - Message role ('user' or 'assistant')
     * @param {string} content - Message content
     * @param {string} userId - Discord user ID (for user messages)
     * @param {string} username - Discord username (for user messages)
     * @param {number} tokens - Token count for this message
     * @returns {boolean} Success status
     */
    async addMessageToConversation(channelId, personalityId, role, content, userId = null, username = null, tokens = 0) {
        if (!this.db) {
            logger.error('Cannot add message: Not connected to MongoDB.');
            return false;
        }
        return this._traced('updateOne', 'chat_conversations', async (span) => {
            span.setAttributes({
                'conversation.channel_id': channelId,
                'conversation.personality_id': personalityId,
                'message.role': role,
                'message.tokens': tokens,
            });
            const collection = this.db.collection('chat_conversations');
            const conversationId = this._getConversationId(channelId, personalityId);

            const message = {
                role,
                content,
                timestamp: new Date()
            };

            if (role === 'user' && userId) {
                message.userId = userId;
                message.username = username;
            }

            const result = await collection.updateOne(
                { conversationId, status: 'active' },
                {
                    $push: { messages: message },
                    $inc: { messageCount: 1, totalTokens: tokens },
                    $set: { lastActivity: new Date() }
                }
            );

            span.setAttribute(DB.DOCUMENTS_AFFECTED, result.modifiedCount);
            logger.debug(`Added ${role} message to conversation ${conversationId}`);
            return true;
        });
    }

    /**
     * Get conversation history for API calls
     * @param {string} channelId - Discord channel ID
     * @param {string} personalityId - Personality identifier
     * @returns {Object|null} Conversation with messages or null
     */
    async getConversationHistory(channelId, personalityId) {
        if (!this.db) {
            logger.error('Cannot get conversation history: Not connected to MongoDB.');
            return null;
        }
        try {
            const collection = this.db.collection('chat_conversations');
            const conversationId = this._getConversationId(channelId, personalityId);

            const conversation = await collection.findOne({ conversationId });
            return conversation;
        } catch (error) {
            logger.error(`Error getting conversation history: ${error.message}`);
            return null;
        }
    }

    /**
     * Get conversation status
     * @param {string} channelId - Discord channel ID
     * @param {string} personalityId - Personality identifier
     * @returns {Object} Status info { exists, status, lastActivity, messageCount, totalTokens }
     */
    async getConversationStatus(channelId, personalityId) {
        if (!this.db) {
            logger.error('Cannot get conversation status: Not connected to MongoDB.');
            return { exists: false };
        }
        try {
            const collection = this.db.collection('chat_conversations');
            const conversationId = this._getConversationId(channelId, personalityId);

            // First try to find an active conversation (prioritize active over expired/reset)
            let conversation = await collection.findOne({ conversationId, status: 'active' });

            // If no active conversation, look for any conversation (expired/reset)
            if (!conversation) {
                conversation = await collection.findOne(
                    { conversationId },
                    { sort: { createdAt: -1 } }  // Get the most recent one
                );
            }

            if (!conversation) {
                return { exists: false };
            }

            return {
                exists: true,
                status: conversation.status,
                lastActivity: conversation.lastActivity,
                messageCount: conversation.messageCount,
                totalTokens: conversation.totalTokens
            };
        } catch (error) {
            logger.error(`Error getting conversation status: ${error.message}`);
            return { exists: false };
        }
    }

    /**
     * Reset a conversation (clear messages, mark as reset)
     * @param {string} channelId - Discord channel ID
     * @param {string} personalityId - Personality identifier
     * @returns {boolean} Success status
     */
    async resetConversation(channelId, personalityId) {
        if (!this.db) {
            logger.error('Cannot reset conversation: Not connected to MongoDB.');
            return false;
        }
        try {
            const collection = this.db.collection('chat_conversations');
            const conversationId = this._getConversationId(channelId, personalityId);

            // Mark existing conversation as reset
            await collection.updateOne(
                { conversationId, status: 'active' },
                { $set: { status: 'reset', resetAt: new Date() } }
            );

            logger.info(`Reset conversation: ${conversationId}`);
            return true;
        } catch (error) {
            logger.error(`Error resetting conversation: ${error.message}`);
            return false;
        }
    }

    /**
     * Expire a conversation due to idle timeout
     * @param {string} channelId - Discord channel ID
     * @param {string} personalityId - Personality identifier
     * @returns {boolean} Success status
     */
    async expireConversation(channelId, personalityId) {
        if (!this.db) {
            logger.error('Cannot expire conversation: Not connected to MongoDB.');
            return false;
        }
        try {
            const collection = this.db.collection('chat_conversations');
            const conversationId = this._getConversationId(channelId, personalityId);

            await collection.updateOne(
                { conversationId, status: 'active' },
                { $set: { status: 'expired', expiredAt: new Date() } }
            );

            logger.info(`Expired conversation: ${conversationId}`);
            return true;
        } catch (error) {
            logger.error(`Error expiring conversation: ${error.message}`);
            return false;
        }
    }

    /**
     * Resume an expired conversation
     * @param {string} channelId - Discord channel ID
     * @param {string} personalityId - Personality identifier
     * @returns {boolean} Success status
     */
    async resumeConversation(channelId, personalityId) {
        if (!this.db) {
            logger.error('Cannot resume conversation: Not connected to MongoDB.');
            return false;
        }
        try {
            const collection = this.db.collection('chat_conversations');
            const conversationId = this._getConversationId(channelId, personalityId);

            const result = await collection.updateOne(
                { conversationId, status: 'expired' },
                {
                    $set: { status: 'active', resumedAt: new Date() },
                    $unset: { expiredAt: '' }
                }
            );

            if (result.matchedCount === 0) {
                logger.warn(`No expired conversation found to resume: ${conversationId}`);
                return false;
            }

            logger.info(`Resumed conversation: ${conversationId}`);
            return true;
        } catch (error) {
            logger.error(`Error resuming conversation: ${error.message}`);
            return false;
        }
    }

    /**
     * Update conversation token count
     * @param {string} channelId - Discord channel ID
     * @param {string} personalityId - Personality identifier
     * @param {number} tokens - Tokens to add
     * @returns {boolean} Success status
     */
    async updateConversationTokenCount(channelId, personalityId, tokens) {
        if (!this.db) {
            logger.error('Cannot update token count: Not connected to MongoDB.');
            return false;
        }
        try {
            const collection = this.db.collection('chat_conversations');
            const conversationId = this._getConversationId(channelId, personalityId);

            await collection.updateOne(
                { conversationId, status: 'active' },
                {
                    $inc: { totalTokens: tokens },
                    $set: { lastActivity: new Date() }
                }
            );

            return true;
        } catch (error) {
            logger.error(`Error updating token count: ${error.message}`);
            return false;
        }
    }

    /**
     * Check if conversation has exceeded idle timeout
     * @param {string} channelId - Discord channel ID
     * @param {string} personalityId - Personality identifier
     * @param {number} timeoutMinutes - Idle timeout in minutes (default: 30)
     * @returns {boolean} True if conversation is idle/expired
     */
    async isConversationIdle(channelId, personalityId, timeoutMinutes = 30) {
        const status = await this.getConversationStatus(channelId, personalityId);

        if (!status.exists) return false;
        if (status.status !== 'active') return true;

        const lastActivity = new Date(status.lastActivity);
        const now = new Date();
        const diffMinutes = (now - lastActivity) / (1000 * 60);

        return diffMinutes > timeoutMinutes;
    }

    /**
     * Get all conversations where a user has participated
     * Returns conversations that are expired or reset (resumable)
     * @param {string} userId - Discord user ID
     * @param {string} guildId - Discord guild ID (optional, to filter by server)
     * @returns {Array} Array of conversation summaries
     */
    async getUserConversations(userId, guildId = null) {
        if (!this.db) {
            logger.error('Cannot get user conversations: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('chat_conversations');

            // Find conversations where the user has sent messages
            const query = {
                'messages.userId': userId,
                status: { $in: ['expired', 'reset'] }  // Only resumable conversations
            };

            // Optionally filter by guild
            if (guildId) {
                query.guildId = guildId;
            }

            const conversations = await collection.find(query)
                .sort({ lastActivity: -1 })  // Most recent first
                .limit(10)  // Limit to 10 conversations
                .toArray();

            // Return summary info for each conversation
            return conversations.map(conv => ({
                channelId: conv.channelId,
                personalityId: conv.personalityId,
                status: conv.status,
                messageCount: conv.messageCount,
                totalTokens: conv.totalTokens,
                lastActivity: conv.lastActivity,
                createdAt: conv.createdAt,
                // Get preview of last user message
                lastUserMessage: conv.messages
                    .filter(m => m.role === 'user')
                    .slice(-1)[0]?.content?.substring(0, 50) || null
            }));
        } catch (error) {
            logger.error(`Error getting user conversations: ${error.message}`);
            return [];
        }
    }

    // ==================== IMAGE GENERATION TRACKING ====================

    /**
     * Record an image generation request
     * @param {string} userId - Discord user ID
     * @param {string} username - Discord username
     * @param {string} prompt - The prompt used for generation
     * @param {string} aspectRatio - The aspect ratio used
     * @param {string} model - The model used (e.g., 'gemini-3-pro-image-preview')
     * @param {boolean} success - Whether generation was successful
     * @param {string} error - Error message if generation failed
     * @param {number} imageSizeBytes - Size of generated image in bytes (if successful)
     * @returns {boolean} Success status
     */
    async recordImageGeneration(userId, username, prompt, aspectRatio, model, success, error = null, imageSizeBytes = 0) {
        if (!this.db) {
            logger.error('Cannot record image generation: Not connected to MongoDB.');
            return false;
        }
        return this._traced('insertOne', 'image_generations', async (span) => {
            span.setAttributes({
                'image_gen.user_id': userId,
                'image_gen.model': model,
                'image_gen.aspect_ratio': aspectRatio,
                'image_gen.success': success,
                'image_gen.size_bytes': imageSizeBytes,
            });
            const collection = this.db.collection('image_generations');
            await collection.insertOne({
                userId,
                username,
                prompt,
                aspectRatio,
                model,
                success,
                error,
                imageSizeBytes,
                timestamp: new Date()
            });
            logger.debug(`Recorded image generation for user ${username}: ${success ? 'success' : 'failed'}`);
            span.setAttribute(DB.DOCUMENTS_AFFECTED, 1);
            return true;
        });
    }

    /**
     * Get image generation statistics for a specific user
     * @param {string} userId - Discord user ID
     * @param {number} days - Number of days to look back (default: 30)
     * @returns {Object} Generation statistics
     */
    async getImageGenerationStats(userId, days = 30) {
        if (!this.db) {
            logger.error('Cannot get image generation stats: Not connected to MongoDB.');
            return { totalGenerations: 0, successfulGenerations: 0, failedGenerations: 0, totalBytes: 0 };
        }
        try {
            const collection = this.db.collection('image_generations');
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - days);

            const pipeline = [
                {
                    $match: {
                        userId,
                        timestamp: { $gte: cutoffDate }
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalGenerations: { $sum: 1 },
                        successfulGenerations: {
                            $sum: { $cond: ['$success', 1, 0] }
                        },
                        failedGenerations: {
                            $sum: { $cond: ['$success', 0, 1] }
                        },
                        totalBytes: { $sum: '$imageSizeBytes' }
                    }
                }
            ];

            const results = await collection.aggregate(pipeline).toArray();
            if (results.length === 0) {
                return { totalGenerations: 0, successfulGenerations: 0, failedGenerations: 0, totalBytes: 0 };
            }

            const { totalGenerations, successfulGenerations, failedGenerations, totalBytes } = results[0];
            return { totalGenerations, successfulGenerations, failedGenerations, totalBytes };
        } catch (error) {
            logger.error(`Error getting image generation stats for user ${userId}: ${error.message}`);
            return { totalGenerations: 0, successfulGenerations: 0, failedGenerations: 0, totalBytes: 0 };
        }
    }

    /**
     * Get recent image generations for a user
     * @param {string} userId - Discord user ID
     * @param {number} limit - Maximum number of records to return (default: 10)
     * @returns {Array} Recent image generations
     */
    async getRecentImageGenerations(userId, limit = 10) {
        if (!this.db) {
            logger.error('Cannot get recent image generations: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('image_generations');
            return await collection
                .find({ userId })
                .sort({ timestamp: -1 })
                .limit(limit)
                .toArray();
        } catch (error) {
            logger.error(`Error getting recent image generations for user ${userId}: ${error.message}`);
            return [];
        }
    }

    // ==================== VIDEO GENERATION TRACKING ====================

    /**
     * Record a video generation request
     * @param {string} userId - Discord user ID
     * @param {string} username - Discord username
     * @param {string} prompt - The prompt used for generation
     * @param {number} duration - Video duration in seconds
     * @param {string} aspectRatio - The aspect ratio used
     * @param {string} model - The model used (e.g., 'veo-3.1-fast-generate-001')
     * @param {boolean} success - Whether generation was successful
     * @param {string} error - Error message if generation failed
     * @param {number} videoSizeBytes - Size of generated video in bytes (if successful)
     * @returns {boolean} Success status
     */
    async recordVideoGeneration(userId, username, prompt, duration, aspectRatio, model, success, error = null, videoSizeBytes = 0) {
        if (!this.db) {
            logger.error('Cannot record video generation: Not connected to MongoDB.');
            return false;
        }
        try {
            const collection = this.db.collection('video_generations');
            await collection.insertOne({
                userId,
                username,
                prompt,
                duration,
                aspectRatio,
                model,
                success,
                error,
                videoSizeBytes,
                timestamp: new Date()
            });
            logger.debug(`Recorded video generation for user ${username}: ${success ? 'success' : 'failed'}`);
            return true;
        } catch (err) {
            logger.error(`Error recording video generation for user ${userId}: ${err.message}`);
            return false;
        }
    }

    /**
     * Get video generation statistics for a specific user
     * @param {string} userId - Discord user ID
     * @param {number} days - Number of days to look back (default: 30)
     * @returns {Object} Generation statistics
     */
    async getVideoGenerationStats(userId, days = 30) {
        if (!this.db) {
            logger.error('Cannot get video generation stats: Not connected to MongoDB.');
            return { totalGenerations: 0, successfulGenerations: 0, failedGenerations: 0, totalBytes: 0 };
        }
        try {
            const collection = this.db.collection('video_generations');
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - days);

            const pipeline = [
                {
                    $match: {
                        userId,
                        timestamp: { $gte: cutoffDate }
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalGenerations: { $sum: 1 },
                        successfulGenerations: {
                            $sum: { $cond: ['$success', 1, 0] }
                        },
                        failedGenerations: {
                            $sum: { $cond: ['$success', 0, 1] }
                        },
                        totalBytes: { $sum: '$videoSizeBytes' },
                        totalDurationSeconds: { $sum: '$duration' }
                    }
                }
            ];

            const results = await collection.aggregate(pipeline).toArray();
            if (results.length === 0) {
                return { totalGenerations: 0, successfulGenerations: 0, failedGenerations: 0, totalBytes: 0, totalDurationSeconds: 0 };
            }

            const { totalGenerations, successfulGenerations, failedGenerations, totalBytes, totalDurationSeconds } = results[0];
            return { totalGenerations, successfulGenerations, failedGenerations, totalBytes, totalDurationSeconds };
        } catch (error) {
            logger.error(`Error getting video generation stats for user ${userId}: ${error.message}`);
            return { totalGenerations: 0, successfulGenerations: 0, failedGenerations: 0, totalBytes: 0, totalDurationSeconds: 0 };
        }
    }

    /**
     * Get recent video generations for a user
     * @param {string} userId - Discord user ID
     * @param {number} limit - Maximum number of records to return (default: 10)
     * @returns {Array} Recent video generations
     */
    async getRecentVideoGenerations(userId, limit = 10) {
        if (!this.db) {
            logger.error('Cannot get recent video generations: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('video_generations');
            return await collection
                .find({ userId })
                .sort({ timestamp: -1 })
                .limit(limit)
                .toArray();
        } catch (error) {
            logger.error(`Error getting recent video generations for user ${userId}: ${error.message}`);
            return [];
        }
    }

    // ==================== CHANNEL CONTEXT TRACKING ====================

    /**
     * Get all channels that have tracking enabled
     * @returns {Array} Array of tracked channel documents
     */
    async getTrackedChannels() {
        if (!this.db) {
            logger.error('Cannot get tracked channels: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('channel_tracking_config');
            return await collection.find({ enabled: true }).toArray();
        } catch (error) {
            logger.error(`Error getting tracked channels: ${error.message}`);
            return [];
        }
    }

    /**
     * Enable channel context tracking for a channel
     * @param {string} channelId - Discord channel ID
     * @param {string} guildId - Discord guild ID
     * @param {string} userId - User who enabled tracking
     * @returns {boolean} Success status
     */
    async enableChannelTracking(channelId, guildId, userId) {
        if (!this.db) {
            logger.error('Cannot enable channel tracking: Not connected to MongoDB.');
            return false;
        }
        try {
            const collection = this.db.collection('channel_tracking_config');
            await collection.updateOne(
                { channelId },
                {
                    $set: {
                        channelId,
                        guildId,
                        enabled: true,
                        enabledAt: new Date(),
                        enabledBy: userId,
                        lastActivity: new Date()
                    },
                    $setOnInsert: {
                        messageCount: 0,
                        createdAt: new Date()
                    }
                },
                { upsert: true }
            );
            logger.info(`Channel tracking enabled for ${channelId} by ${userId}`);
            return true;
        } catch (error) {
            logger.error(`Error enabling channel tracking: ${error.message}`);
            return false;
        }
    }

    /**
     * Disable channel context tracking for a channel
     * @param {string} channelId - Discord channel ID
     * @returns {boolean} Success status
     */
    async disableChannelTracking(channelId) {
        if (!this.db) {
            logger.error('Cannot disable channel tracking: Not connected to MongoDB.');
            return false;
        }
        try {
            const collection = this.db.collection('channel_tracking_config');
            await collection.updateOne(
                { channelId },
                {
                    $set: {
                        enabled: false,
                        disabledAt: new Date()
                    }
                }
            );
            logger.info(`Channel tracking disabled for ${channelId}`);
            return true;
        } catch (error) {
            logger.error(`Error disabling channel tracking: ${error.message}`);
            return false;
        }
    }

    /**
     * Update last activity timestamp and increment message count for a channel
     * @param {string} channelId - Discord channel ID
     * @returns {boolean} Success status
     */
    async updateChannelActivity(channelId) {
        if (!this.db) {
            return false;
        }
        try {
            const collection = this.db.collection('channel_tracking_config');
            await collection.updateOne(
                { channelId },
                {
                    $set: { lastActivity: new Date() },
                    $inc: { messageCount: 1 }
                }
            );
            return true;
        } catch (error) {
            logger.debug(`Error updating channel activity: ${error.message}`);
            return false;
        }
    }

    /**
     * Get tracking configuration for a specific channel
     * @param {string} channelId - Discord channel ID
     * @returns {Object|null} Channel tracking config or null if not found
     */
    async getChannelTrackingConfig(channelId) {
        if (!this.db) {
            logger.error('Cannot get channel tracking config: Not connected to MongoDB.');
            return null;
        }
        try {
            const collection = this.db.collection('channel_tracking_config');
            return await collection.findOne({ channelId });
        } catch (error) {
            logger.error(`Error getting channel tracking config: ${error.message}`);
            return null;
        }
    }
    // ==================== CATCH ME UP ====================

    /**
     * Get recent article summaries within a time range
     * @param {number} days - Number of days to look back
     * @param {number} limit - Maximum number of articles to return
     * @returns {Promise<Array>} Recent articles with summaries
     */
    async getRecentArticleSummaries(days = 7, limit = 20) {
        if (!this.db) {
            logger.error('Cannot get recent articles: Not connected to MongoDB.');
            return [];
        }
        try {
            const collection = this.db.collection('articles');
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);

            return await collection.find({
                createdAt: { $gte: cutoff }
            }).sort({ createdAt: -1 }).limit(limit).toArray();
        } catch (error) {
            logger.error(`Error getting recent article summaries: ${error.message}`);
            return [];
        }
    }

    /**
     * Record user activity for last-seen tracking
     * @param {string} userId - Discord user ID
     * @param {string} guildId - Discord guild ID
     * @param {string} channelId - Discord channel ID where activity occurred
     */
    async recordUserActivity(userId, guildId, channelId) {
        if (!this.db) return;
        try {
            const collection = this.db.collection('user_activity');
            await collection.updateOne(
                { userId, guildId },
                {
                    $set: {
                        userId,
                        guildId,
                        lastSeenAt: new Date()
                    },
                    $addToSet: { activeChannels: channelId }
                },
                { upsert: true }
            );
        } catch (error) {
            logger.error(`Error recording user activity: ${error.message}`);
        }
    }

    /**
     * Get user's last seen activity record
     * @param {string} userId - Discord user ID
     * @param {string} guildId - Discord guild ID
     * @returns {Promise<Object|null>} User activity record or null
     */
    async getUserLastSeen(userId, guildId) {
        if (!this.db) return null;
        try {
            const collection = this.db.collection('user_activity');
            return await collection.findOne({ userId, guildId });
        } catch (error) {
            logger.error(`Error getting user last seen: ${error.message}`);
            return null;
        }
    }

    // ==================== CHANNEL MESSAGES ====================

    /**
     * Record a channel message for historical retrieval.
     * Optional message.executionIds array is persisted when present so the
     * sandbox reaction-reveal handler can look up which executions belong
     * to a given bot reply.
     * @param {Object} message - Message data
     */
    async recordChannelMessage(message) {
        if (!this.db) return;
        try {
            const collection = this.db.collection('channel_messages');
            await collection.insertOne(message);
        } catch (error) {
            logger.error(`Error recording channel message: ${error.message}`);
        }
    }

    /**
     * Look up the execution_ids attached to a bot reply message id.
     * Returns an empty array when the message is unknown or has no
     * sandbox executions associated with it.
     * @param {string} messageId
     * @returns {Promise<string[]>}
     */
    async getMessageExecutionIds(messageId) {
        if (!this.db || !messageId) return [];
        try {
            const collection = this.db.collection('channel_messages');
            const doc = await collection.findOne({ messageId });
            return (doc && Array.isArray(doc.executionIds)) ? doc.executionIds : [];
        } catch (error) {
            logger.error(`Error reading executionIds for message ${messageId}: ${error.message}`);
            return [];
        }
    }

    /**
     * Get channel messages since a given time
     * @param {string|string[]} channelIds - Single channel ID or array of channel IDs
     * @param {Date} since - Start of time range
     * @param {number} limit - Max messages to return
     * @returns {Promise<Array>} Messages sorted by timestamp ascending
     */
    async getChannelMessages(channelIds, since, limit = 200) {
        if (!this.db) return [];
        try {
            const collection = this.db.collection('channel_messages');
            const channelFilter = Array.isArray(channelIds)
                ? { $in: channelIds }
                : channelIds;

            return await collection.find({
                channelId: channelFilter,
                timestamp: { $gte: since }
            }).sort({ timestamp: 1 }).limit(limit).toArray();
        } catch (error) {
            logger.error(`Error getting channel messages: ${error.message}`);
            return [];
        }
    }

    /**
     * Get the most recent N messages from a single channel, in chronological order.
     * Used by ChannelContextService for startup hot-buffer rehydration.
     * @param {string} channelId
     * @param {number} limit
     * @returns {Promise<Array>} Messages sorted by timestamp ASCENDING (oldest first)
     */
    async getRecentChannelMessages(channelId, limit = 100) {
        if (!this.db) return [];
        try {
            const collection = this.db.collection('channel_messages');
            const docs = await collection
                .find({ channelId })
                .sort({ timestamp: -1 })
                .limit(limit)
                .toArray();
            return docs.reverse();
        } catch (error) {
            logger.error(`Error fetching recent channel messages for ${channelId}: ${error.message}`);
            return [];
        }
    }

    // ==================== RECALL LEDGER ====================

    async getRecallLedger(memoryKeys) {
        if (!this.db || !memoryKeys || memoryKeys.length === 0) return {};
        try {
            const rows = await this.db.collection('recall_ledger')
                .find({ memoryKey: { $in: memoryKeys } }).toArray();
            const byKey = {};
            for (const r of rows) byKey[r.memoryKey] = r;
            return byKey;
        } catch (error) {
            logger.error(`Error reading recall_ledger: ${error.message}`);
            return {};
        }
    }

    async bumpRecallAccess(entries, opts = {}) {
        if (!this.db || !entries || entries.length === 0) return;
        const now = new Date();
        const nudge = typeof opts.nudge === 'number' ? opts.nudge : 0.02;
        const max = typeof opts.importanceMax === 'number' ? opts.importanceMax : 1.0;
        try {
            const ops = entries.map((e) => ({
                updateOne: {
                    filter: { memoryKey: e.memoryKey },
                    update: [
                        { $set: {
                            memoryKey: e.memoryKey,
                            scope: e.scope || {},
                            source: e.source || null,
                            contentHash: e.contentHash || null,
                            accessCount: { $add: [{ $ifNull: ['$accessCount', 0] }, 1] },
                            importance: { $min: [max, { $add: [{ $ifNull: ['$importance', e.importanceSeed != null ? e.importanceSeed : 0.5] }, nudge] }] },
                            firstSeenAtUtc: { $ifNull: ['$firstSeenAtUtc', now] },
                            lastAccessedAtUtc: now,
                            expiresAt: { $ifNull: ['$expiresAt', e.expiresAt || null] },
                        } },
                    ],
                    upsert: true,
                },
            }));
            await this.db.collection('recall_ledger').bulkWrite(ops, { ordered: false });
        } catch (error) {
            logger.error(`Error bumping recall_ledger: ${error.message}`);
        }
    }

    async pruneRecallLedger(now = new Date()) {
        if (!this.db) return 0;
        try {
            const res = await this.db.collection('recall_ledger').deleteMany({ expiresAt: { $ne: null, $lt: now } });
            return res.deletedCount || 0;
        } catch (error) {
            logger.error(`Error pruning recall_ledger: ${error.message}`);
            return 0;
        }
    }

    async recordRecallComparison(doc) {
        if (!this.db) return;
        try {
            await this.db.collection('recall_comparisons').insertOne({ ...doc, ts: doc.ts || new Date() });
        } catch (error) {
            logger.error(`Error recording recall_comparison: ${error.message}`);
        }
    }
}

module.exports = MongoService;
