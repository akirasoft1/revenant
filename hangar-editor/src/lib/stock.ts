import type { LoadoutSlot, StockItem, SlotDef } from '../api/types';

/**
 * The stock item of every slot of a ship. A slot of the stock vehicle takes its
 * stock from the catalog. A `dynamic` slot (a port of a FITTED item, e.g. a
 * turret's gun mount) is not in the catalog's vehicle slots, and its id can
 * even coincide with one (a refitted gimbal keeps `…/hardpoint_class_2`), so the
 * vehicle's stock must not be shown for it: its stock is whatever the fitted
 * item carries in that port — the slot's own item while it is still `stock`,
 * and unknown (none) once the member has fitted something there.
 */
export function stockBySlot(vehicleSlots: SlotDef[] | undefined, loadout: LoadoutSlot[] | null | undefined): Map<string, StockItem | null> {
  const out = new Map<string, StockItem | null>((vehicleSlots ?? []).map((s) => [s.slot, s.stockItem]));
  for (const s of loadout ?? []) {
    if (!s.dynamic) continue;
    const own = s.source === 'stock' && s.item?.uuid ? { uuid: s.item.uuid, name: s.item.name ?? '' } : null;
    out.set(s.slot, own);
  }
  return out;
}
