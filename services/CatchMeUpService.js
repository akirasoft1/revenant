// services/CatchMeUpService.js
// Synthesizes a "catch me up" summary of what happened while a user was away

const logger = require('../logger');
const { DEFAULT_OPENAI_MODEL, reasoningParams } = require('../utils/openaiModels');

// Default lookback when no last-seen record exists (3 days)
const DEFAULT_LOOKBACK_DAYS = 3;
// Minimum lookback in hours (to avoid near-zero ranges)
const MIN_LOOKBACK_HOURS = 1;

class CatchMeUpService {
  /**
   * @param {Object} mongoService - MongoService for messages, user activity
   * @param {Object} voiceProfileService - VoiceProfileService for channel voice styling
   * @param {Object} openaiClient - OpenAI client for synthesis
   * @param {Object} config - Bot configuration
   */
  constructor(mongoService, voiceProfileService, openaiClient, config) {
    this.mongoService = mongoService;
    this.voiceProfileService = voiceProfileService;
    this.openaiClient = openaiClient;
    this.config = config;
  }

  /**
   * Generate a catch-up summary for a user
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   * @param {Object} options - Options
   * @param {number} options.days - Override lookback period in days
   * @returns {Promise<{success: boolean, message?: string, nothingNew?: boolean, error?: string}>}
   */
  async generateCatchUp(userId, guildId, options = {}) {
    try {
      // 1. Determine time range
      const lastSeen = await this.mongoService.getUserLastSeen(userId, guildId);
      let lookbackDays;

      if (options.days) {
        // User explicitly requested a lookback period
        lookbackDays = options.days;
      } else if (lastSeen) {
        // Calculate from actual time away (can be fractional — hours matter)
        const hoursAway = (Date.now() - new Date(lastSeen.lastSeenAt).getTime()) / (1000 * 60 * 60);
        lookbackDays = Math.max(MIN_LOOKBACK_HOURS / 24, hoursAway / 24);
      } else {
        lookbackDays = DEFAULT_LOOKBACK_DAYS;
      }

      const activeChannels = lastSeen?.activeChannels || [];

      const lookbackLabel = lookbackDays >= 1
        ? `${Math.round(lookbackDays)} day${Math.round(lookbackDays) !== 1 ? 's' : ''}`
        : `${Math.round(lookbackDays * 24)} hour${Math.round(lookbackDays * 24) !== 1 ? 's' : ''}`;
      logger.info(`Generating catch-up for user ${userId}: lookback ${lookbackLabel}, ${activeChannels.length} active channels`);

      // 2. Gather data in parallel
      const voiceProfile = await (this.voiceProfileService?.getProfile().catch(() => null) || Promise.resolve(null));

      // 3. Gather recent messages from MongoDB (persists across restarts)
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const channelContexts = [];

      if (activeChannels.length > 0) {
        const messages = await this.mongoService.getChannelMessages(
          activeChannels.slice(0, 5), since, 200
        );

        if (messages.length > 0) {
          const context = messages
            .filter(m => m.content && m.content.trim())
            .map(m => `[${m.authorName}]: ${m.content}`)
            .join('\n');
          if (context) {
            channelContexts.push({ context });
          }
        }
      }

      // 4. Check if there's anything to report
      const hasMessages = channelContexts.some(c => c.context.length > 0);

      if (!hasMessages) {
        return {
          success: true,
          nothingNew: true,
          message: "Things have been pretty quiet — nothing notable since you were last around."
        };
      }

      // 5. Build context for synthesis
      const contextParts = [];

      for (const { context } of channelContexts) {
        if (context) {
          contextParts.push(`**Recent Chat:**\n${context}`);
        }
      }

      const gatheredContext = contextParts.join('\n\n');

      // Guard: if context is too thin, don't waste an LLM call on it
      const contextLines = gatheredContext.split('\n').filter(l => l.trim() && !l.startsWith('**')).length;
      if (contextLines < 3) {
        logger.info(`Catch-up context too thin (${contextLines} lines), skipping LLM synthesis`);
        return {
          success: true,
          nothingNew: true,
          message: "Things have been pretty quiet — not enough recent conversation to summarize."
        };
      }

      // 6. Build system prompt with voice styling
      let systemPrompt = `You are summarizing what happened in a Discord server while a user was away (approximately ${lookbackLabel}).

CRITICAL RULES:
- ONLY reference conversations, users, and events that appear in the provided chat logs below
- Do NOT invent, fabricate, or hallucinate any content, usernames, events, or discussions
- If the chat logs are sparse, keep the summary short — a few sentences is fine
- It is much better to say "not much happened" than to make things up
- Only mention usernames that explicitly appear in the [Username]: format in the logs

Your task:
- Summarize what actually happened based on the chat logs provided
- Keep it concise and natural — like a friend filling someone in
- Group related topics together
- If there's very little to report, just say so briefly`;

      if (voiceProfile) {
        systemPrompt += `\n\nStyle your response to match this group's communication style:\n${voiceProfile.voiceInstructions || ''}`;
        if (voiceProfile.toneKeywords?.length > 0) {
          systemPrompt += `\nTone: ${voiceProfile.toneKeywords.join(', ')}`;
        }
      }

      // 7. Synthesize
      logger.info(`Catch-up LLM input for user ${userId}: ${contextLines} context lines, ${gatheredContext.length} chars`);
      logger.debug(`Catch-up raw context:\n${gatheredContext}`);

      const model = this.config.openai.model || DEFAULT_OPENAI_MODEL;
      const response = await this.openaiClient.responses.create({
        model,
        instructions: systemPrompt,
        input: gatheredContext,
        ...reasoningParams(model, 'low')
      });

      logger.info(`Catch-up generated for user ${userId}: ${response.usage?.input_tokens || 0} input tokens, ${response.usage?.output_tokens || 0} output tokens`);
      logger.debug(`Catch-up LLM output:\n${response.output_text}`);

      return {
        success: true,
        message: response.output_text.trim()
      };

    } catch (error) {
      logger.error(`Error generating catch-up for user ${userId}: ${error.message}`);
      return {
        success: false,
        error: `Sorry, I encountered an error generating your catch-up: ${error.message}`
      };
    }
  }
}

module.exports = CatchMeUpService;
