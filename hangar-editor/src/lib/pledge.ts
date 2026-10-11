import type { PledgeCost, RsiInfo } from '../api/types';

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`; // not an ISO code
  }
}

export function formatCost(cost: PledgeCost | null | undefined): string | null {
  if (!cost || cost.amount == null || !cost.currency) return cost?.raw ?? null;
  return formatMoney(cost.amount, cost.currency);
}

/** "$1,200.00 + €50.00": one amount per currency, no FX. USD first. */
export function formatTotals(totals: Record<string, number>): string {
  return Object.entries(totals)
    .sort(([a], [b]) => (a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b)))
    .map(([cur, amt]) => formatMoney(amt, cur))
    .join(' + ');
}

/** "RSI · LTI · Aegis Warbond · $350.00" */
export function rsiBadgeText(rsi: RsiInfo): string {
  const parts = ['RSI'];
  if (rsi.lti) parts.push('LTI');
  if (rsi.warbond) parts.push('Warbond');
  if (rsi.pledgeName) parts.push(rsi.pledgeName);
  const cost = formatCost(rsi.pledgeCost);
  if (cost) parts.push(cost);
  return parts.join(' · ');
}
