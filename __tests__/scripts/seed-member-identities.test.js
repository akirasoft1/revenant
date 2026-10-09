'use strict';
const { planSeed, applySeed } = require('../../scripts/seed-member-identities');

describe('planSeed', () => {
  test('plans an insert for every override ID with no existing record', () => {
    const { inserts, skipped } = planSeed({ 1: 'Mike', 2: 'Alex' }, []);
    expect(inserts).toEqual([
      { _id: '1', addressName: 'Mike' },
      { _id: '2', addressName: 'Alex' },
    ]);
    expect(skipped).toEqual([]);
  });

  test('never overwrites: IDs that already have a record are skipped', () => {
    const existing = [{ _id: '1', addressName: 'Michael', aliases: [] }];
    const { inserts, skipped } = planSeed({ 1: 'Mike', 2: 'Alex' }, existing);
    expect(inserts).toEqual([{ _id: '2', addressName: 'Alex' }]);
    expect(skipped).toEqual([{ _id: '1', name: 'Mike', reason: 'exists' }]);
  });

  test('sanitises names and skips ones the registry would reject', () => {
    const { inserts, skipped } = planSeed({ 1: '😂 LOL 😂', 2: '007', 3: '' }, []);
    expect(inserts).toEqual([{ _id: '1', addressName: 'LOL' }]);
    expect(skipped).toEqual([
      { _id: '2', name: '007', reason: 'invalid' },
      { _id: '3', name: '', reason: 'invalid' },
    ]);
  });

  test('skips names already held by another member (existing or planned)', () => {
    const existing = [{ _id: '9', addressName: 'Akira', aliases: ['Mike'] }];
    const { inserts, skipped } = planSeed({ 1: 'mike', 2: 'Alex', 3: 'ALEX' }, existing);
    expect(inserts).toEqual([{ _id: '2', addressName: 'Alex' }]);
    expect(skipped).toEqual([
      { _id: '1', name: 'mike', reason: 'taken', holderId: '9' },
      { _id: '3', name: 'ALEX', reason: 'taken', holderId: '2' },
    ]);
  });

  test('tolerates a non-object table', () => {
    expect(planSeed(null, [])).toEqual({ inserts: [], skipped: [] });
  });
});

describe('applySeed', () => {
  const now = new Date('2026-10-09T00:00:00Z');

  test('inserts full docs and counts duplicates (raced) as skipped, never overwriting', async () => {
    const col = {
      insertOne: jest.fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 })),
    };
    const res = await applySeed(col, [
      { _id: '1', addressName: 'Mike' },
      { _id: '2', addressName: 'Alex' },
    ], { now: () => now });
    expect(col.insertOne).toHaveBeenNthCalledWith(1, {
      _id: '1', addressName: 'Mike', aliases: [], updatedBy: 'seed', updatedAt: now,
    });
    expect(res).toEqual({ inserted: 1, duplicates: 1 });
  });

  test('other insert errors propagate', async () => {
    const col = { insertOne: jest.fn().mockRejectedValue(new Error('auth')) };
    await expect(applySeed(col, [{ _id: '1', addressName: 'Mike' }], { now: () => now })).rejects.toThrow('auth');
  });
});
