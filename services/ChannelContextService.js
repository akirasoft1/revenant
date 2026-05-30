// services/ChannelContextService.js
// Three-tier channel conversation context service for passive conversation awareness
// Tier 1: In-memory buffer (hot) - recent messages, zero cost
// Tier 2: Qdrant semantic index (warm) - batch indexed, semantic search
// Tier 3: Mem0 channel memories (cold) - extracted channel facts/patterns

const { QdrantClient } = require('@qdrant/js-client-rest');
const crypto = require('crypto');
const logger = require('../logger');

// Circular buffer implementation for efficient message storage
class CircularBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = [];
  }

  push(item) {
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }
    this.buffer.push(item);
  }

  getAll() {
    return [...this.buffer];
  }

  getRecent(count) {
    return this.buffer.slice(-count);
  }

  size() {
    return this.buffer.length;
  }

  clear() {
    this.buffer = [];
  }
}

class ChannelContextService {
  /**
   * Initialize ChannelContextService
   * @param {Object} config - Application configuration
   * @param {Object} openaiClient - OpenAI client for embeddings
   * @param {Object} mongoService - MongoDB service for persistence
   * @param {Object} mem0Service - Optional Mem0 service for channel memories
   */
  constructor(config, openaiClient, mongoService, mem0Service = null, botUserId = null) {
    this.config = config.channelContext;
    this.qdrantConfig = config.qdrant;
    this.openai = openaiClient;
    this.mongoService = mongoService;
    this.mem0Service = mem0Service;
    this.botUserId = botUserId || config.discord?.clientId || null;

    // Tier 1: In-memory buffers per channel
    this.channelBuffers = new Map();

    // Tier 2: Pending messages for batch indexing
    this.pendingIndex = [];

    // Track message counts for Tier 3 memory extraction
    this.messageCountSinceExtraction = new Map();

    // Tracked channels (loaded from MongoDB on start)
    this.trackedChannels = new Set();

    // Background job intervals
    this.batchInterval = null;
    this.cleanupInterval = null;

    // Qdrant client initialization
    this.qdrantClient = null;
    this._enabled = false;

    logger.info('ChannelContextService initialized (pending start)');
  }

  /**
   * Start the service - initialize Qdrant and background jobs
   */
  async start() {
    try {
      // Initialize Qdrant client
      this.qdrantClient = new QdrantClient({
        host: this.qdrantConfig.host,
        port: this.qdrantConfig.port,
      });

      // Ensure collection exists
      await this._ensureCollection();

      // Load tracked channels from MongoDB
      await this._loadTrackedChannels();

      // Rehydrate per-channel hot buffer from MongoDB so the bot has
      // conversation context immediately after restart, not after N
      // new messages arrive.
      for (const channelId of this.trackedChannels) {
        await this._rehydrateBufferFromMongoDB(channelId).catch((err) => {
          logger.warn(`Rehydration for ${channelId} failed (non-fatal): ${err.message}`);
        });
      }

      // Start background batch indexing job
      const intervalMs = this.config.batchIndexIntervalMinutes * 60 * 1000;
      this.batchInterval = setInterval(() => this._processBatchIndex(), intervalMs);

      // Start daily cleanup interval
      this.cleanupInterval = setInterval(
        () => this._cleanupExpiredMessages(),
        24 * 60 * 60 * 1000
      );

      this._enabled = true;

      // Run cleanup immediately on startup to clear any expired messages
      // that accumulated while the pod was down (must be after _enabled = true)
      await this._cleanupExpiredMessages();
      logger.info(`ChannelContextService started - tracking ${this.trackedChannels.size} channels`);
      logger.info(`Batch indexing interval: ${this.config.batchIndexIntervalMinutes} minutes`);
    } catch (error) {
      logger.error(`Failed to start ChannelContextService: ${error.message}`);
      this._enabled = false;
    }
  }

  /**
   * Stop the service gracefully
   */
  async stop() {
    // Clear intervals
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Process any remaining pending messages
    if (this.pendingIndex.length > 0) {
      logger.info(`Processing ${this.pendingIndex.length} pending messages before shutdown`);
      await this._processBatchIndex();
    }

    this._enabled = false;
    logger.info('ChannelContextService stopped');
  }

  /**
   * Check if service is enabled and running
   */
  isEnabled() {
    return this._enabled;
  }

  // ========== Channel Tracking Management ==========

  /**
   * Check if a channel is being tracked
   * @param {string} channelId - Discord channel ID
   * @returns {boolean}
   */
  isChannelTracked(channelId) {
    return this.trackedChannels.has(channelId);
  }

  /**
   * Enable tracking for a channel
   * @param {string} channelId - Discord channel ID
   * @param {string} guildId - Discord guild ID
   * @param {string} userId - User who enabled tracking
   */
  async enableChannel(channelId, guildId, userId) {
    this.trackedChannels.add(channelId);

    // Initialize buffer for the channel
    if (!this.channelBuffers.has(channelId)) {
      this.channelBuffers.set(channelId, {
        messages: new CircularBuffer(this.config.recentMessageCount),
        lastActivity: new Date(),
        guildId: guildId,
        activeParticipants: new Map()
      });
    }

    // Persist to MongoDB
    await this.mongoService.enableChannelTracking(channelId, guildId, userId);

    logger.info(`Channel tracking enabled for ${channelId} by ${userId}`);
  }

  /**
   * Disable tracking for a channel
   * @param {string} channelId - Discord channel ID
   */
  async disableChannel(channelId) {
    this.trackedChannels.delete(channelId);
    this.channelBuffers.delete(channelId);
    this.messageCountSinceExtraction.delete(channelId);

    // Persist to MongoDB
    await this.mongoService.disableChannelTracking(channelId);

    logger.info(`Channel tracking disabled for ${channelId}`);
  }

  /**
   * Load tracked channels from MongoDB and pre-configured list on startup
   */
  async _loadTrackedChannels() {
    try {
      // Load from MongoDB first
      const channels = await this.mongoService.getTrackedChannels();
      for (const channel of channels) {
        this.trackedChannels.add(channel.channelId);
        this.channelBuffers.set(channel.channelId, {
          messages: new CircularBuffer(this.config.recentMessageCount),
          lastActivity: channel.lastActivity || new Date(),
          guildId: channel.guildId,
          activeParticipants: new Map()
        });
      }
      logger.info(`Loaded ${channels.length} tracked channels from database`);

      // Also load pre-configured channels from environment
      const preConfigured = this.config.preConfiguredChannels || [];
      let newFromConfig = 0;
      for (const channelId of preConfigured) {
        if (!this.trackedChannels.has(channelId)) {
          this.trackedChannels.add(channelId);
          this.channelBuffers.set(channelId, {
            messages: new CircularBuffer(this.config.recentMessageCount),
            lastActivity: new Date(),
            guildId: null, // Will be set when first message arrives
            activeParticipants: new Map()
          });
          // Persist to MongoDB for consistency
          await this.mongoService.enableChannelTracking(channelId, null, 'config');
          newFromConfig++;
        }
      }
      if (newFromConfig > 0) {
        logger.info(`Added ${newFromConfig} pre-configured channels from CHANNEL_CONTEXT_CHANNELS`);
      }
    } catch (error) {
      logger.error(`Error loading tracked channels: ${error.message}`);
    }
  }

  // ========== Tier 1: In-Memory Buffer ==========

  /**
   * Record a message to the in-memory buffer
   * Called on every message in tracked channels
   * @param {Object} message - Discord.js message object
   */
  async recordMessage(message) {
    if (!this._enabled) return;
    if (!this.isChannelTracked(message.channel.id)) return;

    const channelId = message.channel.id;
    const guildId = message.guild?.id;

    // Ensure buffer exists
    if (!this.channelBuffers.has(channelId)) {
      this.channelBuffers.set(channelId, {
        messages: new CircularBuffer(this.config.recentMessageCount),
        lastActivity: new Date(),
        guildId: guildId,
        activeParticipants: new Map()
      });
    }

    const buffer = this.channelBuffers.get(channelId);

    // Create message record
    const record = {
      id: message.id,
      authorId: message.author.id,
      authorName: message.author.username,
      content: message.content,
      timestamp: new Date(),
      isBot: message.author.bot,
      replyToId: message.reference?.messageId || null
    };

    // Add to in-memory buffer (Tier 1)
    buffer.messages.push(record);
    buffer.lastActivity = new Date();

    // Track participant activity (for non-bot users)
    if (!message.author.bot) {
      this.updateParticipant(channelId, message.author.id, message.author.username);
    }

    // Queue for batch indexing (Tier 2)
    this.pendingIndex.push({
      ...record,
      channelId: channelId,
      guildId: guildId
    });

    // Update activity in MongoDB (non-blocking)
    this.mongoService.updateChannelActivity(channelId).catch(err =>
      logger.debug(`Failed to update channel activity: ${err.message}`)
    );

    // Check if we should extract channel memories (Tier 3)
    if (this.config.extractChannelMemories && this.mem0Service?.isEnabled()) {
      const count = (this.messageCountSinceExtraction.get(channelId) || 0) + 1;
      this.messageCountSinceExtraction.set(channelId, count);

      if (count >= this.config.memoryExtractionInterval) {
        this._extractChannelMemories(channelId).catch(err =>
          logger.debug(`Failed to extract channel memories: ${err.message}`)
        );
        this.messageCountSinceExtraction.set(channelId, 0);
      }
    }
  }

  /**
   * Get recent messages formatted as context string
   * @param {string} channelId - Channel ID
   * @param {number} limit - Number of messages to return
   * @returns {string} Formatted context
   */
  getRecentContext(channelId, limit = 10) {
    const buffer = this.channelBuffers.get(channelId);
    if (!buffer) return '';

    const messages = buffer.messages.getRecent(limit);
    if (messages.length === 0) return '';

    return messages
      .filter(m => !m.isBot) // Exclude bot messages for context
      .map(m => `[${m.authorName}]: ${m.content}`)
      .join('\n');
  }

  /**
   * Get recent messages as raw buffered message objects (NOT a formatted string).
   * Mirrors getRecentContext's source + bot-filtering, but returns the underlying
   * objects so callers (e.g. the v2 recall path) can read raw content/authorName
   * and compute content hashes for cross-block exclusion.
   * @param {string} channelId - Channel ID
   * @param {number} limit - Number of messages to return
   * @returns {Array<{authorName: string, content: string, isBot: boolean}>}
   */
  getRecentMessagesRaw(channelId, limit = 10) {
    const buffer = this.channelBuffers.get(channelId);
    if (!buffer) return [];

    const messages = buffer.messages.getRecent(limit);
    return messages.filter(m => !m.isBot);
  }

  /**
   * Get buffer size for a channel
   * @param {string} channelId - Channel ID
   * @returns {number} Number of messages in buffer
   */
  getBufferSize(channelId) {
    const buffer = this.channelBuffers.get(channelId);
    return buffer ? buffer.messages.size() : 0;
  }

  // ========== Participant Tracking ==========

  /**
   * Update participant activity in a channel
   * Called when a user sends a message in a tracked channel
   * @param {string} channelId - Channel ID
   * @param {string} userId - User ID
   * @param {string} username - User's display name
   */
  updateParticipant(channelId, userId, username) {
    const buffer = this.channelBuffers.get(channelId);
    if (!buffer) return;

    // Ensure activeParticipants map exists (for backwards compatibility)
    if (!buffer.activeParticipants) {
      buffer.activeParticipants = new Map();
    }

    const existing = buffer.activeParticipants.get(userId);
    if (existing) {
      existing.messageCount += 1;
      existing.lastSeen = new Date();
      existing.username = username; // Update in case username changed
    } else {
      buffer.activeParticipants.set(userId, {
        username: username,
        lastSeen: new Date(),
        messageCount: 1
      });
    }
  }

  /**
   * Get active participants in a channel within a time window
   * @param {string} channelId - Channel ID
   * @param {number} windowMinutes - Time window in minutes (default: 30)
   * @returns {Array<{userId: string, username: string, lastSeen: Date, messageCount: number}>}
   */
  getActiveParticipants(channelId, windowMinutes = 30) {
    const buffer = this.channelBuffers.get(channelId);
    if (!buffer || !buffer.activeParticipants) return [];

    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);
    const active = [];

    for (const [userId, data] of buffer.activeParticipants) {
      if (data.lastSeen >= cutoff) {
        active.push({
          userId,
          username: data.username,
          lastSeen: data.lastSeen,
          messageCount: data.messageCount
        });
      }
    }

    // Sort by message count descending (most active first)
    return active.sort((a, b) => b.messageCount - a.messageCount);
  }

  /**
   * Get formatted participant context for system prompt injection
   * @param {string} channelId - Channel ID
   * @param {number} windowMinutes - Time window in minutes (default: 30)
   * @returns {string} Formatted participant list
   */
  getParticipantContext(channelId, windowMinutes = 30) {
    const participants = this.getActiveParticipants(channelId, windowMinutes);
    if (participants.length === 0) return '';

    const participantList = participants
      .map(p => `- ${p.username} (${p.messageCount} messages)`)
      .join('\n');

    return `Active participants in this channel:\n${participantList}`;
  }

  // ========== Tier 2: Qdrant Semantic Index ==========

  /**
   * Ensure Qdrant collection exists
   */
  async _ensureCollection() {
    const collectionName = this.config.qdrantCollection;

    try {
      await this.qdrantClient.getCollection(collectionName);
      logger.debug(`Qdrant collection ${collectionName} exists`);
    } catch (error) {
      // Collection doesn't exist, create it
      logger.info(`Creating Qdrant collection: ${collectionName}`);
      await this.qdrantClient.createCollection(collectionName, {
        vectors: {
          size: 1536, // text-embedding-3-small dimension
          distance: 'Cosine'
        }
      });

      // Create payload indexes for filtering
      await this.qdrantClient.createPayloadIndex(collectionName, {
        field_name: 'channelId',
        field_schema: 'keyword'
      });
      await this.qdrantClient.createPayloadIndex(collectionName, {
        field_name: 'expiresAt',
        field_schema: 'datetime'
      });
    }
  }

  /**
   * Rehydrate the in-memory hot buffer for a channel from MongoDB on startup.
   * `channel_messages` persists every incoming message, so this gives the bot
   * immediate conversation context after a pod restart instead of waiting for
   * new messages to arrive.
   *
   * Called after `_loadTrackedChannels` has already initialized buffer entries
   * for each tracked channel, so the buffer is guaranteed to exist by the time
   * this runs.
   *
   * @param {string} channelId
   * @private
   */
  async _rehydrateBufferFromMongoDB(channelId) {
    if (!this.mongoService) {
      logger.debug(`Skipping buffer rehydration for ${channelId}: no mongoService`);
      return;
    }

    let docs;
    try {
      docs = await this.mongoService.getRecentChannelMessages(channelId, this.config.recentMessageCount);
    } catch (err) {
      logger.warn(`Failed to rehydrate buffer for channel ${channelId}: ${err.message}`);
      return;
    }

    if (!Array.isArray(docs) || docs.length === 0) {
      return;
    }

    const buffer = this.channelBuffers.get(channelId);
    if (!buffer) {
      // Defensive — _loadTrackedChannels should have initialized this. Bail.
      logger.warn(`No buffer entry for ${channelId}; skipping rehydration`);
      return;
    }

    let latestTimestamp = buffer.lastActivity;

    for (const doc of docs) {
      const record = {
        id: doc.messageId,
        authorId: doc.authorId,
        authorName: doc.authorName,
        content: doc.content,
        timestamp: doc.timestamp,
        isBot: this.botUserId ? doc.authorId === this.botUserId : false,
        replyToId: null,
      };
      buffer.messages.push(record);
      if (doc.timestamp instanceof Date && doc.timestamp > latestTimestamp) {
        latestTimestamp = doc.timestamp;
      }
    }
    buffer.lastActivity = latestTimestamp;

    logger.info(`Rehydrated ${docs.length} messages for channel ${channelId} from MongoDB`);
  }

  /**
   * Process batch of pending messages for indexing
   */
  async _processBatchIndex() {
    if (this.pendingIndex.length === 0) return;

    const batch = [...this.pendingIndex];
    this.pendingIndex = [];

    logger.info(`Processing batch index of ${batch.length} messages`);

    try {
      // Filter out very short messages (not useful for semantic search)
      const indexableMessages = batch.filter(m =>
        m.content && m.content.length > 10 && !m.isBot
      );

      if (indexableMessages.length === 0) {
        logger.debug('No indexable messages in batch');
        return;
      }

      // Generate embeddings in batches of 100
      const embeddings = await this._embedBatch(
        indexableMessages.map(m => m.content)
      );

      // Calculate expiry date
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + this.config.retentionDays);

      // Prepare points for Qdrant
      const points = indexableMessages.map((msg, idx) => ({
        id: crypto.randomUUID(),
        vector: embeddings[idx],
        payload: {
          channelId: msg.channelId,
          guildId: msg.guildId,
          messageId: msg.id,
          authorId: msg.authorId,
          authorName: msg.authorName,
          content: msg.content,
          timestamp: msg.timestamp.toISOString(),
          expiresAt: expiresAt.toISOString()
        }
      }));

      // Upsert to Qdrant
      await this.qdrantClient.upsert(this.config.qdrantCollection, {
        wait: true,
        points: points
      });

      logger.info(`Indexed ${points.length} messages to Qdrant`);
    } catch (error) {
      logger.error(`Batch indexing error: ${error.message}`);
      // Re-queue failed messages (with limit to prevent infinite growth)
      if (batch.length < 1000) {
        this.pendingIndex.push(...batch);
      }
    }
  }

  /**
   * Generate embeddings for a batch of texts
   * @param {Array<string>} texts - Texts to embed
   * @returns {Promise<Array<Array<number>>>} Embeddings
   */
  async _embedBatch(texts) {
    const embeddings = [];
    const batchSize = 100;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batchTexts = texts.slice(i, i + batchSize);

      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: batchTexts
      });

      embeddings.push(...response.data.map(d => d.embedding));
    }

    return embeddings;
  }

  /**
   * Semantic search for relevant historical messages
   * @param {string} query - Search query
   * @param {string} channelId - Channel to search in
   * @param {Object} options - Search options
   * @returns {Promise<Array>} Relevant messages
   */
  async searchRelevantHistory(query, channelId, options = {}) {
    if (!this._enabled || !this.qdrantClient) return [];

    try {
      // Generate query embedding
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: query
      });
      const queryVector = response.data[0].embedding;

      // Search Qdrant
      const results = await this.qdrantClient.search(this.config.qdrantCollection, {
        vector: queryVector,
        filter: {
          must: [
            { key: 'channelId', match: { value: channelId } }
          ]
        },
        limit: options.limit || this.config.semanticSearchLimit,
        score_threshold: options.scoreThreshold || this.config.searchScoreThreshold
      });

      return results.map(r => ({
        authorName: r.payload.authorName,
        content: r.payload.content,
        timestamp: r.payload.timestamp,
        score: r.score
      }));
    } catch (error) {
      logger.error(`Semantic search error: ${error.message}`);
      return [];
    }
  }

  /**
   * Get recent messages from Qdrant for a channel within a time range
   * Unlike getRecentContext (in-memory), this survives pod restarts
   * @param {string} channelId - Channel ID
   * @param {Date} since - Start of time range
   * @param {number} limit - Max messages to return
   * @returns {Promise<Array<{authorName: string, content: string, timestamp: string}>>}
   */
  async getRecentMessagesFromStore(channelId, since, limit = 50) {
    if (!this._enabled || !this.qdrantClient) return [];

    try {
      const results = await this.qdrantClient.scroll(this.config.qdrantCollection, {
        filter: {
          must: [
            { key: 'channelId', match: { value: channelId } },
            { key: 'timestamp', range: { gte: since.toISOString() } }
          ]
        },
        limit,
        with_payload: true,
        with_vector: false
      });

      // Sort by timestamp ascending and format
      const messages = (results.points || [])
        .sort((a, b) => new Date(a.payload.timestamp) - new Date(b.payload.timestamp))
        .map(p => ({
          authorName: p.payload.authorName,
          content: p.payload.content,
          timestamp: p.payload.timestamp
        }));

      return messages;
    } catch (error) {
      logger.error(`Error fetching recent messages from store: ${error.message}`);
      return [];
    }
  }

  /**
   * Cleanup expired messages from Qdrant
   */
  async _cleanupExpiredMessages() {
    if (!this._enabled || !this.qdrantClient) return;

    const now = new Date().toISOString();

    try {
      await this.qdrantClient.delete(this.config.qdrantCollection, {
        filter: {
          must: [{
            key: 'expiresAt',
            range: { lt: now }
          }]
        }
      });

      logger.info('Completed channel context cleanup (expired messages)');
    } catch (error) {
      logger.error(`Channel context cleanup error: ${error.message}`);
    }
  }

  // ========== Tier 3: Channel-Level Mem0 Memories ==========

  /**
   * Extract channel-level memories using Mem0
   * @param {string} channelId - Channel ID
   */
  async _extractChannelMemories(channelId) {
    if (!this.mem0Service?.isEnabled()) return;

    const buffer = this.channelBuffers.get(channelId);
    if (!buffer) return;

    const messages = buffer.messages.getAll();
    if (messages.length < 5) return; // Need minimum messages for extraction

    // Format messages for Mem0
    const formattedMessages = messages
      .filter(m => !m.isBot)
      .slice(-20) // Last 20 messages
      .map(m => ({
        role: 'user',
        content: `[${m.authorName}]: ${m.content}`
      }));

    if (formattedMessages.length < 3) return;

    try {
      // Use special userId format for channel-level memories
      await this.mem0Service.addMemory(
        formattedMessages,
        `channel:${channelId}`,
        {
          personalityId: 'channel_context',
          guildId: buffer.guildId,
          channelId: channelId
        }
      );

      logger.debug(`Extracted channel memories for ${channelId}`);
    } catch (error) {
      logger.error(`Channel memory extraction error: ${error.message}`);
    }
  }

  /**
   * Get channel-level facts from Mem0
   * @param {string} channelId - Channel ID
   * @returns {Promise<string>} Formatted channel facts
   */
  async getChannelFacts(channelId) {
    if (!this.mem0Service?.isEnabled()) return '';

    try {
      const result = await this.mem0Service.getUserMemories(
        `channel:${channelId}`,
        { limit: 5 }
      );

      if (!result.results || result.results.length === 0) return '';

      return result.results
        .map(m => `- ${m.memory}`)
        .join('\n');
    } catch (error) {
      logger.debug(`Error getting channel facts: ${error.message}`);
      return '';
    }
  }

  /**
   * Get channel-level facts from Mem0 as raw memory objects ({id, memory, ...}),
   * for structured consumers like RecallService. getChannelFacts() returns a
   * preformatted string for the legacy prompt path; this returns the array.
   * @param {string} channelId
   * @returns {Promise<Array>} raw Mem0 result items, or [] when unavailable
   */
  async getChannelFactsRaw(channelId) {
    if (!this.mem0Service?.isEnabled()) return [];
    try {
      const result = await this.mem0Service.getUserMemories(`channel:${channelId}`, { limit: 5 });
      return (result && result.results) ? result.results : [];
    } catch (error) {
      logger.debug(`Error getting raw channel facts: ${error.message}`);
      return [];
    }
  }

  // ========== Hybrid Context Building ==========

  /**
   * Build complete hybrid context for prompt injection
   * Combines: recent messages + semantic search + channel facts
   * @param {string} channelId - Channel ID
   * @param {string} currentMessage - Current user message (for semantic relevance)
   * @returns {Promise<string>} Combined context string
   */
  async buildHybridContext(channelId, currentMessage) {
    if (!this._enabled || !this.isChannelTracked(channelId)) return '';

    try {
      // Parallel fetch all context tiers
      const [recent, semantic, facts] = await Promise.all([
        Promise.resolve(this.getRecentContext(channelId, this.config.promptRecentCount || 10)),
        this.searchRelevantHistory(currentMessage, channelId),
        this.getChannelFacts(channelId)
      ]);

      let context = '';

      // Participant awareness
      const participantContext = this.getParticipantContext(channelId);
      if (participantContext) {
        context += `\n${participantContext}`;
      }

      // Tier 1: Recent conversation
      if (recent) {
        context += `\n\nRecent channel conversation:\n${recent}`;
      }

      // Tier 2: Semantically relevant past messages
      if (semantic && semantic.length > 0) {
        const semanticContext = semantic
          .map(m => `[${m.authorName}]: ${m.content}`)
          .join('\n');
        context += `\n\nRelevant past discussion:\n${semanticContext}`;
      }

      // Tier 3: Channel-level facts
      if (facts) {
        context += `\n\nAbout this channel:\n${facts}`;
      }

      return context;
    } catch (error) {
      logger.error(`Error building hybrid context: ${error.message}`);
      return '';
    }
  }

  /**
   * Build ONLY the participant list + recent in-memory buffer for a channel.
   * No semantic hits, no channel facts. Used by the v2 recall path, which
   * sources semantic/fact recall through RecallService instead.
   *
   * Accessors used (matching buildHybridContext):
   *   getParticipantContext(channelId) → formatted string
   *   getRecentContext(channelId)      → formatted string ("[author]: content\n...")
   *
   * @param {string} channelId
   * @returns {Promise<string>} formatted block, or '' when there is nothing
   */
  async buildRecentContext(channelId) {
    const participantContext = this.getParticipantContext(channelId);
    const recent = this.getRecentContext(channelId);

    if (!participantContext && !recent) return '';

    const parts = [];
    if (participantContext) {
      parts.push(participantContext);
    }
    if (recent) {
      parts.push(`Recent channel conversation:\n${recent}`);
    }
    return `\n\n${parts.join('\n\n')}`;
  }

  // ========== Stats and Diagnostics ==========

  /**
   * Get stats for a channel
   * @param {string} channelId - Channel ID
   * @returns {Promise<Object>} Channel stats
   */
  async getChannelStats(channelId) {
    const buffer = this.channelBuffers.get(channelId);

    let indexedCount = 0;
    if (this.qdrantClient) {
      try {
        const result = await this.qdrantClient.count(this.config.qdrantCollection, {
          filter: {
            must: [{ key: 'channelId', match: { value: channelId } }]
          }
        });
        indexedCount = result.count;
      } catch (error) {
        logger.debug(`Error getting indexed count: ${error.message}`);
      }
    }

    return {
      bufferCount: buffer ? buffer.messages.size() : 0,
      indexedCount: indexedCount,
      pendingCount: this.pendingIndex.filter(m => m.channelId === channelId).length,
      lastActivity: buffer?.lastActivity || null,
      isTracked: this.isChannelTracked(channelId)
    };
  }
}

module.exports = ChannelContextService;
