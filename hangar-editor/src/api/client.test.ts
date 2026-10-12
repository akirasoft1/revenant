import { describe, expect, it, vi } from 'vitest';
import { ApiError, fitSlot, getSlotOptions, slotOptionsKey, slotOptionsScope, getWireframe, importApply, getVehiclePositions, importPreview, loginUrl, resetShip, resetSlot } from './client';
import { mockFetch } from '../test/utils';

describe('api client', () => {
  it('parses {error, message} into ApiError', async () => {
    mockFetch({
      'PUT /api/v1/members': { status: 422, body: { error: 'incompatible', message: 'size 3 does not fit S1' } },
    });
    const err = await fitSlot('1', 's', 'slot', 'item').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'incompatible', message: 'size 3 does not fit S1' });
  });

  it('%2F-encodes nested slot ids and sends JSON writes same-origin', async () => {
    const { calls } = mockFetch({
      'PUT /api/v1/members': { body: { ship: { shipId: 's' } } },
      'DELETE /api/v1/members': { body: { ship: { shipId: 's' } } },
    });
    await fitSlot('1', 's', 'turret/hardpoint_class_2', 'uuid-1');
    await resetSlot('1', 's', 'turret/hardpoint_class_2');
    expect(calls[0]).toMatchObject({
      url: '/api/v1/members/1/ships/s/slots/turret%2Fhardpoint_class_2',
      method: 'PUT',
      body: { item: 'uuid-1' },
      credentials: 'same-origin',
    });
    expect(calls[1]).toMatchObject({ url: '/api/v1/members/1/ships/s/slots/turret%2Fhardpoint_class_2', method: 'DELETE' });
  });

  it('resetShip POSTs slot "all" to the ship reset route', async () => {
    const { calls } = mockFetch({ 'POST /api/v1/members': { body: { ship: { shipId: 's' }, changes: [] } } });
    await resetShip('1', 's');
    expect(calls[0]).toMatchObject({
      url: '/api/v1/members/1/ships/s/reset',
      method: 'POST',
      body: { slot: 'all' },
      credentials: 'same-origin',
    });
  });

  it('getVehiclePositions GETs the catalog positions route', async () => {
    const { calls } = mockFetch({ 'GET /api/v1/catalog': { body: {} } });
    await getVehiclePositions('abc-123');
    expect(calls[0]).toMatchObject({ url: '/api/v1/catalog/vehicles/abc-123/positions', method: 'GET' });
  });

  it('accepts an enveloped or bare slot-options response', async () => {
    mockFetch({ 'GET /api/v1/catalog/slot-options?vehicle=v&slot=a': { body: { items: [{ uuid: 'x' }] } } });
    expect(await getSlotOptions('v', 'a')).toEqual([{ uuid: 'x' }]);
    mockFetch({ 'GET /api/v1/catalog/slot-options?vehicle=v&slot=a': { body: [{ uuid: 'y' }] } });
    expect(await getSlotOptions('v', 'a')).toEqual([{ uuid: 'y' }]);
  });

  it('slot-options adds member + ship when given a ship, and keys the cache by them', async () => {
    const { calls } = mockFetch({ 'GET /api/v1/catalog/slot-options': { body: { items: [] } } });
    await getSlotOptions('v', 'turret/gun_left', { memberId: '42', shipId: 's/1' });
    expect(calls[0].url).toBe('/api/v1/catalog/slot-options?vehicle=v&slot=turret%2Fgun_left&member=42&ship=s%2F1');
    const a = slotOptionsKey('v', 'gun', { memberId: '42', shipId: 'a' });
    const b = slotOptionsKey('v', 'gun', { memberId: '42', shipId: 'b' });
    expect(a).not.toEqual(b);
    // Every slot of a ship sits under that ship's scope, so one invalidation covers them.
    expect(a.slice(0, 3)).toEqual([...slotOptionsScope({ memberId: '42', shipId: 'a' })]);
    expect(slotOptionsKey('v', 'gun')).toEqual(['slot-options', null, null, 'v', 'gun']);
  });

  it('fit and reset return the ship plus the child fittings the server dropped', async () => {
    mockFetch({
      'PUT /api/v1/members': { body: { ship: { shipId: 's' }, dropped: [{ slot: 't/gun', item: { uuid: 'g', name: 'Mantis' } }] } },
      'DELETE /api/v1/members': { body: { ship: { shipId: 's' } } },
    });
    expect(await fitSlot('1', 's', 't', 'uuid-1')).toEqual({ ship: { shipId: 's' }, dropped: [{ slot: 't/gun', name: 'Mantis' }] });
    expect(await resetSlot('1', 's', 't')).toEqual({ ship: { shipId: 's' }, dropped: [] });
  });

  it('normalises preview rows and apply results', async () => {
    mockFetch({
      'POST /api/v1/import/spviewer/preview': { body: { rows: [{ rowIndex: 0, loadoutName: 'x', vehicle: null }] } },
      'POST /api/v1/import/spviewer/apply': { body: [{ shipId: 'a' }] },
    });
    expect(await importPreview([])).toEqual([
      { rowIndex: 0, loadoutName: 'x', vehicle: null, changes: [], skipped: [], matchingShips: [] },
    ]);
    expect(await importApply([], [])).toEqual({ ships: [{ shipId: 'a' }], errors: [] });
  });

  it('builds the login URL with an encoded next path', () => {
    expect(loginUrl('/members/1?x=y')).toBe('/api/auth/login?next=%2Fmembers%2F1%3Fx%3Dy');
    expect(loginUrl('')).toBe('/api/auth/login?next=%2F');
  });

  describe('getWireframe', () => {
    const stub = (res: Response | Error) => {
      const fn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
        if (res instanceof Error) throw res;
        return res;
      });
      vi.stubGlobal('fetch', fn);
      return fn;
    };

    it('returns the raw bytes, revalidating with the server (no-cache) on the same origin', async () => {
      const bytes = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]);
      const fn = stub(new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
      const buf = await getWireframe('v/1');
      expect(buf).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(buf!)]).toEqual([...bytes]);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0][0]).toBe('/api/v1/models/vehicle/v%2F1/wireframe');
      expect(fn.mock.calls[0][1]).toMatchObject({ cache: 'no-cache', credentials: 'same-origin' });
    });

    it('answers null for 404 (no model stored)', async () => {
      stub(new Response(JSON.stringify({ error: 'not_found', message: 'no wireframe' }), { status: 404 }));
      expect(await getWireframe('v1')).toBeNull();
    });

    it('throws ApiError for other failures', async () => {
      stub(new Response(JSON.stringify({ error: 'unavailable', message: 'model store is not configured' }), { status: 503 }));
      await expect(getWireframe('v1')).rejects.toMatchObject({ status: 503, code: 'unavailable', message: 'model store is not configured' });
      stub(new Response('<html>bad gateway</html>', { status: 502 }));
      await expect(getWireframe('v1')).rejects.toMatchObject({ status: 502, code: 'http_502' });
      stub(new TypeError('Failed to fetch'));
      const err = await getWireframe('v1').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 0, code: 'network' });
    });
  });
});
