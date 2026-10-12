import { describe, expect, it } from 'vitest';
import type { LoadoutSlot, VehiclePositions } from '../../api/types';
import { buildMarkers } from './markers';

const slot = (s: string): LoadoutSlot => ({
  slot: s,
  type: 'WeaponGun',
  sizeMin: 2,
  sizeMax: 2,
  compatibleTypes: [],
  item: null,
  source: 'stock',
});

const LOADOUT = [slot('hardpoint_nose/hardpoint_class_2'), slot('hardpoint_quantum_drive'), slot('hardpoint_radar')];

describe('buildMarkers', () => {
  it('builds a marker for each loadout slot that has a finite xyz, labelled with slotLabel, in loadout order', () => {
    const positions: VehiclePositions = {
      space: 'gltf-y-up-m',
      source: 'extracted',
      slots: {
        hardpoint_quantum_drive: { xyz: [0, 1, 2] },
        'hardpoint_nose/hardpoint_class_2': { xyz: [-1.5, 0, -15] },
      },
    };
    expect(buildMarkers(positions, LOADOUT)).toEqual([
      { id: 'hardpoint_nose/hardpoint_class_2', label: 'nose › class 2', xyz: [-1.5, 0, -15] },
      { id: 'hardpoint_quantum_drive', label: 'quantum drive', xyz: [0, 1, 2] },
    ]);
  });

  it('skips slots not in the loadout, 2D-only points and malformed xyz', () => {
    const positions = {
      slots: {
        hardpoint_gone: { xyz: [1, 2, 3] },
        hardpoint_quantum_drive: { view: 'top', x: 0.5, y: 0.5 },
        hardpoint_radar: { xyz: [1, NaN, 3] },
        'hardpoint_nose/hardpoint_class_2': { xyz: [1, 2] },
      },
    } as unknown as VehiclePositions;
    expect(buildMarkers(positions, LOADOUT)).toEqual([]);
    expect(buildMarkers({ slots: { hardpoint_radar: { xyz: ['1', 2, 3] } } } as unknown as VehiclePositions, LOADOUT)).toEqual([]);
    expect(buildMarkers({ slots: { hardpoint_radar: null } } as unknown as VehiclePositions, LOADOUT)).toEqual([]);
  });

  it('a slot with no xyz of its own uses its nearest positioned ancestor (ids stay distinct)', () => {
    const loadout = [
      slot('hardpoint_weapon_center'),
      slot('hardpoint_weapon_center/hardpoint_weapon_S3_left'),
      slot('hardpoint_weapon_center/hardpoint_weapon_S3_right'),
      slot('hardpoint_turret/hardpoint_gimbal/hardpoint_class_2'),
      slot('hardpoint_orphan/hardpoint_class_1'),
    ];
    const positions: VehiclePositions = {
      slots: {
        hardpoint_weapon_center: { xyz: [0, 1, -4] },
        // Own position wins over the ancestor's.
        'hardpoint_weapon_center/hardpoint_weapon_S3_right': { xyz: [0.5, 1, -4] },
        // Two levels up; the malformed middle node is skipped.
        hardpoint_turret: { xyz: [3, 2, 1] },
        'hardpoint_turret/hardpoint_gimbal': { xyz: [1, NaN, 3] },
      },
    };
    const markers = buildMarkers(positions, loadout);
    expect(markers).toEqual([
      { id: 'hardpoint_weapon_center', label: 'weapon center', xyz: [0, 1, -4] },
      { id: 'hardpoint_weapon_center/hardpoint_weapon_S3_left', label: 'weapon center › weapon S3 left', xyz: [0, 1, -4] },
      { id: 'hardpoint_weapon_center/hardpoint_weapon_S3_right', label: 'weapon center › weapon S3 right', xyz: [0.5, 1, -4] },
      { id: 'hardpoint_turret/hardpoint_gimbal/hardpoint_class_2', label: 'turret › gimbal › class 2', xyz: [3, 2, 1] },
    ]);
    // Borrowed positions are copies too.
    markers[1].xyz[0] = 99;
    expect(markers[0].xyz[0]).toBe(0);
    expect(positions.slots!.hardpoint_weapon_center.xyz![0]).toBe(0);
  });

  it('returns nothing for missing or empty positions', () => {
    expect(buildMarkers(undefined, LOADOUT)).toEqual([]);
    expect(buildMarkers({}, LOADOUT)).toEqual([]);
  });

  it('copies xyz so callers cannot mutate the cached positions', () => {
    const positions: VehiclePositions = { slots: { hardpoint_radar: { xyz: [1, 2, 3] } } };
    const [m] = buildMarkers(positions, LOADOUT);
    m.xyz[0] = 99;
    expect(positions.slots!.hardpoint_radar.xyz![0]).toBe(1);
  });
});
