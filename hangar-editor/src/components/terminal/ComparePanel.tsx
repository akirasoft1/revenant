import type { SlotOption } from '../../api/types';
import { formatPrice, formatStat } from '../../lib/picker';
import { statRows } from '../../lib/terminal';
import { SafeImage } from './SafeImage';

function signed(delta: number): string {
  return `${delta > 0 ? '+' : '−'}${formatStat(Math.abs(delta))}`;
}

/**
 * CURRENT → CANDIDATE comparison. Preview only: the sole write is the Install
 * button, shown when `canInstall`.
 */
export function ComparePanel({
  current,
  candidate,
  options,
  portType,
  canInstall,
  installing,
  onInstall,
  notice,
}: {
  current: SlotOption;
  candidate: SlotOption | null;
  options: SlotOption[];
  portType: string;
  canInstall: boolean;
  installing: boolean;
  onInstall(): void;
  notice?: string | null;
}) {
  const shown = candidate ?? current;
  const comparing = candidate != null && candidate.uuid !== current.uuid;
  const rows = statRows(shown, comparing ? current : null, options);
  const meta = [shown.manufacturer, shown.grade && `Grade ${shown.grade}`, shown.class, shown.size != null && `Size ${shown.size}`]
    .filter(Boolean)
    .join(' · ');
  const price = shown.cheapestPrice;

  return (
    <section className="t-compare t-frame" data-testid="compare-panel" aria-label="Comparison">
      <header className="t-compare-head" data-testid="compare-header">
        <span className="t-eyebrow">{comparing ? 'CURRENT → CANDIDATE' : candidate ? 'CURRENT (selected)' : 'CURRENT'}</span>
        <h2 className="t-compare-title">
          {comparing ? (
            <>
              <span className="t-compare-from">{current.name}</span>
              <span className="t-compare-arrow" aria-hidden="true">
                →
              </span>
              <span className="sr-only"> to </span>
              <span className="t-compare-to">{candidate.name}</span>
            </>
          ) : (
            <span className="t-compare-to">{shown.name}</span>
          )}
        </h2>
      </header>

      <div className="t-compare-img">
        <SafeImage src={shown.image} alt="" type={shown.type || portType} context="compare" />
      </div>

      {rows.length > 0 && (
        <ul className="t-stats" aria-label="Stats">
          {rows.map((r) => (
            <li key={r.key} className="t-stat" data-testid="stat-row">
              <span className="t-stat-label">{r.label}</span>
              <span className="t-stat-value">
                {formatStat(r.value)}
                {r.unit && <small> {r.unit}</small>}
              </span>
              <span
                className={`t-stat-delta${r.better === true ? ' is-better' : r.better === false ? ' is-worse' : ''}`}
                aria-label={r.better == null ? undefined : r.better ? 'better' : 'worse'}
              >
                {r.delta != null && r.delta !== 0 && r.better != null && (
                  <>
                    {r.better ? '▲' : '▼'} {signed(r.delta)}
                  </>
                )}
              </span>
              <span className="t-stat-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(r.fraction * 100)}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="t-compare-meta">
        {meta && <p className="t-compare-sub">{meta}</p>}
        {shown.description && <p className="t-compare-desc">{shown.description}</p>}
        {price && (
          <p className="t-compare-price">
            Cheapest {formatPrice(price.price)} · {price.shop}, {price.location}
          </p>
        )}
        {notice && <p className="t-notice">{notice}</p>}
      </div>

      {canInstall && comparing && (
        <button type="button" className="t-btn t-btn-primary t-install" disabled={installing} onClick={onInstall}>
          Install
        </button>
      )}
    </section>
  );
}
