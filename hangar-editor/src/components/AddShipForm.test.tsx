import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddShipForm } from './AddShipForm';
import { mockFetch, renderWithProviders } from '../test/utils';
import { errorText } from './Status';
import { ApiError } from '../api/client';

describe('AddShipForm', () => {
  it('searches the catalog and adds the picked ship by uuid', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/catalog/vehicles': { body: { vehicles: [{ uuid: 'v-cut', name: 'Cutlass Black', manufacturer: 'Drake' }] } },
      'POST /api/v1/members/111/ships': { status: 201, body: { ship: { shipId: 'n' } } },
    });
    const user = userEvent.setup();
    renderWithProviders(<AddShipForm memberId="111" />);
    await user.type(screen.getByPlaceholderText(/Search the catalog/), 'cutlass');
    await user.click(await screen.findByRole('button', { name: /Cutlass Black/ }));
    await user.type(screen.getByLabelText('Nickname (optional)'), 'Cutty');
    await user.click(screen.getByRole('button', { name: 'Add ship' }));
    await screen.findByPlaceholderText(/Search the catalog/);
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ vehicle: 'v-cut', nickname: 'Cutty' });
  });

  it('shows the ship-limit message on 409 limit', async () => {
    mockFetch({
      'GET /api/v1/catalog/vehicles': { body: { vehicles: [{ uuid: 'v-cut', name: 'Cutlass Black' }] } },
      'POST /api/v1/members/111/ships': {
        status: 409,
        body: { error: 'limit', message: 'member 111 already has 200 ships', limit: 200, shipCount: 200 },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<AddShipForm memberId="111" />);
    await user.type(screen.getByPlaceholderText(/Search the catalog/), 'cutlass');
    await user.click(await screen.findByRole('button', { name: /Cutlass Black/ }));
    await user.click(screen.getByRole('button', { name: 'Add ship' }));
    expect(
      await screen.findByText('Hangar limit reached: at most 200 ships per member (this hangar has 200). Remove a ship first.'),
    ).toBeInTheDocument();
  });

  it('falls back to the server message when the limit body has no numbers', () => {
    expect(errorText(new ApiError(409, 'limit', 'too many ships'))).toBe('Hangar limit reached: too many ships');
  });
});
