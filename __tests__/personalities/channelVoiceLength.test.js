// channel-voice length rules: short by default, long when asked.
//
// The persona was tuned to "1-3 sentences", with no exception. On 2026-10-25
// a request for "a guide of all wikelo items to buy in stanton, in order, and
// then in pyro", followed by "can you elaborate on this with an ordered list
// formatted for Discord", got a four-line list with almost no supporting
// detail. Explicit requests for detail must override the default.
const channelVoice = require('../../personalities/channel-voice');

const prompt = channelVoice.systemPrompt;
const lower = prompt.toLowerCase();

describe('channel-voice response length', () => {
  test('short replies stay the default', () => {
    expect(prompt).toContain('1-3 sentences');
    expect(lower).toContain('by default');
  });

  test('an explicit request for detail lifts the length limit', () => {
    for (const trigger of ['guide', 'elaborate', 'step-by-step', 'full list', 'in detail', 'breakdown']) {
      expect(lower).toContain(trigger);
    }
    // follow-ups that ask to expand an earlier answer count too
    expect(lower).toMatch(/expand|go deeper|more detail/);
    expect(lower).toMatch(/drop the length limit|length limit does not apply/);
  });

  test('a long-form reply is complete and carries supporting specifics', () => {
    expect(lower).toMatch(/every relevant item|cover everything/);
    expect(lower).toMatch(/supporting (detail|specifics)/);
    // e.g. where, what it costs, quantities, why this order
    expect(lower).toContain('why');
  });

  test('long-form text replies use Discord formatting and are never cut short for size', () => {
    expect(lower).toContain('discord markdown');
    expect(lower).toMatch(/split automatically|split into several messages/);
  });

  test('requested detail is not "unsolicited information"', () => {
    expect(lower).toMatch(/volunteer unsolicited information[^\n]*\(detail someone asked for is not unsolicited\)/);
  });

  test('voice turns stay spoken (no markdown) even when detail is requested', () => {
    expect(lower).toMatch(/(in|on) voice[^\n]*(spoken|out loud|aloud)/);
  });

  test('the {VOICE_INSTRUCTIONS} placeholder is still present', () => {
    expect(prompt).toContain('{VOICE_INSTRUCTIONS}');
  });
});
