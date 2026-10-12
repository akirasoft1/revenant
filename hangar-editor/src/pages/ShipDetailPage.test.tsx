import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // The hangar is re-read after a write, so the mock answers with the server's current state.
    let current = SHIP;
    const { calls } = mockFetch({
      'GET /api/me': { body: ME },
      'GET /api/v1/members/111/hangar': () => ({ body: { member: '111', ships: [current] } }),
      'GET /api/v1/members': { body: { members: [] } },
      'GET /api/v1/catalog/vehicles/v-harb/slots': { body: STOCK_SLOTS },
      'DELETE /api/v1/members/111/ships/ship-1/slots/hardpoint_quantum_drive': () => {
        current = reset;
        return { body: { ship: reset } };
      },
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
    // The (spoofable) display name is always accompanied by the Discord ID.
    expect(document.querySelector('.crumbs')).toHaveTextContent('Wingman’s hangar 222');
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
    let current = SHIP;
    const { calls } = mockFetch({
      'GET /api/me': { body: ME },
      'GET /api/v1/members/111/hangar': () => ({ body: { member: '111', ships: [current] } }),
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
      'PUT /api/v1/members/111/ships/ship-1/slots/hardpoint_quantum_drive': () => {
        current = fitted;
        return { body: { ship: fitted } };
      },
    });
    const user = userEvent.setup();
    renderShip('111');
    const qdRow = (await screen.findByText('XL-1')).closest('tr')!;
    await user.click(within(qdRow).getByRole('button', { name: 'Change' }));
    await user.click(await screen.findByRole('button', { name: 'Fit Crossfield' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Crossfield')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ item: 'q3' });
    // The picker names the member's ship, so slots owned by fitted items can be found.
    expect(calls.find((c) => c.url.includes('/catalog/slot-options'))!.url).toBe(
      '/api/v1/catalog/slot-options?vehicle=v-harb&slot=hardpoint_quantum_drive&member=111&ship=ship-1',
    );
  });

  describe('slots that come from a fitted item', () => {
    const TURRET = 'hardpoint_weapon_center';
    const LEFT = `${TURRET}/hardpoint_weapon_S3_left`;
    const RIGHT = `${TURRET}/hardpoint_weapon_S3_right`;
    const turretSlot = (item: { uuid: string; name: string }, source: 'stock' | 'fitted') => ({
      slot: TURRET,
      type: 'Turret',
      sizeMin: 5,
      sizeMax: 5,
      compatibleTypes: [{ type: 'Turret', subTypes: [] }],
      item,
      source,
    });
    const gunSlot = (slot: string, item: { uuid: string; name: string } | null) => ({
      slot,
      type: 'WeaponGun',
      sizeMin: 3,
      sizeMax: 3,
      compatibleTypes: [{ type: 'WeaponGun', subTypes: [] }],
      item,
      source: item ? ('fitted' as const) : ('stock' as const),
      dynamic: true,
    });
    const CARGO = { uuid: 'cargo', name: 'Cargo Module' };
    const BALL = { uuid: 'ball', name: 'C5-173f Ball Turret' };
    const MANTIS = { uuid: 'mantis', name: 'Mantis GT-220' };
    // Stock: a cargo module in the centre mount, so no gun slots at all.
    const BARE: Ship = { ...SHIP, fitted: {}, loadout: [turretSlot(CARGO, 'stock')] };
    // With the ball turret fitted, its two gun mounts are slots of the ship.
    const TURRETED: Ship = {
      ...SHIP,
      fitted: { [TURRET]: BALL, [LEFT]: MANTIS },
      loadout: [turretSlot(BALL, 'fitted'), gunSlot(LEFT, MANTIS), gunSlot(RIGHT, null)],
    };
    const TURRET_OPTIONS = { items: [{ uuid: 'ball', name: BALL.name, type: 'Turret', size: 5, grade: null, class: null, keyStat: null }] };
    const slotPath = `/api/v1/members/111/ships/ship-1/slots/${TURRET}`;

    it('fitting a parent re-reads the hangar and shows the child slots it brought', async () => {
      let current = BARE;
      const { calls } = mockFetch({
        'GET /api/me': { body: ME },
        'GET /api/v1/members/111/hangar': () => ({ body: { member: '111', ships: [current] } }),
        'GET /api/v1/members': { body: { members: [] } },
        'GET /api/v1/catalog/vehicles/v-harb/slots': { body: STOCK_SLOTS },
        'GET /api/v1/catalog/slot-options': { body: TURRET_OPTIONS },
        // The write's own ship is stale on purpose: the child rows must come from the re-read.
        [`PUT ${slotPath}`]: () => {
          current = TURRETED;
          return { body: { ship: { ...TURRETED, loadout: [turretSlot(BALL, 'fitted')] } } };
        },
      });
      const user = userEvent.setup();
      renderShip('111');
      const row = (await screen.findByText('Cargo Module')).closest('tr')!;
      await user.click(within(row).getByRole('button', { name: 'Change' }));
      await user.click(await screen.findByRole('button', { name: `Fit ${BALL.name}` }));
      // Child rows read as nested slots do: parent › child.
      expect(await screen.findByText('weapon center › weapon S3 left')).toBeInTheDocument();
      expect(screen.getByText('weapon center › weapon S3 right')).toBeInTheDocument();
      expect(screen.getByText('Mantis GT-220')).toBeInTheDocument();
      expect(calls.filter((c) => c.url === '/api/v1/members/111/hangar')).toHaveLength(2);
      // No fittings were dropped: nothing to announce.
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('resetting a parent removes its child slots and names the fittings dropped with it', async () => {
      let current = TURRETED;
      mockFetch({
        'GET /api/me': { body: ME },
        'GET /api/v1/members/111/hangar': () => ({ body: { member: '111', ships: [current] } }),
        'GET /api/v1/members': { body: { members: [] } },
        'GET /api/v1/catalog/vehicles/v-harb/slots': { body: STOCK_SLOTS },
        [`DELETE ${slotPath}`]: () => {
          current = BARE;
          return { body: { ship: BARE, dropped: [{ slot: LEFT, item: MANTIS }] } };
        },
      });
      const user = userEvent.setup();
      renderShip('111');
      const row = (await screen.findByText(BALL.name)).closest('tr')!;
      expect(screen.getByText('weapon center › weapon S3 left')).toBeInTheDocument();
      await user.click(within(row).getByRole('button', { name: 'Reset to stock' }));
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Also removed 1 fitting that no longer fits: Mantis GT-220 (weapon center › weapon S3 left).',
      );
      expect(screen.queryByText('weapon center › weapon S3 left')).toBeNull();
      expect(screen.getByText('Cargo Module')).toBeInTheDocument();
    });

    it('a loadout change drops the ship’s cached slot options (a refit parent changes what children accept)', async () => {
      let current = TURRETED;
      const { calls } = mockFetch({
        'GET /api/me': { body: ME },
        'GET /api/v1/members/111/hangar': () => ({ body: { member: '111', ships: [current] } }),
        'GET /api/v1/members': { body: { members: [] } },
        'GET /api/v1/catalog/vehicles/v-harb/slots': { body: STOCK_SLOTS },
        'GET /api/v1/catalog/slot-options': { body: { items: [] } },
        [`DELETE /api/v1/members/111/ships/ship-1/slots/${encodeURIComponent(LEFT)}`]: () => {
          current = { ...TURRETED, fitted: { [TURRET]: BALL }, loadout: [turretSlot(BALL, 'fitted'), gunSlot(LEFT, null), gunSlot(RIGHT, null)] };
          return { body: { ship: current } };
        },
      });
      const optionCalls = () => calls.filter((c) => c.url.includes('/catalog/slot-options'));
      const user = userEvent.setup();
      renderShip('111');
      const rightRow = () => screen.getByText('weapon center › weapon S3 right').closest('tr')!;
      await screen.findByText(BALL.name);
      await user.click(within(rightRow()).getByRole('button', { name: 'Change' }));
      await screen.findByText('No compatible items found for this slot.');
      expect(optionCalls()).toHaveLength(1);
      // A dynamic slot is only known through the ship.
      expect(optionCalls()[0].url).toBe(
        `/api/v1/catalog/slot-options?vehicle=v-harb&slot=${encodeURIComponent(RIGHT)}&member=111&ship=ship-1`,
      );
      await user.click(screen.getByRole('button', { name: 'Close' }));
      // Reopening straight away is served from the cache…
      await user.click(within(rightRow()).getByRole('button', { name: 'Change' }));
      await user.click(screen.getByRole('button', { name: 'Close' }));
      expect(optionCalls()).toHaveLength(1);
      // …but not after the loadout changed.
      const leftRow = screen.getByText('weapon center › weapon S3 left').closest('tr')!;
      await user.click(within(leftRow).getByRole('button', { name: 'Reset to stock' }));
      await waitFor(() => expect(screen.queryByText('Mantis GT-220')).toBeNull());
      await user.click(within(rightRow()).getByRole('button', { name: 'Change' }));
      await waitFor(() => expect(optionCalls()).toHaveLength(2));
    });
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

  describe('view toggle', () => {
    const routes = () => ({
      'GET /api/me': { body: ME },
      'GET /api/v1/members/111/hangar': { body: { member: '111', ships: [SHIP] } },
      'GET /api/v1/members': { body: { members: [] } },
      'GET /api/v1/catalog/vehicles/v-harb/slots': { body: STOCK_SLOTS },
      'GET /api/v1/catalog/vehicles/v-harb/positions': { body: {} },
    });
    const stubMedia = (wide: boolean) =>
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: wide && q.includes('900px'), media: q, addEventListener() {}, removeEventListener() {} }));
    beforeEach(() => window.localStorage.removeItem('hangar.shipView'));
    afterEach(() => window.localStorage.removeItem('hangar.shipView'));

    it('wide: shows Classic/Terminal toggle and persists the choice', async () => {
      stubMedia(true);
      mockFetch(routes());
      const user = userEvent.setup();
      renderShip('111');
      expect(await screen.findByRole('button', { name: 'Classic' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument();
      expect(screen.queryByTestId('terminal-view')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Terminal' }));
      expect(await screen.findByTestId('terminal-view')).toBeInTheDocument();
      expect(window.localStorage.getItem('hangar.shipView')).toBe('terminal');
      await user.click(screen.getByRole('button', { name: 'Classic' }));
      expect(screen.queryByTestId('terminal-view')).toBeNull();
      expect(window.localStorage.getItem('hangar.shipView')).toBe('classic');
    });

    it('wide: restores a persisted Terminal preference', async () => {
      stubMedia(true);
      window.localStorage.setItem('hangar.shipView', 'terminal');
      mockFetch(routes());
      renderShip('111');
      expect(await screen.findByTestId('terminal-view')).toBeInTheDocument();
    });

    it('narrow: no toggle and Classic renders even if Terminal is persisted', async () => {
      stubMedia(false);
      window.localStorage.setItem('hangar.shipView', 'terminal');
      mockFetch(routes());
      renderShip('111');
      expect(await screen.findByText('XL-1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
      expect(screen.queryByTestId('terminal-view')).toBeNull();
    });
  });
});
