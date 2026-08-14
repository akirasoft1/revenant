// __tests__/recall-config.test.js
describe('recall config', () => {
  beforeEach(() => { jest.resetModules(); });

  afterEach(() => {
    delete process.env.RECALL_V2_ENABLED;
    delete process.env.RECALL_MAX_ITEMS;
  });

  it('provides sane defaults', () => {
    delete process.env.RECALL_V2_ENABLED;
    const config = require('../config/config');
    expect(config.recall.enabled).toBe(false);
    expect(config.recall.maxItems).toBe(8);
    expect(config.recall.halfLifeDays).toBe(14);
    expect(config.recall.queryStrategy).toBe('recent-window');
    expect(config.recall.sourceWeights['mem0:explicit']).toBeGreaterThan(
      config.recall.sourceWeights['channel:semantic']
    );
    expect(config.recall.promptMaxTokens).toBe(4000);
  });

  it('reads overrides from env', () => {
    process.env.RECALL_V2_ENABLED = 'true';
    process.env.RECALL_MAX_ITEMS = '12';
    const config = require('../config/config');
    expect(config.recall.enabled).toBe(true);
    expect(config.recall.maxItems).toBe(12);
  });
});

describe('VOICE_SPEAKER_NAMES config (FIX 3)', () => {
  beforeEach(() => { jest.resetModules(); });
  afterEach(() => { delete process.env.VOICE_SPEAKER_NAMES; });

  it('parses valid JSON overrides', () => {
    process.env.VOICE_SPEAKER_NAMES = '{"u1":"Mike"}';
    const config = require('../config/config');
    expect(config.voice.speakerNames).toEqual({ u1: 'Mike' });
  });

  it('fails closed to an empty table AND warns on malformed JSON, naming the env var', () => {
    process.env.VOICE_SPEAKER_NAMES = '{not valid json';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const config = require('../config/config');
    expect(config.voice.speakerNames).toEqual({}); // fail-closed behaviour unchanged
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('VOICE_SPEAKER_NAMES'));
    warnSpy.mockRestore();
  });
});
