import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LoadoutSlot, Ship, SlotOption, StockItem, VehiclePositions, VehicleSummary } from '../../api/types';
import { ME, renderWithProviders } from '../../test/utils';

const getSlotOptions = vi.fn();
vi.mock('../../api/client', async (orig) => {
  const actual = await orig<typeof import('../../api/client')>();
  return {
    ...actual,
    getSlotOptions: (...a: unknown[]) => getSlotOptions(...a),
    reportImageError: vi.fn(),
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
    expect(getSlotOptions).toHaveBeenCalledWith('v-harb', GUN);
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
    expect(getSlotOptions).not.toHaveBeenCalledWith('v-harb', MISSILE);
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
