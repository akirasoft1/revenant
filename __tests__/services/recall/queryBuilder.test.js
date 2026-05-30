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

describe('queryBuilder: llm-condense', () => {
  const msgs = ['talked about the deploy', 'and the sort change', 'what was the benchmark again'];

  it('uses the condenser output when provided', async () => {
    const condenser = jest.fn().mockResolvedValue('  sort benchmark results  ');
    const q = await buildQuery(msgs, { strategy: 'llm-condense', condenser });
    expect(condenser).toHaveBeenCalled();
    expect(q).toBe('sort benchmark results');
  });

  it('falls back to last message when no condenser given', async () => {
    expect(await buildQuery(msgs, { strategy: 'llm-condense' })).toBe('what was the benchmark again');
  });

  it('falls back to last message when condenser throws', async () => {
    const condenser = jest.fn().mockRejectedValue(new Error('llm down'));
    expect(await buildQuery(msgs, { strategy: 'llm-condense', condenser })).toBe('what was the benchmark again');
  });
});
