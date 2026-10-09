import type { ImportApplyRow, ImportPreviewRow } from '../api/types';
import { itemName, skipReasonLabel, slotLabel } from '../lib/labels';

export interface RowSelection {
  include: boolean;
  mode: 'new' | 'existing';
  shipId: string;
  nickname: string;
}

export type Selections = Record<number, RowSelection>;

/**
 * Why a row will not be applied, or null. The server's apply is authoritative
 * (every slot it did not resolve goes back to stock), so it refuses any row
 * whose analysis is incomplete and the UI mirrors that:
 * - a `too_many_lookups` skip: some slots were never looked up (the request's
 *   Wiki budget ran out) -- importing fewer loadouts at once fixes it;
 * - any row-level skip (no `slot`): the loadout could not be read, or carries a
 *   selection the importer does not understand. The server resolves the vehicle
 *   BEFORE decoding, so `vehicle` can be set on such a row.
 */
export const TOO_MANY_LOOKUPS_NOTE = "won't be applied — import fewer at once";

export function blockedReason(row: ImportPreviewRow): string | null {
  if (row.vehicle == null) return 'cannot be imported';
  if (row.skipped.some((s) => s.reason === 'too_many_lookups')) return TOO_MANY_LOOKUPS_NOTE;
  if (row.skipped.some((s) => !s.slot)) return 'cannot be imported';
  return null;
}

export function importable(row: ImportPreviewRow): boolean {
  return blockedReason(row) === null;
}

/** shipId -> number of fitted (non-stock) slots on that existing ship. */
export type FittedCounts = Record<string, number>;

/**
 * Default target: "Update existing" ONLY when a matching ship has no fitted
 * overrides (the authoritative import loses nothing there); otherwise a new ship.
 * The existing-ship select still defaults to the first match when chosen by hand.
 */
export function defaultSelection(row: ImportPreviewRow, fitted: FittedCounts = {}): RowSelection {
  const pristine = row.matchingShips.find((m) => (fitted[m.shipId] ?? Infinity) === 0);
  return {
    include: importable(row),
    mode: pristine ? 'existing' : 'new',
    shipId: pristine?.shipId ?? row.matchingShips[0]?.shipId ?? '',
    nickname: '',
  };
}

export function defaultSelections(rows: ImportPreviewRow[], fitted: FittedCounts = {}): Selections {
  return Object.fromEntries(rows.map((r) => [r.rowIndex, defaultSelection(r, fitted)]));
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
  /** Fitted-change counts of the target member's ships (for the overwrite note). */
  fittedCounts?: FittedCounts;
  onChange: (rowIndex: number, next: RowSelection) => void;
  disabled?: boolean;
}

export function ImportPreview({ rows, selections, fittedCounts = {}, onChange, disabled }: Props) {
  if (rows.length === 0) return <p className="empty">The file contains no saved loadouts.</p>;
  return (
    <ol className="import-rows">
      {rows.map((row) => {
        const sel = selections[row.rowIndex] ?? defaultSelection(row, fittedCounts);
        const set = (patch: Partial<RowSelection>) => onChange(row.rowIndex, { ...sel, ...patch });
        const blocked = blockedReason(row);
        const ok = blocked === null;
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
                {row.vehicle && blocked && ` · ${blocked}`}
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
                    <OverwriteNote count={fittedCounts[sel.shipId]} />
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

function OverwriteNote({ count }: { count: number | undefined }) {
  const lead =
    count == null
      ? ''
      : count === 0
        ? 'That ship is all stock today, so nothing is lost. '
        : `That ship has ${count} fitted ${count === 1 ? 'change' : 'changes'} that will be replaced. `;
  return (
    <p className={count ? 'warn-text small overwrite-note' : 'muted small overwrite-note'}>
      {lead}
      The import is authoritative for that ship: only the changes listed above are fitted, and every other slot —
      including skipped slots and slots not in this loadout — is reset to stock.
    </p>
  );
}
