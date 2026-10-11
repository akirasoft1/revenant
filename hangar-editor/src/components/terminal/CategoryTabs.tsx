import type { LoadoutSlot } from '../../api/types';
import { TABS, portsForTab, type TabId } from '../../lib/terminal';
import { TypeIcon } from './icons';

/** Category tabs: filter which ports the rail and Prev/Next step through. */
export function CategoryTabs({
  loadout,
  tab,
  onSelect,
}: {
  loadout: LoadoutSlot[];
  tab: TabId;
  onSelect(tab: TabId): void;
}) {
  return (
    <div className="t-tabs" role="tablist" aria-label="Component categories">
      {TABS.map((t) => {
        const count = portsForTab(loadout, t.id).length;
        const selected = t.id === tab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={count === 0}
            className={`t-tab${selected ? ' is-active' : ''}`}
            title={count === 0 ? `${t.label}: no ports on this ship` : `${t.label} (${count})`}
            onClick={() => onSelect(t.id)}
          >
            <TypeIcon type={t.types?.[0] ?? 'all'} className="t-tab-icon" />
            <span className="t-tab-label">{t.label}</span>
            <span className="t-tab-count" aria-hidden="true">
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
