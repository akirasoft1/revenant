// ===== services/SummarizationService.js =====
const axios = require('axios');
const logger = require('../logger');
const { DEFAULT_OPENAI_MODEL, reasoningParams } = require('../utils/openaiModels');
const UrlUtils = require('../utils/urlUtils');
const TokenService = require('./TokenService');
const CostService = require('./CostService');
const ResponseParser = require('./ResponseParser');
const TextUtils = require('../utils/textUtils');
const MongoService = require('./MongoService');
const SourceCredibilityService = require('./SourceCredibilityService');
const { withSpan, addSpanEvent, setSpanAttributes } = require('../tracing');

class SummarizationService {
  constructor(openaiClient, config, discordClient, messageService = null, mongoService = null) {
    this.openaiClient = openaiClient;
    this.config = config;
    this.discordClient = discordClient;
    this.messageService = messageService;
    this.systemPrompt = null;
    this.isProcessing = false;
    this.mongoService = mongoService || new MongoService(config.mongo.uri);
    this.sourceCredibilityService = new SourceCredibilityService(config);
    
    // Initialize services
    this.tokenService = new TokenService();
    this.costService = new CostService();
    this.responseParser = ResponseParser;
    
    // HTTP client for fetching archive content
    this.axiosInstance = axios.create({
      timeout: 30000,
      headers: { 'User-Agent': 'Discord-Bot/1.0' }
    });

    

    
  }

  /**
   * Model for every summarization call. The helpers below used to hardcode
   * 'gpt-5.1' (now deprecated); they follow OPENAI_MODEL so the next model
   * migration is a one-line config change.
   */
  _model() {
    return this.config?.openai?.model || DEFAULT_OPENAI_MODEL;
  }

  /**
   * Responses API params for a summarization helper call.
   * @param {string} effort - reasoning effort for this call site
   */
  _requestBase(effort) {
    const model = this._model();
    return { model, ...reasoningParams(model, effort) };
  }

  setSystemPrompt(prompt) {
    this.systemPrompt = prompt;
  }

  async processUrl(url, message, user, style = null, forceReSummarize = false, mood = null, narrator = null, historicalPerspective = null) {
    if (this.isProcessing) {
      logger.info('Already processing a URL, skipping.');
      return;
    }

    this.isProcessing = true;

    try {
      logger.info(`Processing URL: ${url}`);

      if (!forceReSummarize) {
        const existingArticle = await this.mongoService.findArticleByUrl(url);
        if (existingArticle) {
          const timeSince = new Date(existingArticle.createdAt).toLocaleDateString();
          const duplicateMessage = `This article was already shared on ${timeSince} by @${existingArticle.username}.`;
          
          if (this.messageService) {
            await this.messageService.sendMessage(message.channel, duplicateMessage);
          } else {
            await message.channel.send(duplicateMessage);
          }
          return;
        }
      }

      if (UrlUtils.shouldSkipUrl(url)) {
        logger.info(`Skipping URL (image/gif): ${url}`);
        return;
      }

      if (this.isQuestionableSource(url)) {
        logger.info(`Flagging questionable source: ${url}`);
        await message.react('⚠️');
      }

      let processedUrl = url;

      const finalUrl = await this.preprocessUrl(processedUrl, message);
      if (!finalUrl) return;

      let content = await this.fetchContent(finalUrl, message);
      if (content === false) return;

      let wasTranslated = false;
      let detectedLanguage = 'N/A';

      if (this.config.bot.autoTranslation.enabled) {
        const translationResult = await this.detectAndTranslate(content);
        content = translationResult.translatedText;
        wasTranslated = translationResult.wasTranslated;
        detectedLanguage = translationResult.detectedLanguage;
      }
      
      const result = await this.generateSummary(content, processedUrl, style, mood, narrator, historicalPerspective);
      
      if (!result) {
        const errorMessage = 'Sorry, I could not generate a summary for this article.';
        if (this.messageService) {
          await this.messageService.sendMessage(message.channel, errorMessage);
        } else {
          await message.channel.send(errorMessage);
        }
        return;
      }

      const enhancedResult = await this.enhanceSummary(result.summary, content);

      let relatedArticles = [];
      if (enhancedResult.topic) {
        relatedArticles = await this.mongoService.findRelatedArticles(enhancedResult.topic, url);
      }

      const sourceCredibility = this.sourceCredibilityService.rateSource(url);

      const responseMessage = ResponseParser.buildDiscordMessage({
        ...result,
        ...enhancedResult,
        relatedArticles,
        sourceCredibility,
        wasTranslated,
        detectedLanguage,
      });
      
      if (!responseMessage) {
        logger.error('Failed to build response message');
        const formatErrorMessage = 'Sorry, I could not format the summary properly.';
        if (this.messageService) {
          await this.messageService.sendMessage(message.channel, formatErrorMessage);
        } else {
          await message.channel.send(formatErrorMessage);
        }
        return;
      }

      await this.mongoService.persistData({
        userId: user.id,
        username: user.tag,
        url,
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
        topic: enhancedResult.topic, // Persist the topic
      });

      // Record token usage for this user
      await this.mongoService.recordTokenUsage(
        user.id,
        user.tag || user.username,
        result.tokens.input,
        result.tokens.output,
        'summarize',
        this.config.openai.model
      );

      // Check and notify for follow-ups
      if (enhancedResult.topic) {
        await this.checkAndNotifyFollowUps(url, enhancedResult.topic, result.summary);
      }
      
      if (this.messageService) {
        await this.messageService.replyToMessage(message, responseMessage, {
          allowedMentions: { repliedUser: false }
        });
      } else {
        await message.reply({
          content: responseMessage,
          allowedMentions: { repliedUser: false }
        });
      }

      

      // Extract and send quote of the day
      // const quote = await this.extractQuote(content || result.summary);
      // if (quote) {
      //   const quoteMessage = `**Key Article Quote:**\n>>> ${quote}`;
      //   if (this.messageService) {
      //     await this.messageService.sendMessage(message.channel, quoteMessage);
      //   } else {
      //     await message.channel.send(quoteMessage);
      //   }
      // }

      
    } catch (error) {
      logger.error(`Error processing URL ${url}: ${error.message}`);
      const unexpectedErrorMessage = `An unexpected error occurred while processing ${url}.`;
      if (this.messageService) {
        await this.messageService.sendMessage(message.channel, unexpectedErrorMessage);
      } else {
        await message.channel.send(unexpectedErrorMessage);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async processUrlWithContext(url, message, user, style = null, mood = null, narrator = null, historicalPerspective = null) {
    if (this.isProcessing) {
      logger.info('Already processing a URL, skipping.');
      return;
    }

    this.isProcessing = true;

    try {
      logger.info(`Processing URL with context: ${url}`);

      const existingArticle = await this.mongoService.findArticleByUrl(url);
      if (existingArticle) {
        const timeSince = new Date(existingArticle.createdAt).toLocaleDateString();
        const duplicateMessage = `This article was already shared on ${timeSince} by @${existingArticle.username}.`;
        
        if (this.messageService) {
          await this.messageService.sendMessage(message.channel, duplicateMessage);
        } else {
          await message.channel.send(duplicateMessage);
        }
        return;
      }

      if (UrlUtils.shouldSkipUrl(url)) {
        logger.info(`Skipping URL (image/gif): ${url}`);
        return;
      }

      if (this.isQuestionableSource(url)) {
        logger.info(`Flagging questionable source: ${url}`);
        await message.react('⚠️');
      }

      let processedUrl = url;

      const finalUrl = await this.preprocessUrl(processedUrl, message);
      if (!finalUrl) return;

      let content = await this.fetchContent(finalUrl, message);
      if (content === false) return;

      let wasTranslated = false;
      let detectedLanguage = 'N/A';

      if (this.config.bot.autoTranslation.enabled) {
        const translationResult = await this.detectAndTranslate(content);
        content = translationResult.translatedText;
        wasTranslated = translationResult.wasTranslated;
        detectedLanguage = translationResult.detectedLanguage;
      }
      
      const result = await this.generateSummary(content, processedUrl, style, mood, narrator, historicalPerspective);
      
      if (!result) {
        const errorMessage = 'Sorry, I could not generate a summary for this article.';
        if (this.messageService) {
          await this.messageService.sendMessage(message.channel, errorMessage);
        } else {
          await message.channel.send(errorMessage);
        }
        return;
      }

      const enhancedResult = await this.enhanceSummary(result.summary, content);

      let relatedArticles = [];
      if (enhancedResult.topic) {
        relatedArticles = await this.mongoService.findRelatedArticles(enhancedResult.topic, url);
      }

      const sourceCredibility = this.sourceCredibilityService.rateSource(url);

      // Include context for this version
      let context = null;
      if (enhancedResult.topic) {
        context = await this.provideContext(enhancedResult.topic);
      }

      const responseMessage = ResponseParser.buildDiscordMessage({
        ...result,
        ...enhancedResult,
        relatedArticles,
        sourceCredibility,
        context,
        wasTranslated,
        detectedLanguage,
      });
      
      if (!responseMessage) {
        logger.error('Failed to build response message');
        const formatErrorMessage = 'Sorry, I could not format the summary properly.';
        if (this.messageService) {
          await this.messageService.sendMessage(message.channel, formatErrorMessage);
        } else {
          await message.channel.send(formatErrorMessage);
        }
        return;
      }

      await this.mongoService.persistData({
        userId: user.id,
        username: user.tag,
        url,
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
        topic: enhancedResult.topic,
      });

      // Check and notify for follow-ups
      if (enhancedResult.topic) {
        await this.checkAndNotifyFollowUps(url, enhancedResult.topic, result.summary);
      }
      
      if (this.messageService) {
        await this.messageService.replyToMessage(message, responseMessage, {
          allowedMentions: { repliedUser: false }
        });
      } else {
        await message.reply({
          content: responseMessage,
          allowedMentions: { repliedUser: false }
        });
      }

      // // Extract and send quote of the day
      // const quote = await this.extractQuote(content || result.summary);
      // if (quote) {
      //   const quoteMessage = `**Key Article Quote:**\n>>> ${quote}`;
      //   if (this.messageService) {
      //     await this.messageService.sendMessage(message.channel, quoteMessage);
      //   } else {
      //     await message.channel.send(quoteMessage);
      //   }
      // }

      
    } catch (error) {
      logger.error(`Error processing URL with context ${url}: ${error.message}`);
      const unexpectedErrorMessage = `An unexpected error occurred while processing ${url}.`;
      if (this.messageService) {
        await this.messageService.sendMessage(message.channel, unexpectedErrorMessage);
      } else {
        await message.channel.send(unexpectedErrorMessage);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async preprocessUrl(url, message) {
    // With Linkwarden integration, archive URL handling is deprecated
    // URLs are now processed through the Linkwarden polling service
    // This method now simply returns the URL as-is for backward compatibility
    return url;
  }

  async fetchContent(url, message) {
    // With Linkwarden integration, content fetching is handled by the polling service
    // This method now returns null to let OpenAI fetch content for non-Linkwarden flows
    // When Linkwarden is enabled, this method should not be called for article processing
    return null;
  }

  async generateSummary(content, url, style = null, mood = null, narrator = null, historicalPerspective = null) {
    if (!this.systemPrompt) {
      logger.error('System prompt not loaded');
      return null;
    }

    const isContentProvided = Boolean(content);
    
    if (this.config.openai.method === 'response') {
      return await this.generateResponseSummary(content, url, isContentProvided, style, mood, narrator, historicalPerspective);
    } else {
      return await this.generateCompletionSummary(content, url, isContentProvided, style, mood, narrator, historicalPerspective);
    }
  }

  async generateResponseSummary(content, url, isContentProvided, style, mood, narrator, historicalPerspective) {
    return withSpan('openai.generateResponseSummary', {
      'openai.method': 'response',
      'openai.model': this.config.openai.model,
      'openai.content_provided': isContentProvided,
      'openai.style': style || 'default',
      'openai.mood': mood || 'default',
      'openai.narrator': narrator || 'none',
      'openai.historical_perspective': historicalPerspective || 'none',
    }, async (span) => {
      let tokenData = null;
      let costData = null;
      let summary = null;

      try {
        const inputText = this.buildInputText(content, url, isContentProvided);
        let systemPrompt = this.systemPrompt;

        if (style && this.config.bot.summaryStyles.enabled && this.config.bot.summaryStyles.styles[style]) {
          systemPrompt += ` ${this.config.bot.summaryStyles.styles[style]}`;
        }

        if (mood && this.config.bot.moodBasedSummaries.enabled && this.config.bot.moodBasedSummaries.moods[mood]) {
          systemPrompt += ` ${this.config.bot.moodBasedSummaries.moods[mood]}`;
        }

        if (narrator && this.config.bot.celebrityNarrators.enabled && this.config.bot.celebrityNarrators.narrators[narrator]) {
          systemPrompt += ` ${this.config.bot.celebrityNarrators.narrators[narrator]}`;
        }

        if (historicalPerspective && this.config.bot.historicalPerspectives.enabled && this.config.bot.historicalPerspectives.perspectives[historicalPerspective]) {
          systemPrompt += ` ${this.config.bot.historicalPerspectives.perspectives[historicalPerspective]}`;
        }

        // Estimate tokens
        const inputTokenEstimate = this.tokenService.countTokens(inputText);
        const systemPromptTokens = this.tokenService.countTokens(systemPrompt);
        const totalInputTokensEstimate = (inputTokenEstimate || 0) + (systemPromptTokens || 0);

        logger.info(`Estimated input tokens: ${totalInputTokensEstimate} (content: ${inputTokenEstimate}, system: ${systemPromptTokens})`);
        span.setAttribute('openai.estimated_input_tokens', totalInputTokensEstimate);
        span.setAttribute('openai.content_tokens', inputTokenEstimate || 0);
        span.setAttribute('openai.system_prompt_tokens', systemPromptTokens || 0);

        // Call OpenAI API
        addSpanEvent('openai.api_call.started');
        const response = await this.callOpenAIResponsesAPI(inputText, systemPrompt);
        addSpanEvent('openai.api_call.completed');

        // Process usage data if available
        if (response.usage) {
          const usageData = this.processUsageData(response.usage, totalInputTokensEstimate);
          tokenData = usageData.tokens;
          costData = usageData.costs;

          span.setAttribute('openai.actual_input_tokens', response.usage.input_tokens);
          span.setAttribute('openai.actual_output_tokens', response.usage.output_tokens);
          span.setAttribute('openai.actual_total_tokens', response.usage.total_tokens);
          span.setAttribute('openai.cached_tokens', response.usage.input_tokens_details?.cached_tokens || 0);
          span.setAttribute('openai.cost_cents', costData?.total || 0);
        } else {
          logger.warn('No usage data in OpenAI response');
          addSpanEvent('openai.no_usage_data');
        }

        // Extract summary
        summary = ResponseParser.extractSummaryFromResponse(response);

        if (!summary) {
          span.setAttribute('openai.summary_extracted', false);
          addSpanEvent('openai.summary_extraction_failed');
          return null;
        }

        span.setAttribute('openai.summary_extracted', true);
        span.setAttribute('openai.summary_length', summary.length);

        // Log output token estimation
        if (response.usage?.output_tokens) {
          const estimatedOutputTokens = this.tokenService.countTokens(summary);
          this.tokenService.logTokenUsage(estimatedOutputTokens, response.usage.output_tokens, 'Output');
        }

        return {
          summary,
          tokens: tokenData,
          costs: costData
        };
      } catch (error) {
        logger.error('OpenAI API error (response method):', error);
        logger.error('Error stack:', error.stack);
        if (error.response) {
          logger.error(`Error response status: ${error.response.status}`);
          logger.error(`Error response data: ${JSON.stringify(error.response.data)}`);
          span.setAttribute('openai.error_status', error.response.status);
        }
        span.setAttribute('openai.error_message', error.message);
        throw error; // Re-throw to let withSpan record the error
      }
    });
  }

  async generateCompletionSummary(content, url, isContentProvided, style, mood, narrator, historicalPerspective) {
    try {
      const userMessage = this.buildUserMessage(content, url, isContentProvided);
      let systemPrompt = this.systemPrompt;

      if (style && this.config.bot.summaryStyles.enabled && this.config.bot.summaryStyles.styles[style]) {
        systemPrompt += ` ${this.config.bot.summaryStyles.styles[style]}`;
      }

      if (mood && this.config.bot.moodBasedSummaries.enabled && this.config.bot.moodBasedSummaries.moods[mood]) {
        systemPrompt += ` ${this.config.bot.moodBasedSummaries.moods[mood]}`;
      }

      if (narrator && this.config.bot.celebrityNarrators.enabled && this.config.bot.celebrityNarrators.narrators[narrator]) {
        systemPrompt += ` ${this.config.bot.celebrityNarrators.narrators[narrator]}`;
      }

      if (historicalPerspective && this.config.bot.historicalPerspectives.enabled && this.config.bot.historicalPerspectives.perspectives[historicalPerspective]) {
        systemPrompt += ` ${this.config.bot.historicalPerspectives.perspectives[historicalPerspective]}`;
      }

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];
      
      // Estimate tokens
      const estimatedTokens = this.tokenService.estimateMessageTokens(messages);
      logger.info(`Estimated input tokens for completion method: ${estimatedTokens}`);

      // Call OpenAI/Ollama API
      const completion = await this.callCompletionAPI(messages);
      
      if (completion.error) {
        logger.error(`OpenAI API error: ${completion.error}`);
        return null;
      }

      // Log token usage if available (Ollama typically doesn't provide this)
      if (completion.usage) {
        logger.info(`Actual token usage - Input: ${completion.usage.prompt_tokens}, Output: ${completion.usage.completion_tokens}, Total: ${completion.usage.total_tokens}`);
      } else {
        logger.info('No token usage data available from Ollama');
      }

      const summary = ResponseParser.extractSummaryFromCompletion(completion);
      
      if (!summary) {
        logger.error('No summary text in response');
        return null;
      }

      // Log estimated output tokens
      const outputTokens = this.tokenService.countTokens(summary);
      logger.info(`Output token count (estimated with OpenAI tokenizer): ${outputTokens}`);

      return {
        summary,
        tokens: null, // Ollama doesn't provide token usage
        costs: null   // No cost data for local models
      };
    } catch (error) {
      logger.error('API error (completion method):', error);
      return null;
    }
  }

  // Helper methods
  buildInputText(content, url, isContentProvided) {
    return isContentProvided
      ? `Summarize the following text per your system prompt: ${content}`
      : `Summarize this article per your system prompt: ${url}`;
  }

  buildUserMessage(content, url, isContentProvided) {
    return isContentProvided
      ? `Summarize the following text in ${this.config.bot.maxSummaryLength} characters or less: ${content}`
      : `Summarize this article in ${this.config.bot.maxSummaryLength} characters or less: ${url}`;
  }

  async callOpenAIResponsesAPI(inputText, systemPrompt) {
    const startTime = Date.now();
    
    const response = await this.openaiClient.responses.create({
      ...this._requestBase('low'),
      tools: [{ type: "web_search_preview" }],
      instructions: systemPrompt,
      input: inputText,
    });

    const duration = Date.now() - startTime;
    logger.info(`OpenAI API Response received (response method) - Duration: ${duration}ms`);
    
    return response;
  }

  async callCompletionAPI(messages) {
    const startTime = Date.now();

    // Convert messages array to responses API format
    const systemMessage = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role !== 'system');
    const inputText = userMessages.map(m => m.content).join('\n\n');

    const response = await this.openaiClient.responses.create({
      ...this._requestBase('low'),
      instructions: systemMessage?.content || '',
      input: inputText,
    });

    const duration = Date.now() - startTime;
    logger.info(`API Response received (responses method) - Duration: ${duration}ms`);

    return response;
  }

  processUsageData(usage, estimatedTokens) {
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const totalTokens = usage.total_tokens;
    const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
    
    logger.info(`Actual token usage - Input: ${inputTokens}, Output: ${outputTokens}, Total: ${totalTokens}`);
    
    if (cachedTokens > 0) {
      logger.info(`Cached tokens: ${cachedTokens}`);
    }
    
    // Calculate costs
    const costs = this.costService.calculateCosts(usage, this._model());
    this.costService.logCostBreakdown(costs, {
      regular: inputTokens - cachedTokens,
      cached: cachedTokens
    });
    
    // Update cumulative costs
    this.costService.updateCumulative(costs);
    
    // Log token estimation accuracy
    if (estimatedTokens) {
      this.tokenService.logTokenUsage(estimatedTokens, inputTokens, 'Input');
    }
    
    // Format for return
    const tokenData = {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens,
      cached: cachedTokens
    };
    
    const costData = this.costService.formatCostBreakdown(costs);
    
    return { tokens: tokenData, costs: costData };
  }

  isQuestionableSource(url) {
    if (!this.config.bot.factChecker.enabled) {
      return false;
    }

    const { questionableSources } = this.config.bot.factChecker;
    if (!questionableSources || questionableSources.length === 0) {
      return false;
    }

    try {
      const { hostname } = new URL(url);
      return questionableSources.some(source => hostname.includes(source));
    } catch (error) {
      logger.error(`Invalid URL for fact-checking: ${url}`);
      return false;
    }
  }

  async enhanceSummary(summary, content) {
    const readingTime = TextUtils.calculateReadingTime(content || summary);

    let biasAnalysis = null;
    if (this.config.bot.biasDetection.enabled) {
      biasAnalysis = await this.analyzeBias(content || summary);
    }

    try {
      const enhancementPrompt = `Analyze the following text and provide:
1.  **Topic**: A single, relevant topic (e.g., Technology, Politics, Sports).
2.  **Sentiment**: A brief sentiment description (e.g., Positive, Negative, Neutral).

Text: """${summary}"""`;

      const response = await this.openaiClient.responses.create({
        ...this._requestBase('none'),
        input: enhancementPrompt,
      });

      const [topic, sentiment] = response.output_text.split('\n').map(line => line.split(': ')[1]);

      return {
        readingTime,
        topic,
        sentiment,
        biasAnalysis,
      };
    } catch (error) {
      logger.error('Failed to enhance summary:', error);
      return {
        readingTime,
        topic: 'N/A',
        sentiment: 'N/A',
        biasAnalysis: null,
      };
    }
  }

  async analyzeBias(text) {
    try {
      const biasPrompt = `Analyze the following text for potential biases. Identify any specific types of bias (e.g., political, gender, racial, corporate) and provide a brief explanation for each. If no significant bias is detected, state that.

Text: """${text}"""

Bias Analysis:`;

      const response = await this.openaiClient.responses.create({
        ...this._requestBase('low'),
        input: biasPrompt,
      });

      return response.output_text.trim();
    } catch (error) {
      logger.error('Failed to analyze bias:', error);
      return 'N/A';
    }
  }

  async getAlternativePerspectiveSummary(content, url, perspective) {
    if (!this.config.bot.alternativePerspectives.enabled || !this.config.bot.alternativePerspectives.perspectives[perspective]) {
      return null;
    }

    try {
      const perspectivePrompt = this.config.bot.alternativePerspectives.perspectives[perspective];
      const userMessage = this.buildUserMessage(content, url, Boolean(content));
      const messages = [
        { role: 'system', content: perspectivePrompt },
        { role: 'user', content: userMessage },
      ];

      const completion = await this.callCompletionAPI(messages);
      if (completion.error) {
        logger.error(`OpenAI API error for alternative perspective: ${completion.error}`);
        return null;
      }
      return ResponseParser.extractSummaryFromCompletion(completion);
    } catch (error) {
      logger.error(`Failed to generate alternative perspective summary for ${perspective}: ${error.message}`);
      return null;
    }
  }

  async extractQuote(text) {
    try {
      const quotePrompt = `From the following text, extract a single, interesting, and thought-provoking quote. The quote should be directly from the text and stand alone well.

Text: """${text}"""

Quote:`;

      const response = await this.openaiClient.responses.create({
        ...this._requestBase('none'),
        input: quotePrompt,
      });

      return response.output_text.trim();
    } catch (error) {
      logger.error('Failed to extract quote:', error);
      return null;
    }
  }
  async checkAndNotifyFollowUps(newArticleUrl, newArticleTopic, newArticleSummary) {
    if (!this.config.bot.followUpTracker.enabled || !newArticleTopic) {
      return;
    }

    try {
      const pendingFollowUps = await this.mongoService.getArticlesForFollowUp();

      for (const oldArticle of pendingFollowUps) {
        // Simple topic-based matching for now. Can be enhanced with more sophisticated similarity checks.
        if (oldArticle.topic && oldArticle.topic === newArticleTopic) {
          logger.info(`Found potential follow-up: New article (${newArticleUrl}) related to old article (${oldArticle.url})`);

          const notificationMessage = `**Follow-up Alert!**\nThere's a new article related to a story you were following:\nOld Article: <${oldArticle.url}>\nNew Article: <${newArticleUrl}>\n\n**Summary of New Article:**\n${newArticleSummary}\n\nThis follow-up has been marked as complete.`;

          for (const userId of oldArticle.followUpUsers) {
            try {
              const user = await this.discordClient.users.fetch(userId);
              if (user) {
                await user.send(notificationMessage);
                logger.info(`Notified user ${userId} about follow-up for ${oldArticle.url}`);
              }
            }
 catch (userError) {
              logger.error(`Could not send DM to user ${userId}: ${userError.message}`);
            }
          }
          await this.mongoService.updateFollowUpStatus(oldArticle.url, 'completed');
        }
      }
    }
 catch (error) {
      logger.error(`Error in checkAndNotifyFollowUps: ${error.message}`);
    }
  }

  async provideContext(topic) {
    if (!this.config.bot.contextProvider.enabled || !topic) {
      return null;
    }

    try {
      const contextPrompt = `${this.config.bot.contextProvider.prompt} ${topic}`;
      const response = await this.openaiClient.responses.create({
        ...this._requestBase('low'),
        input: contextPrompt,
      });
      return response.output_text.trim();
    } catch (error) {
      logger.error(`Failed to provide context for topic ${topic}: ${error.message}`);
      return null;
    }
  }

  async detectAndTranslate(text) {
    if (!this.config.bot.autoTranslation.enabled) {
      return { translatedText: text, detectedLanguage: 'N/A', wasTranslated: false };
    }

    try {
      const languageDetectionPrompt = `Detect the language of the following text and respond with only the language name (e.g., "English", "Spanish").

Text: """${text}"""`;

      const langResponse = await this.openaiClient.responses.create({
        ...this._requestBase('none'),
        input: languageDetectionPrompt,
      });
      const detectedLanguage = langResponse.output_text.trim();

      if (detectedLanguage.toLowerCase() !== this.config.bot.autoTranslation.targetLanguage.toLowerCase()) {
        logger.info(`Detected language: ${detectedLanguage}. Translating to ${this.config.bot.autoTranslation.targetLanguage}.`);
        const translationPrompt = `Translate the following text from ${detectedLanguage} to ${this.config.bot.autoTranslation.targetLanguage}.

Text: """${text}"""`;

        const transResponse = await this.openaiClient.responses.create({
          ...this._requestBase('none'),
          input: translationPrompt,
        });
        const translatedText = transResponse.output_text.trim();
        return { translatedText, detectedLanguage, wasTranslated: true };
      } else {
        logger.info(`Detected language: ${detectedLanguage}. No translation needed.`);
        return { translatedText: text, detectedLanguage, wasTranslated: false };
      }
    } catch (error) {
      logger.error(`Error during language detection or translation: ${error.message}`);
      return { translatedText: text, detectedLanguage: 'N/A', wasTranslated: false };
    }
  }

  async generateMultiLanguageSummary(content, url, targetLanguages) {
    if (!this.config.bot.languageLearning.enabled || !targetLanguages || targetLanguages.length === 0) {
      return null;
    }

    const summaries = {};
    for (const lang of targetLanguages) {
      try {
        const translationPrompt = `Summarize the following article in ${lang}.\n\nArticle: """${content}"""`;
        const response = await this.openaiClient.responses.create({
          ...this._requestBase('low'),
          input: translationPrompt,
        });
        summaries[lang] = response.output_text.trim();
      } catch (error) {
        logger.error(`Failed to generate ${lang} summary: ${error.message}`);
        summaries[lang] = `Could not generate summary in ${lang}.`;
      }
    }
    return summaries;
  }

  async generateCulturalContextSummary(content, url, culturalContext) {
    if (!this.config.bot.culturalContext.enabled || !this.config.bot.culturalContext.contexts[culturalContext]) {
      return null;
    }

    try {
      const contextPrompt = this.config.bot.culturalContext.contexts[culturalContext];
      const userMessage = this.buildUserMessage(content, url, Boolean(content));
      const messages = [
        { role: 'system', content: contextPrompt },
        { role: 'user', content: userMessage },
      ];

      const completion = await this.callCompletionAPI(messages);
      if (completion.error) {
        logger.error(`OpenAI API error for cultural context: ${completion.error}`);
        return null;
      }
      return ResponseParser.extractSummaryFromCompletion(completion);
    } catch (error) {
      logger.error(`Failed to generate cultural context summary for ${culturalContext}: ${error.message}`);
      return null;
    }
  }

  /**
   * Process a link from Linkwarden (content already archived)
   * This method is called by LinkwardenPollingService when new archived links are detected
   * @param {Object} options - Link data from Linkwarden
   * @param {Object} options.link - The Linkwarden link object
   * @param {string} options.content - The readable content for summarization
   * @param {Object} options.archiveUrls - URLs for different archive formats
   * @param {string[]} options.availableFormats - List of available format names
   * @param {Object} options.message - Mock message object with channel
   * @param {Object} options.user - Mock user object
   */
  async processLinkwardenLink({ link, content, archiveUrls, availableFormats, message, user }) {
    if (this.isProcessing) {
      logger.info('Already processing a URL, queuing Linkwarden link.');
      return;
    }

    this.isProcessing = true;
    const url = link.url;

    return withSpan('summarization.processLinkwardenLink', {
      'article.url': url,
      'article.link_id': link.id,
      'article.name': link.name || 'unknown',
      'article.content_available': !!content,
      'article.content_length': content ? content.length : 0,
    }, async (span) => {
      try {
        logger.info(`Processing Linkwarden link: ${url}`);
        addSpanEvent('processLinkwardenLink.started');

        // Check for duplicates in our MongoDB
        addSpanEvent('mongodb.check_duplicate');
        const existingArticle = await this.mongoService.findArticleByUrl(url);
        if (existingArticle) {
          logger.info(`Linkwarden link already processed in MongoDB: ${url}`);
          span.setAttribute('article.duplicate', true);
          addSpanEvent('article.duplicate_found', { original_date: existingArticle.createdAt });
          this.isProcessing = false;
          return;
        }
        span.setAttribute('article.duplicate', false);

        // Use the readable content from Linkwarden for summarization
        let textContent = content;

        // If no content available, post basic info without summary
        if (!textContent) {
          logger.warn(`No readable content available for Linkwarden link: ${url}`);
          span.setAttribute('article.no_content', true);
          addSpanEvent('content.not_available');

          const noContentMessage = this.buildLinkwardenResponse({
            link,
            archiveUrls,
            availableFormats,
            summary: '_No readable content available for AI summary._',
            readingTime: 'N/A',
            topic: link.tags?.[0]?.name || 'N/A',
            sentiment: 'N/A',
            sourceCredibility: null,
            relatedArticles: [],
            wasTranslated: false,
            detectedLanguage: 'N/A'
          });
          await message.channel.send(noContentMessage);

          // Still persist to avoid re-processing
          await this.mongoService.persistData({
            userId: user.id,
            username: user.tag,
            url,
            inputTokens: 0,
            outputTokens: 0,
            topic: link.tags?.[0]?.name || 'Unknown',
            source: 'linkwarden'
          });

          this.isProcessing = false;
          return;
        }

        // Handle translation if needed
        let wasTranslated = false;
        let detectedLanguage = 'N/A';
        if (this.config.bot.autoTranslation.enabled) {
          addSpanEvent('translation.detecting_language');
          const translationResult = await this.detectAndTranslate(textContent);
          textContent = translationResult.translatedText;
          wasTranslated = translationResult.wasTranslated;
          detectedLanguage = translationResult.detectedLanguage;
          span.setAttribute('article.detected_language', detectedLanguage);
          span.setAttribute('article.was_translated', wasTranslated);
          if (wasTranslated) {
            addSpanEvent('translation.completed', { from: detectedLanguage });
          }
        }

        // Generate summary using the existing method
        addSpanEvent('openai.generate_summary.started');
        const result = await this.generateSummary(textContent, url, null, null, null, null);

        if (!result) {
          logger.error(`Failed to generate summary for Linkwarden link: ${url}`);
          span.setAttribute('summarization.failed', true);
          addSpanEvent('openai.generate_summary.failed');

          const errorMessage = this.buildLinkwardenResponse({
            link,
            archiveUrls,
            availableFormats,
            summary: '_Summary generation failed. View the archived version for full content._',
            readingTime: 'N/A',
            topic: 'N/A',
            sentiment: 'N/A',
            sourceCredibility: null,
            relatedArticles: [],
            wasTranslated,
            detectedLanguage
          });
          await message.channel.send(errorMessage);
          this.isProcessing = false;
          return;
        }

        addSpanEvent('openai.generate_summary.completed', {
          input_tokens: result.tokens?.input || 0,
          output_tokens: result.tokens?.output || 0,
        });
        span.setAttribute('openai.input_tokens', result.tokens?.input || 0);
        span.setAttribute('openai.output_tokens', result.tokens?.output || 0);
        span.setAttribute('openai.total_tokens', result.tokens?.total || 0);
        span.setAttribute('summarization.summary_length', result.summary?.length || 0);

        // Enhance the summary with topic, sentiment, reading time
        addSpanEvent('openai.enhance_summary.started');
        const enhancedResult = await this.enhanceSummary(result.summary, textContent);
        addSpanEvent('openai.enhance_summary.completed', {
          topic: enhancedResult.topic,
          sentiment: enhancedResult.sentiment,
        });
        span.setAttribute('article.topic', enhancedResult.topic || 'N/A');
        span.setAttribute('article.sentiment', enhancedResult.sentiment || 'N/A');
        span.setAttribute('article.reading_time', enhancedResult.readingTime || 'N/A');

        // Find related articles from our MongoDB
        let relatedArticles = [];
        if (enhancedResult.topic) {
          relatedArticles = await this.mongoService.findRelatedArticles(enhancedResult.topic, url);
          span.setAttribute('article.related_count', relatedArticles.length);
        }

        // Get source credibility rating
        const sourceCredibility = this.sourceCredibilityService.rateSource(url);
        span.setAttribute('article.source_credibility', sourceCredibility || 'unknown');

        // Build the Discord message with Linkwarden-specific formatting
        const responseMessage = this.buildLinkwardenResponse({
          link,
          archiveUrls,
          availableFormats,
          summary: result.summary,
          readingTime: enhancedResult.readingTime,
          topic: enhancedResult.topic,
          sentiment: enhancedResult.sentiment,
          sourceCredibility,
          relatedArticles,
          wasTranslated,
          detectedLanguage
        });

        // Persist to MongoDB for analytics and duplicate detection
        addSpanEvent('mongodb.persist_data');
        await this.mongoService.persistData({
          userId: user.id,
          username: user.tag,
          url,
          inputTokens: result.tokens?.input || 0,
          outputTokens: result.tokens?.output || 0,
          topic: enhancedResult.topic,
          source: 'linkwarden'
        });

        // Record token usage for this user
        await this.mongoService.recordTokenUsage(
          user.id,
          user.tag || user.username,
          result.tokens?.input || 0,
          result.tokens?.output || 0,
          'summarize_linkwarden',
          this.config.openai.model
        );

        // Send to Discord
        addSpanEvent('discord.send_message');
        await message.channel.send(responseMessage);

        // Check for follow-ups on related topics
        if (enhancedResult.topic) {
          await this.checkAndNotifyFollowUps(url, enhancedResult.topic, result.summary);
        }

        logger.info(`Successfully processed Linkwarden link: ${url}`);
        addSpanEvent('processLinkwardenLink.completed');

      } catch (error) {
        logger.error(`Error processing Linkwarden link: ${error.message}`);
        logger.error(error.stack);

        try {
          await message.channel.send(`An error occurred while processing the archived article: ${link.name || link.url}`);
        } catch (sendError) {
          logger.error(`Failed to send error message: ${sendError.message}`);
        }
        throw error; // Re-throw to let withSpan record the error
      } finally {
        this.isProcessing = false;
      }
    });
  }

  /**
   * Build Discord message for Linkwarden-archived content
   * @param {Object} options - Message building options
   * @returns {string} Formatted Discord message
   */
  buildLinkwardenResponse({
    link,
    archiveUrls,
    availableFormats,
    summary,
    readingTime,
    topic,
    sentiment,
    sourceCredibility,
    relatedArticles,
    wasTranslated,
    detectedLanguage
  }) {
    let response = '';

    // Title with link to archived version
    const title = link.name || 'Archived Article';
    response += `**${title}**\n\n`;

    // Summary
    response += `${summary}\n\n`;

    // Archive link (primary call to action)
    response += `**Archived Version:** <${archiveUrls.linkwardenView}>\n`;

    // Original URL (suppressed embed with angle brackets)
    if (link.url) {
      response += `**Original:** <${link.url}>\n`;
    }

    // Metadata line
    const metadataParts = [];
    if (readingTime && readingTime !== 'N/A') {
      metadataParts.push(`**Reading Time:** ${readingTime}`);
    }
    if (topic && topic !== 'N/A') {
      metadataParts.push(`**Topic:** ${topic}`);
    }
    if (sentiment && sentiment !== 'N/A') {
      metadataParts.push(`**Sentiment:** ${sentiment}`);
    }

    if (metadataParts.length > 0) {
      response += `\n${metadataParts.join(' | ')}\n`;
    }

    // Source credibility
    if (sourceCredibility) {
      response += `**Source Rating:** ${sourceCredibility}\n`;
    }

    // Translation info
    if (wasTranslated && detectedLanguage !== 'N/A') {
      response += `*Translated from ${detectedLanguage}*\n`;
    }

    // Available archive formats
    if (availableFormats && availableFormats.length > 0) {
      response += `**Available Formats:** ${availableFormats.join(', ')}\n`;
    }

    // Related articles (limit to 3)
    if (relatedArticles && relatedArticles.length > 0) {
      response += `\n**Related Articles:**\n`;
      relatedArticles.slice(0, 3).forEach(article => {
        const articleTitle = article.name || article.url;
        response += `• ${articleTitle}\n`;
      });
    }

    // Trim and return
    return response.trim();
  }
}

module.exports = SummarizationService;