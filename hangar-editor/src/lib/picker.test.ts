import { describe, expect, it } from 'vitest';
import type { SlotOption } from '../api/types';
import { filterAndSortOptions, formatPrice, sizeLabel } from './picker';

function opt(name: string, value: number | null, extra: Partial<SlotOption> = {}, lowerIsBetter = false): SlotOption {
  return {
    uuid: `u-${name}`,
    name,
    type: 'QuantumDrive',
    size: 1,
    grade: 'A',
    class: 'Military',
    keyStat: value === undefined ? null : { name: 'Speed', value, lowerIsBetter },
    ...extra,
  };
}

const names = (xs: SlotOption[]) => xs.map((x) => x.name);

describe('filterAndSortOptions', () => {
  it('sorts by key stat descending when higher is better', () => {
    const items = [opt('Mid', 50), opt('Best', 90), opt('Worst', 10)];
    expect(names(filterAndSortOptions(items))).toEqual(['Best', 'Mid', 'Worst']);
  });

  it('sorts ascending when lowerIsBetter', () => {
    const items = [opt('Hot', 300, {}, true), opt('Cool', 100, {}, true), opt('Warm', 200, {}, true)];
    expect(names(filterAndSortOptions(items, { sort: 'keyStat' }))).toEqual(['Cool', 'Warm', 'Hot']);
  });

  it('puts items without a key stat (null stat or null value) last, then by name', () => {
    const items = [
      opt('Zed', null),
      { ...opt('NoStat', 0), keyStat: null },
      opt('Good', 5),
      opt('Alpha', null),
    ];
    expect(names(filterAndSortOptions(items))).toEqual(['Good', 'Alpha', 'NoStat', 'Zed']);
  });

  it('breaks key-stat ties by name', () => {
    expect(names(filterAndSortOptions([opt('Beta', 7), opt('alpha', 7)]))).toEqual(['alpha', 'Beta']);
  });

  it('sorts by price ascending with unpriced items last', () => {
    const items = [
      opt('NotSold', 1),
      opt('Pricey', 1, { cheapestPrice: { price: 90000, shop: 'Shop', location: 'Area18' } }),
      opt('Cheap', 1, { cheapestPrice: { price: 1200, shop: 'Shop', location: 'Lorville' } }),
      opt('AlsoNotSold', 1),
    ];
    expect(names(filterAndSortOptions(items, { sort: 'price' }))).toEqual(['Cheap', 'Pricey', 'AlsoNotSold', 'NotSold']);
  });

  it('filters by every query term across name, grade, class and size', () => {
    const items = [
      opt('Atlas', 1, { grade: 'A', class: 'Military' }),
      opt('Beacon', 1, { grade: 'C', class: 'Civilian' }),
      opt('Atlas Pro', 1, { grade: 'B', class: 'Civilian', size: 2 }),
    ];
    expect(names(filterAndSortOptions(items, { query: 'atlas' , sort: 'name' }))).toEqual(['Atlas', 'Atlas Pro']);
    expect(names(filterAndSortOptions(items, { query: 'atlas civilian' }))).toEqual(['Atlas Pro']);
    expect(names(filterAndSortOptions(items, { query: 's2' }))).toEqual(['Atlas Pro']);
    expect(filterAndSortOptions(items, { query: 'nothing-matches' })).toEqual([]);
  });

  it('filters by exact size', () => {
    const items = [opt('Small', 1, { size: 1 }), opt('Big', 2, { size: 2 })];
    expect(names(filterAndSortOptions(items, { size: 2 }))).toEqual(['Big']);
    expect(names(filterAndSortOptions(items, { size: null }))).toEqual(['Big', 'Small']);
  });

  it('does not mutate the input', () => {
    const items = [opt('B', 1), opt('A', 2)];
    const copy = [...items];
    filterAndSortOptions(items);
    expect(items).toEqual(copy);
  });
});

describe('formatting', () => {
  it('formats prices and size ranges', () => {
    expect(formatPrice(12345.6)).toBe('12,346 aUEC');
    expect(sizeLabel(2, 2)).toBe('S2');
    expect(sizeLabel(1, 3)).toBe('S1–3');
    expect(sizeLabel(null, null)).toBe('—');
  });
});
