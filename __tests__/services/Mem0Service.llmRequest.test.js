// __tests__/services/Mem0Service.llmRequest.test.js
//
// Pins what actually goes over the wire when mem0ai's OpenAI LLM provider runs
// with the config Mem0Service builds. The deployed MEM0_LLM_MODEL is a gpt-6-*
// model, and those REJECT `temperature` (anything but the default), `top_p`, and
// `max_tokens` (they want `max_completion_tokens`). mem0ai v3's OpenAILLM does
// not forward sampling params at all; this test fails loudly if a future mem0ai
// release (or a Mem0Service edit) starts sending them again.
//
// It runs the REAL mem0ai LLMFactory + OpenAI SDK against a local HTTP server
// (via the provider's baseURL), so it checks the request body, not a mock's
// call arguments. Only the Memory class is stubbed, to avoid connecting to Qdrant.

const http = require('http');

jest.mock('mem0ai/oss', () => {
  const actual = jest.requireActual('mem0ai/oss');
  return { ...actual, Memory: jest.fn().mockImplementation(() => ({})) };
});

const { Memory, LLMFactory } = require('mem0ai/oss');
const Mem0Service = require('../../services/Mem0Service');

describe('Mem0Service -> mem0ai OpenAI LLM request params', () => {
  let server;
  let baseURL;
  let requests;

  beforeAll(async () => {
    requests = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({ url: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-6-luna',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: '{"facts": []}' },
          }],
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    requests.length = 0;
    Memory.mockClear();
  });

  function buildLlm() {
    new Mem0Service({
      mem0: {
        enabled: true,
        openaiApiKey: 'sk-test',
        llmModel: 'gpt-6-luna',
        qdrantHost: 'localhost',
        qdrantPort: 6333,
      },
    });
    const { provider, config } = Memory.mock.calls[0][0].llm;
    // Same provider + config mem0 would build internally; only redirect the host.
    return LLMFactory.create(provider, { ...config, baseURL });
  }

  const FORBIDDEN = ['temperature', 'top_p', 'max_tokens'];

  it('generateResponse (fact extraction, JSON mode) sends no temperature/top_p/max_tokens', async () => {
    const llm = buildLlm();
    await llm.generateResponse(
      [{ role: 'system', content: 'extract facts' }, { role: 'user', content: 'I like vim' }],
      { type: 'json_object' }
    );

    expect(requests).toHaveLength(1);
    const body = requests[0].body;
    expect(requests[0].url).toBe('/v1/chat/completions');
    expect(body.model).toBe('gpt-6-luna');
    expect(body.response_format).toEqual({ type: 'json_object' });
    for (const key of FORBIDDEN) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('generateChat sends no temperature/top_p/max_tokens', async () => {
    const llm = buildLlm();
    await llm.generateChat([{ role: 'user', content: 'hi' }]);

    expect(requests).toHaveLength(1);
    const body = requests[0].body;
    expect(body.model).toBe('gpt-6-luna');
    for (const key of FORBIDDEN) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

describe('Mem0Service telemetry default', () => {
  const saved = process.env.MEM0_TELEMETRY;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEM0_TELEMETRY;
    else process.env.MEM0_TELEMETRY = saved;
  });

  it('defaults MEM0_TELEMETRY to "false" before mem0ai is loaded', () => {
    delete process.env.MEM0_TELEMETRY;
    jest.isolateModules(() => { require('../../services/Mem0Service'); });
    expect(process.env.MEM0_TELEMETRY).toBe('false');
  });

  it('respects an explicit MEM0_TELEMETRY setting', () => {
    process.env.MEM0_TELEMETRY = 'true';
    jest.isolateModules(() => { require('../../services/Mem0Service'); });
    expect(process.env.MEM0_TELEMETRY).toBe('true');
  });
});
