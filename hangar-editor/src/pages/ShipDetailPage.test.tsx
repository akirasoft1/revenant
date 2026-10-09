import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { AuthGate } from '../auth/AuthGate';
import { ShipDetailPage } from './ShipDetailPage';
import { ME, mockFetch, renderWithProviders } from '../test/utils';
import type { Ship } from '../api/types';

const SHIP: Ship = {
  shipId: 'ship-1',
  vehicleUuid: 'v-harb',
  vehicleName: 'Harbinger',
  vehicleClassName: 'RSI_Harbinger',
  nickname: 'Big H',
  fitted: { hardpoint_quantum_drive: { uuid: 'q2', name: 'XL-1' } },
  loadoutError: null,
  loadout: [
    {
      slot: 'hardpoint_quantum_drive',
      type: 'QuantumDrive',
      sizeMin: 2,
      sizeMax: 2,
      compatibleTypes: [{ type: 'QuantumDrive', subTypes: [] }],
      item: { uuid: 'q2', name: 'XL-1' },
      source: 'fitted',
    },
    {
      slot: 'hardpoint_nose/hardpoint_class_2',
      type: 'WeaponGun',
      sizeMin: 1,
      sizeMax: 3,
      compatibleTypes: [{ type: 'WeaponGun', subTypes: [] }],
      item: { uuid: 'g1', name: 'CF-337 Panther' },
      source: 'stock',
    },
  ],
};

const STOCK_SLOTS = {
  vehicle: { uuid: 'v-harb', name: 'Harbinger' },
  slots: [
    {
      slot: 'hardpoint_quantum_drive',
      type: 'QuantumDrive',
      subType: null,
      sizeMin: 2,
      sizeMax: 2,
      compatibleTypes: [],
      stockItem: { uuid: 'q1', name: 'Atlas' },
    },
  ],
};

function renderShip(memberId: string) {
  return renderWithProviders(
    <AuthGate>
      <Routes>
        <Route path="/members/:memberId/ships/:shipId" element={<ShipDetailPage />} />
      </Routes>
    </AuthGate>,
    { route: `/members/${memberId}/ships/ship-1` },
  );
}

describe('ShipDetailPage', () => {
  it('groups slots by type with stock/fitted badges, and resets a fitted slot', async () => {
    const reset: Ship = {
      ...SHIP,
      fitted: {},
      loadout: SHIP.loadout!.map((s) =>
        s.slot === 'hardpoint_quantum_drive' ? { ...s, item: { uuid: 'q1', name: 'Atlas' }, source: 'stock' } : s,
      ),
    };
    const { calls } = mockFetch({
      'GET /api/me': { body: ME },
      'GET /api/v1/members/111/hangar': { body: { member: '111', ships: [SHIP] } },
      'GET /api/v1/members': { body: { members: [] } },
      'GET /api/v1/catalog/vehicles/v-harb/slots': { body: STOCK_SLOTS },
      'DELETE /api/v1/members/111/ships/ship-1/slots/hardpoint_quantum_drive': { body: { ship: reset } },
    });
    const user = userEvent.setup();
    renderShip('111');

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Big H');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Guns', 'Quantum drive']);

    const qdRow = screen.getByText('XL-1').closest('tr')!;
    expect(within(qdRow).getByText('fitted')).toBeInTheDocument();
    expect(await within(qdRow).findByText(/stock: Atlas/)).toBeInTheDocument();
    const gunRow = screen.getByText('CF-337 Panther').closest('tr')!;
    expect(within(gunRow).getByText('stock')).toBeInTheDocument();
    expect(within(gunRow).getByText('S1–3')).toBeInTheDocument();
    expect(within(gunRow).queryByRole('button', { name: 'Reset to stock' })).toBeNull();

    await user.click(within(qdRow).getByRole('button', { name: 'Reset to stock' }));
    await waitFor(() => expect(screen.getByText('Atlas')).toBeInTheDocument());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it("is read-only on another member's ship for non-admins", async () => {
    mockFetch({
      'GET /api/me': { body: ME },
      'GET /api/v1/members/222/hangar': { body: { member: '222', ships: [SHIP] } },
      'GET /api/v1/members': { body: { members: [{ discordId: '222', shipCount: 1, displayName: 'Wingman' }] } },
      'GET /api/v1/catalog/vehicles/v-harb/slots': { body: STOCK_SLOTS },
    });
    renderShip('222');
    expect(await screen.findByText('read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(await screen.findByRole('link', { name: 'Wingman’s hangar' })).toHaveAttribute('href', '/members/222');
  });

  it("lets admins edit another member's ship", async () => {
    mockFetch({
      'GET /api/me': { body: { ...ME, isAdmin: true } },
      'GET /api/v1/members/222/hangar': { body: { member: '222', ships: [SHIP] } },
      'GET /api/v1/members': { body: { members: [] } },
      'GET /api/v1/catalog/vehicles/v-harb/slots': { body: STOCK_SLOTS },
    });
    renderShip('222');
    expect(await screen.findAllByRole('button', { name: 'Change' })).toHaveLength(2);
  });

  it('opens the picker and fits the chosen item', async () => {
    const fitted: Ship = {
      ...SHIP,
      loadout: SHIP.loadout!.map((s) =>
        s.slot === 'hardpoint_quantum_drive' ? { ...s, item: { uuid: 'q3', name: 'Crossfield' } } : s,
      ),
    };
    const { calls } = mockFetch({
      'GET /api/me': { body: ME },
      'GET /api/v1/members/111/hangar': { body: { member: '111', ships: [SHIP] } },
      'GET /api/v1/members': { body: { members: [] } },
      'GET /api/v1/catalog/vehicles/v-harb/slots': { body: STOCK_SLOTS },
      'GET /api/v1/catalog/slot-options': {
        body: {
          items: [
            { uuid: 'q3', name: 'Crossfield', type: 'QuantumDrive', size: 2, grade: 'A', class: 'Military',
              keyStat: { name: 'Speed', value: 200, lowerIsBetter: false } },
          ],
        },
      },
      'PUT /api/v1/members/111/ships/ship-1/slots/hardpoint_quantum_drive': { body: { ship: fitted } },
    });
    const user = userEvent.setup();
    renderShip('111');
    const qdRow = (await screen.findByText('XL-1')).closest('tr')!;
    await user.click(within(qdRow).getByRole('button', { name: 'Change' }));
    await user.click(await screen.findByRole('button', { name: 'Fit Crossfield' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Crossfield')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ item: 'q3' });
  });

  it('explains when the ship has no catalog loadout', async () => {
    mockFetch({
      'GET /api/me': { body: ME },
      'GET /api/v1/members/111/hangar': {
        body: { member: '111', ships: [{ ...SHIP, loadout: null, loadoutError: 'unavailable' }] },
      },
      'GET /api/v1/members': { body: { members: [] } },
    });
    renderShip('111');
    expect(await screen.findByText(/game catalog is unavailable/)).toBeInTheDocument();
  });
});
