// __tests__/services/recall/queryBuilder.test.js
const { buildQuery } = require('../../../services/recall/queryBuilder');

describe('queryBuilder', () => {
  const msgs = ['first message', 'second message', 'third message', 'current message'];

  it('last-message returns the final message', async () => {
    expect(await buildQuery(msgs, { strategy: 'last-message' })).toBe('current message');
  });

  it('recent-window joins the last N messages', async () => {
    expect(await buildQuery(msgs, { strategy: 'recent-window', windowSize: 2 }))
      .toBe('third message\ncurrent message');
  });

  it('returns empty string for empty input', async () => {
    expect(await buildQuery([], { strategy: 'recent-window' })).toBe('');
  });
});
