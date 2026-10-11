import { describe, expect, it } from 'vitest';
import { formatTotals, rsiBadgeText } from './pledge';

describe('pledge formatting', () => {
  it('joins currencies with " + ", USD first', () => {
    expect(formatTotals({ EUR: 50, USD: 1200 })).toBe('$1,200.00 + €50.00');
  });
  it('builds the badge', () => {
    expect(
      rsiBadgeText({ lti: true, pledgeName: 'Standalone Ship - Cutlass', pledgeCost: { amount: 350, currency: 'USD' } }),
    ).toBe('RSI · LTI · Standalone Ship - Cutlass · $350.00');
    expect(rsiBadgeText({ pledgeCost: { amount: null, currency: null, raw: '$??' } })).toBe('RSI · $??');
  });
});
