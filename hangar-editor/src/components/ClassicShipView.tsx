import { useState } from 'react';
import type { LoadoutSlot, ShipViewProps } from '../api/types';
import { TYPE_ORDER, slotLabel, typeLabel } from '../lib/labels';
import { sizeLabel } from '../lib/picker';
import { SlotPicker } from './SlotPicker';

export type { ShipViewProps } from '../api/types';

export function groupSlots(loadout: LoadoutSlot[]): [string, LoadoutSlot[]][] {
  const groups = new Map<string, LoadoutSlot[]>();
  for (const s of loadout) {
    const list = groups.get(s.type) ?? [];
    list.push(s);
    groups.set(s.type, list);
  }
  const rank = (t: string) => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

/** Today's grouped slot tables + picker, fed by the same props as the Terminal view. */
export function ClassicShipView({
  ship,
  loadout,
  stockBySlot,
  editable,
  onFit,
  onReset,
  busy,
  error,
  onDismissError,
}: ShipViewProps) {
  const [picking, setPicking] = useState<LoadoutSlot | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  async function doReset(slot: string) {
    setResetting(slot);
    setResetError(null);
    try {
      await onReset(slot);
    } catch (e) {
      setResetError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(null);
    }
  }

  return (
    <>
      {resetError && <p className="alert alert-error">{resetError}</p>}
      {groupSlots(loadout).map(([type, slots]) => (
        <section key={type} className="slot-group">
          <h2>{typeLabel(type)}</h2>
          <table className="slot-table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Size</th>
                <th>Item</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s) => {
                const stockItem = stockBySlot.get(s.slot);
                return (
                  <tr key={s.slot}>
                    <td data-label="Slot" className="slot-name" title={s.slot}>
                      {slotLabel(s.slot)}
                    </td>
                    <td data-label="Size">{sizeLabel(s.sizeMin, s.sizeMax)}</td>
                    <td data-label="Item">
                      <span className="item-name">{s.item?.name ?? <em className="muted">empty</em>}</span>{' '}
                      <span className={s.source === 'fitted' ? 'badge badge-fitted' : 'badge badge-stock'}>
                        {s.source}
                      </span>
                      {s.source === 'fitted' && stockItem && (
                        <span className="muted small stock-note"> stock: {stockItem.name}</span>
                      )}
                    </td>
                    <td className="slot-actions">
                      {editable && (
                        <>
                          <button className="btn btn-small" onClick={() => setPicking(s)}>
                            Change
                          </button>
                          {s.source === 'fitted' && (
                            <button
                              className="btn btn-small btn-ghost"
                              disabled={resetting === s.slot}
                              onClick={() => void doReset(s.slot)}
                            >
                              Reset to stock
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      {picking && (
        <SlotPicker
          vehicleUuid={ship.vehicleUuid}
          slot={picking}
          stockUuid={stockBySlot.get(picking.slot)?.uuid ?? null}
          busy={busy}
          error={error}
          onPick={(item) => {
            onFit(picking.slot, item).then(
              () => setPicking(null),
              () => {},
            );
          }}
          onClose={() => {
            setPicking(null);
            onDismissError?.();
          }}
        />
      )}
    </>
  );
}
