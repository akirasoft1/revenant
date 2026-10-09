import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LoadoutSlot, SlotOption } from '../api/types';
import { SlotOptionList, SlotPicker } from './SlotPicker';
import { mockFetch, renderWithProviders } from '../test/utils';

const COOLERS: SlotOption[] = [
  {
    uuid: 'c-hot',
    name: 'Hot Box',
    type: 'Cooler',
    size: 1,
    grade: 'D',
    class: 'Civilian',
    keyStat: { name: 'Cooling rate', value: 120, lowerIsBetter: false },
  },
  {
    uuid: 'c-ice',
    name: 'Ice Queen',
    type: 'Cooler',
    size: 1,
    grade: 'A',
    class: 'Military',
    keyStat: { name: 'Cooling rate', value: 300, lowerIsBetter: false },
    cheapestPrice: { price: 45210, shop: 'Platinum Bay', location: 'Port Olisar' },
  },
  {
    uuid: 'c-mid',
    name: 'Mid Chill',
    type: 'Cooler',
    size: 1,
    grade: 'B',
    class: 'Industrial',
    keyStat: { name: 'Cooling rate', value: 200, lowerIsBetter: false },
    cheapestPrice: { price: 9000, shop: 'Cousin Crow’s', location: 'Orison' },
  },
];

const rowNames = () => screen.getAllByTestId('slot-option').map((li) => within(li).getByText(/./, { selector: '.option-name' }).textContent);

describe('SlotOptionList', () => {
  it('lists best key stat first and shows price only when present', () => {
    render(<SlotOptionList options={COOLERS} onPick={() => {}} />);
    expect(rowNames()).toEqual(['Ice Queen', 'Mid Chill', 'Hot Box']);
    const [ice, , hot] = screen.getAllByTestId('slot-option');
    expect(within(ice).getByText(/45,210 aUEC/)).toBeInTheDocument();
    expect(within(ice).getByText(/Platinum Bay, Port Olisar/)).toBeInTheDocument();
    expect(within(hot).getByText('price unknown')).toBeInTheDocument();
    expect(screen.getByText(/higher is better/)).toBeInTheDocument();
  });

  it('respects lowerIsBetter', () => {
    const emissions = COOLERS.map((o) => ({ ...o, keyStat: { ...o.keyStat!, name: 'EM signature', lowerIsBetter: true } }));
    render(<SlotOptionList options={emissions} onPick={() => {}} />);
    expect(rowNames()).toEqual(['Hot Box', 'Mid Chill', 'Ice Queen']);
    expect(screen.getByText(/lower is better/)).toBeInTheDocument();
  });

  it('filters by text and re-sorts by price (unpriced last)', async () => {
    const user = userEvent.setup();
    render(<SlotOptionList options={COOLERS} onPick={() => {}} />);
    await user.selectOptions(screen.getByLabelText('Sort by'), 'price');
    expect(rowNames()).toEqual(['Mid Chill', 'Ice Queen', 'Hot Box']);
    await user.type(screen.getByLabelText('Filter items'), 'military');
    expect(rowNames()).toEqual(['Ice Queen']);
    await user.clear(screen.getByLabelText('Filter items'));
    await user.type(screen.getByLabelText('Filter items'), 'zzz');
    expect(screen.getByText('No items match the filter.')).toBeInTheDocument();
  });

  it('marks current and stock items and disables fitting the current one', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<SlotOptionList options={COOLERS} currentUuid="c-hot" stockUuid="c-mid" onPick={onPick} />);
    expect(screen.getByRole('button', { name: 'Fit Hot Box' })).toBeDisabled();
    expect(within(screen.getAllByTestId('slot-option')[1]).getByText('stock')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fit Ice Queen' }));
    expect(onPick).toHaveBeenCalledWith(COOLERS[1]);
  });

  it('shows a size filter only when several sizes are offered', async () => {
    const mixed = [...COOLERS, { ...COOLERS[0], uuid: 'c-big', name: 'Big Chill', size: 2 }];
    const user = userEvent.setup();
    const { unmount } = render(<SlotOptionList options={COOLERS} onPick={() => {}} />);
    expect(screen.queryByLabelText('Size')).toBeNull();
    unmount();
    render(<SlotOptionList options={mixed} onPick={() => {}} />);
    await user.selectOptions(screen.getByLabelText('Size'), '2');
    expect(rowNames()).toEqual(['Big Chill']);
  });

  it('says so when the slot has no compatible items', () => {
    render(<SlotOptionList options={[]} onPick={() => {}} />);
    expect(screen.getByText('No compatible items found for this slot.')).toBeInTheDocument();
  });
});

describe('SlotPicker', () => {
  const slot: LoadoutSlot = {
    slot: 'hardpoint_cooler_left',
    type: 'Cooler',
    sizeMin: 1,
    sizeMax: 1,
    compatibleTypes: [{ type: 'Cooler', subTypes: [] }],
    item: { uuid: 'c-hot', name: 'Hot Box' },
    source: 'stock',
  };

  it('fetches slot options for the vehicle + slot and renders them', async () => {
    const { calls } = mockFetch({ 'GET /api/v1/catalog/slot-options': { body: { items: COOLERS } } });
    renderWithProviders(<SlotPicker vehicleUuid="veh-1" slot={slot} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('slot-option')).toHaveLength(3));
    expect(calls[0].url).toBe('/api/v1/catalog/slot-options?vehicle=veh-1&slot=hardpoint_cooler_left');
    expect(calls[0].credentials).toBe('same-origin');
    expect(screen.getByRole('dialog', { name: /cooler left/i })).toBeInTheDocument();
  });

  it('shows the API error when options cannot be loaded', async () => {
    mockFetch({
      'GET /api/v1/catalog/slot-options': { status: 404, body: { error: 'not_found', message: 'no slot x' } },
    });
    renderWithProviders(<SlotPicker vehicleUuid="veh-1" slot={slot} onPick={() => {}} onClose={() => {}} />);
    expect(await screen.findByText('no slot x')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    mockFetch({ 'GET /api/v1/catalog/slot-options': { body: { items: [] } } });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SlotPicker vehicleUuid="veh-1" slot={slot} onPick={() => {}} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('traps Tab inside the dialog and returns focus to the opener on close', async () => {
    // Ice Queen is not the current item, so its Fit button is the last focusable.
    mockFetch({ 'GET /api/v1/catalog/slot-options': { body: { items: COOLERS.slice(1, 2) } } });
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Change</button>
          <button>Elsewhere</button>
          {open && <SlotPicker vehicleUuid="veh-1" slot={slot} onPick={() => {}} onClose={() => setOpen(false)} />}
        </>
      );
    }
    const user = userEvent.setup();
    renderWithProviders(<Opener />);
    const opener = screen.getByRole('button', { name: 'Change' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog');
    await screen.findByRole('button', { name: 'Fit Ice Queen' });
    expect(dialog).toHaveFocus();
    const close = screen.getByRole('button', { name: 'Close' });
    const fit = screen.getByRole('button', { name: 'Fit Ice Queen' });
    await user.tab();
    expect(close).toHaveFocus();
    // Shift+Tab from the first focusable wraps to the last (never leaves the dialog).
    await user.tab({ shift: true });
    expect(fit).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});
