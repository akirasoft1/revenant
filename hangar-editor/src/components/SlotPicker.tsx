import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSlotOptions } from '../api/client';
import type { LoadoutSlot, SlotOption } from '../api/types';
import { filterAndSortOptions, formatPrice, formatStat, sizeLabel, type PickerSort } from '../lib/picker';
import { slotLabel } from '../lib/labels';
import { ErrorNote, Loading } from './Status';

interface ListProps {
  options: SlotOption[];
  currentUuid?: string | null;
  stockUuid?: string | null;
  busy?: boolean;
  onPick: (item: SlotOption) => void;
}

/** Filterable, sortable list of compatible items (pure: receives the options). */
export function SlotOptionList({ options, currentUuid, stockUuid, busy, onPick }: ListProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<PickerSort>('keyStat');
  const [size, setSize] = useState<number | null>(null);
  const sizes = useMemo(
    () => [...new Set(options.map((o) => o.size).filter((s): s is number => s != null))].sort((a, b) => a - b),
    [options],
  );
  const shown = useMemo(() => filterAndSortOptions(options, { query, sort, size }), [options, query, sort, size]);
  const stat = options.find((o) => o.keyStat)?.keyStat ?? null;

  return (
    <div className="picker">
      <div className="picker-controls">
        <input
          type="search"
          placeholder="Filter by name, grade, class…"
          aria-label="Filter items"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <span className="sr-only">Sort by</span>
          <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as PickerSort)}>
            <option value="keyStat">Best {stat ? stat.name : 'key stat'}</option>
            <option value="price">Cheapest</option>
            <option value="name">Name</option>
          </select>
        </label>
        {sizes.length > 1 && (
          <label>
            <span className="sr-only">Size</span>
            <select
              aria-label="Size"
              value={size ?? ''}
              onChange={(e) => setSize(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">All sizes</option>
              {sizes.map((s) => (
                <option key={s} value={s}>
                  S{s}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {stat && (
        <p className="muted small">
          Sorted by {stat.name} ({stat.lowerIsBetter ? 'lower is better' : 'higher is better'}). Prices are the
          cheapest player-reported UEX shop price, when known.
        </p>
      )}
      {shown.length === 0 ? (
        <p className="empty">{options.length === 0 ? 'No compatible items found for this slot.' : 'No items match the filter.'}</p>
      ) : (
        <ul className="option-list" aria-label="Compatible items">
          {shown.map((o) => {
            const isCurrent = o.uuid === currentUuid;
            return (
              <li key={o.uuid} className={isCurrent ? 'option current' : 'option'} data-testid="slot-option">
                <div className="option-main">
                  <span className="option-name">{o.name}</span>
                  <span className="option-tags">
                    {o.size != null && <span className="tag">S{o.size}</span>}
                    {o.grade && <span className="tag">Grade {o.grade}</span>}
                    {o.class && <span className="tag">{o.class}</span>}
                    {o.uuid === stockUuid && <span className="badge badge-stock">stock</span>}
                    {isCurrent && <span className="badge badge-fitted">current</span>}
                  </span>
                </div>
                <div className="option-stats">
                  {o.keyStat && (
                    <span className="stat" title={o.keyStat.lowerIsBetter ? 'lower is better' : 'higher is better'}>
                      {o.keyStat.name}: <strong>{formatStat(o.keyStat.value)}</strong>
                    </span>
                  )}
                  {o.cheapestPrice ? (
                    <span className="price" title={`${o.cheapestPrice.shop} — ${o.cheapestPrice.location}`}>
                      {formatPrice(o.cheapestPrice.price)}{' '}
                      <span className="muted">
                        @ {o.cheapestPrice.shop}, {o.cheapestPrice.location}
                      </span>
                    </span>
                  ) : (
                    <span className="price muted">price unknown</span>
                  )}
                </div>
                <button
                  className="btn btn-small btn-primary"
                  disabled={busy || isCurrent}
                  onClick={() => onPick(o)}
                  aria-label={`Fit ${o.name}`}
                >
                  Fit
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

interface PickerProps {
  vehicleUuid: string;
  slot: LoadoutSlot;
  stockUuid?: string | null;
  busy?: boolean;
  error?: string | null;
  onPick: (item: SlotOption) => void;
  onClose: () => void;
}

/** Modal: fetches the compatible items for one slot and lets the user fit one. */
export function SlotPicker({ vehicleUuid, slot, stockUuid, busy, error, onPick, onClose }: PickerProps) {
  const options = useQuery({
    queryKey: ['slot-options', vehicleUuid, slot.slot],
    queryFn: () => getSlotOptions(vehicleUuid, slot.slot),
    staleTime: 10 * 60_000,
  });
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Remember the opener ("Change" button) and give focus back to it on close.
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialog.current) return;
      // Focus trap: Tab / Shift+Tab cycle inside the dialog.
      const items = focusables(dialog.current);
      if (items.length === 0) {
        e.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = dialog.current.contains(active);
      if (e.shiftKey && (active === first || active === dialog.current || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Change ${slotLabel(slot.slot)}`}
        tabIndex={-1}
        ref={dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <h2>{slotLabel(slot.slot)}</h2>
            <p className="muted small">
              {slot.type} · {sizeLabel(slot.sizeMin, slot.sizeMax)} · now: {slot.item?.name ?? 'empty'}
            </p>
          </div>
          <button className="btn btn-ghost btn-small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        {options.isPending ? (
          <Loading label="Loading compatible items…" />
        ) : options.isError ? (
          <ErrorNote error={options.error} onRetry={() => void options.refetch()} />
        ) : (
          <SlotOptionList
            options={options.data}
            currentUuid={slot.item?.uuid}
            stockUuid={stockUuid}
            busy={busy}
            onPick={onPick}
          />
        )}
      </div>
    </div>
  );
}
