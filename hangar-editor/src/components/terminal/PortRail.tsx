import type { LoadoutSlot } from '../../api/types';
import { slotLabel, typeLabel } from '../../lib/labels';
import { sizeLabel } from '../../lib/picker';
import { TypeIcon } from './icons';

/** Ports of the active tab grouped by type; the selected one glows. */
export function PortRail({
  ports,
  selected,
  onSelect,
}: {
  ports: LoadoutSlot[];
  selected: string | null;
  onSelect(slot: string): void;
}) {
  const groups: [string, LoadoutSlot[]][] = [];
  for (const p of ports) {
    const last = groups[groups.length - 1];
    if (last && last[0] === p.type) last[1].push(p);
    else groups.push([p.type, [p]]);
  }
  return (
    <ul className="t-rail" aria-label="Ports">
      {groups.map(([type, list]) => (
        <li key={type} className="t-rail-group">
          <span className="t-rail-head">
            <TypeIcon type={type} className="t-rail-icon" />
            {typeLabel(type)}
          </span>
          <ul className="t-rail-list">
            {list.map((p) => {
              const on = p.slot === selected;
              return (
                <li key={p.slot}>
                  <button
                    type="button"
                    data-testid="rail-port"
                    className={`t-port${on ? ' is-selected' : ''}`}
                    aria-current={on ? 'true' : undefined}
                    title={p.slot}
                    onClick={() => onSelect(p.slot)}
                  >
                    <span className="t-port-size">{sizeLabel(p.sizeMin, p.sizeMax)}</span>
                    <span className="t-port-text">
                      <span className="t-port-name">{slotLabel(p.slot)}</span>
                      <span className="t-port-item">{p.item?.name ?? 'Empty'}</span>
                    </span>
                    <span
                      className={`t-dot ${p.source === 'fitted' ? 't-dot-fitted' : 't-dot-stock'}`}
                      title={p.source === 'fitted' ? 'Fitted (changed from stock)' : 'Stock'}
                    >
                      <span className="sr-only">{p.source}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
