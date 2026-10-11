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
  it('names the pledge as-is when it mentions the ship the member has', () => {
    const rsi = { pledgeName: 'Standalone Ships - Vanguard Harbinger ', pledgeCost: { amount: 290, currency: 'USD' } };
    expect(rsiBadgeText(rsi, 'Vanguard Harbinger')).toBe('RSI · Standalone Ships - Vanguard Harbinger · $290.00');
    // word-level match, not substring: "Constellation Taurus" is in "Constellation Mk IV Taurus"
    expect(rsiBadgeText({ pledgeName: 'Standalone Ships - Constellation Mk IV Taurus' }, 'Constellation Taurus')).toBe(
      'RSI · Standalone Ships - Constellation Mk IV Taurus',
    );
  });
  it('says "pledged as" when the pledge names a different ship (CCU) or a package', () => {
    // RSI never renames a pledge after a CCU: this Ironclad sits in the original Aquila pledge
    const ccu = { pledgeName: 'Standalone Ships - Constellation Aquila', pledgeCost: { amount: 650, currency: 'USD' } };
    expect(rsiBadgeText(ccu, 'Ironclad Assault')).toBe(
      'RSI · pledged as Standalone Ships - Constellation Aquila · $650.00',
    );
    expect(rsiBadgeText({ lti: true, pledgeName: 'Arbiter - LTI' }, 'F7C Hornet Mk II')).toBe(
      'RSI · LTI · pledged as Arbiter - LTI',
    );
  });
  it('keeps the old form when no ship name is given', () => {
    expect(rsiBadgeText({ pledgeName: 'Standalone Ships - Constellation Aquila' })).toBe(
      'RSI · Standalone Ships - Constellation Aquila',
    );
  });
});
