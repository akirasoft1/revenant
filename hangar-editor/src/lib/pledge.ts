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

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** True when every word of the ship's model name appears in the pledge name
 *  ("Constellation Taurus" is in "Standalone Ships - Constellation Mk IV Taurus"). */
function pledgeNamesShip(pledgeName: string, shipName: string): boolean {
  const have = new Set(words(pledgeName));
  const need = words(shipName);
  return need.length > 0 && need.every((w) => have.has(w));
}

/** "RSI · LTI · Aegis Warbond · $350.00". With the ship's model name, a pledge
 *  title that names some OTHER ship reads "pledged as …": RSI never renames a
 *  pledge after a CCU (an Ironclad Assault still sits in "Standalone Ships -
 *  Constellation Aquila"), and package titles ("Arbiter - LTI") name no ship. */
export function rsiBadgeText(rsi: RsiInfo, shipName?: string | null): string {
  const parts = ['RSI'];
  if (rsi.lti) parts.push('LTI');
  if (rsi.warbond) parts.push('Warbond');
  const pledgeName = rsi.pledgeName?.trim();
  if (pledgeName) {
    parts.push(shipName && !pledgeNamesShip(pledgeName, shipName) ? `pledged as ${pledgeName}` : pledgeName);
  }
  const cost = formatCost(rsi.pledgeCost);
  if (cost) parts.push(cost);
  return parts.join(' · ');
}
