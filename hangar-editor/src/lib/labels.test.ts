import { describe, expect, it } from 'vitest';
import { slotLabel } from './labels';

describe('slotLabel', () => {
  it('reads nested slots as parent › child at any depth', () => {
    expect(slotLabel('hardpoint_quantum_drive')).toBe('quantum drive');
    expect(slotLabel('hardpoint_turret_base_upper/hardpoint_weapon_left/hardpoint_class_2')).toBe(
      'turret base upper › weapon left › class 2',
    );
  });

  it('labels the ports of a fitted turret (item-owned slots)', () => {
    expect(slotLabel('hardpoint_weapon_center/hardpoint_weapon_S3_left')).toBe('weapon center › weapon S3 left');
    expect(slotLabel('hardpoint_weapon_nose/hardpoint_weapon_S1_right')).toBe('weapon nose › weapon S1 right');
  });
});
