import { describe, expect, it } from 'vitest';
import type { LoadoutSlot, SlotDef } from '../api/types';
import { stockBySlot } from './stock';

const vslot = (slot: string, uuid: string | null): SlotDef =>
  ({ slot, type: 'WeaponGun', subType: null, sizeMin: 4, sizeMax: 4, compatibleTypes: [], stockItem: uuid ? { uuid, name: `stock ${uuid}` } : null }) as SlotDef;
const lslot = (slot: string, over: Partial<LoadoutSlot> = {}): LoadoutSlot => ({
  slot,
  type: 'WeaponGun',
  sizeMin: 4,
  sizeMax: 4,
  compatibleTypes: [],
  item: null,
  source: 'stock',
  ...over,
});

describe('stockBySlot', () => {
  it('vehicle slots take their stock from the catalog', () => {
    const m = stockBySlot([vslot('wing/hardpoint_class_2', 'rev'), vslot('nose', null)], [lslot('wing/hardpoint_class_2'), lslot('nose')]);
    expect(m.get('wing/hardpoint_class_2')).toEqual({ uuid: 'rev', name: 'stock rev' });
    expect(m.get('nose')).toBeNull();
  });

  it('a dynamic slot never shows the vehicle’s stock, even when its id coincides with a vehicle slot', () => {
    const m = stockBySlot(
      [vslot('wing/hardpoint_class_2', 'rev')],
      [lslot('wing/hardpoint_class_2', { dynamic: true, source: 'fitted', item: { uuid: 'ad4b', name: 'AD4B' } })],
    );
    expect(m.get('wing/hardpoint_class_2')).toBeNull();
  });

  it('a dynamic slot still holding the fitted item’s default shows that as stock; an empty one shows none', () => {
    const m = stockBySlot(
      [],
      [
        lslot('center/left', { dynamic: true, item: { uuid: 'gimbal', name: 'TMSB-5 Gimbal Mount' } }),
        lslot('center/left/hardpoint_class_2', { dynamic: true }),
      ],
    );
    expect(m.get('center/left')).toEqual({ uuid: 'gimbal', name: 'TMSB-5 Gimbal Mount' });
    expect(m.get('center/left/hardpoint_class_2')).toBeNull();
  });

  it('copes with nothing loaded yet', () => {
    expect(stockBySlot(undefined, null).size).toBe(0);
  });
});
