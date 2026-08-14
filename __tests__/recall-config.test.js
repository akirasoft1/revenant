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

// A typo here used to become a 0ms qualification bar (parseInt('0.7s') === 0,
// parseInt('seven hundred') === NaN, and the consumer's `x || 0` finished the
// job), and `>= 0` is true for EVERY named waiting speaker on their first speech
// frame -- the design's top-listed risk, from one bad character.
describe('VOICE_DEFERRAL_MIN_SPEECH_MS config', () => {
  beforeEach(() => { jest.resetModules(); });
  afterEach(() => { delete process.env.VOICE_DEFERRAL_MIN_SPEECH_MS; });

  it('defaults to 700ms when unset', () => {
    delete process.env.VOICE_DEFERRAL_MIN_SPEECH_MS;
    const config = require('../config/config');
    expect(config.voice.deferralMinSpeechMs).toBe(700);
  });

  it('reads a valid numeric override', () => {
    process.env.VOICE_DEFERRAL_MIN_SPEECH_MS = '450';
    const config = require('../config/config');
    expect(config.voice.deferralMinSpeechMs).toBe(450);
  });

  it.each([
    ['0.7s', 'a unit suffix parseInt would silently truncate to 0'],
    ['seven hundred', 'a non-numeric string'],
    ['0', 'an explicit zero -- announce-everyone'],
    ['-1', 'a negative threshold'],
  ])('falls back to 700 and warns for %s (%s)', (value) => {
    process.env.VOICE_DEFERRAL_MIN_SPEECH_MS = value;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const config = require('../config/config');
    expect(config.voice.deferralMinSpeechMs).toBe(700);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('VOICE_DEFERRAL_MIN_SPEECH_MS'));
    warnSpy.mockRestore();
  });
});
