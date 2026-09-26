// __tests__/utils/tokenCounter.test.js

const {
  countTokens,
  countMessageTokens,
  wouldExceedLimit,
  estimateUserMessageTokens,
  getRemainingBudget
} = require('../../utils/tokenCounter');

describe('tokenCounter', () => {
  describe('countTokens', () => {
    it('should count tokens in a simple string', () => {
      const text = 'Hello, world!';
      const count = countTokens(text);
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(10); // Should be around 4 tokens
    });

    it('should return 0 for empty string', () => {
      expect(countTokens('')).toBe(0);
    });

    it('should return 0 for null/undefined', () => {
      expect(countTokens(null)).toBe(0);
      expect(countTokens(undefined)).toBe(0);
    });

    it('should handle longer text', () => {
      const text = 'The quick brown fox jumps over the lazy dog. This is a longer sentence to test token counting.';
      const count = countTokens(text);
      expect(count).toBeGreaterThan(10);
      expect(count).toBeLessThan(50);
    });
  });

  describe('countMessageTokens', () => {
    it('should count tokens in message array', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: 'Hi there! How can I help you?' }
      ];
      const count = countMessageTokens(messages);
      expect(count).toBeGreaterThan(0);
    });

    it('should return 0 for empty array', () => {
      expect(countMessageTokens([])).toBe(0);
    });

    it('should return 0 for non-array', () => {
      expect(countMessageTokens(null)).toBe(0);
      expect(countMessageTokens('not an array')).toBe(0);
    });

    it('should include message overhead', () => {
      const singleMessage = [{ role: 'user', content: 'Hi' }];
      const count = countMessageTokens(singleMessage);
      // Should be content tokens + role tokens + overhead + reply priming
      expect(count).toBeGreaterThan(countTokens('Hi'));
    });
  });

  describe('wouldExceedLimit', () => {
    it('should return false when under limit', () => {
      expect(wouldExceedLimit(100, 50, 200)).toBe(false);
    });

    it('should return true when would exceed limit', () => {
      expect(wouldExceedLimit(100, 150, 200)).toBe(true);
    });

    it('should return true when exactly at limit', () => {
      expect(wouldExceedLimit(100, 100, 200)).toBe(false); // 200 = 200, not exceeded
    });

    it('should return true when over limit', () => {
      expect(wouldExceedLimit(100, 101, 200)).toBe(true); // 201 > 200
    });

    it('should use default limit of 150000', () => {
      expect(wouldExceedLimit(149000, 500)).toBe(false);
      expect(wouldExceedLimit(149000, 1500)).toBe(true);
    });
  });

  describe('estimateUserMessageTokens', () => {
    it('should include username prefix in count', () => {
      const withPrefix = estimateUserMessageTokens('Alice', 'Hello');
      const withoutPrefix = countTokens('Hello');
      expect(withPrefix).toBeGreaterThan(withoutPrefix);
    });

    it('should handle longer usernames', () => {
      const shortName = estimateUserMessageTokens('Al', 'Hi');
      const longName = estimateUserMessageTokens('AlexanderTheGreat', 'Hi');
      expect(longName).toBeGreaterThan(shortName);
    });
  });

  describe('getRemainingBudget', () => {
    it('should calculate remaining budget', () => {
      expect(getRemainingBudget(100, 200)).toBe(100);
    });

    it('should return 0 when at or over limit', () => {
      expect(getRemainingBudget(200, 200)).toBe(0);
      expect(getRemainingBudget(250, 200)).toBe(0);
    });

    it('should use default limit of 150000', () => {
      expect(getRemainingBudget(100000)).toBe(50000);
    });
  });
});

describe('getEncoderForModel (unknown-model fallback)', () => {
  const { getEncoderForModel } = require('../../utils/tokenCounter');

  it('does not throw for gpt-6 models tiktoken does not know, and falls back to o200k_base', () => {
    let enc;
    expect(() => { enc = getEncoderForModel('gpt-6-luna'); }).not.toThrow();
    expect(enc).toBeTruthy();
    // o200k_base and gpt-4o share an encoding: same token ids for the same text
    const ref = getEncoderForModel('gpt-4o');
    expect(Array.from(enc.encode('Hello, world!'))).toEqual(Array.from(ref.encode('Hello, world!')));
  });

  it('does not throw for empty/undefined model names', () => {
    expect(() => getEncoderForModel(undefined)).not.toThrow();
    expect(getEncoderForModel(undefined)).toBeTruthy();
  });
});

describe('TokenService', () => {
  const TokenService = require('../../services/TokenService');

  it('initializes an encoder for a gpt-6 model instead of silently disabling counting', () => {
    const svc = new TokenService('gpt-6-luna');
    expect(svc.encoder).toBeTruthy();
    expect(svc.countTokens('Hello, world!')).toBeGreaterThan(0);
  });

  it('defaults to a working encoder with no model argument', () => {
    const svc = new TokenService();
    expect(svc.countTokens('Hello')).toBeGreaterThan(0);
  });
});
