import type { ImportApplyRow, ImportPreviewRow } from '../api/types';
import { itemName, skipReasonLabel, slotLabel } from '../lib/labels';

export interface RowSelection {
  include: boolean;
  mode: 'new' | 'existing';
  shipId: string;
  nickname: string;
}

export type Selections = Record<number, RowSelection>;

export function importable(row: ImportPreviewRow): boolean {
  return row.vehicle != null;
}

export function defaultSelection(row: ImportPreviewRow): RowSelection {
  const first = row.matchingShips[0]?.shipId ?? '';
  return {
    include: importable(row),
    mode: first ? 'existing' : 'new',
    shipId: first,
    nickname: '',
  };
}

export function defaultSelections(rows: ImportPreviewRow[]): Selections {
  return Object.fromEntries(rows.map((r) => [r.rowIndex, defaultSelection(r)]));
}

/** The `rows` body for `/import/spviewer/apply` (only included, importable rows). */
export function toApplyRows(rows: ImportPreviewRow[], sel: Selections): ImportApplyRow[] {
  const out: ImportApplyRow[] = [];
  for (const row of rows) {
    const s = sel[row.rowIndex];
    if (!s?.include || !importable(row)) continue;
    if (s.mode === 'existing' && s.shipId) {
      out.push({ rowIndex: row.rowIndex, mode: 'existing', shipId: s.shipId });
    } else {
      const nickname = s.nickname.trim();
      out.push({ rowIndex: row.rowIndex, mode: 'new', ...(nickname ? { nickname } : {}) });
    }
  }
  return out;
}

interface Props {
  rows: ImportPreviewRow[];
  selections: Selections;
  onChange: (rowIndex: number, next: RowSelection) => void;
  disabled?: boolean;
}

export function ImportPreview({ rows, selections, onChange, disabled }: Props) {
  if (rows.length === 0) return <p className="empty">The file contains no saved loadouts.</p>;
  return (
    <ol className="import-rows">
      {rows.map((row) => {
        const sel = selections[row.rowIndex] ?? defaultSelection(row);
        const set = (patch: Partial<RowSelection>) => onChange(row.rowIndex, { ...sel, ...patch });
        const ok = importable(row);
        return (
          <li key={row.rowIndex} className={ok ? 'import-row' : 'import-row import-row-bad'} data-testid="import-row">
            <div className="import-row-head">
              <label className="check">
                <input
                  type="checkbox"
                  checked={ok && sel.include}
                  disabled={!ok || disabled}
                  onChange={(e) => set({ include: e.target.checked })}
                  aria-label={`Import ${row.loadoutName}`}
                />
                <span className="import-name">{row.loadoutName || `Loadout #${row.rowIndex + 1}`}</span>
              </label>
              <span className="muted">
                {row.vehicle ? row.vehicle.name : 'ship not recognized'}
                {row.patch && ` · ${row.patch}`}
              </span>
            </div>

            <div className="import-body">
              <h4>
                {row.changes.length === 0
                  ? 'No component changes from stock'
                  : `${row.changes.length} component ${row.changes.length === 1 ? 'change' : 'changes'}`}
              </h4>
              {row.changes.length > 0 && (
                <ul className="changes">
                  {row.changes.map((c) => (
                    <li key={c.slot}>
                      <span className="slot-name" title={c.slot}>
                        {slotLabel(c.slot)}
                      </span>
                      : <span className="from">{itemName(c.from)}</span> → <strong className="to">{c.to.name}</strong>
                    </li>
                  ))}
                </ul>
              )}
              {row.skipped.length > 0 && (
                <>
                  <h4 className="warn-text">Skipped ({row.skipped.length})</h4>
                  <ul className="skipped">
                    {row.skipped.map((s, i) => (
                      <li key={`${s.slot ?? ''}-${i}`}>
                        {s.slot && (
                          <span className="slot-name" title={s.slot}>
                            {slotLabel(s.slot)}:{' '}
                          </span>
                        )}
                        <span className="reason">{skipReasonLabel(s.reason)}</span>
                        {s.detail && <span className="muted"> — {s.detail}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            {ok && sel.include && (
              <div className="import-target">
                <label className="radio">
                  <input
                    type="radio"
                    name={`mode-${row.rowIndex}`}
                    checked={sel.mode === 'new'}
                    disabled={disabled}
                    onChange={() => set({ mode: 'new' })}
                  />
                  New ship
                </label>
                {sel.mode === 'new' && (
                  <input
                    className="nickname"
                    aria-label={`Nickname for ${row.loadoutName}`}
                    placeholder={row.loadoutName || 'Nickname'}
                    value={sel.nickname}
                    maxLength={64}
                    disabled={disabled}
                    onChange={(e) => set({ nickname: e.target.value })}
                  />
                )}
                <label className="radio">
                  <input
                    type="radio"
                    name={`mode-${row.rowIndex}`}
                    checked={sel.mode === 'existing'}
                    disabled={disabled || row.matchingShips.length === 0}
                    onChange={() => set({ mode: 'existing', shipId: sel.shipId || row.matchingShips[0]?.shipId || '' })}
                  />
                  Update existing
                  {row.matchingShips.length === 0 && <span className="muted"> (no {row.vehicle?.name} in your hangar)</span>}
                </label>
                {sel.mode === 'existing' && row.matchingShips.length > 0 && (
                  <>
                    <select
                      aria-label={`Ship to update for ${row.loadoutName}`}
                      value={sel.shipId}
                      disabled={disabled}
                      onChange={(e) => set({ shipId: e.target.value })}
                    >
                      {row.matchingShips.map((m) => (
                        <option key={m.shipId} value={m.shipId}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <p className="muted small">
                      Replaces that ship’s fitted components: slots this loadout doesn’t change go back to stock.
                    </p>
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
