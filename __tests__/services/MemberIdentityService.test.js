'use strict';

jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const MemberIdentityService = require('../../services/MemberIdentityService');

// Minimal in-memory stand-in for the `member_identities` collection.
function fakeCollection(initial = []) {
  const docs = new Map(initial.map((d) => [d._id, { ...d }]));
  const col = {
    docs,
    find: jest.fn(() => ({ toArray: async () => [...docs.values()].map((d) => ({ ...d })) })),
    updateOne: jest.fn(async (filter, update, opts) => {
      const cur = docs.get(filter._id);
      if (!cur && !(opts && opts.upsert)) return { matchedCount: 0 };
      docs.set(filter._id, { ...(cur || { _id: filter._id }), ...update.$set });
      return { matchedCount: cur ? 1 : 0, upsertedCount: cur ? 0 : 1 };
    }),
  };
  return col;
}

function makeService(initial, opts = {}) {
  const col = fakeCollection(initial);
  const mongoService = { db: { collection: jest.fn(() => col) } };
  const fixedNow = new Date('2026-10-09T12:00:00Z');
  const svc = new MemberIdentityService({ mongoService, now: () => fixedNow, ...opts });
  return { svc, col, mongoService, fixedNow };
}

const AKIRA = { _id: 'a', addressName: 'Akira', aliases: ['Akirasoft', 'Phalabala'], updatedBy: 'a', updatedAt: new Date(0) };
const BOB = { _id: 'b', addressName: 'Bob', aliases: [], updatedBy: 'b', updatedAt: new Date(0) };

afterEach(() => jest.useRealTimers());

describe('load / get / all', () => {
  test('loads every doc into the cache and serves get()/all() synchronously', async () => {
    const { svc, mongoService } = makeService([AKIRA, BOB]);
    expect(svc.isLoaded()).toBe(false);
    expect(svc.get('a')).toBeNull();
    await expect(svc.load()).resolves.toBe(true);
    expect(mongoService.db.collection).toHaveBeenCalledWith('member_identities');
    expect(svc.isLoaded()).toBe(true);
    expect(svc.get('a')).toEqual({ discordId: 'a', addressName: 'Akira', aliases: ['Akirasoft', 'Phalabala'] });
    expect(svc.get('zzz')).toBeNull();
    expect(svc.get(undefined)).toBeNull();
    expect(svc.all().map((r) => r.discordId).sort()).toEqual(['a', 'b']);
  });

  test('get() returns a copy -- callers cannot mutate the cache', async () => {
    const { svc } = makeService([AKIRA]);
    await svc.load();
    svc.get('a').aliases.push('Hacked');
    expect(svc.get('a').aliases).toEqual(['Akirasoft', 'Phalabala']);
  });

  test('normalises malformed docs (missing aliases / addressName)', async () => {
    const { svc } = makeService([{ _id: 'x' }]);
    await svc.load();
    expect(svc.get('x')).toEqual({ discordId: 'x', addressName: null, aliases: [] });
  });

  test('degrades when Mongo is missing: not loaded, get() null, never throws', async () => {
    const svc = new MemberIdentityService({ mongoService: { db: null } });
    await expect(svc.load()).resolves.toBe(false);
    expect(svc.isLoaded()).toBe(false);
    expect(svc.get('a')).toBeNull();
    expect(svc.all()).toEqual([]);
    const none = new MemberIdentityService({});
    await expect(none.load()).resolves.toBe(false);
  });

  test('a failed refresh keeps the previous cache', async () => {
    const { svc, col } = makeService([AKIRA]);
    await svc.load();
    col.find.mockImplementationOnce(() => ({ toArray: async () => { throw new Error('boom'); } }));
    await expect(svc.load()).resolves.toBe(false);
    expect(svc.isLoaded()).toBe(true);
    expect(svc.get('a').addressName).toBe('Akira');
  });
});

describe('start / stop refresh timer', () => {
  test('refreshes on the interval and picks up out-of-band changes', async () => {
    jest.useFakeTimers();
    const { svc, col } = makeService([AKIRA], { refreshMs: 60000 });
    svc.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(svc.get('a').addressName).toBe('Akira');
    col.docs.set('b', { ...BOB });
    await jest.advanceTimersByTimeAsync(60000);
    expect(svc.get('b').addressName).toBe('Bob');
    svc.stop();
    col.docs.set('c', { _id: 'c', addressName: 'Chuck', aliases: [] });
    await jest.advanceTimersByTimeAsync(120000);
    expect(svc.get('c')).toBeNull();
  });

  test('loads once Mongo connects late', async () => {
    jest.useFakeTimers();
    const col = fakeCollection([AKIRA]);
    const mongoService = { db: null };
    const svc = new MemberIdentityService({ mongoService, refreshMs: 1000 });
    svc.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(svc.isLoaded()).toBe(false);
    mongoService.db = { collection: () => col };
    await jest.advanceTimersByTimeAsync(1000);
    expect(svc.isLoaded()).toBe(true);
    expect(svc.get('a').addressName).toBe('Akira');
    svc.stop();
  });

  test('start() is idempotent', () => {
    jest.useFakeTimers();
    const { svc } = makeService([]);
    svc.start();
    svc.start();
    expect(jest.getTimerCount()).toBe(1);
    svc.stop();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('setAddressName', () => {
  test('creates a record for a new member and refreshes the cache', async () => {
    const { svc, col, fixedNow } = makeService([AKIRA]);
    await svc.load();
    const res = await svc.setAddressName('n', '  Newbie  ', 'n');
    expect(res).toEqual({ ok: true, record: { discordId: 'n', addressName: 'Newbie', aliases: [] } });
    expect(col.updateOne).toHaveBeenCalledWith(
      { _id: 'n' },
      { $set: { addressName: 'Newbie', aliases: [], updatedBy: 'n', updatedAt: fixedNow } },
      { upsert: true },
    );
    expect(svc.get('n').addressName).toBe('Newbie');
  });

  test('replaces the address name and keeps aliases', async () => {
    const { svc } = makeService([AKIRA]);
    await svc.load();
    const res = await svc.setAddressName('a', 'Aki', 'admin');
    expect(res.ok).toBe(true);
    expect(res.record).toEqual({ discordId: 'a', addressName: 'Aki', aliases: ['Akirasoft', 'Phalabala'] });
  });

  test('rejects invalid names', async () => {
    const { svc, col } = makeService([AKIRA]);
    await svc.load();
    expect(await svc.setAddressName('a', '🔥', 'a')).toEqual({ ok: false, reason: 'invalid' });
    expect(await svc.setAddressName('a', '1234', 'a')).toEqual({ ok: false, reason: 'invalid' });
    expect(await svc.setAddressName('', 'Fine', 'a')).toEqual({ ok: false, reason: 'invalid' });
    expect(col.updateOne).not.toHaveBeenCalled();
  });

  test('rejects a name held by ANOTHER member (address or alias, any case) with holderId', async () => {
    const { svc, col } = makeService([AKIRA, BOB]);
    await svc.load();
    expect(await svc.setAddressName('b', 'akira', 'b')).toEqual({ ok: false, reason: 'taken', holderId: 'a' });
    expect(await svc.setAddressName('b', 'PHALABALA', 'b')).toEqual({ ok: false, reason: 'taken', holderId: 'a' });
    expect(col.updateOne).not.toHaveBeenCalled();
  });

  test('a member may take one of their own aliases as address name', async () => {
    const { svc } = makeService([AKIRA]);
    await svc.load();
    const res = await svc.setAddressName('a', 'akirasoft', 'a');
    expect(res.ok).toBe(true);
    expect(res.record.addressName).toBe('akirasoft');
  });

  test('collision check runs against fresh data, not a stale cache', async () => {
    const { svc, col } = makeService([AKIRA]);
    await svc.load();
    col.docs.set('b', { ...BOB }); // written by another replica / out of band
    expect(await svc.setAddressName('n', 'bob', 'n')).toEqual({ ok: false, reason: 'taken', holderId: 'b' });
  });

  test('unavailable when Mongo is missing or the write fails', async () => {
    const svc = new MemberIdentityService({ mongoService: { db: null } });
    expect(await svc.setAddressName('a', 'Akira', 'a')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await svc.addAlias('a', 'Akira', 'a')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await svc.removeAlias('a', 'Akira', 'a')).toEqual({ ok: false, reason: 'unavailable' });

    const { svc: svc2, col } = makeService([AKIRA]);
    col.updateOne.mockRejectedValueOnce(new Error('write failed'));
    expect(await svc2.setAddressName('a', 'Aki', 'a')).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('addAlias', () => {
  test('appends an alias (upserting a record with null address name if needed)', async () => {
    const { svc, col, fixedNow } = makeService([]);
    await svc.load();
    const res = await svc.addAlias('n', 'Nuggets', 'admin');
    expect(res).toEqual({ ok: true, record: { discordId: 'n', addressName: null, aliases: ['Nuggets'] } });
    expect(col.updateOne).toHaveBeenCalledWith(
      { _id: 'n' },
      { $set: { addressName: null, aliases: ['Nuggets'], updatedBy: 'admin', updatedAt: fixedNow } },
      { upsert: true },
    );
  });

  test('adding an existing alias (any case) is idempotent and does not write', async () => {
    const { svc, col } = makeService([AKIRA]);
    await svc.load();
    const res = await svc.addAlias('a', 'AKIRASOFT', 'a');
    expect(res).toEqual({ ok: true, record: { discordId: 'a', addressName: 'Akira', aliases: ['Akirasoft', 'Phalabala'] } });
    expect(col.updateOne).not.toHaveBeenCalled();
  });

  test('an alias equal to the member\'s own address name is allowed', async () => {
    const { svc } = makeService([AKIRA]);
    await svc.load();
    const res = await svc.addAlias('a', 'akira', 'a');
    expect(res.ok).toBe(true);
    expect(res.record.aliases).toEqual(['Akirasoft', 'Phalabala', 'akira']);
  });

  test('rejects an alias held by another member', async () => {
    const { svc } = makeService([AKIRA, BOB]);
    await svc.load();
    expect(await svc.addAlias('b', 'akirasoft', 'b')).toEqual({ ok: false, reason: 'taken', holderId: 'a' });
    expect(await svc.addAlias('a', 'bob', 'a')).toEqual({ ok: false, reason: 'taken', holderId: 'b' });
  });

  test('rejects invalid aliases', async () => {
    const { svc } = makeService([AKIRA]);
    await svc.load();
    expect(await svc.addAlias('a', '   ', 'a')).toEqual({ ok: false, reason: 'invalid' });
    expect(await svc.addAlias('a', '99', 'a')).toEqual({ ok: false, reason: 'invalid' });
  });

  test('caps aliases at 10 per member', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `Name${String.fromCharCode(65 + i)}`);
    const { svc, col } = makeService([{ _id: 'a', addressName: 'Akira', aliases: ten }]);
    await svc.load();
    expect(await svc.addAlias('a', 'Eleventh', 'a')).toEqual({ ok: false, reason: 'too_many' });
    // ...but re-adding one they already have stays idempotent, not too_many
    expect((await svc.addAlias('a', 'namea', 'a')).ok).toBe(true);
    expect(col.updateOne).not.toHaveBeenCalled();
  });
});

describe('removeAlias', () => {
  test('removes case-insensitively and refreshes the cache', async () => {
    const { svc } = makeService([AKIRA]);
    await svc.load();
    const res = await svc.removeAlias('a', 'akiraSOFT', 'a');
    expect(res).toEqual({ ok: true, record: { discordId: 'a', addressName: 'Akira', aliases: ['Phalabala'] } });
    expect(svc.get('a').aliases).toEqual(['Phalabala']);
  });

  test('not_found for an alias the member does not have, or a member with no record', async () => {
    const { svc, col } = makeService([AKIRA]);
    await svc.load();
    expect(await svc.removeAlias('a', 'Nope', 'a')).toEqual({ ok: false, reason: 'not_found' });
    expect(await svc.removeAlias('zzz', 'Akira', 'zzz')).toEqual({ ok: false, reason: 'not_found' });
    expect(await svc.removeAlias('a', '', 'a')).toEqual({ ok: false, reason: 'not_found' });
    expect(col.updateOne).not.toHaveBeenCalled();
  });
});
