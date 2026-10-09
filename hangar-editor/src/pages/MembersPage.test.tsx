import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate } from '../auth/AuthGate';
import { MembersPage } from './MembersPage';
import { ME, mockFetch, renderWithProviders } from '../test/utils';

const MEMBERS = [
  { discordId: '222', shipCount: 3, displayName: 'Admin' }, // a spoofable display name
  { discordId: '111', shipCount: 1, displayName: 'Pilot' },
  { discordId: '333', shipCount: 2 }, // no known name
];

function renderMembers(me = ME) {
  mockFetch({ 'GET /api/me': { body: me }, 'GET /api/v1/members': { body: { members: MEMBERS } } });
  return renderWithProviders(
    <AuthGate>
      <MembersPage />
    </AuthGate>,
    { route: '/members' },
  );
}

describe('MembersPage', () => {
  it('shows the Discord ID next to every display name', async () => {
    renderMembers();
    const admin = (await screen.findByText('Admin')).closest('a')!;
    expect(within(admin).getByText('222')).toHaveClass('member-id');
    expect(admin).toHaveAttribute('href', '/members/222');
    expect(within(admin).getByText('3 ships')).toBeInTheDocument();
  });

  it('shows a nameless member by ID only (no duplicate) and links you to your own hangar', async () => {
    renderMembers();
    const nameless = (await screen.findByText('333')).closest('a')!;
    expect(within(nameless).getAllByText('333')).toHaveLength(1);
    const self = screen.getByText('you').closest('a')!;
    expect(self).toHaveAttribute('href', '/');
    expect(within(self).getByText('111')).toBeInTheDocument();
    expect(within(self).getByText('1 ship')).toBeInTheDocument();
  });

  it('filters by name or ID', async () => {
    const user = userEvent.setup();
    renderMembers();
    await screen.findByText('Admin');
    await user.type(screen.getByLabelText('Filter members'), '333');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await user.clear(screen.getByLabelText('Filter members'));
    await user.type(screen.getByLabelText('Filter members'), 'nobody');
    expect(screen.getByText('No members match.')).toBeInTheDocument();
  });

  it('tells admins they can edit any hangar', async () => {
    renderMembers({ ...ME, isAdmin: true });
    expect(await screen.findByText(/As an admin you can edit any hangar/)).toBeInTheDocument();
  });
});
