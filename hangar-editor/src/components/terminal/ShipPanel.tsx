import { useState } from 'react';
import type { LoadoutSlot, VehiclePositions, VehicleSummary } from '../../api/types';
import { slotLabel } from '../../lib/labels';
import { TypeIcon } from './icons';
import { SafeImage } from './SafeImage';
import { ShipStatsSidebar } from './ShipStatsSidebar';

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

/**
 * CSS aspect ratio for a view figure. The figure is sized to the image's own
 * shape (width-fitted; the panel scrolls if it is taller) and the image fills it
 * exactly, so a marker's x/y percentages land on the rendered image — never on a
 * letterboxed box. Unknown dimensions: no ratio, the figure wraps the image.
 */
export function viewAspectRatio(view: { width: number; height: number }): string | undefined {
  return view.width > 0 && view.height > 0 ? `${view.width} / ${view.height}` : undefined;
}

/**
 * The framed ship panel at the top of the right column: the whole vehicle render
 * at full strength (`contain`, never cropped) over a blurred `cover` copy of itself (or, when hardpoint positions exist, the view image with its
 * markers), the ship stats as a top-right overlay and the model name bottom-left.
 */
export function ShipPanel({
  vehicle,
  modelName,
  positions,
  loadout,
  selected,
  onSelect,
}: {
  vehicle?: VehicleSummary;
  modelName: string;
  positions?: VehiclePositions;
  loadout: LoadoutSlot[];
  selected: string | null;
  onSelect(slot: string): void;
}) {
  const byView = markersByView(positions, loadout);
  const viewNames = [...byView.keys()];
  const selectedView = viewNames.find((v) => byView.get(v)!.some((m) => m.slot === selected));
  // The user's chosen view wins; it is dropped only when the selection moves to a
  // port whose marker lives in a different view (a markerless port keeps it).
  const [chosen, setChosen] = useState<string | null>(null);
  const [prevSelected, setPrevSelected] = useState(selected);
  if (selected !== prevSelected) {
    setPrevSelected(selected);
    if (chosen && selectedView && selectedView !== chosen) setChosen(null);
  }
  const active = chosen && byView.has(chosen) ? chosen : (selectedView ?? viewNames[0]);
  const view = active ? positions?.views?.[active] : undefined;
  const manufacturer = vehicle?.manufacturer;
  // The blurred backdrop is a decorative copy of the same render; it is drawn only
  // while the foreground image is good (the foreground alone reports failures).
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const hero = vehicle?.image;
  const backdrop = hero && hero !== failedSrc ? hero : null;

  return (
    <div className={`t-shippanel t-frame${view ? ' has-view' : ''}`} data-testid="ship-panel">
      {view && active ? (
        <div className="t-shippanel-scroll">
          <figure className="t-view" data-testid="ship-view" style={{ aspectRatio: viewAspectRatio(view) }}>
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
          </figure>
        </div>
      ) : (
        <div className="t-shippanel-media">
          {backdrop && <img className="t-shippanel-backdrop" src={backdrop} alt="" aria-hidden="true" data-testid="ship-panel-backdrop" />}
          <SafeImage
            src={hero}
            alt={`${modelName} render`}
            type="all"
            context="hero"
            className="t-shippanel-img"
            onFail={() => setFailedSrc(hero ?? null)}
            fallback={
              <div className="t-shippanel-empty">
                <TypeIcon type="all" className="t-shippanel-icon" />
                <span>No render available</span>
              </div>
            }
          />
        </div>
      )}
      <span className="t-shippanel-tint" aria-hidden="true" />
      <span className="t-shippanel-scan" aria-hidden="true" />
      <ShipStatsSidebar vehicle={vehicle} />
      <div className="t-shippanel-name" data-testid="ship-panel-name">
        {manufacturer && <small>{manufacturer}</small>}
        <span>{modelName}</span>
      </div>
      {viewNames.length > 1 && (
        <div className="t-view-switch" role="group" aria-label="Ship views">
          {viewNames.map((v) => (
            <button key={v} type="button" className={`t-chip${v === active ? ' is-active' : ''}`} aria-pressed={v === active} onClick={() => setChosen(v)}>
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
