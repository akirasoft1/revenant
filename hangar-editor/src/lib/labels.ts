import type { ItemRef, MemberSummary, Me } from '../api/types';

/** Turn a slot id like `hardpoint_turret_base_upper/hardpoint_weapon_left` into something readable. */
export function slotLabel(slot: string): string {
  return slot
    .split('/')
    .map((part) =>
      part
        .replace(/^hardpoint_/, '')
        .replace(/_/g, ' ')
        .trim(),
    )
    .join(' › ');
}

const TYPE_LABELS: Record<string, string> = {
  WeaponGun: 'Guns',
  Turret: 'Turrets',
  MissileLauncher: 'Missile racks',
  QuantumDrive: 'Quantum drive',
  Shield: 'Shields',
  PowerPlant: 'Power plants',
  Cooler: 'Coolers',
  Radar: 'Radar',
  WeaponMining: 'Mining',
  TractorBeam: 'Tractor beams',
};

/** Display order of slot groups on the ship page. */
export const TYPE_ORDER = [
  'WeaponGun',
  'Turret',
  'MissileLauncher',
  'Shield',
  'PowerPlant',
  'Cooler',
  'QuantumDrive',
  'Radar',
  'WeaponMining',
  'TractorBeam',
];

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/([a-z])([A-Z])/g, '$1 $2');
}

const SKIP_REASONS: Record<string, string> = {
  untracked_slot: 'Slot not tracked by the hangar',
  unknown_item: 'Item not found in the catalog',
  incompatible: 'Item does not fit this slot',
  unknown_vehicle: 'Ship not found in the catalog',
  unrecognized_format: 'Could not read this loadout',
  too_large: 'Loadout data too large',
  empty_slot: 'Emptied in spviewer — the hangar keeps the stock item',
  too_many_lookups: 'Too many different items in this file — split it up and import again',
};

export function skipReasonLabel(reason: string): string {
  return SKIP_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

export function itemName(ref: ItemRef | string | null | undefined): string {
  if (ref == null || ref === '') return 'empty';
  return typeof ref === 'string' ? ref : ref.name || ref.uuid;
}

export function memberName(m: MemberSummary, me?: Me | null): string {
  if (me && m.discordId === me.discordId) return me.globalName || me.username;
  return m.displayName || m.discordId;
}
