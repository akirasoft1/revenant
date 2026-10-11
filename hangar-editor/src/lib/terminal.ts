// Pure logic for the Terminal ship view (no React).
import type { LoadoutSlot, SlotOption } from '../api/types';
import { TYPE_ORDER } from './labels';

export type TabId = 'all' | 'weapons' | 'turrets' | 'missiles' | 'shields' | 'power' | 'coolers' | 'qd' | 'radar' | 'utility';

/** `types: null` = every type. */
export const TABS: { id: TabId; label: string; types: string[] | null }[] = [
  { id: 'all', label: 'All', types: null },
  { id: 'weapons', label: 'Weapons', types: ['WeaponGun'] },
  { id: 'turrets', label: 'Turrets', types: ['Turret'] },
  { id: 'missiles', label: 'Missiles', types: ['MissileLauncher'] },
  { id: 'shields', label: 'Shields', types: ['Shield'] },
  { id: 'power', label: 'Power', types: ['PowerPlant'] },
  { id: 'coolers', label: 'Coolers', types: ['Cooler'] },
  { id: 'qd', label: 'Quantum', types: ['QuantumDrive'] },
  { id: 'radar', label: 'Radar', types: ['Radar'] },
  { id: 'utility', label: 'Utility', types: ['WeaponMining', 'TractorBeam'] },
];

/** Types shown but not editable (missile racks are not tracked). */
export const READONLY_TYPES: ReadonlySet<string> = new Set(['MissileLauncher']);

const rank = (t: string) => {
  const i = TYPE_ORDER.indexOf(t);
  return i === -1 ? TYPE_ORDER.length : i;
};

/** Ports of a tab in rail order: TYPE_ORDER, then slot id. */
export function portsForTab(loadout: LoadoutSlot[], tab: TabId): LoadoutSlot[] {
  const types = TABS.find((t) => t.id === tab)?.types ?? null;
  return loadout
    .filter((s) => types === null || types.includes(s.type))
    .sort((a, b) => rank(a.type) - rank(b.type) || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
}

/** Previous/next port id with wrap. `null` current -> first (dir 1) / last (dir -1). */
export function stepPort(ports: LoadoutSlot[], current: string | null, dir: 1 | -1): string | null {
  if (ports.length === 0) return null;
  const i = current == null ? -1 : ports.findIndex((p) => p.slot === current);
  if (i === -1) return (dir === 1 ? ports[0] : ports[ports.length - 1]).slot;
  return ports[(i + dir + ports.length) % ports.length].slot;
}

export interface StatRow {
  key: string;
  label: string;
  unit: string | null;
  value: number;
  delta: number | null;
  better: boolean | null;
  fraction: number;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Candidate stats vs the currently fitted item; bar fraction is relative to the best option. */
export function statRows(candidate: SlotOption | null, current: SlotOption | null, options: SlotOption[]): StatRow[] {
  if (!candidate?.stats?.length) return [];
  return candidate.stats.map((st) => {
    const cur = current?.stats?.find((s) => s.key === st.key);
    const delta = cur ? st.value - cur.value : null;
    const better = delta == null || delta === 0 ? null : st.lowerIsBetter ? delta < 0 : delta > 0;
    const values = [candidate, ...options]
      .map((o) => o.stats?.find((s) => s.key === st.key)?.value)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const best = st.lowerIsBetter ? Math.min(...values) : Math.max(...values);
    let fraction: number;
    if (st.value === best) fraction = 1;
    else if (st.lowerIsBetter) fraction = st.value > 0 ? best / st.value : 0;
    else fraction = best > 0 ? st.value / best : 0;
    return { key: st.key, label: st.label, unit: st.unit, value: st.value, delta, better, fraction: clamp01(fraction) };
  });
}

export function badges(option: SlotOption, slot: LoadoutSlot, stockUuid: string | null): ('IN USE' | 'STOCK')[] {
  const out: ('IN USE' | 'STOCK')[] = [];
  if (slot.item?.uuid === option.uuid) out.push('IN USE');
  if (stockUuid != null && stockUuid === option.uuid) out.push('STOCK');
  return out;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Best key stat first (lowest first when lowerIsBetter); no stat last; then name. */
export function sortOptions(options: SlotOption[]): SlotOption[] {
  const has = (o: SlotOption) => o.keyStat != null && typeof o.keyStat.value === 'number' && Number.isFinite(o.keyStat.value);
  return [...options].sort((a, b) => {
    const ha = has(a);
    const hb = has(b);
    if (ha !== hb) return ha ? -1 : 1;
    if (ha) {
      const va = a.keyStat!.value as number;
      const vb = b.keyStat!.value as number;
      if (va !== vb) return a.keyStat!.lowerIsBetter ? va - vb : vb - va;
    }
    return collator.compare(a.name, b.name);
  });
}

// ----- view preference -----

export const VIEW_PREF_KEY = 'hangar.shipView';
export type ViewPref = 'classic' | 'terminal';

function store(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadViewPref(storage?: Storage | null): ViewPref {
  try {
    return store(storage)?.getItem(VIEW_PREF_KEY) === 'terminal' ? 'terminal' : 'classic';
  } catch {
    return 'classic';
  }
}

export function saveViewPref(v: ViewPref, storage?: Storage | null): void {
  try {
    store(storage)?.setItem(VIEW_PREF_KEY, v);
  } catch {
    /* ignore */
  }
}
