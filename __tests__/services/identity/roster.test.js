'use strict';
const {
  labelFor, selectRosterMembers, formatRoster, containsWholeWord, ROSTER_HEADING,
} = require('../../../services/identity/roster');

const AKIRA = '161644375040983040';
const BOB = '222';
const CAROL = '333';
const DAVE = '444';

const records = [
  { discordId: AKIRA, addressName: 'Akira', aliases: ['Akirasoft', 'Phalabala'] },
  { discordId: CAROL, addressName: 'Carol', aliases: [] },
  { discordId: DAVE, addressName: null, aliases: ['Aki'] },
];

describe('labelFor', () => {
  test('uses the middle dot with single spaces', () => {
    expect(labelFor({ discordId: AKIRA, name: 'Akira' })).toBe('[Akira · 161644375040983040]');
  });
});

describe('containsWholeWord', () => {
  test('case-insensitive whole word', () => {
    expect(containsWholeWord('hey akira, look', 'Akira')).toBe(true);
    expect(containsWholeWord('@AKIRA!', 'Akira')).toBe(true);
  });
  test('does not match inside a longer word', () => {
    expect(containsWholeWord('ask Akirasoft', 'Aki')).toBe(false);
    expect(containsWholeWord('Akira_bot', 'Akira')).toBe(false);
  });
  test('Unicode-aware boundaries', () => {
    expect(containsWholeWord('ÉloÏse said hi', 'Éloïse')).toBe(true);
    expect(containsWholeWord('xÉloïse', 'Éloïse')).toBe(false);
    expect(containsWholeWord('Zoë', 'Zo')).toBe(false);
  });
  test('regex metacharacters in names are literal', () => {
    expect(containsWholeWord('ping J.R. now', 'J.R')).toBe(true);
    expect(containsWholeWord('ping JxR now', 'J.R')).toBe(false);
  });
});

describe('selectRosterMembers', () => {
  test('current speaker first, then history authors in first-appearance order, then mentioned registry members', () => {
    const ids = selectRosterMembers({
      currentSpeakerId: AKIRA,
      historyDocs: [
        { authorId: BOB, content: 'Akira, what ship should I buy?', isBot: false },
        { authorId: 'bot', content: 'Ask Carol.', isBot: true },
        { authorId: BOB, content: 'ok', isBot: false },
        { authorId: AKIRA, content: 'hi', isBot: false },
      ],
      currentText: 'thanks',
      records,
    });
    expect(ids).toEqual([AKIRA, BOB, CAROL]);
  });

  test('non-participant registry members not mentioned are excluded', () => {
    const ids = selectRosterMembers({
      currentSpeakerId: BOB,
      historyDocs: [{ authorId: BOB, content: 'hello there', isBot: false }],
      currentText: 'anyone?',
      records,
    });
    expect(ids).toEqual([BOB]);
  });

  test('alias match in the current text pulls the member in; "Aki" does not match inside "Akirasoft"', () => {
    const ids = selectRosterMembers({
      currentSpeakerId: BOB, historyDocs: [], currentText: 'is Akirasoft online?', records,
    });
    expect(ids).toEqual([BOB, AKIRA]);
  });

  test('bot authors are never members', () => {
    const ids = selectRosterMembers({
      currentSpeakerId: null,
      historyDocs: [{ authorId: '999', content: 'x', isBot: true }],
      records: [],
    });
    expect(ids).toEqual([]);
  });

  test('docs without authorId are skipped; dedupes', () => {
    const ids = selectRosterMembers({
      currentSpeakerId: BOB,
      historyDocs: [{ content: 'x', isBot: false }, { authorId: BOB, content: 'y' }],
    });
    expect(ids).toEqual([BOB]);
  });

  test('caps at 20 by default', () => {
    const historyDocs = Array.from({ length: 30 }, (_, i) => ({ authorId: `u${i}`, content: 'x', isBot: false }));
    const ids = selectRosterMembers({ currentSpeakerId: 'cur', historyDocs });
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('cur');
  });

  test('tolerates missing/garbage inputs', () => {
    expect(selectRosterMembers({})).toEqual([]);
    expect(selectRosterMembers({ currentSpeakerId: 'a', historyDocs: null, records: null })).toEqual(['a']);
  });
});

describe('formatRoster', () => {
  test('exact block for the spec example', () => {
    const out = formatRoster({
      entries: [{ discordId: AKIRA, name: 'Akira', addressName: 'Akira', aliases: ['Akirasoft', 'Phalabala'] }],
      currentSpeakerId: AKIRA,
    });
    expect(out).toBe([
      '## People in this conversation',
      'Messages are labelled [Name · Discord ID]. "I", "me" and "my" mean the labelled speaker of that message. Use this list only to work out who is who; don\'t mention these aliases unless it matters. Never start your own replies with a label.',
      '- Akira (Discord 161644375040983040) — also called Akirasoft, Phalabala; address as Akira  ← current speaker',
    ].join('\n'));
  });

  test('member without a record shows the resolved name only; aliases equal to name/address are not repeated', () => {
    const out = formatRoster({
      entries: [
        { discordId: BOB, name: 'Bob' },
        { discordId: AKIRA, name: 'Akira', addressName: 'Akira', aliases: ['akira', 'Akirasoft'] },
        { discordId: DAVE, name: 'Dave', addressName: null, aliases: ['Aki'] },
      ],
      currentSpeakerId: BOB,
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe(ROSTER_HEADING);
    expect(lines.slice(2)).toEqual([
      '- Bob (Discord 222)  ← current speaker',
      '- Akira (Discord 161644375040983040) — also called Akirasoft; address as Akira',
      '- Dave (Discord 444) — also called Aki',
    ]);
  });

  test('empty -> empty string', () => {
    expect(formatRoster({ entries: [] })).toBe('');
    expect(formatRoster({})).toBe('');
  });
});
