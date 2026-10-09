import type { SlotOption } from '../api/types';

export type PickerSort = 'keyStat' | 'price' | 'name';

export interface PickerOptions {
  query?: string;
  /** Only items of exactly this size (null/undefined = all sizes the server returned). */
  size?: number | null;
  sort?: PickerSort;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function hasStat(o: SlotOption): boolean {
  return o.keyStat != null && typeof o.keyStat.value === 'number' && Number.isFinite(o.keyStat.value);
}

function hasPrice(o: SlotOption): boolean {
  return o.cheapestPrice != null && typeof o.cheapestPrice.price === 'number' && Number.isFinite(o.cheapestPrice.price);
}

/** Best first. Each item carries its own `lowerIsBetter`; items without a value go last. */
function byKeyStat(a: SlotOption, b: SlotOption): number {
  const ha = hasStat(a);
  const hb = hasStat(b);
  if (ha !== hb) return ha ? -1 : 1;
  if (!ha) return 0;
  const va = a.keyStat!.value as number;
  const vb = b.keyStat!.value as number;
  if (va === vb) return 0;
  const lower = a.keyStat!.lowerIsBetter;
  return lower ? va - vb : vb - va;
}

/** Cheapest first; items not sold anywhere (no price) go last. */
function byPrice(a: SlotOption, b: SlotOption): number {
  const ha = hasPrice(a);
  const hb = hasPrice(b);
  if (ha !== hb) return ha ? -1 : 1;
  if (!ha) return 0;
  return a.cheapestPrice!.price - b.cheapestPrice!.price;
}

function matches(o: SlotOption, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = [o.name, o.type, o.grade, o.class, o.size != null ? `s${o.size}` : null, o.cheapestPrice?.shop, o.cheapestPrice?.location]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Pure filter + sort used by the compatible-item picker. Never mutates `items`. */
export function filterAndSortOptions(items: SlotOption[], opts: PickerOptions = {}): SlotOption[] {
  const terms = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const sort = opts.sort ?? 'keyStat';
  const out = items.filter(
    (o) => matches(o, terms) && (opts.size == null || o.size === opts.size),
  );
  const primary = sort === 'price' ? byPrice : sort === 'keyStat' ? byKeyStat : () => 0;
  return out.sort((a, b) => primary(a, b) || collator.compare(a.name, b.name));
}

export function formatPrice(price: number): string {
  return `${Math.round(price).toLocaleString('en-US')} aUEC`;
}

export function formatStat(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(value).toLocaleString('en-US');
  if (abs >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/\.?0+$/, '');
}

export function sizeLabel(min: number | null | undefined, max: number | null | undefined): string {
  if (min == null && max == null) return '—';
  if (min == null || max == null || min === max) return `S${min ?? max}`;
  return `S${min}–${max}`;
}
