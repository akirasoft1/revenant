// services/ImagePromptAnalyzerService.js
// Analyzes failed image generation prompts and suggests improvements

const logger = require('../logger');
const { DEFAULT_OPENAI_MODEL, reasoningParams } = require('../utils/openaiModels');
const { withSpan } = require('../tracing');
const { ERROR } = require('../tracing-attributes');

// Failure type colors for Discord embeds
const FAILURE_COLORS = {
  safety: 0xED4245,      // Red - safety/content issues
  rate_limit: 0xFEE75C,  // Yellow - temporary issue
  no_candidates: 0x5865F2, // Blurple - unclear issue
  no_image: 0xF0B232,      // Orange - prompt too complex
  text_response: 0xEB459E, // Pink - model misunderstanding
  unknown: 0x95A5A6       // Grey - unknown
};

// Failure type titles for user display
const FAILURE_TITLES = {
  safety: 'Safety Filter Blocked',
  rate_limit: 'Rate Limit Reached',
  no_candidates: 'No Image Generated',
  no_image: 'Unable to Generate Image',
  text_response: 'Model Returned Text',
  unknown: 'Generation Failed'
};

class ImagePromptAnalyzerService {
  /**
   * Initialize ImagePromptAnalyzerService
   * @param {Object} openaiClient - OpenAI client for analysis
   * @param {Object} config - Application configuration
   * @param {Object} mongoService - MongoDB service for storing analyses (optional)
   */
  constructor(openaiClient, config, mongoService = null) {
    this.openaiClient = openaiClient;
    this.config = config;
    this.mongoService = mongoService;

    logger.info('ImagePromptAnalyzerService initialized');
  }

  /**
   * Check if the service is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return !!this.openaiClient;
  }

  /**
   * Analyze a failed image generation prompt and suggest improvements
   * @param {string} originalPrompt - The original prompt that failed
   * @param {string} failureReason - The error message from the generation attempt
   * @param {Object} failureContext - Additional context about the failure
   * @param {string} failureContext.type - Type of failure (safety, rate_limit, etc.)
   * @param {Object} failureContext.details - Additional failure details
   * @param {string} failureContext.textResponse - Text returned by model (if applicable)
   * @returns {Promise<Object>} Analysis result with suggestions
   */
  async analyzeFailedPrompt(originalPrompt, failureReason, failureContext = {}) {
    return withSpan('image_analyzer.analyze', {
      'image_analyzer.failure_type': failureContext.type || 'unknown',
      'image_analyzer.prompt_length': originalPrompt?.length || 0,
    }, async (span) => {
      try {
        const failureType = failureContext.type || this.categorizeFailure(failureReason);
        span.setAttribute('image_analyzer.categorized_type', failureType);

        // Build the analysis prompt
        const analysisPrompt = this._buildAnalysisPrompt(originalPrompt, failureReason, failureContext, failureType);

        // Call OpenAI to analyze the failure
        const model = this.config.openai.model || DEFAULT_OPENAI_MODEL;
        const response = await this.openaiClient.responses.create({
          model,
          ...reasoningParams(model, 'low'),
          instructions: `You are an image generation expert. Analyze why image generation prompts fail and suggest improvements.

Your task is to:
1. Identify why the prompt failed based on the error and context provided
2. Provide a brief, helpful analysis (2-3 sentences)
3. Suggest 2-3 improved prompts that would be more likely to succeed

Respond with valid JSON in this exact format:
{
  "failureType": "safety|rate_limit|no_candidates|no_image|text_response|unknown",
  "analysis": "Brief explanation of why the prompt failed",
  "suggestions": ["List of general tips to improve the prompt"],
  "suggestedPrompts": ["Specific reworded prompts that might work"],
  "confidence": 0.0-1.0
}

For safety filter issues, suggest artistic alternatives that avoid restricted content.
For unclear prompts, suggest more specific and descriptive alternatives.
Keep suggested prompts under 200 characters each.`,
          input: analysisPrompt
        });

        // Parse the response
        const analysisResult = this._parseAnalysisResponse(response.output_text, failureType);
        span.setAttribute('image_analyzer.suggestions_count', analysisResult.suggestedPrompts?.length || 0);

        return analysisResult;

      } catch (error) {
        span.setAttributes({
          [ERROR.TYPE]: error.name || 'AnalysisError',
          [ERROR.MESSAGE]: error.message,
        });
        logger.error(`Error analyzing failed prompt: ${error.message}`);

        return {
          failureType: failureContext.type || 'unknown',
          analysis: `Unable to analyze the prompt failure: ${error.message}`,
          suggestions: [],
          suggestedPrompts: [],
          confidence: 0,
          error: error.message
        };
      }
    });
  }

  /**
   * Build the analysis prompt for OpenAI
   * @private
   */
  _buildAnalysisPrompt(originalPrompt, failureReason, failureContext, failureType) {
    let prompt = `Analyze this failed image generation attempt:

**Original Prompt:** "${originalPrompt}"
**Error Message:** "${failureReason}"
**Failure Type:** ${failureType}`;

    if (failureContext.textResponse) {
      prompt += `\n**Model Response (text instead of image):** "${failureContext.textResponse}"`;
    }

    if (failureContext.details) {
      prompt += `\n**Additional Context:** ${JSON.stringify(failureContext.details)}`;
    }

    return prompt;
  }

  /**
   * Parse the analysis response from OpenAI
   * @private
   */
  _parseAnalysisResponse(responseText, fallbackType) {
    try {
      // Try to parse as JSON
      const parsed = JSON.parse(responseText);

      // Limit suggested prompts to 3
      if (parsed.suggestedPrompts && parsed.suggestedPrompts.length > 3) {
        parsed.suggestedPrompts = parsed.suggestedPrompts.slice(0, 3);
      }

      return {
        failureType: parsed.failureType || fallbackType,
        analysis: parsed.analysis || 'Analysis unavailable',
        suggestions: parsed.suggestions || [],
        suggestedPrompts: parsed.suggestedPrompts || [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5
      };
    } catch (e) {
      // If not JSON, try to extract useful information from plain text
      logger.debug(`Analysis response was not JSON, extracting from text`);

      return {
        failureType: fallbackType,
        analysis: responseText.substring(0, 500),
        suggestions: [],
        suggestedPrompts: [],
        confidence: 0.3
      };
    }
  }

  /**
   * Categorize a failure based on the error message
   * @param {string} errorMessage - The error message from the failed generation
   * @returns {string} Failure type category
   */
  categorizeFailure(errorMessage) {
    if (!errorMessage) return 'unknown';

    const lowerMessage = errorMessage.toLowerCase();

    if (lowerMessage.includes('safety') ||
        lowerMessage.includes('blocked') ||
        lowerMessage.includes('content policy')) {
      return 'safety';
    }

    if (lowerMessage.includes('rate limit') ||
        lowerMessage.includes('too many requests') ||
        lowerMessage.includes('quota')) {
      return 'rate_limit';
    }

    if (lowerMessage.includes('no image was generated') ||
        lowerMessage.includes('no candidates') ||
        lowerMessage.includes('empty candidates')) {
      return 'no_candidates';
    }

    if (lowerMessage.includes('text instead') ||
        lowerMessage.includes('model returned text')) {
      return 'text_response';
    }

    return 'unknown';
  }

  /**
   * Record a failure analysis to MongoDB
   * @param {string} originalPrompt - The original failed prompt
   * @param {Object} analysis - The analysis result
   * @param {string} userId - Discord user ID
   * @param {string} channelId - Discord channel ID
   * @param {Object} metadata - Additional metadata (guildId, username)
   * @returns {Promise<{success: boolean, id?: string, error?: string}>}
   */
  async recordFailureAnalysis(originalPrompt, analysis, userId, channelId, metadata = {}) {
    if (!this.mongoService) {
      return { success: false, error: 'MongoDB not available' };
    }

    try {
      const collection = this.mongoService.db.collection('image_failure_analyses');

      const doc = {
        originalPrompt,
        failureType: analysis.failureType,
        analysis: analysis.analysis,
        suggestedPrompts: analysis.suggestedPrompts,
        confidence: analysis.confidence,
        userId,
        channelId,
        guildId: metadata.guildId,
        username: metadata.username,
        timestamp: new Date(),
        retryAttempted: false,
        retryPrompt: null,
        retrySuccess: null
      };

      const result = await collection.insertOne(doc);

      return { success: true, id: result.insertedId.toString() };
    } catch (error) {
      logger.error(`Error recording failure analysis: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update a failure analysis record with retry information
   * @param {string} analysisId - The analysis document ID
   * @param {string} retryPrompt - The prompt used for retry
   * @param {boolean} retrySuccess - Whether the retry was successful
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async updateRetryAttempt(analysisId, retryPrompt, retrySuccess) {
    if (!this.mongoService) {
      return { success: false, error: 'MongoDB not available' };
    }

    try {
      const collection = this.mongoService.db.collection('image_failure_analyses');

      await collection.updateOne(
        { _id: analysisId },
        {
          $set: {
            retryAttempted: true,
            retryPrompt,
            retrySuccess,
            retryTimestamp: new Date()
          }
        }
      );

      return { success: true };
    } catch (error) {
      logger.error(`Error updating retry attempt: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Format an analysis result for a Discord embed
   * @param {Object} analysis - The analysis result
   * @returns {Object} Discord embed-compatible object
   */
  formatAnalysisForEmbed(analysis) {
    const color = FAILURE_COLORS[analysis.failureType] || FAILURE_COLORS.unknown;
    const title = FAILURE_TITLES[analysis.failureType] || FAILURE_TITLES.unknown;

    const fields = [
      {
        name: 'Analysis',
        value: analysis.analysis?.substring(0, 1000) || 'No analysis available',
        inline: false
      }
    ];

    // Add suggestions if available
    if (analysis.suggestions && analysis.suggestions.length > 0) {
      fields.push({
        name: 'Tips',
        value: analysis.suggestions.slice(0, 3).map(s => `• ${s}`).join('\n').substring(0, 1000),
        inline: false
      });
    }

    // Add suggested prompts with number emojis
    if (analysis.suggestedPrompts && analysis.suggestedPrompts.length > 0) {
      const numberEmojis = ['1️⃣', '2️⃣', '3️⃣'];
      const formattedSuggestions = analysis.suggestedPrompts
        .slice(0, 3)
        .map((prompt, i) => `${numberEmojis[i]} ${prompt}`)
        .join('\n\n');

      fields.push({
        name: 'Suggested Prompts (React to retry)',
        value: formattedSuggestions.substring(0, 1000),
        inline: false
      });
    }

    // Add confidence indicator
    if (typeof analysis.confidence === 'number') {
      const confidenceBar = this._createConfidenceBar(analysis.confidence);
      fields.push({
        name: 'Confidence',
        value: confidenceBar,
        inline: true
      });
    }

    return {
      title: `Image Generation: ${title}`,
      description: 'I analyzed why your image generation failed and have some suggestions.',
      color,
      fields,
      footer: {
        text: 'React with a number to retry with that prompt, or ❌ to dismiss'
      }
    };
  }

  /**
   * Create a visual confidence bar
   * @private
   */
  _createConfidenceBar(confidence) {
    const filled = Math.round(confidence * 10);
    const empty = 10 - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${Math.round(confidence * 100)}%`;
  }
}

module.exports = ImagePromptAnalyzerService;
