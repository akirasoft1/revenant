import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { AuthGate } from '../auth/AuthGate';
import { ShipDetailPage } from './ShipDetailPage';
import { ME, mockFetch, renderWithProviders } from '../test/utils';
import type { Ship } from '../api/types';

// Simulates a stale/404'd content-hashed chunk: the lazy import rejects.
vi.mock('../components/terminal/TerminalShipView', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const SHIP: Ship = {
  shipId: 'ship-1',
  vehicleUuid: 'v-harb',
  vehicleName: 'Harbinger',
  vehicleClassName: null,
  nickname: null,
  fitted: {},
  loadoutError: null,
  loadout: [
    {
      slot: 'hardpoint_quantum_drive',
      type: 'QuantumDrive',
      sizeMin: 2,
      sizeMax: 2,
      compatibleTypes: [{ type: 'QuantumDrive', subTypes: [] }],
      item: { uuid: 'q1', name: 'Atlas' },
      source: 'stock',
    },
  ],
};

describe('ShipDetailPage terminal load failure', () => {
  it('falls back to Classic with a note instead of blanking the page', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('900px'), media: q, addEventListener() {}, removeEventListener() {} }));
    window.localStorage.setItem('hangar.shipView', 'terminal');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch({
      'GET /api/me': { body: ME },
      'GET /api/v1/members/111/hangar': { body: { member: '111', ships: [SHIP] } },
      'GET /api/v1/members': { body: { members: [] } },
      'GET /api/v1/catalog/vehicles/v-harb/slots': { body: { vehicle: { uuid: 'v-harb', name: 'Harbinger' }, slots: [] } },
      'GET /api/v1/catalog/vehicles/v-harb/positions': { body: {} },
    });
    try {
      renderWithProviders(
        <AuthGate>
          <Routes>
            <Route path="/members/:memberId/ships/:shipId" element={<ShipDetailPage />} />
          </Routes>
        </AuthGate>,
        { route: '/members/111/ships/ship-1' },
      );
      expect(await screen.findByText(/Terminal view failed to load/)).toBeInTheDocument();
      expect(screen.getByText('Atlas')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Harbinger');
      expect(screen.getByRole('button', { name: 'Classic' })).toHaveAttribute('aria-pressed', 'true');
    } finally {
      window.localStorage.removeItem('hangar.shipView');
    }
  });
});
