// __tests__/openaiCallSites.test.js
// Pins the request params of every bot-side OpenAI Responses API call site
// against the gpt-6 (reasoning) family:
//   - no params reasoning models reject (temperature, top_p, max_tokens,
//     presence/frequency penalties)
//   - no tight output cap (reasoning tokens count against it -> empty text)
//   - an explicit reasoning effort chosen per call site's latency/quality need
//   - no deprecated model id reaching the wire when config omits a model

jest.mock('../logger', () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }));

const FORBIDDEN = ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'max_output_tokens', 'max_completion_tokens'];
const DEPRECATED = ['gpt-5.1', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4o'];

function mockClient(outputText = 'ok') {
  return {
    responses: {
      create: jest.fn().mockResolvedValue({
        output_text: outputText,
        output: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      })
    }
  };
}

function expectReasoningSafe(params, { model, effort }) {
  for (const key of FORBIDDEN) {
    expect(params).not.toHaveProperty(key);
  }
  expect(params.model).toBe(model);
  expect(DEPRECATED).not.toContain(params.model);
  if (effort === undefined) {
    expect(params).not.toHaveProperty('reasoning');
  } else {
    expect(params.reasoning).toEqual({ effort });
  }
}

const lastParams = (client) => client.responses.create.mock.calls.at(-1)[0];
const allParams = (client) => client.responses.create.mock.calls.map((c) => c[0]);

describe('OpenAI call sites are gpt-6 (reasoning model) compatible', () => {
  describe('MessageService.compressMessage', () => {
    const MessageService = require('../services/MessageService');

    test('uses the configured model with effort none (pure text transform)', async () => {
      const client = mockClient('short');
      const svc = new MessageService(client, { openai: { model: 'gpt-6-luna' } });
      await svc.compressMessage('x'.repeat(2500));
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'none' });
    });

    test('with no config falls back to gpt-6-luna, not a deprecated id', async () => {
      const client = mockClient('short');
      const svc = new MessageService(client);
      await svc.compressMessage('x'.repeat(2500));
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'none' });
    });
  });

  describe('CatchMeUpService.generateCatchUp', () => {
    const CatchMeUpService = require('../services/CatchMeUpService');

    test('uses effort low', async () => {
      const client = mockClient('catch up');
      const mongo = {
        getUserLastSeen: jest.fn().mockResolvedValue({ lastSeenAt: new Date(Date.now() - 86400000), activeChannels: ['c1'] }),
        getChannelMessages: jest.fn().mockResolvedValue(['one', 'two', 'three'].map((c) => ({ authorName: 'A', content: c, timestamp: new Date() })))
      };
      const svc = new CatchMeUpService(mongo, null, client, { openai: { model: 'gpt-6-luna' } });
      const result = await svc.generateCatchUp('u1', 'g1');
      expect(result.success).toBe(true);
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'low' });
    });

    test('with no configured model falls back to gpt-6-luna', async () => {
      const client = mockClient('catch up');
      const mongo = {
        getUserLastSeen: jest.fn().mockResolvedValue({ lastSeenAt: new Date(Date.now() - 86400000), activeChannels: ['c1'] }),
        getChannelMessages: jest.fn().mockResolvedValue(['one', 'two', 'three'].map((c) => ({ authorName: 'A', content: c, timestamp: new Date() })))
      };
      const svc = new CatchMeUpService(mongo, null, client, { openai: {} });
      await svc.generateCatchUp('u1', 'g1');
      expect(lastParams(client).model).toBe('gpt-6-luna');
    });
  });

  describe('VoiceSearchService', () => {
    const VoiceSearchService = require('../services/VoiceSearchService');

    test('expandQuery uses effort none (latency-sensitive rewrite)', async () => {
      const client = mockClient('["a","b"]');
      const svc = new VoiceSearchService(null, null, client, { openai: { model: 'gpt-6-luna' } });
      await svc.expandQuery('server went down');
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'none' });
    });

    test('synthesizeResults uses effort low', async () => {
      const client = mockClient('narrative');
      const svc = new VoiceSearchService(null, null, client, { openai: { model: 'gpt-6-luna' } });
      await svc.synthesizeResults('q', [{ payload: { text: 'a result', year: 2001, channel: '#x' }, score: 0.9 }]);
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'low' });
    });

    test('with no configured model falls back to gpt-6-luna', async () => {
      const client = mockClient('["a"]');
      const svc = new VoiceSearchService(null, null, client, { openai: {} });
      await svc.expandQuery('q');
      expect(lastParams(client).model).toBe('gpt-6-luna');
    });
  });

  describe('VoiceProfileService', () => {
    const VoiceProfileService = require('../services/VoiceProfileService');

    test('style analysis + synthesis pin effort medium (background, quality-first)', async () => {
      const client = mockClient('{"voice_instructions":"x"}');
      const svc = new VoiceProfileService(client, { voiceProfile: { analysisModel: 'gpt-6-luna' } });
      await svc._analyzeStyleBatch([{ payload: { text: 'hi' } }]);
      await svc._synthesizeProfile([{ a: 1 }]);
      for (const p of allParams(client)) {
        expectReasoningSafe(p, { model: 'gpt-6-luna', effort: 'medium' });
      }
      expect(client.responses.create).toHaveBeenCalledTimes(2);
    });

    test('with no analysisModel configured falls back to gpt-6-luna', async () => {
      const client = mockClient('{}');
      const svc = new VoiceProfileService(client, { voiceProfile: {} });
      await svc._analyzeStyleBatch([{ payload: { text: 'hi' } }]);
      expect(lastParams(client).model).toBe('gpt-6-luna');
    });
  });

  describe('ImagePromptAnalyzerService.analyzeFailedPrompt', () => {
    const ImagePromptAnalyzerService = require('../services/ImagePromptAnalyzerService');

    test('uses effort low', async () => {
      const client = mockClient('{"failureType":"safety","analysis":"a","suggestions":[],"suggestedPrompts":["p"],"confidence":0.5}');
      const svc = new ImagePromptAnalyzerService(client, { openai: { model: 'gpt-6-luna' } });
      await svc.analyzeFailedPrompt('a cat', 'blocked by safety', { type: 'safety' });
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'low' });
    });

    test('with no configured model falls back to gpt-6-luna', async () => {
      const client = mockClient('{}');
      const svc = new ImagePromptAnalyzerService(client, { openai: {} });
      await svc.analyzeFailedPrompt('a cat', 'blocked', { type: 'safety' });
      expect(lastParams(client).model).toBe('gpt-6-luna');
    });
  });

  describe('ReplyHandler', () => {
    const ReplyHandler = require('../handlers/ReplyHandler');

    test('_enhancePromptWithFeedback uses effort none', async () => {
      const client = mockClient('better prompt');
      const h = new ReplyHandler({}, {}, client, { openai: { model: 'gpt-6-luna' } });
      await h._enhancePromptWithFeedback('a cat', 'make it blue');
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'none' });
    });

    test('_enhancePromptWithFeedback with no configured model falls back to gpt-6-luna', async () => {
      const client = mockClient('better prompt');
      const h = new ReplyHandler({}, {}, client, { openai: {} });
      await h._enhancePromptWithFeedback('a cat', 'make it blue');
      expect(lastParams(client).model).toBe('gpt-6-luna');
    });

    test('handleSummarizationReply uses effort low and records the serving model', async () => {
      const client = mockClient('answer');
      const recordTokenUsage = jest.fn().mockResolvedValue(true);
      const h = new ReplyHandler({}, { mongoService: { recordTokenUsage } }, client, { openai: {} });
      const message = {
        content: 'why?',
        author: { id: 'u1', username: 'U', tag: 'U#1' },
        channel: { id: 'c1', send: jest.fn(), sendTyping: jest.fn().mockResolvedValue() },
        reply: jest.fn().mockResolvedValue({})
      };
      await h.handleSummarizationReply(message, '**Summary**\n\nA summary.\n\n**Reading Time:** 1 min');
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'low' });
      expect(recordTokenUsage.mock.calls[0][5]).toBe('gpt-6-luna');
    });
  });

  describe('SummarizationService helpers', () => {
    const SummarizationService = require('../services/SummarizationService');
    const config = {
      openai: { model: 'gpt-6-luna' },
      bot: {
        sourceCredibility: { enabled: false },
        biasDetection: { enabled: false },
        contextProvider: { enabled: true, prompt: 'Context for' },
        autoTranslation: { enabled: true, targetLanguage: 'English' },
        languageLearning: { enabled: true },
        alternativePerspectives: { enabled: false, perspectives: {} },
        maxSummaryLength: 1000
      }
    };
    const make = (client) => new SummarizationService(client, config, null, null, { });

    test('callOpenAIResponsesAPI (web-search summary) uses effort low', async () => {
      const client = mockClient('s');
      await make(client).callOpenAIResponsesAPI('in', 'sys');
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'low' });
    });

    test('callCompletionAPI uses effort low', async () => {
      const client = mockClient('s');
      await make(client).callCompletionAPI([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'low' });
    });

    test('enhanceSummary (topic/sentiment) uses the configured model, effort none', async () => {
      const client = mockClient('Topic: Tech\nSentiment: Neutral');
      await make(client).enhanceSummary('summary', 'content');
      const p = allParams(client).find((x) => /Topic/.test(x.input));
      expectReasoningSafe(p, { model: 'gpt-6-luna', effort: 'none' });
    });

    test('analyzeBias uses effort low', async () => {
      const client = mockClient('none');
      await make(client).analyzeBias('text');
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'low' });
    });

    test('extractQuote uses effort none', async () => {
      const client = mockClient('"q"');
      await make(client).extractQuote('text');
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'none' });
    });

    test('provideContext uses effort low', async () => {
      const client = mockClient('ctx');
      await make(client).provideContext('Tech');
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'low' });
    });

    test('detectAndTranslate uses effort none for detection and translation', async () => {
      const client = mockClient('Spanish');
      await make(client).detectAndTranslate('hola');
      expect(client.responses.create).toHaveBeenCalledTimes(2);
      for (const p of allParams(client)) {
        expectReasoningSafe(p, { model: 'gpt-6-luna', effort: 'none' });
      }
    });

    test('generateMultiLanguageSummary uses effort low', async () => {
      const client = mockClient('resumen');
      await make(client).generateMultiLanguageSummary('content', 'url', ['Spanish']);
      expectReasoningSafe(lastParams(client), { model: 'gpt-6-luna', effort: 'low' });
    });

    test('hardcoded helpers follow OPENAI_MODEL instead of a deprecated literal', async () => {
      const client = mockClient('x');
      const svc = new SummarizationService(client, { ...config, openai: { model: 'gpt-6-sol' } }, null, null, {});
      await svc.analyzeBias('t');
      await svc.extractQuote('t');
      await svc.provideContext('t');
      for (const p of allParams(client)) expect(p.model).toBe('gpt-6-sol');
    });
  });
});
