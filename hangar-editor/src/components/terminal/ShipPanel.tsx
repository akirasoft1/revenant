import { Suspense, lazy, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getWireframe } from '../../api/client';
import type { LoadoutSlot, VehiclePositions, VehicleSummary } from '../../api/types';
import { slotLabel } from '../../lib/labels';
import { loadVisualPref, saveVisualPref, wireframeSupport, type VisualPref } from '../../lib/wireframe';
import { buildMarkers } from '../wireframe/markers';
import { ViewerBoundary } from '../wireframe/ViewerBoundary';
import { TypeIcon } from './icons';
import { SafeImage } from './SafeImage';
import { ShipStatsSidebar } from './ShipStatsSidebar';

// three.js lives only in this lazily loaded chunk; it is fetched the first time a
// ship with a wireframe is shown in wireframe mode.
const WireframeViewer = lazy(() => import('../wireframe/WireframeViewer'));

const DAY_MS = 24 * 60 * 60_000;

/** Why the wireframe is not being shown for a vehicle that has one. */
type WireProblem = 'webgl' | 'decompression' | 'unavailable';

const PROBLEM_NOTES: Record<WireProblem, string> = {
  webgl: 'Wireframe needs WebGL, which this browser doesn’t offer — showing the render.',
  decompression: 'This browser can’t unpack the wireframe — showing the render.',
  unavailable: 'Wireframe unavailable — showing the render.',
};

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
 * The framed ship panel at the top of the right column, with the ship stats as a
 * top-right overlay and the model name bottom-left over one of:
 * - the rotatable **wireframe** with 3D hardpoint markers, when the vehicle has
 *   one (`vehicle.hasWireframe`) — the default, with a `Wireframe | Render`
 *   switch remembered per browser (`hangar.shipVisual`);
 * - the **render**: the whole vehicle image at full strength (`contain`, never
 *   cropped) over a blurred `cover` copy of itself, or, when 2D hardpoint view
 *   positions exist, the view image with its markers.
 * The wireframe never blocks the panel: an unsupported browser, a bundle that
 * cannot be fetched or decoded, a lost GL context or a viewer chunk that fails
 * to load all fall back to the render with a short note.
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
  const uuid = vehicle?.uuid;
  const hasWire = !!uuid && vehicle?.hasWireframe === true;
  const unsupported = useMemo(() => (hasWire ? wireframeSupport() : null), [hasWire]);
  const [visual, setVisual] = useState<VisualPref>(() => loadVisualPref());
  // The vehicle whose viewer failed (decode error, no/lost GL context, chunk load).
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const viewerFailed = hasWire && failedFor === uuid;
  const bundle = useQuery({
    queryKey: ['wireframe', uuid],
    queryFn: ({ signal }) => getWireframe(uuid!, signal),
    enabled: hasWire && !unsupported && !viewerFailed && visual === 'wireframe',
    staleTime: DAY_MS,
  });
  const problem: WireProblem | null = !hasWire
    ? null
    : unsupported
      ? unsupported
      : viewerFailed || bundle.isError || bundle.data === null
        ? 'unavailable'
        : null;
  const wireOn = hasWire && !problem && visual === 'wireframe';
  const markers3d = useMemo(() => buildMarkers(positions, loadout), [positions, loadout]);
  const viewerError = (e: unknown) => {
    console.warn('Wireframe viewer failed; showing the render', e);
    setFailedFor(uuid ?? null);
  };
  // How much of the panel's right side the stats overlay covers: the viewer
  // centres the ship in what is left.
  const panelRef = useRef<HTMLDivElement>(null);
  const [insetRight, setInsetRight] = useState(0);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const stats = panel?.querySelector<HTMLElement>('.t-shipstats');
    if (!wireOn || !panel || !stats || typeof ResizeObserver !== 'function') return;
    const measure = () => {
      const covered = stats.hidden || stats.offsetWidth === 0 ? 0 : panel.getBoundingClientRect().right - stats.getBoundingClientRect().left;
      setInsetRight(Math.max(0, Math.round(covered)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(panel);
    ro.observe(stats);
    return () => ro.disconnect();
  }, [wireOn]);
  const chooseVisual = (v: VisualPref) => {
    setVisual(v);
    saveVisualPref(v);
  };

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
  const view = !wireOn && active ? positions?.views?.[active] : undefined;
  const manufacturer = vehicle?.manufacturer;
  // The blurred backdrop is a decorative copy of the same render; it is drawn only
  // while the foreground image is good (the foreground alone reports failures).
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const hero = vehicle?.image;
  const backdrop = hero && hero !== failedSrc ? hero : null;

  return (
    <div ref={panelRef} className={`t-shippanel t-frame${view ? ' has-view' : ''}${wireOn ? ' has-wire' : ''}`} data-testid="ship-panel">
      {wireOn ? (
        bundle.data ? (
          <ViewerBoundary key={uuid} onError={viewerError}>
            <Suspense fallback={<WireLoading />}>
              <WireframeViewer
                bundle={bundle.data}
                markers={markers3d}
                selected={selected}
                onSelect={onSelect}
                onError={viewerError}
                insetRight={insetRight}
                label={`${modelName} wireframe — drag to rotate, scroll to zoom`}
              />
            </Suspense>
          </ViewerBoundary>
        ) : (
          <WireLoading />
        )
      ) : view && active ? (
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
      {hasWire && !problem && (
        <div className="t-visual-switch" role="group" aria-label="Ship visual">
          {(['wireframe', 'render'] as const).map((v) => (
            <button key={v} type="button" className={`t-chip${v === visual ? ' is-active' : ''}`} aria-pressed={v === visual} onClick={() => chooseVisual(v)}>
              {v === 'wireframe' ? 'Wireframe' : 'Render'}
            </button>
          ))}
        </div>
      )}
      {problem && (
        <p className="t-shippanel-note" role="status" data-testid="ship-panel-note">
          {PROBLEM_NOTES[problem]}
        </p>
      )}
      {!wireOn && viewNames.length > 1 && (
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

function WireLoading() {
  return (
    <div className="t-wire-loading" role="status" data-testid="wireframe-loading">
      Loading wireframe…
    </div>
  );
}
