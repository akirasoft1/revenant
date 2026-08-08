// services/ChatService.js
// Handles personality-based chat conversations with memory

const logger = require('../logger');
const personalityManager = require('../personalities');
const { countTokens, wouldExceedLimit } = require('../utils/tokenCounter');
const { withSpan } = require('../tracing');
const localLlmService = require('./LocalLlmService');

// Conversation limits
const LIMITS = {
  MAX_MESSAGES: 100,
  MAX_TOKENS: 150000,
  IDLE_TIMEOUT_MINUTES: 30
};

class ChatService {
  constructor(openaiClient, config, mongoService, mem0Service = null, channelContextService = null, voiceProfileService = null, qdrantService = null, agentClient = null, recallService = null) {
    this.openaiClient = openaiClient;
    this.config = config;
    this.mongoService = mongoService;
    this.mem0Service = mem0Service;
    this.channelContextService = channelContextService;
    this.voiceProfileService = voiceProfileService;
    this.qdrantService = qdrantService;
    this.agentClient = agentClient;
    // v2 centralized ranked recall (RecallService); null disables the v2 path.
    this.recallService = recallService;
  }

  /**
   * Build enhanced system prompt for group conversations
   * @param {Object} personality - Personality object
   * @param {string} memoryContext - Optional personal memory context to include
   * @param {string} channelContext - Optional channel conversation context
   * @param {string} sharedContext - Optional shared channel memory context
   * @param {Object|null} voiceContext - Optional voice profile context {voiceInstructions, fewShotBlock}
   * @returns {string} Enhanced system prompt
   */
  _buildGroupSystemPrompt(personality, memoryContext = '', channelContext = '', sharedContext = '', voiceContext = null) {
    let systemPrompt = personality.systemPrompt;

    // If personality uses voice profile, inject dynamic voice instructions
    if (personality.useVoiceProfile) {
      if (voiceContext?.voiceInstructions) {
        systemPrompt = systemPrompt.replace('{VOICE_INSTRUCTIONS}', voiceContext.voiceInstructions);
      } else {
        systemPrompt = systemPrompt.replace('{VOICE_INSTRUCTIONS}',
          'Be casual, direct, and conversational. Match the energy of the group.');
      }
    }

    const fewShotBlock = voiceContext?.fewShotBlock || '';

    const assembled = `${systemPrompt}

You are in a group conversation with multiple users in a Discord channel.
Their names appear before their messages like "[Username]: message".
Address users by name when relevant. Do not announce when new users join the conversation.${memoryContext}${sharedContext}${channelContext}${fewShotBlock}`;

    // Cross-block prompt-size guard (recall v2): when the fully assembled prompt
    // exceeds the configured ceiling, trim the Memory Context block FIRST (it is
    // the most compressible / lowest-priority block), line-by-line from the
    // bottom, so the verbatim recent-conversation and voice blocks are preserved.
    const max = this.config?.recall?.promptMaxTokens;
    if (max && memoryContext && countTokens(assembled) > max) {
      const header = '\n\n## Memory Context\n';
      if (memoryContext.startsWith(header)) {
        let lines = memoryContext.slice(header.length).split('\n');
        let trimmed = memoryContext;
        while (lines.length > 0 && countTokens(assembled.replace(memoryContext, trimmed)) > max) {
          lines = lines.slice(0, -1);
          trimmed = lines.length ? header + lines.join('\n') : '';
        }
        return assembled.replace(memoryContext, trimmed);
      }
    }

    return assembled;
  }

  /**
   * Get channel conversation context from ChannelContextService
   * @param {string} channelId - Discord channel ID
   * @param {string} userMessage - Current user message for semantic relevance
   * @returns {Promise<string>} Channel context string for prompt injection
   * @private
   */
  async _getChannelContext(channelId, userMessage) {
    if (!this.channelContextService?.isChannelTracked(channelId)) {
      return '';
    }

    try {
      const context = await this.channelContextService.buildHybridContext(channelId, userMessage);
      if (!context) return '';

      return `

${context}`;
    } catch (error) {
      logger.debug(`Error getting channel context: ${error.message}`);
      return '';
    }
  }

  /**
   * Get voice profile context for dynamic style injection
   * @param {string} channelId - Discord channel ID
   * @param {string} userMessage - Current user message for few-shot retrieval
   * @returns {Promise<Object|null>} {voiceInstructions, fewShotBlock} or null
   * @private
   */
  async _getVoiceContext(channelId, userMessage) {
    if (!this.voiceProfileService) return null;

    try {
      const profile = await this.voiceProfileService.getProfile();
      if (!profile) return null;

      // Fetch topically relevant IRC conversation chunks as few-shot style examples
      let fewShotBlock = '';
      if (this.qdrantService) {
        try {
          const examples = await this.qdrantService.search(userMessage, {
            limit: 3,
            scoreThreshold: 0.25
          });

          if (examples.length > 0) {
            const exampleTexts = examples.map(e => {
              const lines = (e.payload.text || '').split('\n').slice(0, 3).join('\n');
              return lines;
            }).filter(Boolean);

            if (exampleTexts.length > 0) {
              fewShotBlock = `\n\nSTYLE REFERENCE ONLY (do NOT reference the topics, people, or events in these examples — only mimic the sentence structure, slang, tone, and formatting):\n${exampleTexts.map(t => `\`\`\`\n${t}\n\`\`\``).join('\n')}`;
            }
          }
        } catch (err) {
          logger.debug(`Few-shot retrieval failed: ${err.message}`);
        }
      }

      return {
        voiceInstructions: profile.voiceInstructions,
        fewShotBlock
      };
    } catch (error) {
      logger.debug(`Error getting voice context: ${error.message}`);
      return null;
    }
  }

  /**
   * v2 recall path: gather the prompt context strings sourced from RecallService
   * (the single ranked `## Memory Context` block) plus the separate recent-buffer
   * block. The shared-memory block folds into recall, so sharedContext is ''.
   *
   * The recall query is built from the raw recent buffer (current userMessage
   * appended last), and the buffer's content hashes are passed as excludeHashes
   * so verbatim recent messages aren't double-injected via semantic recall.
   * @param {string} channelId
   * @param {string} userMessage
   * @param {Object} user - Discord user object (uses user.id)
   * @param {string} personalityId
   * @returns {Promise<{memoryContext:string, sharedContext:string, channelContext:string, recallDebug:Object}>}
   * @private
   */
  async _getRecallContext(channelId, userMessage, user, personalityId) {
    const { contentHash } = require('./recall/ranking');

    const recentBuffer = this.channelContextService?.getRecentMessagesRaw
      ? (this.channelContextService.getRecentMessagesRaw(channelId) || [])
      : [];
    const recentMessages = recentBuffer.map((m) => m.content).filter(Boolean);
    recentMessages.push(userMessage);
    const emptyHash = contentHash('');
    const excludeHashes = recentBuffer
      .map((m) => contentHash(m.content || ''))
      .filter((h) => h && h !== emptyHash);

    const [recall, recentContext] = await Promise.all([
      this.recallService.recall({
        recentMessages,
        scope: { userId: user.id, channelId, personalityId },
        excludeHashes,
      }),
      this.channelContextService?.buildRecentContext
        ? this.channelContextService.buildRecentContext(channelId)
        : Promise.resolve(''),
    ]);

    return {
      memoryContext: recall.block || '',
      sharedContext: '',
      channelContext: recentContext || '',
      recallDebug: recall,
    };
  }

  /**
   * Legacy recall path (today's behavior), extracted so shadow mode can run it
   * alongside the v2 path. Returns the same context-string shape as the v2 path.
   * @returns {Promise<{memoryContext:string, sharedContext:string, channelContext:string}>}
   * @private
   */
  async _getLegacyContext(channelId, userMessage, user, personalityId) {
    const [{ context, sharedContext }, channelContext] = await Promise.all([
      this._getRelevantMemories(userMessage, user.id, personalityId, channelId),
      this._getChannelContext(channelId, userMessage),
    ]);
    return { memoryContext: context, sharedContext, channelContext };
  }

  /**
   * Decide which recall path feeds the prompt and (optionally) shadow-log the other.
   * With recall.enabled=false and recall.shadowEnabled=false this is byte-for-byte
   * the legacy path (recall is never invoked).
   * @returns {Promise<{memoryContext:string, sharedContext:string, channelContext:string, voiceContext:Object|null}>}
   * @private
   */
  async _composeRecallContexts(channelId, userMessage, user, personalityId, personality) {
    // Safety: if the recall service isn't wired (e.g. flag flipped before
    // bot.js injects it), fall back to the legacy path instead of crashing.
    if (!this.recallService) {
      const [oldCtx, voiceContext] = await Promise.all([
        this._getLegacyContext(channelId, userMessage, user, personalityId),
        personality.useVoiceProfile ? this._getVoiceContext(channelId, userMessage) : Promise.resolve(null),
      ]);
      return { ...oldCtx, voiceContext };
    }

    const recallCfg = this.config?.recall || {};
    const voiceP = personality.useVoiceProfile
      ? this._getVoiceContext(channelId, userMessage)
      : Promise.resolve(null);

    const wantNew = !!(recallCfg.enabled || recallCfg.shadowEnabled);
    const wantOld = !recallCfg.enabled || !!recallCfg.shadowEnabled;

    const [newCtx, oldCtx, voiceContext] = await Promise.all([
      wantNew ? this._getRecallContext(channelId, userMessage, user, personalityId) : Promise.resolve(null),
      wantOld ? this._getLegacyContext(channelId, userMessage, user, personalityId) : Promise.resolve(null),
      voiceP,
    ]);

    // Shadow mode: log old vs new without blocking the turn.
    if (recallCfg.shadowEnabled && newCtx && oldCtx) {
      this._logRecallShadow(channelId, userMessage, user, personalityId, oldCtx, newCtx)
        .catch((e) => logger.debug(`recall shadow log failed: ${e.message}`));
    }

    const injectNew = !!(recallCfg.enabled || recallCfg.shadowInject === 'new');
    const chosen = (injectNew ? newCtx : oldCtx) || oldCtx || newCtx;
    return {
      memoryContext: chosen.memoryContext || '',
      sharedContext: chosen.sharedContext || '',
      channelContext: chosen.channelContext || '',
      voiceContext,
    };
  }

  /**
   * Build the shared per-turn context (personality system prompt + recall
   * memory block + recent-buffer history) consumed by BOTH the text agent
   * sidecar and the voice Live sidecar, so the channel-voice brain replies
   * consistently in-voice with memory across surfaces.
   *
   * The memory block is returned SEPARATELY from systemPrompt (not folded in)
   * so callers can place it wherever their prompt/turn format expects it,
   * instead of always at the tail of one big system string.
   *
   * @param {Object} params
   * @param {string} params.userId - Discord user ID
   * @param {string} [params.userTag] - Discord user tag/display name
   * @param {string} params.channelId - Discord channel ID
   * @param {string|null} [params.guildId] - Discord guild ID (reserved for future scoping; unused today)
   * @param {string} params.userMessage - Current user message (drives recall query + voice few-shot)
   * @param {string} [params.personalityId] - Personality to resolve (defaults to channel-voice)
   * @returns {Promise<{systemPrompt: string, memoryBlock: string, historyTurns: Array<{role: 'user'|'assistant', content: string}>}>}
   */
  async buildTurnContext({ userId, userTag = '', channelId, guildId = null, userMessage, personalityId = 'channel-voice' }) {
    void guildId; // reserved for future per-guild scoping; not used yet
    const personality = personalityManager.get(personalityId);
    const user = { id: userId, tag: userTag, username: userTag || userId };

    const { memoryContext = '', channelContext = '', sharedContext = '', voiceContext = null } =
      await this._composeRecallContexts(channelId, userMessage, user, personalityId, personality);

    // systemPrompt WITHOUT the memory block: memory travels separately as memoryBlock.
    const systemPrompt = this._buildGroupSystemPrompt(personality, '', channelContext, sharedContext, voiceContext);

    // History MUST carry both sides of the conversation (user turns AND the
    // bot's own prior replies mapped to 'assistant') so the model has real
    // continuity across surfaces. ChannelContextService.getRecentMessagesRaw
    // is NOT a valid source for this: it reads the in-memory per-channel
    // buffer, which is only ever populated from bot.js's `messageCreate`
    // handler — and that handler unconditionally does
    // `if (message.author.bot) return;` before recording anything, so the
    // bot's own replies never make it into that buffer at all (not merely
    // filtered on read). Source from MongoService's `channel_messages`
    // collection instead — the same store /tldr (CatchMeUpService) reads,
    // and the one durable place bot replies ARE recorded with `isBot: true`
    // (see VoiceService._persistTurn and bot.js's sandbox-executionIds path).
    // getRecentChannelMessages(channelId, limit) already returns the most
    // recent `limit` docs sorted oldest->newest, matching the contract.
    let historyTurns = [];
    try {
      const docs = this.mongoService?.getRecentChannelMessages
        ? await this.mongoService.getRecentChannelMessages(
            channelId,
            this.config?.channelContext?.promptRecentCount || 10
          )
        : [];
      historyTurns = (docs || [])
        .filter((m) => m && m.content)
        .map((m) => ({ role: m.isBot ? 'assistant' : 'user', content: m.content }));
    } catch (error) {
      logger.debug(`buildTurnContext: history lookup failed, degrading to []: ${error.message}`);
      historyTurns = [];
    }

    // bot.js persists the incoming user message to channel_messages
    // fire-and-forget BEFORE calling chat(), so by the time we read history
    // here the current turn is usually already present as the last doc —
    // and would otherwise be forwarded twice (once via historyTurns with raw
    // `<@id>` mention markup, once via the separate stripped userMessage).
    // Drop it defensively; no-op if the write hasn't landed yet (the race's
    // other branch) since there's simply nothing to match.
    historyTurns = this._dropDuplicatedCurrentTurn(historyTurns, userMessage);

    // Deliberate: memoryBlock/historyTurns are returned as-is, WITHOUT the
    // legacy `config.recall.promptMaxTokens` trim that `_buildGroupSystemPrompt`
    // applies below for the direct-OpenAI path. This context feeds the unified
    // agent path (Gemini, ~1M-token context window), where that trim — built
    // for small-window models — isn't needed; recall volume is already bounded
    // upstream by RecallService's own budget (`maxItems`/`tokenBudget`) and by
    // the `channelContext.promptRecentCount` history cap above. Not DRY debt —
    // see CLAUDE.md's Agentic Sandbox section for the split rationale.
    return { systemPrompt, memoryBlock: memoryContext || '', historyTurns };
  }

  /**
   * Drop a trailing `role:'user'` history turn whose content is the current
   * userMessage, so the current turn isn't forwarded twice (once via history,
   * once as the separate current-turn field). Normalizes Discord mention
   * markup and whitespace before comparing, then requires an EXACT match
   * (no endsWith/prefix fallback: getRecentChannelMessages stores raw
   * content with no `[username]: ` prefix today, so exact match already
   * covers the real duplicate case; a fuzzy suffix match would risk
   * false-positive-dropping a genuinely different prior turn that merely
   * ends with the current short message, e.g. prior "let me know if
   * that's ok" + current "ok"). Only ever removes the LAST turn, only when
   * it's a user turn, and only when it matches — earlier turns are never
   * touched. No-op when userMessage is empty (e.g. the voice path, which
   * doesn't have a separate current-turn field to dedupe against).
   * @param {Array<{role: 'user'|'assistant', content: string}>} historyTurns
   * @param {string} userMessage
   * @returns {Array<{role: 'user'|'assistant', content: string}>}
   * @private
   */
  _dropDuplicatedCurrentTurn(historyTurns, userMessage) {
    if (!userMessage || historyTurns.length === 0) return historyTurns;

    const normalize = (s) => String(s || '').replace(/<@!?\d+>/g, '').trim();
    const normalizedUserMessage = normalize(userMessage);
    if (!normalizedUserMessage) return historyTurns;

    const lastTurn = historyTurns[historyTurns.length - 1];
    if (lastTurn.role !== 'user') return historyTurns;

    const normalizedLastTurn = normalize(lastTurn.content);
    if (normalizedLastTurn !== normalizedUserMessage) return historyTurns;

    return historyTurns.slice(0, -1);
  }

  /**
   * Write an A/B comparison of the legacy vs v2 recall blocks to MongoDB.
   * Best-effort: callers should not await this in the hot path.
   * @private
   */
  async _logRecallShadow(channelId, userMessage, user, personalityId, oldCtx, newCtx) {
    if (!this.mongoService?.recordRecallComparison) return;
    await this.mongoService.recordRecallComparison({
      query: userMessage,
      derivedQuery: newCtx.recallDebug?.query || null,
      scope: { userId: user.id, channelId, personalityId },
      oldBlock: `${oldCtx.memoryContext || ''}${oldCtx.sharedContext || ''}`,
      newBlock: newCtx.memoryContext || '',
      // oldKeys intentionally omitted: the legacy path produces formatted strings,
      // not structured candidate keys — synthesizing them would be misleading.
      newKeys: (newCtx.recallDebug?.candidates || []).map((c) => c.key),
      weights: this.config?.recall?.sourceWeights || null,
      strategy: this.config?.recall?.queryStrategy || null,
      ts: new Date(),
    });
  }

  /**
   * Extract generated images from the OpenAI Responses API output
   * @param {Object} response - The full response from OpenAI Responses API
   * @returns {Array<{id: string, base64: string}>} Array of generated images
   * @private
   */
  _extractGeneratedImages(response) {
    if (!response?.output || !Array.isArray(response.output)) {
      return [];
    }

    const images = [];
    for (const item of response.output) {
      if (item.type === 'image_generation_call' &&
          item.status === 'completed' &&
          item.result) {
        images.push({
          id: item.id,
          base64: item.result
        });
        logger.info(`Extracted generated image from response: ${item.id}`);
      }
    }

    return images;
  }

  /**
   * Retrieve relevant memories for a user (if Mem0 is enabled)
   * Performs 3-way parallel search: personality + explicit + shared channel memories
   * @param {string} userMessage - The user's message to search for relevant memories
   * @param {string} userId - Discord user ID
   * @param {string} personalityId - Personality ID for filtering
   * @param {string} channelId - Optional channel ID for shared channel memories
   * @returns {Promise<{memories: Array, context: string, sharedContext: string}>}
   * @private
   */
  async _getRelevantMemories(userMessage, userId, personalityId, channelId = null) {
    if (!this.mem0Service || !this.mem0Service.isEnabled()) {
      return { memories: [], context: '', sharedContext: '' };
    }

    try {
      // 3-way parallel search: personality + explicit + shared channel memories
      const searches = [
        this.mem0Service.searchMemories(userMessage, userId, {
          personalityId: personalityId,
          limit: 3
        }),
        this.mem0Service.searchMemories(userMessage, userId, {
          personalityId: 'explicit_memory',
          limit: 3
        })
      ];

      // Add shared channel memory search if channelId is provided and method exists
      if (channelId && this.mem0Service.searchSharedChannelMemories) {
        searches.push(
          this.mem0Service.searchSharedChannelMemories(userMessage, channelId, { limit: 2 })
        );
      }

      const results = await Promise.all(searches);
      const [personalityResult, explicitResult, sharedResult] = results;

      // Combine results, deduplicating by memory ID
      // Priority order: explicit > shared > personality
      const seenIds = new Set();
      const combinedMemories = [];
      const sharedMemories = [];

      // Add explicit memories first (user-specified, highest priority)
      for (const memory of (explicitResult.results || [])) {
        if (memory.id && !seenIds.has(memory.id)) {
          seenIds.add(memory.id);
          combinedMemories.push(memory);
        }
      }

      // Add shared channel memories (team knowledge, second priority)
      if (sharedResult) {
        for (const memory of (sharedResult.results || [])) {
          if (memory.id && !seenIds.has(memory.id)) {
            seenIds.add(memory.id);
            combinedMemories.push(memory);
            sharedMemories.push(memory);
          }
        }
      }

      // Add personality-specific memories (lowest priority)
      for (const memory of (personalityResult.results || [])) {
        if (memory.id && !seenIds.has(memory.id)) {
          seenIds.add(memory.id);
          combinedMemories.push(memory);
        }
      }

      // Limit to top 5 total for personal context
      const memories = combinedMemories.slice(0, 5);
      const context = this.mem0Service.formatMemoriesForContext(memories);

      // Format shared channel memories separately if method exists
      const sharedContext = (sharedMemories.length > 0 && this.mem0Service.formatSharedMemoriesForContext)
        ? this.mem0Service.formatSharedMemoriesForContext(sharedMemories)
        : '';

      if (memories.length > 0) {
        logger.debug(`Found ${memories.length} relevant memories for user ${userId} (explicit + shared + ${personalityId})`);
      }

      return { memories, context, sharedContext };
    } catch (error) {
      logger.error(`Error retrieving memories: ${error.message}`);
      return { memories: [], context: '', sharedContext: '' };
    }
  }

  /**
   * Store new memories from a conversation exchange
   * @param {string} userMessage - The user's message
   * @param {string} assistantMessage - The assistant's response
   * @param {string} userId - Discord user ID
   * @param {Object} metadata - Conversation metadata
   * @private
   */
  async _storeMemories(userMessage, assistantMessage, userId, metadata) {
    if (!this.mem0Service || !this.mem0Service.isEnabled()) {
      return;
    }

    try {
      const messages = [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: assistantMessage }
      ];

      await this.mem0Service.addMemory(messages, userId, metadata);
    } catch (error) {
      logger.error(`Error storing memories: ${error.message}`);
      // Don't fail the chat response if memory storage fails
    }
  }

  /**
   * Format conversation history for OpenAI API
   * @param {Array} messages - Raw messages from database
   * @returns {Array} Formatted messages for API
   */
  _formatMessagesForAPI(messages) {
    return messages.map(msg => {
      if (msg.role === 'user' && msg.username) {
        return {
          role: 'user',
          content: `[${msg.username}]: ${msg.content}`
        };
      }
      return {
        role: msg.role,
        content: msg.content
      };
    });
  }

  /**
   * Check conversation limits and status
   * @param {string} channelId - Discord channel ID
   * @param {string} personalityId - Personality identifier
   * @returns {Object} Limit check result
   */
  async _checkConversationLimits(channelId, personalityId) {
    const status = await this.mongoService.getConversationStatus(channelId, personalityId);

    // No existing conversation
    if (!status.exists) {
      return { allowed: true, reason: null };
    }

    // Expired or reset conversations should start fresh with !chat
    // Users can use !chatresume to continue an expired conversation with history
    if (status.status === 'expired' || status.status === 'reset') {
      return { allowed: true, reason: null, startFresh: true };
    }

    // Check idle timeout - if idle, expire and allow fresh start
    const isIdle = await this.mongoService.isConversationIdle(channelId, personalityId, LIMITS.IDLE_TIMEOUT_MINUTES);
    if (isIdle) {
      // Expire the conversation
      await this.mongoService.expireConversation(channelId, personalityId);
      return { allowed: true, reason: null, startFresh: true };
    }

    // Check message count limit
    if (status.messageCount >= LIMITS.MAX_MESSAGES) {
      return {
        allowed: false,
        reason: 'message_limit',
        message: `This conversation has reached ${LIMITS.MAX_MESSAGES} messages. An admin can reset it with \`!chatreset ${personalityId}\`.`
      };
    }

    // Check token limit
    if (status.totalTokens >= LIMITS.MAX_TOKENS) {
      return {
        allowed: false,
        reason: 'token_limit',
        message: `This conversation has reached the ${LIMITS.MAX_TOKENS.toLocaleString()} token limit. An admin can reset it with \`!chatreset ${personalityId}\`.`
      };
    }

    return { allowed: true, reason: null };
  }

  /**
   * Build input for OpenAI Responses API, optionally with an image
   * @param {string} textInput - The text input
   * @param {string|null} imageUrl - Optional image URL
   * @returns {string|Array} Input for the API
   */
  _buildApiInput(textInput, imageUrl = null) {
    if (!imageUrl) {
      return textInput;
    }

    // Multimodal input with image - must be wrapped in a message object
    return [{
      role: 'user',
      content: [
        { type: 'input_text', text: textInput },
        { type: 'input_image', image_url: imageUrl }
      ]
    }];
  }

  /**
   * Generate a response from a personality with conversation memory
   * @param {string} personalityId - The personality ID to use
   * @param {string} userMessage - The user's message
   * @param {Object} user - Discord user object
   * @param {string} channelId - Discord channel ID
   * @param {string} guildId - Discord guild ID
   * @param {string|null} imageUrl - Optional image URL for vision
   * @returns {Object} Response with message and token usage
   */
  async chat(personalityId, userMessage, user, channelId = null, guildId = null, imageUrl = null) {
    // Route channel-voice through the agent sidecar when available and healthy.
    // On agent failure or unhealthy state, fall through to the existing direct
    // OpenAI path so the bot keeps working when the sidecar is down.
    if (
      personalityId === 'channel-voice'
      && this.agentClient
      && this.agentClient.isHealthy()
      && process.env.AGENT_ENABLED !== 'false'
    ) {
      try {
        const turnCtx = await this.buildTurnContext({
          userId: user.id,
          userTag: user.tag || user.username || '',
          channelId: channelId || '',
          guildId: guildId || '',
          userMessage,
          personalityId,
        }).catch(() => ({ systemPrompt: '', memoryBlock: '', historyTurns: [] }));
        const agentResp = await this.agentClient.chat({
          userId: user.id,
          userTag: user.tag || user.username || '',
          channelId: channelId || '',
          guildId: guildId || '',
          interactionId: user.interactionId || '',
          userMessage,
          imageUrl: imageUrl || '',
          systemPrompt: turnCtx.systemPrompt,
          memoryContext: turnCtx.memoryBlock,
          history: turnCtx.historyTurns,
        });
        const cvPersonality = personalityManager.get('channel-voice') || {
          id: 'channel-voice',
          name: 'Channel Voice',
          emoji: '🗣️',
        };
        return {
          success: true,
          message: agentResp.messageText,
          personality: {
            id: cvPersonality.id,
            name: cvPersonality.name,
            emoji: cvPersonality.emoji,
          },
          tokens: { input: 0, output: 0, total: 0 },
          executionSummary: agentResp.summary,
          fallback: agentResp.fallbackOccurred ? { occurred: true, reason: 'agent fallback' } : undefined,
        };
      } catch (err) {
        logger.warn(`Agent call failed; falling through to direct-OpenAI: ${err.message}`);
      }
    }

    const personality = personalityManager.get(personalityId);

    if (!personality) {
      // Check if personality exists but is unavailable (e.g., local LLM not running)
      const availability = personalityManager.checkAvailability(personalityId);
      if (availability.exists && !availability.available) {
        // Path A: Check if personality has a fallback we can redirect to
        const rawPersonality = personalityManager.getRaw(personalityId);
        if (rawPersonality?.useLocalLlm && rawPersonality?.fallbackPersonality) {
          const fallbackId = rawPersonality.fallbackPersonality;
          const fallbackPersonality = personalityManager.get(fallbackId);
          if (fallbackPersonality) {
            logger.warn(`Personality ${personalityId} unavailable (circuit open), falling back to ${fallbackId}`);
            const result = await this.chat(fallbackId, userMessage, user, channelId, guildId, imageUrl);
            if (result.success) {
              result.fallback = {
                occurred: true,
                originalPersonality: personalityId,
                reason: 'Local LLM unavailable'
              };
            }
            return result;
          }
        }
        return {
          success: false,
          error: availability.reason
        };
      }
      return {
        success: false,
        error: `Unknown personality: ${personalityId}`
      };
    }

    // Check if personality requires local LLM
    const shouldUseLocalLlm = personality.useLocalLlm;

    // If no channelId provided, fall back to stateless mode (backwards compatibility)
    if (!channelId || !this.mongoService) {
      return this._statelessChat(personality, userMessage, user, imageUrl);
    }

    try {
      // Check conversation limits
      const limitCheck = await this._checkConversationLimits(channelId, personalityId);
      if (!limitCheck.allowed) {
        return {
          success: false,
          error: limitCheck.message,
          reason: limitCheck.reason,
          personality: {
            id: personality.id,
            name: personality.name,
            emoji: personality.emoji
          }
        };
      }

      // If starting fresh (expired/reset conversation), reset it first
      if (limitCheck.startFresh) {
        await this.mongoService.resetConversation(channelId, personalityId);
        logger.info(`Starting fresh conversation with ${personalityId} in channel ${channelId} (previous was expired/reset)`);
      }

      // Get or create conversation
      const conversation = await this.mongoService.getOrCreateConversation(channelId, personalityId, guildId);
      if (!conversation) {
        logger.error('Failed to get/create conversation');
        return this._statelessChat(personality, userMessage, user);
      }

      logger.info(`Chat request from ${user.username} using personality: ${personality.name} (channel: ${channelId})`);

      // Compose recall + channel + voice context. Behind RECALL_V2_ENABLED /
      // RECALL_SHADOW_ENABLED this either runs today's legacy retrieval, the v2
      // ranked RecallService path, or both (shadow A/B logging). With both flags
      // off it is byte-for-byte the legacy path.
      const { memoryContext, sharedContext, channelContext, voiceContext } =
        await this._composeRecallContexts(channelId, userMessage, user, personalityId, personality);

      // Build system prompt and format history
      // This is the direct-OpenAI path (falls through to here when the agent
      // sidecar is disabled/unhealthy, or for any non-channel-voice
      // personality). It INTENTIONALLY keeps `_buildGroupSystemPrompt`'s
      // `promptMaxTokens` trim — unlike `buildTurnContext` above, which feeds
      // the unified Gemini agent path untrimmed. This is the unhappy-path
      // fallback on a smaller-window, cost-sensitive model, so bounding the
      // memory block here still matters. Deliberate split, not DRY debt.
      const systemPrompt = this._buildGroupSystemPrompt(personality, memoryContext, channelContext, sharedContext, voiceContext);
      const historyMessages = this._formatMessagesForAPI(conversation.messages || []);

      // Format current user message
      const formattedUserMessage = `[${user.username}]: ${userMessage}`;

      // Build input text from history for responses API
      const historyText = historyMessages.length > 0
        ? historyMessages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n') + '\n\n'
        : '';
      const inputText = `${historyText}User: ${formattedUserMessage}`;

      // Check if adding this message would exceed token limit
      const estimatedTokens = countTokens(systemPrompt) + countTokens(inputText);
      if (wouldExceedLimit(0, estimatedTokens, LIMITS.MAX_TOKENS)) {
        return {
          success: false,
          error: `This conversation is approaching the token limit. An admin can reset it with \`!chatreset ${personalityId}\`.`,
          reason: 'token_limit',
          personality: {
            id: personality.id,
            name: personality.name,
            emoji: personality.emoji
          }
        };
      }

      // Generate response - route to local LLM if uncensored, otherwise cloud
      let assistantMessage;
      let inputTokens = 0;
      let outputTokens = 0;
      let generatedImages = [];
      let usedFallback = false;
      let fallbackPersonalityInfo = null;

      if (shouldUseLocalLlm && localLlmService.isAvailable()) {
        // Use local LLM for uncensored response or local-LLM-only personality
        // Get uncensored system prompt if available, otherwise use standard prompt
        const uncensoredSystemPrompt = personalityManager.getSystemPrompt(personalityId, true) || systemPrompt;

        // Build messages array for chat.completions API
        const messages = [
          { role: 'system', content: uncensoredSystemPrompt },
          ...historyMessages,
          { role: 'user', content: formattedUserMessage }
        ];

        logger.info(`Using local LLM for response (personality: ${personalityId}, reason: ${personality.useLocalLlm ? 'personality requires local LLM' : 'user requested uncensored'})`);

        try {
          assistantMessage = await localLlmService.generateCompletion(messages);

          // Local LLM doesn't provide token counts, estimate them
          inputTokens = countTokens(uncensoredSystemPrompt) + countTokens(inputText);
          outputTokens = countTokens(assistantMessage);

          // Successful — ensure the service is marked available
          localLlmService.markAvailable();
        } catch (localLlmError) {
          // Path B: Check if this is a connection error that warrants fallback
          if (localLlmService.isConnectionError(localLlmError)) {
            logger.warn(`Local LLM connection failed, falling back to cloud provider: ${localLlmError.message}`);
            localLlmService.markUnavailable();

            // Determine fallback personality
            const fallbackId = personality.fallbackPersonality || 'friendly';
            const fallbackPers = personalityManager.get(fallbackId) || personalityManager.get('friendly');

            if (!fallbackPers) {
              throw localLlmError; // No fallback available
            }

            // Use fallback personality's system prompt with cloud provider
            const fallbackSystemPrompt = this._buildGroupSystemPrompt(fallbackPers, memoryContext, channelContext, sharedContext);
            const apiInput = this._buildApiInput(inputText, imageUrl);

            const model = this.config.openai.model || 'gpt-5.1';
            const response = await withSpan('openai.responses.create', {
              'gen_ai.system': 'openai',
              'gen_ai.operation.name': 'chat',
              'gen_ai.request.model': model,
              'chat.personality.id': fallbackId,
              'chat.personality.name': fallbackPers.name,
              'chat.mode': 'stateful',
              'chat.fallback': true,
              'chat.fallback.reason': localLlmError.message,
              'chat.original_personality.id': personalityId,
              'discord.channel.id': channelId,
              'discord.guild.id': guildId || '',
              'discord.user.id': user.id,
            }, async (span) => {
              const result = await this.openaiClient.responses.create({
                model: model,
                instructions: fallbackSystemPrompt,
                input: apiInput,
                tools: [{ type: 'web_search' }]
              });

              span.setAttributes({
                'gen_ai.response.id': result.id || '',
                'gen_ai.response.model': result.model || model,
                'gen_ai.usage.input_tokens': result.usage?.input_tokens || 0,
                'gen_ai.usage.output_tokens': result.usage?.output_tokens || 0,
              });

              return result;
            });

            assistantMessage = response.output_text;
            inputTokens = response.usage?.input_tokens || 0;
            outputTokens = response.usage?.output_tokens || 0;
            generatedImages = this._extractGeneratedImages(response);

            usedFallback = true;
            fallbackPersonalityInfo = {
              id: fallbackPers.id,
              name: fallbackPers.name,
              emoji: fallbackPers.emoji
            };
          } else {
            // Not a connection error — re-throw to be caught by outer catch
            throw localLlmError;
          }
        }

      } else {
        // Call OpenAI Responses API (cloud provider)
        const apiInput = this._buildApiInput(inputText, imageUrl);
        if (imageUrl) {
          logger.info(`Including image in chat request: ${imageUrl}`);
        }

        const model = this.config.openai.model || 'gpt-5.1';
        const response = await withSpan('openai.responses.create', {
          // GenAI semantic conventions
          'gen_ai.system': 'openai',
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': model,
          // Chat context
          'chat.personality.id': personalityId,
          'chat.personality.name': personality.name,
          'chat.mode': 'stateful',
          'chat.has_image': !!imageUrl,
          'chat.tools_enabled': 'web_search',
          'chat.conversation.message_count': conversation.messageCount || 0,
          // Discord context
          'discord.channel.id': channelId,
          'discord.guild.id': guildId || '',
          'discord.user.id': user.id,
        }, async (span) => {
          const result = await this.openaiClient.responses.create({
            model: model,
            instructions: systemPrompt,
            input: apiInput,
            tools: [{ type: 'web_search' }]
          });

          // Add response attributes
          span.setAttributes({
            'gen_ai.response.id': result.id || '',
            'gen_ai.response.model': result.model || model,
            'gen_ai.usage.input_tokens': result.usage?.input_tokens || 0,
            'gen_ai.usage.output_tokens': result.usage?.output_tokens || 0,
          });

          return result;
        });

        assistantMessage = response.output_text;
        inputTokens = response.usage?.input_tokens || 0;
        outputTokens = response.usage?.output_tokens || 0;

        // Extract any generated images from the response
        generatedImages = this._extractGeneratedImages(response);
      }

      const totalTokens = inputTokens + outputTokens;

      // Store user message in conversation (with original content, not formatted)
      await this.mongoService.addMessageToConversation(
        channelId,
        personalityId,
        'user',
        userMessage,
        user.id,
        user.username,
        countTokens(formattedUserMessage)
      );

      // Store assistant response
      await this.mongoService.addMessageToConversation(
        channelId,
        personalityId,
        'assistant',
        assistantMessage,
        null,
        null,
        outputTokens
      );

      // Record per-user token usage
      await this.mongoService.recordTokenUsage(
        user.id,
        user.tag || user.username,
        inputTokens,
        outputTokens,
        `chat_${personalityId}`,
        this.config.openai.model || 'gpt-5.1'
      );

      // Store conversation in Mem0 for long-term memory extraction
      await this._storeMemories(userMessage, assistantMessage, user.id, {
        channelId: channelId,
        personalityId: personalityId,
        guildId: guildId
      });

      logger.info(`Chat response generated: ${inputTokens} in, ${outputTokens} out (conversation: ${conversation.messageCount + 2} messages)`);

      const result = {
        success: true,
        message: assistantMessage,
        personality: fallbackPersonalityInfo || {
          id: personality.id,
          name: personality.name,
          emoji: personality.emoji
        },
        tokens: {
          input: inputTokens,
          output: outputTokens,
          total: totalTokens
        },
        conversation: {
          messageCount: (conversation.messageCount || 0) + 2,
          totalTokens: (conversation.totalTokens || 0) + totalTokens
        },
        images: generatedImages // Base64 images generated by the model
      };

      if (usedFallback) {
        result.fallback = {
          occurred: true,
          originalPersonality: personalityId,
          reason: 'Local LLM unavailable'
        };
      }

      return result;

    } catch (error) {
      logger.error(`Chat error with personality ${personalityId}: ${error.message}`);
      return {
        success: false,
        error: `Failed to generate response: ${error.message}`
      };
    }
  }

  /**
   * Stateless chat (no memory) - backwards compatibility
   * @param {Object} personality - Personality object
   * @param {string} userMessage - User's message
   * @param {Object} user - Discord user object
   * @param {string|null} imageUrl - Optional image URL for vision
   * @private
   */
  async _statelessChat(personality, userMessage, user, imageUrl = null) {
    try {
      logger.info(`Stateless chat request from ${user.username} using personality: ${personality.name}`);

      const apiInput = this._buildApiInput(userMessage, imageUrl);
      if (imageUrl) {
        logger.info(`Including image in stateless chat request: ${imageUrl}`);
      }

      const model = this.config.openai.model || 'gpt-5.1';
      const response = await withSpan('openai.responses.create', {
        // GenAI semantic conventions
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': model,
        // Chat context
        'chat.personality.id': personality.id,
        'chat.personality.name': personality.name,
        'chat.mode': 'stateless',
        'chat.has_image': !!imageUrl,
        'chat.tools_enabled': 'web_search',
        // Discord context
        'discord.user.id': user.id,
      }, async (span) => {
        const result = await this.openaiClient.responses.create({
          model: model,
          instructions: personality.systemPrompt,
          input: apiInput,
          tools: [{ type: 'web_search' }]
        });

        // Add response attributes
        span.setAttributes({
          'gen_ai.response.id': result.id || '',
          'gen_ai.response.model': result.model || model,
          'gen_ai.usage.input_tokens': result.usage?.input_tokens || 0,
          'gen_ai.usage.output_tokens': result.usage?.output_tokens || 0,
        });

        return result;
      });

      const assistantMessage = response.output_text;
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;

      // Extract any generated images from the response
      const generatedImages = this._extractGeneratedImages(response);

      // Record token usage if mongoService available
      if (this.mongoService) {
        await this.mongoService.recordTokenUsage(
          user.id,
          user.tag || user.username,
          inputTokens,
          outputTokens,
          `chat_${personality.id}`,
          this.config.openai.model || 'gpt-5.1'
        );
      }

      return {
        success: true,
        message: assistantMessage,
        personality: {
          id: personality.id,
          name: personality.name,
          emoji: personality.emoji
        },
        tokens: {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens
        },
        images: generatedImages // Base64 images generated by the model
      };

    } catch (error) {
      logger.error(`Stateless chat error: ${error.message}`);
      return {
        success: false,
        error: `Failed to generate response: ${error.message}`
      };
    }
  }

  /**
   * Resume an expired conversation
   * @param {string} personalityId - Personality ID
   * @param {string} userMessage - User's message
   * @param {Object} user - Discord user object
   * @param {string} channelId - Discord channel ID
   * @param {string} guildId - Discord guild ID
   * @returns {Object} Response with message and token usage
   */
  async resumeChat(personalityId, userMessage, user, channelId, guildId) {
    const personality = personalityManager.get(personalityId);

    if (!personality) {
      return {
        success: false,
        error: `Unknown personality: ${personalityId}`
      };
    }

    // Check if there's an expired conversation to resume
    const status = await this.mongoService.getConversationStatus(channelId, personalityId);

    if (!status.exists) {
      return {
        success: false,
        error: `No conversation found with ${personality.name} in this channel. Start a new one with \`!chat ${personalityId} <message>\`.`
      };
    }

    if (status.status === 'active') {
      return {
        success: false,
        error: `The conversation with ${personality.name} is still active. Just use \`!chat ${personalityId} <message>\`.`
      };
    }

    if (status.status === 'reset') {
      return {
        success: false,
        error: `The conversation with ${personality.name} was reset. Start a new one with \`!chat ${personalityId} <message>\`.`
      };
    }

    // Resume the expired conversation
    const resumed = await this.mongoService.resumeConversation(channelId, personalityId);
    if (!resumed) {
      return {
        success: false,
        error: `Failed to resume conversation with ${personality.name}.`
      };
    }

    logger.info(`Resumed conversation with ${personalityId} in channel ${channelId}`);

    // Now continue with normal chat
    return this.chat(personalityId, userMessage, user, channelId, guildId);
  }

  /**
   * Reset a conversation (requires admin role - checked by command)
   * @param {string} channelId - Discord channel ID
   * @param {string} personalityId - Personality ID
   * @returns {Object} Result
   */
  async resetConversation(channelId, personalityId) {
    const personality = personalityManager.get(personalityId);

    if (!personality) {
      return {
        success: false,
        error: `Unknown personality: ${personalityId}`
      };
    }

    const status = await this.mongoService.getConversationStatus(channelId, personalityId);

    if (!status.exists) {
      return {
        success: false,
        error: `No conversation found with ${personality.name} in this channel.`
      };
    }

    const reset = await this.mongoService.resetConversation(channelId, personalityId);

    if (reset) {
      return {
        success: true,
        message: `Conversation with ${personality.emoji} ${personality.name} has been reset. Start fresh with \`!chat ${personalityId} <message>\`.`,
        personality: {
          id: personality.id,
          name: personality.name,
          emoji: personality.emoji
        }
      };
    }

    return {
      success: false,
      error: `Failed to reset conversation with ${personality.name}.`
    };
  }

  /**
   * Get conversation info for a channel + personality
   * @param {string} channelId - Discord channel ID
   * @param {string} personalityId - Personality ID
   * @returns {Object} Conversation info
   */
  async getConversationInfo(channelId, personalityId) {
    const personality = personalityManager.get(personalityId);
    const status = await this.mongoService.getConversationStatus(channelId, personalityId);

    return {
      personality: personality ? {
        id: personality.id,
        name: personality.name,
        emoji: personality.emoji
      } : null,
      ...status,
      limits: LIMITS
    };
  }

  /**
   * List all available personalities
   * @returns {Array} List of personalities
   */
  listPersonalities() {
    return personalityManager.list();
  }

  /**
   * Get a specific personality's details
   * @param {string} personalityId - The personality ID
   * @returns {Object|null} Personality details or null
   */
  getPersonality(personalityId) {
    return personalityManager.get(personalityId);
  }

  /**
   * Check if a personality exists
   * @param {string} personalityId - The personality ID
   * @returns {boolean} True if exists
   */
  personalityExists(personalityId) {
    return personalityManager.exists(personalityId);
  }

  /**
   * List resumable conversations for a user
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID (optional)
   * @returns {Array} Array of conversation summaries with personality info
   */
  async listUserConversations(userId, guildId = null) {
    if (!this.mongoService) {
      return [];
    }

    const conversations = await this.mongoService.getUserConversations(userId, guildId);

    // Enrich with personality info
    return conversations.map(conv => {
      const personality = personalityManager.get(conv.personalityId);
      return {
        ...conv,
        personality: personality ? {
          id: personality.id,
          name: personality.name,
          emoji: personality.emoji
        } : {
          id: conv.personalityId,
          name: conv.personalityId,
          emoji: '🎭'
        }
      };
    });
  }
}

module.exports = ChatService;
