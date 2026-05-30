// __tests__/services/recall/evalMetrics.test.js
const { precisionAtN, ndcgAtN } = require('../../../services/recall/evalMetrics');

describe('evalMetrics', () => {
  it('precisionAtN counts expected keys in the top N', () => {
    expect(precisionAtN(['a', 'b', 'c'], new Set(['b', 'c']), 3)).toBeCloseTo(2 / 3);
    expect(precisionAtN(['a', 'b'], new Set(['x']), 2)).toBe(0);
  });

  it('ndcgAtN rewards expected keys ranked higher', () => {
    const expected = new Set(['a']);
    const top = ndcgAtN(['a', 'b', 'c'], expected, 3);
    const bottom = ndcgAtN(['b', 'c', 'a'], expected, 3);
    expect(top).toBeGreaterThan(bottom);
    expect(top).toBeCloseTo(1);
  });
});
