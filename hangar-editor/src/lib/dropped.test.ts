import { describe, expect, it } from 'vitest';
import { droppedNotice, parseDropped } from './dropped';

describe('parseDropped', () => {
  it('reads {slot, item: {name}} and {slot, itemName} entries from `dropped`', () => {
    const body = {
      ship: { shipId: 's' },
      dropped: [
        { slot: 'hardpoint_weapon_center/hardpoint_weapon_S3_left', item: { uuid: 'g1', name: 'Mantis GT-220' } },
        { slot: 'hardpoint_weapon_center/hardpoint_weapon_S3_right', itemName: 'Mantis GT-220' },
      ],
    };
    expect(parseDropped(body)).toEqual([
      { slot: 'hardpoint_weapon_center/hardpoint_weapon_S3_left', name: 'Mantis GT-220' },
      { slot: 'hardpoint_weapon_center/hardpoint_weapon_S3_right', name: 'Mantis GT-220' },
    ]);
  });

  it('tolerates a plain item name, a `from` ref and a missing name', () => {
    expect(
      parseDropped({
        dropped: [
          { slot: 'a', item: 'Panther' },
          { slot: 'b', from: { name: 'Omnisky' } },
          { slot: 'c', name: 'Bulldog' },
          { slot: 'd' },
        ],
      }),
    ).toEqual([
      { slot: 'a', name: 'Panther' },
      { slot: 'b', name: 'Omnisky' },
      { slot: 'c', name: 'Bulldog' },
      { slot: 'd', name: null },
    ]);
  });

  it('returns nothing for an absent or malformed field, and skips entries without a slot', () => {
    expect(parseDropped(undefined)).toEqual([]);
    expect(parseDropped(null)).toEqual([]);
    expect(parseDropped({ ship: {} })).toEqual([]);
    expect(parseDropped({ dropped: 'nope' })).toEqual([]);
    expect(parseDropped({ dropped: [null, 3, 'x', { item: { name: 'no slot' } }, { slot: '' }, { slot: 7 }] })).toEqual([]);
  });
});

describe('droppedNotice', () => {
  it('is null when nothing was dropped', () => {
    expect(droppedNotice([])).toBeNull();
  });

  it('names each removed item with its readable slot', () => {
    expect(
      droppedNotice([
        { slot: 'hardpoint_weapon_center/hardpoint_weapon_S3_left', name: 'Mantis GT-220' },
        { slot: 'hardpoint_weapon_center/hardpoint_weapon_S3_right', name: null },
      ]),
    ).toBe(
      'Also removed 2 fittings that no longer fit: Mantis GT-220 (weapon center › weapon S3 left), weapon center › weapon S3 right.',
    );
    expect(droppedNotice([{ slot: 'hardpoint_nose/hardpoint_class_2', name: 'M4A Cannon' }])).toBe(
      'Also removed 1 fitting that no longer fits: M4A Cannon (nose › class 2).',
    );
  });
});
