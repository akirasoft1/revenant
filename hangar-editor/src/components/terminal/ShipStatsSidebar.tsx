import type { VehicleSummary } from '../../api/types';
import { typeLabel } from '../../lib/labels';

const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });

/**
 * Vehicle summary from the Wiki record; any missing field is omitted. `overlay`
 * sits on the ship panel (render mode); `strip` is the compact wrapping row under
 * the panel used in wireframe mode, so the stats never cover the wireframe.
 */
export function ShipStatsSidebar({ vehicle, variant = 'overlay' }: { vehicle?: VehicleSummary; variant?: 'overlay' | 'strip' }) {
  const cls = variant === 'strip' ? 't-shipstats-strip' : 't-shipstats';
  const rows: [string, string][] = [];
  if (vehicle) {
    if (num(vehicle.mass)) rows.push(['Mass', `${fmt(vehicle.mass)} kg`]);
    const d = vehicle.dimension;
    if (d && num(d.length) && num(d.width) && num(d.height)) rows.push(['Dimensions', `${fmt(d.length)} × ${fmt(d.width)} × ${fmt(d.height)} m`]);
    const c = vehicle.crew;
    if (c && (num(c.min) || num(c.max))) {
      const lo = num(c.min) ? c.min : c.max!;
      const hi = num(c.max) ? c.max : lo;
      rows.push(['Crew', lo === hi ? String(lo) : `${lo}–${hi}`]);
    }
  }
  const counts = Object.entries(vehicle?.portCounts ?? {}).filter(([, n]) => num(n) && n > 0);
  if (rows.length === 0 && counts.length === 0) return <div className={cls} data-testid="ship-stats" hidden />;
  return (
    <div className={cls} data-testid="ship-stats" tabIndex={variant === 'strip' ? 0 : undefined} aria-label={variant === 'strip' ? 'Ship stats' : undefined}>
      {rows.length > 0 && (
        <dl className="t-kv">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {counts.length > 0 && (
        <dl className="t-kv t-kv-ports" aria-label="Ports per type">
          {counts.map(([t, n]) => (
            <div key={t}>
              <dt>{typeLabel(t)}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
