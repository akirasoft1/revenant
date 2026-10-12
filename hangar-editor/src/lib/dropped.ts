// Child fittings the server removed because their parent slot changed (a refit
// or reset of a turret drops the guns that no longer have a port, or no longer
// fit). The ONE place that knows the wire shape of that list.
import { slotLabel } from './labels';

export interface DroppedFitting {
  slot: string;
  /** The removed item's name, when the server gave one. */
  name: string | null;
}

/** Field of the fit/reset response that carries the list. */
const DROPPED_FIELD = 'dropped';

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function refName(v: unknown): string | null {
  if (v && typeof v === 'object') return text((v as Record<string, unknown>).name);
  return text(v);
}

/**
 * Dropped fittings from a fit/reset response body. Accepts `{slot, item: {name}}`
 * and `{slot, itemName}` (also a plain `item`/`name` string or a `from` ref);
 * anything else — an absent field, a non-array, an entry without a slot — is
 * ignored, so an older server simply reports nothing.
 */
export function parseDropped(body: unknown): DroppedFitting[] {
  if (!body || typeof body !== 'object') return [];
  const list = (body as Record<string, unknown>)[DROPPED_FIELD];
  if (!Array.isArray(list)) return [];
  const out: DroppedFitting[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const slot = text(e.slot);
    if (!slot) continue;
    out.push({ slot, name: refName(e.item) ?? text(e.itemName) ?? text(e.name) ?? refName(e.from) });
  }
  return out;
}

/** One sentence naming what was removed, or `null` when nothing was. */
export function droppedNotice(dropped: DroppedFitting[]): string | null {
  if (dropped.length === 0) return null;
  const names = dropped.map((d) => (d.name ? `${d.name} (${slotLabel(d.slot)})` : slotLabel(d.slot)));
  const head = dropped.length === 1 ? '1 fitting that no longer fits' : `${dropped.length} fittings that no longer fit`;
  return `Also removed ${head}: ${names.join(', ')}.`;
}
