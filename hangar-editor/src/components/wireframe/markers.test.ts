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
