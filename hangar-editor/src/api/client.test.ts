import { describe, expect, it } from 'vitest';
import { ApiError, fitSlot, getSlotOptions, importApply, importPreview, loginUrl, resetSlot } from './client';
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

  it('accepts an enveloped or bare slot-options response', async () => {
    mockFetch({ 'GET /api/v1/catalog/slot-options?vehicle=v&slot=a': { body: { items: [{ uuid: 'x' }] } } });
    expect(await getSlotOptions('v', 'a')).toEqual([{ uuid: 'x' }]);
    mockFetch({ 'GET /api/v1/catalog/slot-options?vehicle=v&slot=a': { body: [{ uuid: 'y' }] } });
    expect(await getSlotOptions('v', 'a')).toEqual([{ uuid: 'y' }]);
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
});
