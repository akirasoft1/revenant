// handlers/ReplyHandler.js
// Handles replies to bot messages for summarization follow-ups and image regeneration

const { AttachmentBuilder } = require('discord.js');
const logger = require('../logger');
const { DEFAULT_OPENAI_MODEL, reasoningParams } = require('../utils/openaiModels');
const TextUtils = require('../utils/textUtils');
const { withRootSpan, withSpan, setSpanAttributes } = require('../tracing');
const { DISCORD, REPLY, ERROR, SUMMARIZATION } = require('../tracing-attributes');

class ReplyHandler {
  constructor(chatService, summarizationService, openaiClient, config, imagenService = null) {
    this.chatService = chatService;
    this.summarizationService = summarizationService;
    this.openaiClient = openaiClient;
    this.config = config;
    this.imagenService = imagenService;
  }

  /**
   * Handle a reply to a bot message
   * @param {Message} message - The reply message from a user
   * @param {Message} referencedMessage - The original bot message being replied to
   * @returns {boolean} True if the reply was handled, false otherwise
   */
  async handleReply(message, referencedMessage) {
    // Only handle replies to bot messages
    if (!referencedMessage.author.bot) {
      return false;
    }

    const botContent = referencedMessage.content;

    // Wrap in root span for tracing entry point
    return withRootSpan('discord.reply.handle', {
      [DISCORD.USER_ID]: message.author.id,
      [DISCORD.USER_TAG]: message.author.tag || message.author.username,
      [DISCORD.CHANNEL_ID]: message.channel.id,
      [DISCORD.GUILD_ID]: message.guild?.id || 'dm',
      [DISCORD.MESSAGE_ID]: message.id,
      [REPLY.OPERATION]: 'handle_reply',
    }, async (span) => {
      // Try to detect if this is a summarization message
      if (this.isSummarizationMessage(botContent)) {
        logger.info('Detected reply to summarization message');
        span.setAttributes({
          [REPLY.TYPE]: 'summarization_followup',
          [REPLY.IS_SUMMARIZATION]: true,
        });
        await this.handleSummarizationReply(message, botContent);
        return true;
      }

      // Try to detect if this is an image generation message
      const attachments = referencedMessage.attachments?.map?.(a => a) ||
                          (referencedMessage.attachments?.size > 0 ?
                            [referencedMessage.attachments.first()] : []);
      if (this.isImageGenerationMessage(botContent, attachments)) {
        const originalPrompt = this.extractOriginalPrompt(botContent);
        if (originalPrompt && this.imagenService) {
          logger.info(`Detected reply to image generation: "${originalPrompt}"`);
          span.setAttributes({
            [REPLY.TYPE]: 'image_regeneration',
            'image.original_prompt': originalPrompt,
          });
          await this.handleImageReply(message, originalPrompt);
          return true;
        }
      }

      span.setAttribute(REPLY.TYPE, 'unhandled');
      return false;
    });
  }

  /**
   * Check if a message is a summarization message
   * Summarization messages contain specific patterns like reading time, topic, source rating
   * @param {string} content - The bot message content
   * @returns {boolean} True if this is a summarization message
   */
  isSummarizationMessage(content) {
    // Check for typical summarization patterns
    const summarizationPatterns = [
      /\*\*Reading Time:\*\*/i,
      /\*\*Topic:\*\*/i,
      /\*\*Source Rating:\*\*/i,
      /\*\*Sentiment:\*\*/i,
      /\*\*Archived Version:\*\*/i,
      /\*\*Original:\*\*/i
    ];

    return summarizationPatterns.some(pattern => pattern.test(content));
  }

  /**
   * Extract article URL from a summarization message
   * @param {string} content - The bot message content
   * @returns {string|null} The article URL or null if not found
   */
  extractArticleUrl(content) {
    // Look for Original URL pattern: **Original:** <url>
    const originalMatch = content.match(/\*\*Original:\*\*\s*<([^>]+)>/);
    if (originalMatch) {
      return originalMatch[1];
    }

    // Look for Archived Version pattern: **Archived Version:** <url>
    const archivedMatch = content.match(/\*\*Archived Version:\*\*\s*<([^>]+)>/);
    if (archivedMatch) {
      return archivedMatch[1];
    }

    // Look for any URL in the content
    const urlMatch = content.match(/(https?:\/\/[^\s<>]+)/);
    return urlMatch ? urlMatch[1] : null;
  }

  /**
   * Extract the summary text from a summarization message
   * @param {string} content - The bot message content
   * @returns {string} The summary text
   */
  extractSummaryText(content) {
    // Summary is typically between the title and the metadata section
    // Try to extract the main content before the **Archived Version:** or **Original:** line
    const lines = content.split('\n');
    const summaryLines = [];
    let inSummary = false;

    for (const line of lines) {
      // Skip title (usually first line with **)
      if (!inSummary && line.startsWith('**') && !line.includes('Reading Time') && !line.includes('Topic')) {
        inSummary = true;
        continue;
      }

      // Stop at metadata sections
      if (line.startsWith('**Archived Version:') ||
          line.startsWith('**Original:') ||
          line.startsWith('**Reading Time:') ||
          line.startsWith('**Topic:')) {
        break;
      }

      if (inSummary && line.trim()) {
        summaryLines.push(line);
      }
    }

    return summaryLines.join('\n').trim();
  }

  /**
   * Check if a message is an image generation result
   * Image generation messages have format: "**Prompt:** <prompt>" + image attachment
   * @param {string} content - The bot message content
   * @param {Array} attachments - Array of message attachments
   * @returns {boolean} True if this is an image generation message
   */
  isImageGenerationMessage(content, attachments) {
    // Must start with **Prompt:** (not nested in personality format)
    if (!content.startsWith('**Prompt:**')) {
      return false;
    }

    // Must have at least one image attachment
    if (!attachments || attachments.length === 0) {
      return false;
    }

    // Check if any attachment is an image
    const validImageTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    const hasImageAttachment = attachments.some(att =>
      att.contentType && validImageTypes.includes(att.contentType)
    );

    return hasImageAttachment;
  }

  /**
   * Extract the original prompt from an image generation message
   * @param {string} content - The bot message content
   * @returns {string|null} The original prompt or null if not found
   */
  extractOriginalPrompt(content) {
    // Match "**Prompt:** <text>" format
    const match = content.match(/^\*\*Prompt:\*\*\s*(.+?)(?:\n|$)/);
    if (!match) {
      return null;
    }
    return match[1].trim();
  }

  /**
   * Handle a reply to an image generation message (regeneration with feedback)
   * @param {Message} message - The user's reply message with feedback
   * @param {string} originalPrompt - The original image prompt
   */
  async handleImageReply(message, originalPrompt) {
    return withSpan('discord.reply.image_regeneration', {
      [DISCORD.CHANNEL_ID]: message.channel.id,
      'image.original_prompt': originalPrompt,
    }, async (span) => {
      const userFeedback = message.content;

      // Show typing indicator
      await message.channel.sendTyping();

      try {
        // Use AI to combine original prompt with user feedback
        let enhancedPrompt = await this._enhancePromptWithFeedback(originalPrompt, userFeedback);

        // Strip any aspect ratio directives the AI may have included despite instructions
        // (e.g. "in 3:2 aspect ratio") to avoid conflicting with generateImage's own ratio handling
        enhancedPrompt = enhancedPrompt
          .replace(/\b(?:in|at|with)?\s*\d+:\d+\s*(?:aspect\s*ratio|format|dimensions?|ratio)?\b/gi, '')
          .replace(/\b(?:aspect\s*ratio|dimensions?)\s*(?:of|:)?\s*\d+:\d+\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim();

        span.setAttribute('image.enhanced_prompt', enhancedPrompt);

        logger.info(`Enhanced prompt: "${enhancedPrompt}"`);

        // Check if user is an admin (for premium model access)
        const isAdmin = this.config.discord?.adminUserIds?.includes(message.author.id) || false;

        // Generate new image with enhanced prompt
        const result = await this.imagenService.generateImage(
          enhancedPrompt,
          { isAdmin },
          { id: message.author.id, tag: message.author.tag || message.author.username }
        );

        if (!result.success) {
          span.setAttributes({
            [ERROR.TYPE]: 'image_generation_failed',
            [ERROR.MESSAGE]: result.error,
          });
          await message.reply({
            content: `Failed to regenerate image: ${result.error}`,
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        // Get file extension from MIME type
        const extension = this._getImageExtension(result.mimeType);
        const filename = `regenerated_${Date.now()}.${extension}`;

        // Create attachment
        const attachment = new AttachmentBuilder(result.buffer, {
          name: filename,
          description: enhancedPrompt.substring(0, 100)
        });

        // Send regenerated image
        await message.reply({
          content: `**Prompt:** ${enhancedPrompt}`,
          files: [attachment],
          allowedMentions: { repliedUser: false }
        });

        logger.info(`Regenerated image for ${message.author.tag || message.author.username}`);

      } catch (error) {
        logger.error(`Error handling image reply: ${error.message}`);
        span.setAttributes({
          [ERROR.TYPE]: error.name || 'Error',
          [ERROR.MESSAGE]: error.message,
        });
        await message.reply({
          content: `Sorry, I encountered an error while processing your image request: ${error.message}`,
          allowedMentions: { repliedUser: false }
        });
      }
    });
  }

  /**
   * Enhance an image prompt with user feedback using AI
   * @param {string} originalPrompt - The original image prompt
   * @param {string} userFeedback - User's feedback/modification request
   * @returns {Promise<string>} Enhanced prompt
   * @private
   */
  async _enhancePromptWithFeedback(originalPrompt, userFeedback) {
    const systemPrompt = `You are an expert at crafting image generation prompts. Your task is to take an original image generation prompt and user feedback, then create an improved prompt that incorporates the requested changes.

Rules:
- Keep the enhanced prompt concise (under 200 words)
- Preserve the core subject and style of the original prompt unless the user specifically asks to change it
- Incorporate the user's feedback naturally
- Output ONLY the new prompt text, nothing else - no explanations, no quotation marks, no prefixes
- Maintain image generation best practices (clear descriptions, style cues, composition hints)
- Do NOT include any aspect ratio instructions or dimensions (e.g. "16:9", "3:2", "square") - aspect ratio is handled separately`;

    const userInput = `Original prompt: "${originalPrompt}"

User feedback: "${userFeedback}"

Create an enhanced prompt that incorporates this feedback:`;

    const model = this.config.openai.model || DEFAULT_OPENAI_MODEL;
    const response = await this.openaiClient.responses.create({
      model,
      instructions: systemPrompt,
      input: userInput,
      ...reasoningParams(model, 'none'),
    });

    return response.output_text.trim();
  }

  /**
   * Get file extension from MIME type
   * @param {string} mimeType - The MIME type
   * @returns {string} File extension
   * @private
   */
  _getImageExtension(mimeType) {
    const extensions = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp'
    };
    return extensions[mimeType] || 'png';
  }

  /**
   * Handle a reply to a summarization message (follow-up question about an article)
   * @param {Message} message - The user's reply message
   * @param {string} originalContent - The original bot message content
   */
  async handleSummarizationReply(message, originalContent) {
    return withSpan('discord.reply.summarization_followup', {
      [DISCORD.CHANNEL_ID]: message.channel.id,
      [SUMMARIZATION.IS_FOLLOW_UP]: true,
    }, async (span) => {
      const userQuestion = message.content;
      const articleUrl = this.extractArticleUrl(originalContent);
      const summaryText = this.extractSummaryText(originalContent);

      span.setAttributes({
        [SUMMARIZATION.ARTICLE_URL]: articleUrl || 'unknown',
        [SUMMARIZATION.CONTENT_LENGTH]: summaryText.length,
      });

      // Show typing indicator
      await message.channel.sendTyping();

      // Build context for the follow-up question
      const systemPrompt = `You are a helpful assistant that answers follow-up questions about articles that have been summarized. Be concise and informative.

Here is the context from a previously summarized article:
${summaryText}

${articleUrl ? `Original article URL: ${articleUrl}` : ''}

Answer the user's follow-up question based on the summary provided. If the question cannot be answered from the summary alone, acknowledge this and provide what insight you can. Keep responses focused and under 500 words.`;

      try {
        const model = this.config.openai.model || DEFAULT_OPENAI_MODEL;
        const response = await this.openaiClient.responses.create({
          model,
          instructions: systemPrompt,
          input: userQuestion,
          ...reasoningParams(model, 'low'),
        });

        const answer = response.output_text;

        // Add token usage to span
        span.setAttributes({
          'gen_ai.usage.input_tokens': response.usage?.input_tokens || 0,
          'gen_ai.usage.output_tokens': response.usage?.output_tokens || 0,
        });

        // Record token usage
        if (this.summarizationService?.mongoService) {
          await this.summarizationService.mongoService.recordTokenUsage(
            message.author.id,
            message.author.tag || message.author.username,
            response.usage?.input_tokens || 0,
            response.usage?.output_tokens || 0,
            'summarize_followup',
            model
          );
        }

        // Format and send response with URL wrapping
        const formattedResponse = TextUtils.wrapUrls(`**Follow-up Answer:**\n\n${answer}`);

        if (formattedResponse.length > 2000) {
          const chunks = this.splitMessage(formattedResponse, 2000);
          for (const chunk of chunks) {
            await message.channel.send(chunk);
          }
        } else {
          await message.reply({
            content: formattedResponse,
            allowedMentions: { repliedUser: false }
          });
        }

      } catch (error) {
        logger.error(`Error handling summarization follow-up: ${error.message}`);
        span.setAttributes({
          [ERROR.TYPE]: error.name || 'Error',
          [ERROR.MESSAGE]: error.message,
        });
        await message.reply({
          content: 'Sorry, I encountered an error while processing your question.',
          allowedMentions: { repliedUser: false }
        });
      }
    });
  }

  /**
   * Split a long message into chunks
   * @param {string} text - Text to split
   * @param {number} maxLength - Maximum length per chunk
   * @returns {Array<string>} Array of chunks
   */
  splitMessage(text, maxLength) {
    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point
      let breakPoint = remaining.lastIndexOf('\n', maxLength);
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = maxLength;
      }

      chunks.push(remaining.substring(0, breakPoint));
      remaining = remaining.substring(breakPoint).trim();
    }

    return chunks;
  }
}

module.exports = ReplyHandler;
