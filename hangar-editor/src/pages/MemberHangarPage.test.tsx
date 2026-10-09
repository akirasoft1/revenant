import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { AuthGate } from '../auth/AuthGate';
import { MemberHangarPage } from './MemberHangarPage';
import { ME, mockFetch, renderWithProviders } from '../test/utils';
import type { Ship } from '../api/types';

const SHIP: Ship = {
  shipId: 's1',
  vehicleUuid: 'v',
  vehicleName: 'Cutlass Black',
  vehicleClassName: null,
  nickname: null,
  fitted: {},
  loadout: [],
  loadoutError: null,
};

function renderMember(me = ME) {
  mockFetch({
    'GET /api/me': { body: me },
    'GET /api/v1/members/222/hangar': { body: { member: '222', ships: [SHIP] } },
    'GET /api/v1/members': { body: { members: [{ discordId: '222', shipCount: 1, displayName: 'Wingman' }] } },
  });
  return renderWithProviders(
    <AuthGate>
      <Routes>
        <Route path="/members/:memberId" element={<MemberHangarPage />} />
      </Routes>
    </AuthGate>,
    { route: '/members/222' },
  );
}

describe('MemberHangarPage', () => {
  it('is read-only for non-admins and shows the Discord ID beside the name', async () => {
    renderMember();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Wingman’s hangar'));
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('222');
    expect(h1).toHaveTextContent('read-only');
    expect(await screen.findByText('Cutlass Black')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add ship' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
  });

  it('lets admins edit, and the import button targets that member', async () => {
    renderMember({ ...ME, isAdmin: true });
    expect(await screen.findByText('admin edit')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '+ Add ship' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import from spviewer' })).toHaveAttribute('href', '/import?member=222');
  });
});
