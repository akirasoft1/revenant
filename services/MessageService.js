const logger = require('../logger');
const { DEFAULT_OPENAI_MODEL, reasoningParams } = require('../utils/openaiModels');

class MessageService {
  constructor(openaiClient, config = null) {
    this.openaiClient = openaiClient;
    this.config = config;
    this.DISCORD_MAX_LENGTH = 2000;
  }

  /**
   * Send a message to Discord, automatically compressing if it exceeds the character limit
   * @param {Object} channel - Discord channel object
   * @param {string} content - Message content to send
   * @param {Object} options - Additional options for the message (embeds, etc.)
   * @returns {Promise<Message>} The sent Discord message
   */
  async sendMessage(channel, content, options = {}) {
    try {
      // If using embeds, send directly without content length checking
      if (options.embeds && options.embeds.length > 0) {
        return await channel.send({ content, ...options });
      }

      // Check if message exceeds Discord's limit
      if (content.length <= this.DISCORD_MAX_LENGTH) {
        return await channel.send({ content, ...options });
      }

      logger.warn(`Message exceeds Discord limit (${content.length} chars). Compressing...`);
      
      // Compress the message using OpenAI
      const compressedContent = await this.compressMessage(content);
      
      // Double-check the compressed content
      if (compressedContent.length <= this.DISCORD_MAX_LENGTH) {
        logger.info(`Message compressed successfully (${compressedContent.length} chars)`);
        return await channel.send({ content: compressedContent, ...options });
      } else {
        // If still too long, force truncate with warning
        logger.error(`Compressed message still too long (${compressedContent.length} chars). Force truncating.`);
        const truncatedContent = compressedContent.substring(0, this.DISCORD_MAX_LENGTH - 50) + '\n\n[Message truncated due to length]';
        return await channel.send({ content: truncatedContent, ...options });
      }
    } catch (error) {
      logger.error('Error sending message:', error);
      throw error;
    }
  }

  /**
   * Reply to a message, automatically compressing if it exceeds the character limit
   * @param {Object} message - Discord message object to reply to
   * @param {string} content - Reply content
   * @param {Object} options - Additional options for the reply (embeds, etc.)
   * @returns {Promise<Message>} The sent Discord message
   */
  async replyToMessage(message, content, options = {}) {
    try {
      // If using embeds, send directly without content length checking
      if (options.embeds && options.embeds.length > 0) {
        return await message.reply({ content, ...options });
      }

      // Check if message exceeds Discord's limit
      if (content.length <= this.DISCORD_MAX_LENGTH) {
        return await message.reply({ content, ...options });
      }

      logger.warn(`Reply exceeds Discord limit (${content.length} chars). Compressing...`);
      
      // Compress the message using OpenAI
      const compressedContent = await this.compressMessage(content);
      
      // Double-check the compressed content
      if (compressedContent.length <= this.DISCORD_MAX_LENGTH) {
        logger.info(`Reply compressed successfully (${compressedContent.length} chars)`);
        return await message.reply({ content: compressedContent, ...options });
      } else {
        // If still too long, force truncate with warning
        logger.error(`Compressed reply still too long (${compressedContent.length} chars). Force truncating.`);
        const truncatedContent = compressedContent.substring(0, this.DISCORD_MAX_LENGTH - 50) + '\n\n[Message truncated due to length]';
        return await message.reply({ content: truncatedContent, ...options });
      }
    } catch (error) {
      logger.error('Error replying to message:', error);
      throw error;
    }
  }

  /**
   * Compress a message using OpenAI to fit within Discord's character limit
   * @param {string} content - Original message content
   * @returns {Promise<string>} Compressed message content
   */
  async compressMessage(content) {
    try {
      const compressionPrompt = `Please compress the following message to be ABSOLUTELY under 2000 characters while preserving all key information, formatting, and important details. The compressed version must be complete and readable:

Original message (${content.length} characters):
${content}

Compressed version (MUST be under 2000 characters):`;

      const model = this.config?.openai?.model || DEFAULT_OPENAI_MODEL;
      const response = await this.openaiClient.responses.create({
        model,
        input: compressionPrompt,
        ...reasoningParams(model, 'none'),
      });

      const compressedContent = response.output_text.trim();
      
      logger.info(`Message compression: ${content.length} → ${compressedContent.length} characters`);
      
      return compressedContent;
    } catch (error) {
      logger.error('Error compressing message with OpenAI:', error);
      
      // Fallback: Simple truncation with warning
      const fallbackContent = content.substring(0, this.DISCORD_MAX_LENGTH - 100) + '\n\n[Message compressed due to length. Full details may be truncated.]';
      logger.warn(`Falling back to simple truncation (${fallbackContent.length} chars)`);
      
      return fallbackContent;
    }
  }

  /**
   * Check if a message would exceed Discord's character limit
   * @param {string} content - Message content to check
   * @returns {boolean} True if message exceeds limit
   */
  exceedsLimit(content) {
    return content.length > this.DISCORD_MAX_LENGTH;
  }

  /**
   * Get the remaining character count for a message
   * @param {string} content - Message content
   * @returns {number} Remaining characters (negative if over limit)
   */
  getRemainingChars(content) {
    return this.DISCORD_MAX_LENGTH - content.length;
  }
}

module.exports = MessageService;