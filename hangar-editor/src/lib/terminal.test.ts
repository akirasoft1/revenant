import { describe, expect, it } from 'vitest';
import type { LoadoutSlot, SlotOption, StatValue } from '../api/types';
import { badges, loadViewPref, portsForTab, saveViewPref, sortOptions, statRows, stepPort, TABS } from './terminal';

const st = (key: string, value: number, lowerIsBetter = false): StatValue => ({
  key, label: key, value, unit: null, lowerIsBetter,
});
const opt = (uuid: string, stats?: StatValue[], extra: Partial<SlotOption> = {}): SlotOption => ({
  uuid, name: uuid, type: 'QuantumDrive', size: 2, grade: null, class: null, keyStat: null, stats, ...extra,
});
const slot = (id: string, type: string, item = 'x'): LoadoutSlot => ({
  slot: id, type, sizeMin: 1, sizeMax: 1, compatibleTypes: [], item: { uuid: item, name: item }, source: 'stock',
});

describe('statRows', () => {
  it('computes delta/better, higher and lower-is-better', () => {
    const cur = opt('cur', [st('speed', 180_000), st('fuel_rate', 5, true)]);
    const cand = opt('cand', [st('speed', 290_000), st('fuel_rate', 3, true)]);
    const rows = statRows(cand, cur, [cur, cand]);
    expect(rows[0]).toMatchObject({ key: 'speed', delta: 110_000, better: true });
    expect(rows[1]).toMatchObject({ key: 'fuel_rate', delta: -2, better: true });
  });
  it('fraction is relative to the best option and clamped', () => {
    const a = opt('a', [st('speed', 100), st('fuel_rate', 4, true)]);
    const b = opt('b', [st('speed', 200), st('fuel_rate', 2, true)]);
    const rows = statRows(a, null, [a, b]);
    expect(rows[0].fraction).toBeCloseTo(0.5);
    expect(rows[1].fraction).toBeCloseTo(0.5);
    expect(statRows(b, null, [a, b]).map((r) => r.fraction)).toEqual([1, 1]);
    // candidate absent from options and better than all -> clamped to 1
    expect(statRows(b, null, [a])[0].fraction).toBe(1);
  });
  it('missing current -> delta/better null', () => {
    const rows = statRows(opt('c', [st('speed', 1)]), null, []);
    expect(rows[0].delta).toBeNull();
    expect(rows[0].better).toBeNull();
  });
  it('candidate without stats -> []', () => {
    expect(statRows(opt('c'), opt('d', [st('speed', 1)]), [])).toEqual([]);
    expect(statRows(null, null, [])).toEqual([]);
  });
});

describe('stepPort', () => {
  const ports = [slot('a', 'Shield'), slot('b', 'Shield'), slot('c', 'Shield')];
  it('wraps both directions', () => {
    expect(stepPort(ports, 'c', 1)).toBe('a');
    expect(stepPort(ports, 'a', -1)).toBe('c');
    expect(stepPort(ports, 'a', 1)).toBe('b');
  });
  it('null current -> first/last; empty -> null', () => {
    expect(stepPort(ports, null, 1)).toBe('a');
    expect(stepPort(ports, null, -1)).toBe('c');
    expect(stepPort([], 'a', 1)).toBeNull();
  });
});

describe('portsForTab', () => {
  const loadout = [
    slot('z_qd', 'QuantumDrive'), slot('b_sh', 'Shield'), slot('a_sh', 'Shield'),
    slot('mine', 'WeaponMining'), slot('gun', 'WeaponGun'), slot('tractor', 'TractorBeam'),
  ];
  it('filters by tab', () => {
    expect(portsForTab(loadout, 'shields').map((s) => s.slot)).toEqual(['a_sh', 'b_sh']);
    expect(portsForTab(loadout, 'utility').map((s) => s.slot).sort()).toEqual(['mine', 'tractor']);
  });
  it('all is TYPE_ORDER then slot id', () => {
    expect(portsForTab(loadout, 'all').map((s) => s.slot)).toEqual(['gun', 'a_sh', 'b_sh', 'z_qd', 'mine', 'tractor']);
  });
  it('has the ten tabs', () => expect(TABS.map((t) => t.id)).toHaveLength(10));
});

describe('badges', () => {
  const s = slot('s', 'Shield', 'fit');
  it('IN USE / STOCK / both', () => {
    expect(badges(opt('fit'), s, 'stock')).toEqual(['IN USE']);
    expect(badges(opt('stock'), s, 'stock')).toEqual(['STOCK']);
    expect(badges(opt('fit'), s, 'fit')).toEqual(['IN USE', 'STOCK']);
    expect(badges(opt('other'), s, null)).toEqual([]);
  });
});

describe('sortOptions', () => {
  const ks = (value: number | null, lowerIsBetter = false) => ({ name: 'k', value, lowerIsBetter });
  it('desc by default, asc when lowerIsBetter, no stat last by name', () => {
    const o = [
      opt('nostat-b', undefined, { name: 'b' }),
      opt('lo', undefined, { name: 'lo', keyStat: ks(1) }),
      opt('hi', undefined, { name: 'hi', keyStat: ks(9) }),
      opt('nostat-a', undefined, { name: 'a' }),
    ];
    expect(sortOptions(o).map((x) => x.uuid)).toEqual(['hi', 'lo', 'nostat-a', 'nostat-b']);
    const l = [
      opt('big', undefined, { keyStat: ks(9, true) }),
      opt('small', undefined, { keyStat: ks(1, true) }),
    ];
    expect(sortOptions(l).map((x) => x.uuid)).toEqual(['small', 'big']);
  });
});

describe('view preference', () => {
  const throwing = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  } as unknown as Storage;
  it('falls back to classic and never throws', () => {
    expect(loadViewPref(throwing)).toBe('classic');
    expect(() => saveViewPref('terminal', throwing)).not.toThrow();
  });
  it('round-trips and uses the documented key', () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
    expect(loadViewPref(storage)).toBe('classic');
    saveViewPref('terminal', storage);
    expect(m.get('hangar.shipView')).toBe('terminal');
    expect(loadViewPref(storage)).toBe('terminal');
  });
});
