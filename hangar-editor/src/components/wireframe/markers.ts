import type { LoadoutSlot, VehiclePositions } from '../../api/types';
import { slotLabel } from '../../lib/labels';

/** One hardpoint in the wireframe: `id` is the slot id, `xyz` is glTF Y-up metres (the bundle's space). */
export interface WireMarker {
  id: string;
  label: string;
  xyz: [number, number, number];
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Markers for the slots on this ship that have a 3D position, in loadout order. */
export function buildMarkers(positions: VehiclePositions | undefined, loadout: LoadoutSlot[]): WireMarker[] {
  const slots = positions?.slots;
  if (!slots) return [];
  const out: WireMarker[] = [];
  for (const s of loadout) {
    const xyz = slots[s.slot]?.xyz;
    if (!Array.isArray(xyz) || xyz.length !== 3 || !xyz.every(finite)) continue;
    out.push({ id: s.slot, label: slotLabel(s.slot), xyz: [xyz[0], xyz[1], xyz[2]] });
  }
  return out;
}
