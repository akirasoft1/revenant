jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('google-auth-library', () => {
  const getIdTokenClient = jest.fn();
  const GoogleAuth = jest.fn(() => ({ getIdTokenClient }));
  GoogleAuth.__getIdTokenClient = getIdTokenClient;
  return { GoogleAuth };
});

const { GoogleAuth } = require('google-auth-library');
const logger = require('../../logger');
const HangarClient = require('../../services/HangarClient');

const API = 'https://hangar-service-hvmf2jpuca-uc.a.run.app';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(body === undefined ? '' : JSON.stringify(body)),
  };
}

function tokenClient(token = 'tok-1') {
  return { getRequestHeaders: jest.fn().mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` })) };
}

describe('HangarClient', () => {
  let fetchImpl, authFactory, tc;
  const make = (opts = {}) => new HangarClient({
    apiUrl: API, saKeyPath: '/k.json', fetch: fetchImpl, authClientFactory: authFactory, ...opts,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    tc = tokenClient();
    authFactory = jest.fn().mockResolvedValue(tc);
    fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { member: '111', ships: [] }));
  });

  test('isEnabled reflects apiUrl', () => {
    expect(make().isEnabled()).toBe(true);
    expect(make({ apiUrl: '' }).isEnabled()).toBe(false);
  });

  test('getHangar GETs the member hangar with the ID token and returns data', async () => {
    const res = await make().getHangar('111');
    expect(res).toEqual({ ok: true, data: { member: '111', ships: [] } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${API}/v1/members/111/hangar`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(init.headers['X-Acting-Member']).toBeUndefined();
    expect(init.signal).toBeDefined();
    expect(authFactory).toHaveBeenCalledWith('/k.json', API);
  });

  test('a trailing slash on apiUrl is not doubled', async () => {
    await make({ apiUrl: `${API}/` }).getHangar('111');
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/v1/members/111/hangar`);
    expect(authFactory).toHaveBeenCalledWith('/k.json', API);
  });

  test('the ID-token client is created once and reused', async () => {
    const c = make();
    await c.getHangar('111');
    await c.getHangar('222');
    expect(authFactory).toHaveBeenCalledTimes(1);
    expect(tc.getRequestHeaders).toHaveBeenCalledTimes(2);
  });

  test('a failed token-client creation is not cached, and maps to unavailable', async () => {
    authFactory.mockRejectedValueOnce(new Error('ENOENT: no such file /k.json'));
    const c = make();
    const first = await c.getHangar('111');
    expect(first).toMatchObject({ ok: false, error: 'unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const second = await c.getHangar('111');
    expect(second.ok).toBe(true);
    expect(authFactory).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.some((c2) => String(c2[0]).includes('ENOENT: no such file /k.json'))).toBe(true);
  });

  test('default auth factory uses GoogleAuth({keyFile}).getIdTokenClient(audience)', async () => {
    GoogleAuth.__getIdTokenClient.mockResolvedValue(tc);
    const c = new HangarClient({ apiUrl: API, saKeyPath: '/var/secrets/hangar/key.json', fetch: fetchImpl });
    await c.getHangar('111');
    expect(GoogleAuth).toHaveBeenCalledWith({ keyFile: '/var/secrets/hangar/key.json' });
    expect(GoogleAuth.__getIdTokenClient).toHaveBeenCalledWith(API);
  });

  test('addShip POSTs vehicle + nickname with X-Acting-Member', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(201, { ship: { shipId: 's1' } }));
    const res = await make().addShip('111', { vehicle: 'uuid-1', nickname: 'Betty' }, '999');
    expect(res).toEqual({ ok: true, data: { ship: { shipId: 's1' } } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${API}/v1/members/111/ships`);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Acting-Member']).toBe('999');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ vehicle: 'uuid-1', nickname: 'Betty' });
  });

  test('addShip without nickname sends nickname null', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(201, { ship: {} }));
    await make().addShip('111', { vehicle: 'Harbinger' }, '111');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ vehicle: 'Harbinger', nickname: null });
  });

  test('renameShip PATCHes the nickname with X-Acting-Member and encodes the ship id', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, { ship: { shipId: 'a b' } }));
    await make().renameShip('111', 'a b', 'New', '111');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${API}/v1/members/111/ships/a%20b`);
    expect(init.method).toBe('PATCH');
    expect(init.headers['X-Acting-Member']).toBe('111');
    expect(JSON.parse(init.body)).toEqual({ nickname: 'New' });
  });

  test('removeShip DELETEs with X-Acting-Member', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, { deleted: true, shipId: 's1' }));
    const res = await make().removeShip('111', 's1', '42');
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${API}/v1/members/111/ships/s1`);
    expect(init.method).toBe('DELETE');
    expect(init.headers['X-Acting-Member']).toBe('42');
    expect(init.body).toBeUndefined();
  });

  test('writes without an acting member are refused locally (never sent)', async () => {
    const res = await make().removeShip('111', 's1', '');
    expect(res).toMatchObject({ ok: false, error: 'forbidden' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('searchVehicles passes q and limit', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, { vehicles: [{ uuid: 'u', name: 'Harbinger' }] }));
    const res = await make().searchVehicles('harb ing', { limit: 25 });
    expect(res.data.vehicles[0].name).toBe('Harbinger');
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/v1/catalog/vehicles?q=harb+ing&limit=25`);
  });

  test('409 ambiguous surfaces error, message and candidates', async () => {
    const candidates = [{ uuid: 'a', name: 'Constellation Taurus', label: 'Constellation Taurus' },
      { uuid: 'b', name: 'Constellation Andromeda', label: 'Constellation Andromeda' }];
    fetchImpl.mockResolvedValue(jsonResponse(409, { error: 'ambiguous', message: "'connie' matches several vehicles", candidates }));
    const res = await make().addShip('111', { vehicle: 'connie' }, '111');
    expect(res).toEqual({ ok: false, error: 'ambiguous', message: "'connie' matches several vehicles", candidates });
  });

  test.each([
    [404, 'not_found'], [403, 'forbidden'], [401, 'unauthenticated'], [422, 'incompatible'], [503, 'unavailable'], [400, 'invalid_request'],
  ])('%i envelope maps to its error code', async (status, code) => {
    fetchImpl.mockResolvedValue(jsonResponse(status, { error: code, message: `msg ${code}` }));
    const res = await make().getHangar('111');
    expect(res).toEqual({ ok: false, error: code, message: `msg ${code}` });
  });

  test('a non-JSON error body falls back to a status-derived code', async () => {
    fetchImpl.mockResolvedValue({ ok: false, status: 404, text: jest.fn().mockResolvedValue('<html>Google 404</html>') });
    const res = await make().getHangar('111');
    expect(res).toMatchObject({ ok: false, error: 'not_found' });
    const r2 = await (async () => {
      fetchImpl.mockResolvedValue({ ok: false, status: 502, text: jest.fn().mockResolvedValue('bad gateway') });
      return make().getHangar('111');
    })();
    expect(r2).toMatchObject({ ok: false, error: 'unavailable' });
  });

  test('a 2xx with invalid JSON is unavailable', async () => {
    fetchImpl.mockResolvedValue({ ok: true, status: 200, text: jest.fn().mockResolvedValue('not json') });
    expect(await make().getHangar('111')).toMatchObject({ ok: false, error: 'unavailable' });
  });

  test('network errors map to unavailable and are logged in full', async () => {
    const long = `connect ECONNREFUSED ${'x'.repeat(3000)}`;
    fetchImpl.mockRejectedValue(new Error(long));
    const res = await make().getHangar('111');
    expect(res).toMatchObject({ ok: false, error: 'unavailable' });
    expect(logger.warn.mock.calls.some((c) => String(c[0]).includes(long))).toBe(true);
  });

  test('a hung request times out as unavailable', async () => {
    fetchImpl.mockImplementation((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const res = await make({ timeoutMs: 30 }).getHangar('111');
    expect(res).toMatchObject({ ok: false, error: 'unavailable' });
  });

  test('a hung token mint is bounded by the same deadline', async () => {
    tc.getRequestHeaders.mockImplementation(() => new Promise(() => {}));
    const t0 = Date.now();
    const res = await make({ timeoutMs: 30 }).getHangar('111');
    expect(res).toMatchObject({ ok: false, error: 'unavailable' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('per-call timeout override (used by autocomplete)', async () => {
    fetchImpl.mockImplementation((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const res = await make({ timeoutMs: 60000 }).searchVehicles('x', { timeoutMs: 20 });
    expect(res).toMatchObject({ ok: false, error: 'unavailable' });
  });

  test('getHangar accepts a per-call timeout too', async () => {
    fetchImpl.mockImplementation((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const res = await make({ timeoutMs: 60000 }).getHangar('111', { timeoutMs: 20 });
    expect(res).toMatchObject({ ok: false, error: 'unavailable' });
  });

  test('not configured -> unavailable without any call', async () => {
    const res = await make({ apiUrl: '' }).getHangar('111');
    expect(res).toMatchObject({ ok: false, error: 'unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(authFactory).not.toHaveBeenCalled();
  });
});
