import type { LoadoutSlot, VehiclePositions } from '../../api/types';
import { slotLabel } from '../../lib/labels';

/** One hardpoint in the wireframe: `id` is the slot id, `xyz` is glTF Y-up metres (the bundle's space). */
export interface WireMarker {
  id: string;
  label: string;
  xyz: [number, number, number];
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

type Xyz = [number, number, number];

function ownXyz(slots: NonNullable<VehiclePositions['slots']>, id: string): Xyz | null {
  const xyz = slots[id]?.xyz;
  if (!Array.isArray(xyz) || xyz.length !== 3 || !xyz.every(finite)) return null;
  return [xyz[0], xyz[1], xyz[2]];
}

/**
 * Markers for the slots on this ship that have a 3D position, in loadout order.
 * A slot with no position of its own borrows its nearest ancestor's (walking the
 * `/`-separated id upward): the ports of a fitted turret are not nodes of the
 * ship's model, so its gun slots sit on the turret's marker. Several slots may
 * share one point (ids stay distinct); a slot with no positioned ancestor gets
 * no marker.
 */
export function buildMarkers(positions: VehiclePositions | undefined, loadout: LoadoutSlot[]): WireMarker[] {
  const slots = positions?.slots;
  if (!slots) return [];
  const out: WireMarker[] = [];
  for (const s of loadout) {
    let xyz: Xyz | null = null;
    for (let id = s.slot; ; id = id.slice(0, id.lastIndexOf('/'))) {
      xyz = ownXyz(slots, id);
      if (xyz || !id.includes('/')) break;
    }
    if (xyz) out.push({ id: s.slot, label: slotLabel(s.slot), xyz });
  }
  return out;
}
