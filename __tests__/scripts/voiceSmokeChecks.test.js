// __tests__/scripts/voiceSmokeChecks.test.js
// Pure verdict helpers shared by the real-model voice smoke scripts
// (scripts/smoke-voice-identity.js, scripts/smoke-voice-sc.js). The smokes
// themselves need a live Gemini Live session; these checks don't.

const {
  CITATION_RE,
  findCitationLeaks,
  mentionsName,
  speakerKnownVerdict,
  nameRate,
} = require('../../scripts/lib/voiceSmokeChecks');

describe('findCitationLeaks', () => {
  test('flags bracketed numeric citations', () => {
    expect(CITATION_RE.test('It is sunny [1].')).toBe(true);
    expect(findCitationLeaks(['It is sunny [1].', 'Also windy [1, 3]', 'fine [ 2 ,4 ]']))
      .toEqual(['It is sunny [1].', 'Also windy [1, 3]', 'fine [ 2 ,4 ]']);
  });

  test('ignores brackets that are not numeric citations', () => {
    expect(findCitationLeaks(['a size [S2] shield', 'no brackets here', 'ratio 1, 3', '[]'])).toEqual([]);
  });

  test('catches a citation split across transcript fragments', () => {
    const leaks = findCitationLeaks(['The radar is sold at Area18 [1', ', 3]. It costs']);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toContain('[1, 3]');
  });

  test('empty input has no leaks', () => {
    expect(findCitationLeaks([])).toEqual([]);
  });
});

describe('mentionsName', () => {
  test('whole-word, case-insensitive', () => {
    expect(mentionsName('Hi sarah!', 'Sarah')).toBe(true);
    expect(mentionsName('Sarahs', 'Sarah')).toBe(false);
  });
});

describe('speakerKnownVerdict', () => {
  test('passes when the reply names the asker and not the other speaker', () => {
    expect(speakerKnownVerdict("You're Sarah!", 'Sarah', 'Mike'))
      .toEqual({ pass: true, hasExpected: true, hasOther: false });
  });

  test('fails when the other speaker is named', () => {
    expect(speakerKnownVerdict('You are Mike, or maybe Sarah', 'Sarah', 'Mike').pass).toBe(false);
  });

  test('fails on an empty or nameless reply', () => {
    expect(speakerKnownVerdict('', 'Sarah', 'Mike').pass).toBe(false);
    expect(speakerKnownVerdict("I don't know your name", 'Sarah', 'Mike').pass).toBe(false);
  });
});

describe('nameRate', () => {
  test('counts replies that use the addressed speaker\'s name, skipping empty replies', () => {
    const r = nameRate([
      { name: 'Mike', text: 'Sure Mike, it is sunny.' },
      { name: 'Sarah', text: 'Why did the robot...' },
      { name: 'Sarah', text: '' },
    ]);
    expect(r).toEqual({ used: 1, total: 2, overuse: false });
  });

  test('flags overuse above two thirds', () => {
    expect(nameRate([
      { name: 'Mike', text: 'Mike, yes.' },
      { name: 'Sarah', text: 'Sarah, no.' },
      { name: 'Mike', text: 'ok Mike' },
    ]).overuse).toBe(true);
    expect(nameRate([
      { name: 'Mike', text: 'Mike, yes.' },
      { name: 'Sarah', text: 'Sarah, no.' },
      { name: 'Mike', text: 'ok' },
    ]).overuse).toBe(false); // exactly 2/3 is not overuse
  });

  test('no replies -> 0/0, not overuse', () => {
    expect(nameRate([])).toEqual({ used: 0, total: 0, overuse: false });
  });
});
