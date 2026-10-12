import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { LoadoutSlot, Ship, SlotOption, StockItem, VehiclePositions, VehicleSummary } from '../../api/types';
import { ME, renderWithProviders } from '../../test/utils';

const getSlotOptions = vi.fn();
const reportImageError = vi.fn();
vi.mock('../../api/client', async (orig) => {
  const actual = await orig<typeof import('../../api/client')>();
  return {
    ...actual,
    getSlotOptions: (...a: unknown[]) => getSlotOptions(...a),
    reportImageError: (...a: unknown[]) => reportImageError(...a),
  };
});

// Imported after the mock is registered.
const { TerminalShipView } = await import('./TerminalShipView');

const GUN = 'hardpoint_nose/hardpoint_class_2';
const TURRET = 'hardpoint_turret_top';
const MISSILE = 'hardpoint_missile_rack_left';
const SHIELD = 'hardpoint_shield_generator_left';
const QD = 'hardpoint_quantum_drive';

const slot = (s: string, type: string, size: number, item: { uuid: string; name: string } | null, source: 'stock' | 'fitted'): LoadoutSlot => ({
  slot: s,
  type,
  sizeMin: size,
  sizeMax: size,
  compatibleTypes: [{ type, subTypes: [] }],
  item,
  source,
});

const LOADOUT: LoadoutSlot[] = [
  slot(QD, 'QuantumDrive', 2, { uuid: 'q2', name: 'XL-1' }, 'fitted'),
  slot(SHIELD, 'Shield', 2, { uuid: 's1', name: 'FR-66' }, 'stock'),
  slot(GUN, 'WeaponGun', 2, { uuid: 'g1', name: 'CF-337 Panther' }, 'stock'),
  slot(TURRET, 'Turret', 3, { uuid: 't1', name: 'Manned Turret' }, 'stock'),
  slot(MISSILE, 'MissileLauncher', 3, { uuid: 'm1', name: 'MSD-322' }, 'stock'),
];

const SHIP: Ship = {
  shipId: 'ship-1',
  vehicleUuid: 'v-harb',
  vehicleName: 'Harbinger',
  vehicleClassName: 'RSI_Harbinger',
  nickname: 'Big H',
  fitted: { [QD]: { uuid: 'q2', name: 'XL-1' } },
  loadoutError: null,
  loadout: LOADOUT,
};

const STOCK = new Map<string, StockItem | null>([
  [QD, { uuid: 'q1', name: 'Atlas' }],
  [SHIELD, { uuid: 's1', name: 'FR-66' }],
  [GUN, { uuid: 'g1', name: 'CF-337 Panther' }],
]);

const opt = (o: Partial<SlotOption> & { uuid: string; name: string; type: string }): SlotOption => ({
  size: 2,
  grade: null,
  class: null,
  keyStat: null,
  ...o,
});

const qdStats = (speed: number, fuel: number) => [
  { key: 'speed', label: 'Speed', value: speed, unit: 'm/s', lowerIsBetter: false },
  { key: 'fuel', label: 'Fuel use', value: fuel, unit: null, lowerIsBetter: true },
];

const OPTIONS: Record<string, SlotOption[]> = {
  [GUN]: [
    opt({ uuid: 'g2', name: 'Attrition-2', type: 'WeaponGun', keyStat: { name: 'DPS', value: 300, lowerIsBetter: false } }),
    opt({ uuid: 'g1', name: 'CF-337 Panther', type: 'WeaponGun', keyStat: { name: 'DPS', value: 500, lowerIsBetter: false } }),
  ],
  [QD]: [
    opt({ uuid: 'q1', name: 'Atlas', type: 'QuantumDrive', keyStat: { name: 'Speed', value: 200, lowerIsBetter: false }, stats: qdStats(200, 3) }),
    opt({ uuid: 'q2', name: 'XL-1', type: 'QuantumDrive', keyStat: { name: 'Speed', value: 250, lowerIsBetter: false }, stats: qdStats(250, 4) }),
    opt({
      uuid: 'q3',
      name: 'Hemera',
      type: 'QuantumDrive',
      keyStat: { name: 'Speed', value: 300, lowerIsBetter: false },
      stats: qdStats(300, 5),
      cheapestPrice: { price: 12345, shop: 'Platinum Bay', location: 'Area18' },
    }),
  ],
  [SHIELD]: [opt({ uuid: 's1', name: 'FR-66', type: 'Shield' })],
  [TURRET]: [
    opt({ uuid: 't1', name: 'Manned Turret', type: 'Turret', size: 3, manufacturer: 'Behring', description: 'A crewed gun turret.' }),
    opt({ uuid: 't2', name: 'Remote Turret', type: 'Turret', size: 3, manufacturer: 'Behring', description: 'Remote-operated turret.' }),
  ],
};

const VEHICLE: VehicleSummary = {
  uuid: 'v-harb',
  name: 'Harbinger',
  manufacturer: 'Aegis Dynamics',
  image: 'https://media.starcitizen.tools/harbinger.png',
  mass: 123456,
  dimension: { length: 38, width: 23, height: 7 },
  crew: { min: 1, max: 2 },
  portCounts: { WeaponGun: 1, QuantumDrive: 1 },
};

type Props = Parameters<typeof TerminalShipView>[0];

function setup(over: Partial<Props> = {}) {
  const props: Props = {
    memberId: '111',
    ship: SHIP,
    loadout: LOADOUT,
    stockBySlot: STOCK,
    vehicle: VEHICLE,
    editable: true,
    onFit: vi.fn(async () => ({})),
    onReset: vi.fn(async () => ({})),
    onResetShip: vi.fn(async () => ({})),
    busy: false,
    error: null,
    onExit: vi.fn(),
    me: ME,
    ...over,
  };
  const user = userEvent.setup();
  const utils = renderWithProviders(<TerminalShipView {...props} />);
  return { props, user, ...utils };
}

const rail = () => screen.getByRole('list', { name: 'Ports' });
const railPorts = () => within(rail()).getAllByRole('button');
const selectedPort = () => railPorts().find((b) => b.getAttribute('aria-current') === 'true');
const cards = () => screen.queryAllByTestId('item-card');

async function selectPort(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(within(rail()).getByRole('button', { name }));
}

beforeEach(() => {
  getSlotOptions.mockReset();
  getSlotOptions.mockImplementation(async (_v: string, s: string) => OPTIONS[s] ?? []);
});

describe('TerminalShipView', () => {
  it('renders the top bar with title, signed-in user and ship identity', () => {
    setup();
    expect(screen.getByText('Hangar Configuration Terminal')).toBeInTheDocument();
    expect(screen.getByText(/Pilot/)).toBeInTheDocument();
    const bar = screen.getByTestId('terminal-topbar');
    expect(bar).toHaveTextContent('Big H');
    expect(bar).toHaveTextContent('Aegis Dynamics');
    expect(bar).toHaveTextContent('Harbinger');
  });

  it('renders tabs; a tab with no ports is disabled; Shields restricts the rail', async () => {
    const { user } = setup();
    const tabs = screen.getByRole('tablist');
    expect(within(tabs).getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).getByRole('tab', { name: /Power/ })).toBeDisabled();
    expect(within(tabs).getByRole('tab', { name: /Shields/ })).toBeEnabled();
    expect(railPorts()).toHaveLength(5);
    await user.click(within(tabs).getByRole('tab', { name: /Shields/ }));
    expect(railPorts()).toHaveLength(1);
    expect(railPorts()[0]).toHaveTextContent('FR-66');
    expect(selectedPort()).toBe(railPorts()[0]);
  });

  it('selects the first port by default; grid shows its options sorted with badges', async () => {
    setup();
    expect(selectedPort()).toHaveTextContent('CF-337 Panther');
    await waitFor(() => expect(cards()).toHaveLength(2));
    // Sorted by DPS, best first.
    expect(cards()[0]).toHaveTextContent('CF-337 Panther');
    expect(cards()[1]).toHaveTextContent('Attrition-2');
    expect(cards()[0]).toHaveTextContent('IN USE');
    expect(cards()[0]).toHaveTextContent('STOCK');
    expect(cards()[1]).not.toHaveTextContent('IN USE');
    for (const c of cards()) expect(c).toHaveTextContent('SIZE 2');
    expect(getSlotOptions).toHaveBeenCalledWith('v-harb', GUN, { memberId: '111', shipId: 'ship-1' });
  });

  it('marks the fitted option IN USE and the stock option STOCK on a refitted port', async () => {
    const { user } = setup();
    await selectPort(user, /quantum drive/);
    await waitFor(() => expect(cards()).toHaveLength(3));
    const byName = (n: string) => cards().find((c) => c.textContent?.includes(n))!;
    expect(byName('XL-1')).toHaveTextContent('IN USE');
    expect(byName('XL-1')).not.toHaveTextContent('STOCK');
    expect(byName('Atlas')).toHaveTextContent('STOCK');
    expect(byName('Atlas')).not.toHaveTextContent('IN USE');
  });

  it('previews a candidate with stat deltas and only fits on Install', async () => {
    const { user, props } = setup();
    await selectPort(user, /quantum drive/);
    const hemera = await screen.findByRole('button', { name: /Hemera/ });
    await user.click(hemera);
    expect(hemera).toHaveAttribute('aria-pressed', 'true');
    const header = screen.getByTestId('compare-header');
    expect(header).toHaveTextContent('CURRENT → CANDIDATE');
    expect(header).toHaveTextContent('XL-1');
    expect(header).toHaveTextContent('Hemera');
    const rows = screen.getAllByTestId('stat-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Speed');
    expect(rows[0]).toHaveTextContent('▲');
    expect(rows[1]).toHaveTextContent('Fuel use');
    expect(rows[1]).toHaveTextContent('▼');
    expect(props.onFit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Install' }));
    expect(props.onFit).toHaveBeenCalledTimes(1);
    expect(props.onFit).toHaveBeenCalledWith(QD, expect.objectContaining({ uuid: 'q3' }));
    expect(await screen.findByText('Changes saved')).toBeInTheDocument();
  });

  it('hides Install when the candidate is the current item', async () => {
    const { user } = setup();
    await selectPort(user, /quantum drive/);
    await waitFor(() => expect(cards()).toHaveLength(3));
    await user.click(within(screen.getByRole('list', { name: 'Compatible items' })).getByRole('button', { name: /XL-1/ }));
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Atlas/ }));
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
  });

  it('shows name, manufacturer and description without stat rows when the type has no stats', async () => {
    const { user } = setup();
    await selectPort(user, /turret top/);
    await user.click(await screen.findByRole('button', { name: /Remote Turret/ }));
    const panel = screen.getByTestId('compare-panel');
    expect(panel).toHaveTextContent('Remote Turret');
    expect(panel).toHaveTextContent('Behring');
    expect(panel).toHaveTextContent('Remote-operated turret.');
    expect(screen.queryAllByTestId('stat-row')).toHaveLength(0);
  });

  it('shows the current item in the compare panel when nothing is previewed', async () => {
    setup();
    const panel = screen.getByTestId('compare-panel');
    expect(panel).toHaveTextContent('CF-337 Panther');
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('shows an inline error when Install fails (no unhandled rejection)', async () => {
    const onFit = vi.fn(async () => {
      throw new Error('Item does not fit');
    });
    const { user } = setup({ onFit });
    await selectPort(user, /quantum drive/);
    await user.click(await screen.findByRole('button', { name: /Hemera/ }));
    await user.click(screen.getByRole('button', { name: 'Install' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Item does not fit');
    expect(screen.queryByText('Changes saved')).toBeNull();
  });

  it('read-only: no Install or Reset buttons', async () => {
    const { user } = setup({ editable: false });
    await selectPort(user, /quantum drive/);
    await user.click(await screen.findByRole('button', { name: /Hemera/ }));
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reset port/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reset ship/ })).toBeNull();
  });

  it('Reset port and Reset ship ask for confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { user, props } = setup();
    await selectPort(user, /quantum drive/);
    await user.click(screen.getByRole('button', { name: /Reset port/ }));
    expect(props.onReset).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Reset port/ }));
    expect(props.onReset).toHaveBeenCalledWith(QD);
    await user.click(screen.getByRole('button', { name: /Reset ship/ }));
    expect(props.onResetShip).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it('shows an inline error when a reset fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onResetShip = vi.fn(async () => {
      throw new Error('Temporarily unavailable');
    });
    const { user } = setup({ onResetShip });
    await user.click(screen.getByRole('button', { name: /Reset ship/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporarily unavailable');
  });

  describe('keyboard', () => {
    it('d / a step through ports with wrap; Escape exits', async () => {
      const { user, props } = setup();
      // Rail order: gun, turret, missile, shield, qd.
      expect(selectedPort()).toHaveTextContent('CF-337 Panther');
      await user.keyboard('d');
      expect(selectedPort()).toHaveTextContent('Manned Turret');
      await user.keyboard('a');
      await user.keyboard('a');
      expect(selectedPort()).toHaveTextContent('XL-1');
      await user.keyboard('D');
      expect(selectedPort()).toHaveTextContent('CF-337 Panther');
      await user.keyboard('{Escape}');
      expect(props.onExit).toHaveBeenCalledTimes(1);
    });

    it('r resets the selected port after confirm', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { user, props } = setup();
      await selectPort(user, /quantum drive/);
      await user.keyboard('r');
      expect(props.onReset).toHaveBeenCalledWith(QD);
    });

    it('ignores keys typed in an input and modified keys', async () => {
      const props: Props = {
        memberId: '111',
        ship: SHIP,
        loadout: LOADOUT,
        stockBySlot: STOCK,
        vehicle: VEHICLE,
        editable: true,
        onFit: vi.fn(async () => ({})),
        onReset: vi.fn(async () => ({})),
        onResetShip: vi.fn(async () => ({})),
        busy: false,
        error: null,
        onExit: vi.fn(),
        me: ME,
      };
      const user = userEvent.setup();
      renderWithProviders(
        <>
          <input aria-label="elsewhere" />
          <TerminalShipView {...props} />
        </>,
      );
      await user.click(screen.getByLabelText('elsewhere'));
      await user.keyboard('d');
      expect(selectedPort()).toHaveTextContent('CF-337 Panther');
      await user.keyboard('{Escape}');
      expect(props.onExit).not.toHaveBeenCalled();
      (document.activeElement as HTMLElement).blur();
      await user.keyboard('{Control>}d{/Control}');
      expect(selectedPort()).toHaveTextContent('CF-337 Panther');
      await user.keyboard('{Meta>}d{/Meta}');
      await user.keyboard('{Alt>}d{/Alt}');
      expect(selectedPort()).toHaveTextContent('CF-337 Panther');
    });
  });

  it('draws markers only for view points, and a marker selects its port', async () => {
    const positions: VehiclePositions = {
      views: { top: { imageUrl: 'https://media.starcitizen.tools/top.png', width: 1600, height: 900 } },
      slots: { [QD]: { view: 'top', x: 0.5, y: 0.25 }, [GUN]: { xyz: [1, 2, 3] } },
    };
    const { user } = setup({ positions });
    const markers = screen.getAllByTestId('port-marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveStyle({ left: '50%', top: '25%' });
    await user.click(markers[0]);
    expect(selectedPort()).toHaveTextContent('XL-1');
    expect(markers[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('with positions the ship panel shows the view image, and markers sit in a box sized to that image', () => {
    const positions: VehiclePositions = {
      views: { top: { imageUrl: 'https://media.starcitizen.tools/top.png', width: 1600, height: 900 } },
      slots: { [QD]: { view: 'top', x: 0.5, y: 0.25 } },
    };
    setup({ positions });
    const panel = screen.getByTestId('ship-panel');
    const viewImg = within(panel).getByRole('img', { name: 'top view' });
    expect(viewImg).toHaveAttribute('src', 'https://media.starcitizen.tools/top.png');
    // The view replaces the render in the panel.
    expect(within(panel).queryByRole('img', { name: /render/ })).toBeNull();
    // Markers are positioned against the figure, whose box is the image's own aspect
    // ratio (no max-height letterboxing), and the image fills that box exactly.
    const figure = screen.getByTestId('ship-view');
    expect(figure).toContainElement(viewImg);
    expect(figure).toContainElement(screen.getByTestId('port-marker'));
    expect(figure.style.aspectRatio).toBe('1600 / 900');
    expect(figure.style.maxHeight).toBe('');
    expect(viewImg).toHaveClass('t-view-img');
  });

  it('view chips switch views even when the selected port has a marker in another view', async () => {
    const positions: VehiclePositions = {
      views: {
        top: { imageUrl: 'https://media.starcitizen.tools/top.png', width: 1600, height: 900 },
        side: { imageUrl: 'https://media.starcitizen.tools/side.png', width: 1600, height: 600 },
      },
      slots: { [GUN]: { view: 'top', x: 0.1, y: 0.1 }, [QD]: { view: 'side', x: 0.6, y: 0.4 } },
    };
    const { user } = setup({ positions });
    // GUN (selected by default) lives in "top".
    const panel = screen.getByTestId('ship-panel');
    expect(within(panel).getByRole('img', { name: 'top view' })).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'side' }));
    expect(within(panel).getByRole('img', { name: 'side view' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'side' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('ship-view').style.aspectRatio).toBe('1600 / 600');
    // Selecting a port in the chosen view keeps it.
    await selectPort(user, /quantum drive/);
    expect(within(panel).getByRole('img', { name: 'side view' })).toBeInTheDocument();
    // Selecting a port whose marker is in a different view clears the choice.
    await selectPort(user, /nose/);
    expect(within(panel).getByRole('img', { name: 'top view' })).toBeInTheDocument();
    // A markerless port keeps whatever view is showing.
    await user.click(within(panel).getByRole('button', { name: 'side' }));
    await selectPort(user, /shield/);
    expect(within(panel).getByRole('img', { name: 'side view' })).toBeInTheDocument();
  });

  it('ship panel shows the vehicle render at full strength, the model name and the stats', () => {
    setup();
    const panel = screen.getByTestId('ship-panel');
    const img = within(panel).getByRole('img', { name: 'Harbinger render' });
    expect(img).toHaveAttribute('src', VEHICLE.image);
    expect(img.closest('[aria-hidden="true"]')).toBeNull();
    expect(img).toHaveClass('t-shippanel-img');
    // A decorative blurred copy of the same render fills behind it.
    const backdrop = within(panel).getByTestId('ship-panel-backdrop');
    expect(backdrop).toHaveAttribute('src', VEHICLE.image);
    expect(backdrop).toHaveAttribute('alt', '');
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    expect(within(panel).getByTestId('ship-panel-name')).toHaveTextContent('Aegis Dynamics');
    expect(within(panel).getByTestId('ship-panel-name')).toHaveTextContent('Harbinger');
    expect(panel).toContainElement(screen.getByTestId('ship-stats'));
    expect(within(panel).queryByText('No render available')).toBeNull();
    // The port rail sits below the panel, not inside it.
    expect(panel).not.toContainElement(rail());
    expect(panel.compareDocumentPosition(rail()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('ship panel without an image shows the type icon and "No render available"', () => {
    setup({ vehicle: { ...VEHICLE, image: undefined } });
    const panel = screen.getByTestId('ship-panel');
    expect(within(panel).queryByRole('img')).toBeNull();
    expect(within(panel).getByTestId('type-icon')).toBeInTheDocument();
    expect(within(panel).queryByTestId('ship-panel-backdrop')).toBeNull();
    expect(panel).toHaveTextContent('No render available');
    expect(panel).toContainElement(screen.getByTestId('ship-stats'));
  });

  it('ship panel falls back to the icon and label when the render fails to load', () => {
    reportImageError.mockReset();
    setup();
    const panel = screen.getByTestId('ship-panel');
    fireEvent.error(within(panel).getByRole('img', { name: 'Harbinger render' }));
    expect(within(panel).getByTestId('type-icon')).toBeInTheDocument();
    expect(within(panel).queryByTestId('ship-panel-backdrop')).toBeNull();
    expect(panel).toHaveTextContent('No render available');
    // Only the foreground reports; the backdrop never adds a second report.
    expect(reportImageError).toHaveBeenCalledTimes(1);
    expect(reportImageError).toHaveBeenCalledWith(VEHICLE.image, 'hero');
  });

  it('no positions: no markers', () => {
    setup();
    expect(screen.queryAllByTestId('port-marker')).toHaveLength(0);
  });

  it('missile ports are read-only: notice and no Install', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: /Missiles/ }));
    expect(selectedPort()).toHaveTextContent('MSD-322');
    expect(screen.getByText(/Missiles aren.t tracked/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reset port/ })).toBeNull();
    expect(getSlotOptions.mock.calls.map((c) => c[1])).not.toContain(MISSILE);
  });

  it('stats sidebar shows present vehicle fields and omits absent ones', () => {
    const { unmount } = setup();
    const side = screen.getByTestId('ship-stats');
    expect(side).toHaveTextContent('Mass');
    expect(side).toHaveTextContent('123,456 kg');
    expect(side).toHaveTextContent('38 × 23 × 7 m');
    expect(side).toHaveTextContent('Crew');
    expect(side).toHaveTextContent('1–2');
    unmount();
    setup({ vehicle: { uuid: 'v-harb', name: 'Harbinger', crew: { min: 1, max: 1 } } });
    const side2 = screen.getByTestId('ship-stats');
    expect(side2).not.toHaveTextContent('Mass');
    expect(side2).not.toHaveTextContent('Dimensions');
    expect(side2).toHaveTextContent('Crew');
  });

  describe('slots that come from a fitted item', () => {
    const CHILD = `${TURRET}/hardpoint_weapon_S3_left`;
    const child = { ...slot(CHILD, 'WeaponGun', 3, { uuid: 'g9', name: 'Mantis GT-220' }, 'fitted'), dynamic: true };
    const WITH_CHILD = [...LOADOUT, child];
    // `rerender` replaces the whole tree, so the providers are repeated around the new props.
    const view = (props: Props, client: QueryClient) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TerminalShipView {...props} />
        </MemoryRouter>
      </QueryClientProvider>
    );

    it('lists a dynamic child slot in the rail with a parent › child label and asks for its options by ship', async () => {
      const { user } = setup({ loadout: WITH_CHILD });
      await selectPort(user, /turret top › weapon S3 left/);
      expect(selectedPort()).toHaveTextContent('Mantis GT-220');
      await waitFor(() => expect(getSlotOptions).toHaveBeenCalledWith('v-harb', CHILD, { memberId: '111', shipId: 'ship-1' }));
    });

    it('when the selected slot disappears, its nearest surviving ancestor is selected', async () => {
      const { user, props, rerender, client } = setup({ loadout: WITH_CHILD });
      // From the Weapons tab, where the turret itself is not listed.
      await user.click(screen.getByRole('tab', { name: /Weapons/ }));
      await selectPort(user, /turret top › weapon S3 left/);
      rerender(view({ ...props, loadout: LOADOUT }, client));
      await waitFor(() => expect(selectedPort()).toHaveTextContent('Manned Turret'));
      expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('falls back to the first port when no ancestor survives', async () => {
      const { user, props, rerender, client } = setup({ loadout: WITH_CHILD });
      await selectPort(user, /turret top › weapon S3 left/);
      rerender(view({ ...props, loadout: LOADOUT.filter((s) => s.slot !== TURRET) }, client));
      await waitFor(() => expect(selectedPort()).toHaveTextContent('CF-337 Panther'));
    });

    it('shows the notice about fittings removed with their parent', () => {
      setup({ notice: 'Also removed 1 fitting that no longer fits: Mantis GT-220 (turret top › weapon S3 left).' });
      expect(screen.getByTestId('terminal-notice')).toHaveTextContent('Mantis GT-220 (turret top › weapon S3 left)');
    });
  });

  it('the saved notice disappears after 2.5s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { user } = setup();
      await user.click(screen.getByRole('button', { name: /Reset ship/ }));
      expect(await screen.findByText('Changes saved')).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(2600);
      });
      expect(screen.queryByText('Changes saved')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
