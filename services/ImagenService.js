// services/ImagenService.js
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const logger = require('../logger');
const { withSpan } = require('../tracing');

// Valid aspect ratios supported by Gemini image generation
const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

// Supported image extensions for reference images (GIF not supported by Gemini)
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

// Map file extensions to MIME types
const EXTENSION_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

// Discord CDN base URLs
const DISCORD_EMOJI_CDN = 'https://cdn.discordapp.com/emojis';
const DISCORD_STICKER_CDN = 'https://cdn.discordapp.com/stickers';

// Regex patterns for Discord custom emojis
// Standard emoji: <:name:id>
// Animated emoji: <a:name:id>
const DISCORD_EMOJI_REGEX = /^<(a)?:(\w+):(\d+)>$/;

// Discord snowflake IDs are 17-19 digit numbers
const DISCORD_SNOWFLAKE_REGEX = /^\d{17,19}$/;

class ImagenService {
  constructor(config, mongoService = null) {
    this.config = config;
    this.mongoService = mongoService;

    // Validate configuration
    if (!config.imagen.enabled) {
      throw new Error('Image generation is disabled');
    }

    if (!config.imagen.apiKey) {
      throw new Error('GEMINI_API_KEY is required for image generation');
    }

    // Initialize the unified Google GenAI client. Unlike the legacy SDK, the
    // model is selected per-call in generateImage() — there is no pre-bound
    // model object, so we just track the model name strings here.
    this.client = new GoogleGenAI({ apiKey: config.imagen.apiKey });
    this.modelName = config.imagen.model;

    // Track the admin (premium) model name if configured.
    this.adminModelName = config.imagen.adminModel || null;
    if (this.adminModelName) {
      logger.info(`ImagenService admin model configured: ${this.adminModelName}`);
    }

    // Cooldown tracking: Map of userId -> timestamp when cooldown expires
    this.cooldowns = new Map();

    logger.info(`ImagenService initialized with model: ${config.imagen.model}`);
  }

  /**
   * Get the appropriate model for a request based on admin status
   * @param {boolean} isAdmin - Whether the requesting user is an admin
   * @returns {{modelName: string}}
   */
  getModelForRequest(isAdmin) {
    if (isAdmin && this.adminModelName) {
      return { modelName: this.adminModelName };
    }
    return { modelName: this.modelName };
  }

  /**
   * Validate a prompt before generation
   * @param {string} prompt - The prompt to validate
   * @returns {{valid: boolean, error?: string}}
   */
  validatePrompt(prompt) {
    if (!prompt || prompt.trim().length === 0) {
      return { valid: false, error: 'Prompt cannot be empty' };
    }

    const trimmedPrompt = prompt.trim();
    const maxLength = this.config.imagen.maxPromptLength;

    if (trimmedPrompt.length > maxLength) {
      return {
        valid: false,
        error: `Prompt exceeds maximum length of ${maxLength} characters (current: ${trimmedPrompt.length})`
      };
    }

    return { valid: true };
  }

  /**
   * Validate an aspect ratio
   * @param {string} aspectRatio - The aspect ratio to validate
   * @returns {{valid: boolean, error?: string}}
   */
  validateAspectRatio(aspectRatio) {
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
      return {
        valid: false,
        error: `Invalid aspect ratio: ${aspectRatio}. Valid options: ${VALID_ASPECT_RATIOS.join(', ')}`
      };
    }

    return { valid: true };
  }

  // ==================== DISCORD EMOJI/STICKER SUPPORT ====================

  /**
   * Parse a Discord custom emoji string
   * @param {string} str - String to parse (e.g., "<:blobsad:396521773144866826>")
   * @returns {{name: string, id: string, animated: boolean}|null} Parsed emoji info or null
   */
  parseDiscordEmoji(str) {
    if (!str || typeof str !== 'string') return null;

    const match = str.match(DISCORD_EMOJI_REGEX);
    if (!match) return null;

    return {
      name: match[2],
      id: match[3],
      animated: match[1] === 'a'
    };
  }

  /**
   * Check if a string is a valid Discord snowflake ID (emoji/sticker ID)
   * @param {string} str - String to check
   * @returns {boolean} True if it's a valid snowflake ID
   */
  isDiscordEmojiId(str) {
    if (!str || typeof str !== 'string') return false;
    return DISCORD_SNOWFLAKE_REGEX.test(str);
  }

  /**
   * Generate Discord CDN URL for an emoji
   * @param {string} emojiId - Discord emoji ID
   * @param {boolean} animated - Whether the emoji is animated
   * @returns {string} CDN URL for the emoji
   */
  getDiscordEmojiUrl(emojiId, animated = false) {
    const ext = animated ? 'gif' : 'png';
    return `${DISCORD_EMOJI_CDN}/${emojiId}.${ext}?size=256`;
  }

  /**
   * Generate Discord CDN URL for a sticker
   * @param {string} stickerId - Discord sticker ID
   * @returns {string} CDN URL for the sticker
   */
  getDiscordStickerUrl(stickerId) {
    return `${DISCORD_STICKER_CDN}/${stickerId}.png?size=320`;
  }

  /**
   * Extract Discord CDN URL from emoji format or raw ID
   * @param {string} str - Emoji string (<:name:id>) or raw ID
   * @returns {string|null} CDN URL or null if not a Discord asset or if animated (GIF not supported)
   */
  extractDiscordAssetUrl(str) {
    if (!str || typeof str !== 'string') return null;

    // Try parsing as custom emoji format first
    const emoji = this.parseDiscordEmoji(str);
    if (emoji) {
      // Skip animated emojis - GIF MIME type not supported by Gemini
      if (emoji.animated) {
        return null;
      }
      return this.getDiscordEmojiUrl(emoji.id, false);
    }

    // Try as raw snowflake ID (assume it's an emoji, PNG format)
    if (this.isDiscordEmojiId(str)) {
      return this.getDiscordEmojiUrl(str, false);
    }

    return null;
  }

  // ==================== IMAGE URL SUPPORT ====================

  /**
   * Check if a string is a URL pointing to an image
   * @param {string} str - String to check
   * @returns {boolean} True if it's an image URL
   */
  isImageUrl(str) {
    if (!str || typeof str !== 'string') return false;

    try {
      const url = new URL(str);
      const pathname = url.pathname.toLowerCase();
      return IMAGE_EXTENSIONS.some(ext => pathname.endsWith(ext));
    } catch {
      return false;
    }
  }

  /**
   * Get MIME type from URL extension
   * @param {string} url - Image URL
   * @returns {string} MIME type
   */
  getMimeTypeFromUrl(url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      for (const [ext, mime] of Object.entries(EXTENSION_TO_MIME)) {
        if (pathname.endsWith(ext)) {
          return mime;
        }
      }
    } catch {
      // Ignore URL parsing errors
    }
    return 'image/png'; // Default fallback
  }

  /**
   * Fetch an image from a URL and return it as base64
   * @param {string} imageUrl - URL of the image to fetch
   * @returns {Promise<{success: boolean, data?: string, mimeType?: string, error?: string}>}
   */
  async fetchImageAsBase64(imageUrl) {
    try {
      logger.debug(`Fetching reference image from: ${imageUrl}`);

      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000, // 30 second timeout
        maxContentLength: 10 * 1024 * 1024, // 10MB max
        headers: {
          'User-Agent': 'Discord-Article-Bot/1.0'
        }
      });

      // Get MIME type from headers
      let mimeType = response.headers['content-type'];

      // If content-type is missing or not an image, try to infer from URL
      if (!mimeType || !mimeType.startsWith('image/')) {
        // Check if URL has a known image extension
        if (this.isImageUrl(imageUrl)) {
          mimeType = this.getMimeTypeFromUrl(imageUrl);
        }
      }

      // Validate it's actually an image
      if (!mimeType || !mimeType.startsWith('image/')) {
        return {
          success: false,
          error: `URL does not point to a valid image (content-type: ${response.headers['content-type'] || 'unknown'})`
        };
      }

      // Convert to base64
      const buffer = Buffer.from(response.data);
      const base64Data = buffer.toString('base64');

      logger.debug(`Successfully fetched image: ${mimeType}, ${buffer.length} bytes`);

      return {
        success: true,
        data: base64Data,
        mimeType
      };

    } catch (error) {
      logger.error(`Failed to fetch reference image: ${error.message}`);
      return {
        success: false,
        error: `Failed to fetch reference image: ${error.message}`
      };
    }
  }

  /**
   * Generate an image from a text prompt
   * @param {string} prompt - Text description of the desired image
   * @param {Object} options - Generation options
   * @param {string} options.aspectRatio - Aspect ratio (default: config default)
   * @param {string} options.referenceImageUrl - URL of a reference image (optional)
   * @param {Object} user - Discord user object for tracking
   * @returns {Promise<{success: boolean, buffer?: Buffer, mimeType?: string, error?: string, prompt?: string}>}
   */
  async generateImage(prompt, options = {}, user = null) {
    // Validate prompt
    const promptValidation = this.validatePrompt(prompt);
    if (!promptValidation.valid) {
      return { success: false, error: promptValidation.error };
    }

    // Validate and set aspect ratio
    const aspectRatio = options.aspectRatio || this.config.imagen.defaultAspectRatio;
    const ratioValidation = this.validateAspectRatio(aspectRatio);
    if (!ratioValidation.valid) {
      return { success: false, error: ratioValidation.error };
    }

    const trimmedPrompt = prompt.trim();

    // Fetch reference image if provided
    let referenceImage = null;
    if (options.referenceImageUrl) {
      const fetchResult = await this.fetchImageAsBase64(options.referenceImageUrl);
      if (!fetchResult.success) {
        return { success: false, error: fetchResult.error };
      }
      referenceImage = fetchResult;
      logger.info(`Using reference image from: ${options.referenceImageUrl}`);
    }

    // Select model based on admin status
    const isAdmin = options.isAdmin || false;
    const { modelName } = this.getModelForRequest(isAdmin);

    if (isAdmin && this.adminModelName) {
      logger.info(`Using admin model for user ${user?.id}: ${modelName}`);
    }

    try {
      logger.info(`Generating image for prompt: "${trimmedPrompt}" with aspect ratio: ${aspectRatio}`);

      // Build the request with explicit image generation instruction and aspect ratio hint
      const enhancedPrompt = `Generate an image based on the following description. Do not respond with text, prompt suggestions, or commentary — only generate the image.\n\n${trimmedPrompt}\n\nAspect ratio: ${aspectRatio}`;

      // Build parts array - text prompt and optional reference image
      const parts = [{ text: enhancedPrompt }];

      // Add reference image if provided
      if (referenceImage) {
        parts.push({
          inlineData: {
            mimeType: referenceImage.mimeType,
            data: referenceImage.data
          }
        });
      }

      const result = await withSpan('gemini.generateContent', {
        // GenAI semantic conventions
        'gen_ai.system': 'google',
        'gen_ai.operation.name': 'image_generation',
        'gen_ai.request.model': modelName,
        // Image generation context
        'image_gen.aspect_ratio': aspectRatio,
        'image_gen.has_reference_image': !!referenceImage,
        'image_gen.prompt_length': trimmedPrompt.length,
        'image_gen.is_admin': isAdmin,
        // Discord context
        'discord.user.id': user?.id || '',
      }, async (span) => {
        const genResult = await this.client.models.generateContent({
          model: modelName,
          contents: [{
            role: 'user',
            parts
          }],
          config: {
            responseModalities: ['IMAGE']
          }
        });

        // Add response attributes (the new SDK returns the response directly,
        // with no `.response` wrapper).
        const hasImage = genResult.candidates?.[0]?.content?.parts?.some(p => p.inlineData);
        span.setAttributes({
          'gen_ai.response.has_image': hasImage,
          'gen_ai.response.finish_reason': genResult.candidates?.[0]?.finishReason || '',
        });

        return genResult;
      });

      // The unified @google/genai SDK returns the GenerateContentResponse
      // directly (the legacy SDK nested it under `result.response`).
      const response = result;

      // Check for empty response
      if (!response.candidates || response.candidates.length === 0) {
        // Log detailed information about why no candidates were returned
        logger.warn(`No candidates in image generation response - prompt: "${trimmedPrompt}", aspectRatio: ${aspectRatio}`);

        // Check promptFeedback for block reasons (common when safety filters trigger)
        if (response.promptFeedback) {
          const feedback = response.promptFeedback;
          const safetyInfo = feedback.safetyRatings?.map(r =>
            `${r.category}: ${r.probability}${r.blocked ? ' (BLOCKED)' : ''}`
          ).join(', ') || 'none';
          logger.warn(`Prompt feedback from Gemini - blockReason: ${feedback.blockReason || 'none'}, safetyRatings: [${safetyInfo}]`);

          // Log blockReasonMessage if present (Gemini may include a human-readable explanation)
          if (feedback.blockReasonMessage) {
            logger.warn(`Prompt feedback blockReasonMessage: ${feedback.blockReasonMessage}`);
          }

          // Provide more specific error message based on block reason
          if (feedback.blockReason) {
            const blockReasonMessages = {
              'SAFETY': 'Your prompt was blocked by safety filters. Please try a different prompt.',
              'BLOCK_REASON_UNSPECIFIED': 'Your prompt was blocked for an unspecified reason. Please try a different prompt.',
              'OTHER': 'Your prompt was blocked. Please try a different prompt.',
              'BLOCKLIST': 'Your prompt contains blocked content. Please try a different prompt.',
              'PROHIBITED_CONTENT': 'Your prompt contains prohibited content. Please try a different prompt.'
            };
            const errorMsg = blockReasonMessages[feedback.blockReason] ||
              `Your prompt was blocked (reason: ${feedback.blockReason}). Please try a different prompt.`;
            return {
              success: false,
              error: errorMsg,
              failureContext: {
                type: 'safety',
                originalPrompt: trimmedPrompt,
                promptFeedback: feedback,
                details: {
                  blockReason: feedback.blockReason,
                  blockReasonMessage: feedback.blockReasonMessage || null,
                  safetyRatings: feedback.safetyRatings
                }
              }
            };
          }
        } else {
          logger.warn('No promptFeedback in response - Gemini returned empty candidates without explanation');
        }

        // Log raw response structure at debug level for troubleshooting
        logger.debug(`Full response structure (no candidates): hasPromptFeedback=${!!response.promptFeedback}, hasUsageMetadata=${!!response.usageMetadata}, responseKeys=[${Object.keys(response).join(', ')}]`);

        return {
          success: false,
          error: 'No image was generated. Please try a different prompt.',
          failureContext: {
            type: 'no_candidates',
            originalPrompt: trimmedPrompt,
            promptFeedback: response.promptFeedback || null,
            details: { hasPromptFeedback: !!response.promptFeedback }
          }
        };
      }

      const candidate = response.candidates[0];

      // Safety-related finishReasons: SAFETY, IMAGE_SAFETY, IMAGE_PROHIBITED_CONTENT
      const SAFETY_FINISH_REASONS = ['SAFETY', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT'];

      // Check for safety filter rejection
      if (SAFETY_FINISH_REASONS.includes(candidate.finishReason)) {
        const safetyInfo = candidate.safetyRatings?.map(r =>
          `${r.category}: ${r.probability}${r.blocked ? ' (BLOCKED)' : ''}`
        ).join(', ') || 'none';
        logger.warn(`Image generation blocked by safety filter - prompt: "${trimmedPrompt}", finishReason: ${candidate.finishReason}, safetyRatings: [${safetyInfo}]`);
        logger.debug(`Full candidate structure on safety rejection: ${JSON.stringify({ finishReason: candidate.finishReason, safetyRatings: candidate.safetyRatings, contentKeys: candidate.content ? Object.keys(candidate.content) : null })}`);

        // Use specific error message for prohibited content
        const errorMsg = candidate.finishReason === 'IMAGE_PROHIBITED_CONTENT'
          ? 'Your prompt contains prohibited content. Please try a different prompt.'
          : 'Your prompt was blocked by safety filters. Please try a different prompt.';

        return {
          success: false,
          error: errorMsg,
          failureContext: {
            type: 'safety',
            originalPrompt: trimmedPrompt,
            details: { finishReason: candidate.finishReason, safetyRatings: candidate.safetyRatings }
          }
        };
      }

      // Handle NO_IMAGE finishReason - model was unable to generate an image from the prompt
      if (candidate.finishReason === 'NO_IMAGE') {
        logger.warn(`Image generation returned NO_IMAGE - prompt: "${trimmedPrompt}", finishReason: ${candidate.finishReason}`);
        logger.debug(`Full candidate structure on NO_IMAGE: ${JSON.stringify({ finishReason: candidate.finishReason, safetyRatings: candidate.safetyRatings, contentKeys: candidate.content ? Object.keys(candidate.content) : null })}`);
        return {
          success: false,
          error: 'The model was unable to generate an image from this prompt. Try simplifying or rephrasing it.',
          failureContext: {
            type: 'no_image',
            originalPrompt: trimmedPrompt,
            details: { finishReason: candidate.finishReason, safetyRatings: candidate.safetyRatings || null }
          }
        };
      }

      // Log other non-STOP finish reasons for debugging
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        logger.warn(`Unexpected finish reason in image generation - prompt: "${trimmedPrompt}", finishReason: ${candidate.finishReason}`);
      }

      // Extract image data from response
      const content = candidate.content;
      if (!content || !content.parts) {
        logger.warn(`No content parts in image generation response - prompt: "${trimmedPrompt}", hasContent: ${!!content}, finishReason: ${candidate.finishReason}`);

        // If finishReason indicates safety, treat as safety rejection even without content
        if (SAFETY_FINISH_REASONS.includes(candidate.finishReason)) {
          return {
            success: false,
            error: 'Your prompt was blocked by safety filters. Please try a different prompt.',
            failureContext: {
              type: 'safety',
              originalPrompt: trimmedPrompt,
              details: { hasContent: !!content, finishReason: candidate.finishReason }
            }
          };
        }

        return {
          success: false,
          error: 'No image was generated. Please try a different prompt.',
          failureContext: {
            type: 'no_candidates',
            originalPrompt: trimmedPrompt,
            details: { hasContent: !!content, finishReason: candidate.finishReason }
          }
        };
      }

      // Find the image part in the response
      const imagePart = content.parts.find(part => part.inlineData);
      if (!imagePart) {
        // Check if there's a text response explaining why no image was generated
        const textPart = content.parts.find(part => part.text);
        const partTypes = content.parts.map(p => Object.keys(p).join(',')).join('; ');
        if (textPart) {
          const safetyInfo = candidate.safetyRatings?.map(r =>
            `${r.category}: ${r.probability}${r.blocked ? ' (BLOCKED)' : ''}`
          ).join(', ') || 'none';
          logger.warn(`Image generation returned text instead of image - prompt: "${trimmedPrompt}", finishReason: ${candidate.finishReason || 'none'}, safetyRatings: [${safetyInfo}], partsCount: ${content.parts.length}, partTypes: [${partTypes}]`);
          logger.warn(`Full text response from model:\n${textPart.text}`);
          logger.debug(`Full candidate structure on text response: ${JSON.stringify({ finishReason: candidate.finishReason, safetyRatings: candidate.safetyRatings, partTypes, partsCount: content.parts.length })}`);
          return {
            success: false,
            error: 'No image was generated. Please try a different prompt.',
            failureContext: {
              type: 'text_response',
              originalPrompt: trimmedPrompt,
              textResponse: textPart.text,
              details: { partTypes, partsCount: content.parts.length, finishReason: candidate.finishReason || null }
            }
          };
        } else {
          logger.warn(`No image data in response parts - prompt: "${trimmedPrompt}", finishReason: ${candidate.finishReason || 'none'}, partsCount: ${content.parts.length}, partTypes: [${partTypes}]`);
        }
        return {
          success: false,
          error: 'No image was generated. Please try a different prompt.',
          failureContext: {
            type: 'no_candidates',
            originalPrompt: trimmedPrompt,
            details: { partTypes, partsCount: content.parts.length }
          }
        };
      }

      // Decode base64 image data
      const { mimeType, data } = imagePart.inlineData;
      const buffer = Buffer.from(data, 'base64');

      logger.info(`Image generated successfully: ${mimeType}, ${buffer.length} bytes`);

      // Set cooldown for user if provided
      if (user) {
        this.setCooldown(user.id);
      }

      // Record successful generation in MongoDB
      if (this.mongoService && user) {
        await this.mongoService.recordImageGeneration(
          user.id,
          user.tag || user.username,
          trimmedPrompt,
          aspectRatio,
          modelName,
          true,
          null,
          buffer.length
        );
      }

      return {
        success: true,
        buffer,
        mimeType,
        prompt: trimmedPrompt
      };

    } catch (error) {
      logger.error(`Image generation error: ${error.message}`);

      let errorMessage;
      let failureType = 'unknown';

      // Handle specific error types
      if (error.message.includes('rate limit') || error.message.includes('quota')) {
        errorMessage = 'API rate limit exceeded. Please try again later.';
        failureType = 'rate_limit';
      } else if (error.message.includes('safety') || error.message.includes('blocked')) {
        errorMessage = 'Your prompt was blocked by safety filters. Please try a different prompt.';
        failureType = 'safety';
      } else {
        errorMessage = `Image generation failed: ${error.message}`;
      }

      // Record failed generation in MongoDB
      if (this.mongoService && user) {
        await this.mongoService.recordImageGeneration(
          user.id,
          user.tag || user.username,
          trimmedPrompt,
          aspectRatio,
          modelName,
          false,
          errorMessage,
          0
        );
      }

      return {
        success: false,
        error: errorMessage,
        failureContext: {
          type: failureType,
          originalPrompt: trimmedPrompt,
          details: { errorMessage: error.message }
        }
      };
    }
  }

  /**
   * Set cooldown for a user
   * @param {string} userId - The user's ID
   */
  setCooldown(userId) {
    const cooldownMs = this.config.imagen.cooldownSeconds * 1000;
    this.cooldowns.set(userId, Date.now() + cooldownMs);
  }

  /**
   * Check if a user is on cooldown
   * @param {string} userId - The user's ID
   * @returns {boolean}
   */
  isOnCooldown(userId) {
    const expiresAt = this.cooldowns.get(userId);
    if (!expiresAt) return false;

    if (Date.now() >= expiresAt) {
      this.cooldowns.delete(userId);
      return false;
    }

    return true;
  }

  /**
   * Get remaining cooldown time for a user
   * @param {string} userId - The user's ID
   * @returns {number} Remaining seconds, or 0 if not on cooldown
   */
  getRemainingCooldown(userId) {
    const expiresAt = this.cooldowns.get(userId);
    if (!expiresAt) return 0;

    const remaining = Math.ceil((expiresAt - Date.now()) / 1000);
    return Math.max(0, remaining);
  }

  /**
   * Get list of valid aspect ratios
   * @returns {string[]}
   */
  getValidAspectRatios() {
    return [...VALID_ASPECT_RATIOS];
  }
}

module.exports = ImagenService;
