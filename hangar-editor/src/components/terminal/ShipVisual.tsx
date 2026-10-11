import { useState } from 'react';
import type { LoadoutSlot, VehiclePositions, VehicleSummary } from '../../api/types';
import { slotLabel } from '../../lib/labels';
import { SafeImage } from './SafeImage';

interface Marker {
  slot: string;
  x: number;
  y: number;
}

const finite01 = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Marker points per view, only for slots on this ship that have a 2D view point (xyz is stored, not drawn). */
function markersByView(positions: VehiclePositions | undefined, loadout: LoadoutSlot[]): Map<string, Marker[]> {
  const out = new Map<string, Marker[]>();
  const views = positions?.views ?? {};
  const known = new Set(loadout.map((s) => s.slot));
  for (const [slot, p] of Object.entries(positions?.slots ?? {})) {
    if (!p?.view || !views[p.view] || !known.has(slot) || !finite01(p.x) || !finite01(p.y)) continue;
    const list = out.get(p.view) ?? [];
    list.push({ slot, x: p.x, y: p.y });
    out.set(p.view, list);
  }
  return out;
}

/** Dimmed hero render as backdrop; hardpoint markers over a view image when positions exist. */
export function ShipVisual({
  vehicle,
  positions,
  loadout,
  selected,
  onSelect,
}: {
  vehicle?: VehicleSummary;
  positions?: VehiclePositions;
  loadout: LoadoutSlot[];
  selected: string | null;
  onSelect(slot: string): void;
}) {
  const byView = markersByView(positions, loadout);
  const viewNames = [...byView.keys()];
  const selectedView = viewNames.find((v) => byView.get(v)!.some((m) => m.slot === selected));
  const [chosen, setChosen] = useState<string | null>(null);
  const active = selectedView ?? (chosen && byView.has(chosen) ? chosen : viewNames[0]);
  const view = active ? positions?.views?.[active] : undefined;

  return (
    <div className="t-visual">
      <div className="t-hero" aria-hidden="true">
        <SafeImage src={vehicle?.image} alt="" type="all" context="hero" className="t-hero-img" />
        <span className="t-scan" />
      </div>
      {view && active && (
        <figure className="t-view" style={{ aspectRatio: view.width > 0 && view.height > 0 ? `${view.width} / ${view.height}` : undefined }}>
          <SafeImage src={view.imageUrl} alt={`${active} view`} type="all" context="positions-view" className="t-view-img" />
          {byView.get(active)!.map((m) => {
            const on = m.slot === selected;
            return (
              <button
                key={m.slot}
                type="button"
                data-testid="port-marker"
                className={`t-marker${on ? ' is-selected' : ''}`}
                style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
                aria-pressed={on}
                aria-label={`Select port ${slotLabel(m.slot)}`}
                title={slotLabel(m.slot)}
                onClick={() => onSelect(m.slot)}
              />
            );
          })}
          {viewNames.length > 1 && (
            <figcaption className="t-view-switch">
              {viewNames.map((v) => (
                <button key={v} type="button" className={`t-chip${v === active ? ' is-active' : ''}`} aria-pressed={v === active} onClick={() => setChosen(v)}>
                  {v}
                </button>
              ))}
            </figcaption>
          )}
        </figure>
      )}
    </div>
  );
}
