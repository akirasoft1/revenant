import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate } from '../auth/AuthGate';
import { HangarView } from './HangarView';
import { ME, mockFetch, renderWithProviders } from '../test/utils';
import type { Ship } from '../api/types';

const SHIP: Ship = {
  shipId: 's1',
  vehicleUuid: 'v',
  vehicleName: 'Cutlass Black',
  vehicleClassName: null,
  nickname: 'Cutty',
  fitted: { a: {}, b: {} },
  loadout: [],
  loadoutError: null,
};

function setup(extra: Parameters<typeof mockFetch>[0] = {}) {
  let ships: Ship[] = [SHIP];
  const mock = mockFetch({
    'GET /api/me': { body: ME },
    'GET /api/v1/members/111/hangar': () => ({ body: { member: '111', ships } }),
    'PATCH /api/v1/members/111/ships/s1': () => {
      ships = [{ ...SHIP, nickname: 'Big Cutty' }];
      return { body: { ship: ships[0] } };
    },
    'DELETE /api/v1/members/111/ships/s1': () => {
      ships = [];
      return { body: { deleted: true, shipId: 's1' } };
    },
    ...extra, // overrides the defaults above
  });
  renderWithProviders(
    <AuthGate>
      <HangarView memberId="111" editable />
    </AuthGate>,
  );
  return mock;
}

describe('HangarView', () => {
  it('shows ship cards with nickname, vehicle and fitted count, linking to the ship', async () => {
    setup();
    const link = (await screen.findByText('Cutty')).closest('a')!;
    expect(link).toHaveAttribute('href', '/members/111/ships/s1');
    expect(within(link).getByText('Cutlass Black')).toBeInTheDocument();
    expect(within(link).getByText('2 fitted')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import from spviewer' })).toHaveAttribute('href', '/import');
  });

  it('renames a ship inline', async () => {
    const { calls } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Nickname');
    await user.clear(input);
    await user.type(input, 'Big Cutty');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Big Cutty')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ nickname: 'Big Cutty' });
  });

  it('asks for confirmation before removing, and Keep cancels', async () => {
    const { calls } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Remove Cutty?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(screen.getByText(/No ships yet/)).toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('shows a removal error', async () => {
    setup({
      'DELETE /api/v1/members/111/ships/s1': { status: 403, body: { error: 'forbidden', message: 'not your hangar' } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(await screen.findByText('Not allowed: not your hangar')).toBeInTheDocument();
  });
});
