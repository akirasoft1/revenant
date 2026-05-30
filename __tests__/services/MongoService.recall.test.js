// __tests__/services/MongoService.recall.test.js
jest.mock('mongodb', () => ({ MongoClient: jest.fn().mockImplementation(() => ({ connect: jest.fn(), db: jest.fn() })) }));
jest.mock('../../logger', () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }));
jest.mock('../../tracing', () => ({ withSpan: (n, a, fn) => fn({ setAttribute: jest.fn(), setAttributes: jest.fn() }) }));
jest.mock('../../tracing-attributes', () => ({ DB: {}, ERROR: {} }), { virtual: true });

const MongoService = require('../../services/MongoService');

function makeService(collectionImpl) {
  const svc = Object.create(MongoService.prototype);
  svc.db = { collection: jest.fn(() => collectionImpl) };
  return svc;
}

describe('MongoService recall methods', () => {
  it('getRecallLedger returns a map keyed by memoryKey', async () => {
    const coll = { find: jest.fn(() => ({ toArray: () => Promise.resolve([{ memoryKey: 'k1', importance: 0.5 }]) })) };
    const svc = makeService(coll);
    const out = await svc.getRecallLedger(['k1']);
    expect(out.k1.importance).toBe(0.5);
  });

  it('getRecallLedger returns {} for empty input', async () => {
    const svc = makeService({});
    expect(await svc.getRecallLedger([])).toEqual({});
  });

  it('bumpRecallAccess issues a bulkWrite with upsert pipeline ops', async () => {
    const bulkWrite = jest.fn().mockResolvedValue({});
    const svc = makeService({ bulkWrite });
    await svc.bumpRecallAccess([{ memoryKey: 'k1', scope: {}, source: 'mem0:personal', contentHash: 'h', importanceSeed: 0.5 }], { nudge: 0.02, importanceMax: 1.0 });
    expect(bulkWrite).toHaveBeenCalled();
    const ops = bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.upsert).toBe(true);
    expect(Array.isArray(ops[0].updateOne.update)).toBe(true); // pipeline update
  });

  it('recordRecallComparison inserts a doc with a ts', async () => {
    const insertOne = jest.fn().mockResolvedValue({});
    const svc = makeService({ insertOne });
    await svc.recordRecallComparison({ query: 'q' });
    expect(insertOne).toHaveBeenCalled();
    expect(insertOne.mock.calls[0][0].ts).toBeInstanceOf(Date);
  });
});
