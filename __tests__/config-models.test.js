// __tests__/config-models.test.js
// Code-level model defaults. dotenv is stubbed so a developer's local .env
// can't mask the defaults under test.

jest.mock('dotenv', () => ({ config: jest.fn() }));

const MODEL_ENV_VARS = [
  'OPENAI_MODEL', 'OPENAI_REASONING_EFFORT', 'VOICE_PROFILE_ANALYSIS_MODEL', 'MEM0_LLM_MODEL',
  'IMAGEGEN_MODEL', 'IMAGEGEN_ADMIN_MODEL', 'LYRIA_MODEL', 'LYRIA_PER_CALL_COST_USD',
  'VEO_MODEL', 'ELEVENLABS_MUSIC_MODEL', 'MEM0_EMBEDDING_MODEL'
];

const DEPRECATED = ['gpt-5.1', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini', 'gemini-2.5-flash-image', 'gemini-3-pro-image-preview'];

describe('model defaults (config/config.js)', () => {
  const saved = {};

  beforeEach(() => {
    jest.resetModules();
    for (const k of MODEL_ENV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // config.js exits the process without these
    process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x';
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'x';
    process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://x';
  });

  afterEach(() => {
    for (const k of MODEL_ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const load = () => {
    let config;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.isolateModules(() => { config = require('../config/config'); });
    warn.mockRestore();
    return config;
  };

  test('OpenAI text defaults are gpt-6-luna, with low chat reasoning effort', () => {
    const config = load();
    expect(config.openai.model).toBe('gpt-6-luna');
    expect(config.openai.reasoningEffort).toBe('low');
    expect(config.voiceProfile.analysisModel).toBe('gpt-6-luna');
    expect(config.mem0.llmModel).toBe('gpt-6-luna');
  });

  test('OPENAI_REASONING_EFFORT overrides the chat effort', () => {
    process.env.OPENAI_REASONING_EFFORT = 'medium';
    expect(load().openai.reasoningEffort).toBe('medium');
    delete process.env.OPENAI_REASONING_EFFORT;
  });

  test('embeddings stay on text-embedding-3-small (changing it forces a full Qdrant re-embed)', () => {
    expect(load().mem0.embeddingModel).toBe('text-embedding-3-small');
  });

  test('image gen defaults to GA gemini-3.1-flash-image (2.5-flash-image shuts down 2026-10-02)', () => {
    const config = load();
    expect(config.imagen.model).toBe('gemini-3.1-flash-image');
    expect(config.imagen.adminModel).toBe(''); // premium admin model stays opt-in
  });

  test('Lyria defaults to lyria-3.5 at $0.08/song', () => {
    const config = load();
    expect(config.lyria.model).toBe('lyria-3.5');
    expect(config.lyria.perCallCostUsd).toBeCloseTo(0.08, 5);
  });

  test('no deprecated model id is a code default', () => {
    const config = load();
    const defaults = [
      config.openai.model, config.voiceProfile.analysisModel, config.mem0.llmModel,
      config.imagen.model, config.imagen.adminModel, config.lyria.model
    ];
    for (const d of defaults) expect(DEPRECATED).not.toContain(d);
  });
});
