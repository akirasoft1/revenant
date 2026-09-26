// ===== services/TokenService.js =====
const logger = require('../logger');
const { getEncoderForModel } = require('../utils/tokenCounter');
const { DEFAULT_OPENAI_MODEL } = require('../utils/openaiModels');

class TokenService {
  constructor(model = DEFAULT_OPENAI_MODEL) {
    this.model = model;
    this.encoder = null;
    this.initializeEncoder();
  }

  initializeEncoder() {
    try {
      // Unknown models (e.g. gpt-6-*) fall back to o200k_base instead of throwing
      this.encoder = getEncoderForModel(this.model);
      logger.info('Tiktoken encoder initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize tiktoken encoder:', error);
      this.encoder = null;
    }
  }

  countTokens(text) {
    if (!this.encoder) {
      logger.warn('Token encoder not available, skipping token count');
      return null;
    }
    
    try {
      const tokens = this.encoder.encode(text);
      return tokens.length;
    } catch (error) {
      logger.error('Error counting tokens:', error);
      return null;
    }
  }

  estimateMessageTokens(messages) {
    if (!this.encoder) return null;
    
    let totalTokens = 0;
    
    // Each message has overhead tokens for formatting
    const messageOverhead = 4; // Approximate overhead per message
    
    for (const message of messages) {
      totalTokens += messageOverhead;
      
      if (message.role) {
        totalTokens += this.countTokens(message.role) || 0;
      }
      
      if (message.content) {
        totalTokens += this.countTokens(message.content) || 0;
      }
    }
    
    // Add some tokens for response formatting
    totalTokens += 3;
    
    return totalTokens;
  }

  logTokenUsage(estimated, actual, type = 'input') {
    if (!estimated || !actual) return;
    
    const difference = actual - estimated;
    const percentDiff = ((difference / estimated) * 100).toFixed(2);
    logger.info(`${type} token estimation accuracy: ${percentDiff}% difference (estimated: ${estimated}, actual: ${actual})`);
  }
}

module.exports = TokenService;