import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentProps } from 'react';
import type { LoadoutSlot, VehiclePositions, VehicleSummary } from '../../api/types';
import { ApiError } from '../../api/client';
import { renderWithProviders } from '../../test/utils';

const getWireframe = vi.fn();
vi.mock('../../api/client', async (orig) => {
  const actual = await orig<typeof import('../../api/client')>();
  return {
    ...actual,
    getWireframe: (...a: unknown[]) => getWireframe(...a),
    reportImageError: vi.fn(),
  };
});

// jsdom has no WebGL: stand in for the lazily loaded three.js viewer.
vi.mock('../wireframe/WireframeViewer', () => ({
  default: (p: {
    bundle: ArrayBuffer;
    markers: { id: string; label: string; xyz: number[] }[];
    selected: string | null;
    label?: string;
    onSelect(id: string): void;
    onError?(e: unknown): void;
  }) => (
    <div data-testid="wireframe-viewer" data-bytes={p.bundle.byteLength} data-selected={p.selected ?? ''} aria-label={p.label}>
      {p.markers.map((m) => (
        <button key={m.id} type="button" data-testid="wire-marker" data-xyz={m.xyz.join(',')} onClick={() => p.onSelect(m.id)}>
          {m.label}
        </button>
      ))}
      <button type="button" onClick={() => p.onError?.(new Error('bad magic: expected SWF1'))}>
        break viewer
      </button>
    </div>
  ),
}));

const { ShipPanel } = await import('./ShipPanel');

const QD = 'hardpoint_quantum_drive';
const GUN = 'hardpoint_nose/hardpoint_class_2';
const RADAR = 'hardpoint_radar';

const slot = (s: string, type: string): LoadoutSlot => ({
  slot: s,
  type,
  sizeMin: 2,
  sizeMax: 2,
  compatibleTypes: [{ type, subTypes: [] }],
  item: null,
  source: 'stock',
});

const LOADOUT = [slot(GUN, 'WeaponGun'), slot(QD, 'QuantumDrive'), slot(RADAR, 'Radar')];

const VEHICLE: VehicleSummary = {
  uuid: 'v-harb',
  name: 'Harbinger',
  manufacturer: 'Aegis Dynamics',
  image: 'https://media.starcitizen.tools/harbinger.png',
  mass: 123456,
  portCounts: { WeaponGun: 2 },
  hasWireframe: true,
};

const POSITIONS: VehiclePositions = {
  space: 'gltf-y-up-m',
  source: 'extracted',
  slots: { [QD]: { xyz: [0, 1, 2] }, [GUN]: { xyz: [0, -2.4, -15.3] }, hardpoint_not_on_ship: { xyz: [9, 9, 9] } },
};

type Props = ComponentProps<typeof ShipPanel>;

function setup(over: Partial<Props> = {}) {
  const props: Props = {
    vehicle: VEHICLE,
    modelName: 'Harbinger',
    positions: POSITIONS,
    loadout: LOADOUT,
    selected: GUN,
    onSelect: vi.fn(),
    ...over,
  };
  const user = userEvent.setup();
  const utils = renderWithProviders(
    <div className="terminal">
      <ShipPanel {...props} />
    </div>,
  );
  const rerender = (next: Partial<Props>) =>
    utils.rerender(
      // Same tree shape as renderWithProviders, so the panel updates instead of remounting.
      <QueryClientProvider client={utils.client}>
        <MemoryRouter initialEntries={['/']}>
          <div className="terminal">
            <ShipPanel {...props} {...next} />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  return { props, user, ...utils, rerender };
}

const panel = () => screen.getByTestId('ship-panel');
const viewer = () => screen.queryByTestId('wireframe-viewer');
const note = () => screen.queryByTestId('ship-panel-note');
const render = () => within(panel()).queryByRole('img', { name: 'Harbinger render' });
const visualSwitch = () => within(panel()).queryByRole('group', { name: 'Ship visual' });

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {});
  vi.stubGlobal('DecompressionStream', function DecompressionStream() {});
  getWireframe.mockReset();
  getWireframe.mockImplementation(async () => new Uint8Array([1, 2, 3, 4, 5]).buffer);
});

describe('ShipPanel wireframe', () => {
  it('shows the wireframe by default when the vehicle has one, with stats and name on top', async () => {
    setup();
    const v = await screen.findByTestId('wireframe-viewer');
    expect(panel()).toContainElement(v);
    expect(v).toHaveAttribute('data-bytes', '5');
    expect(v).toHaveAttribute('data-selected', GUN);
    expect(v).toHaveAttribute('aria-label', expect.stringContaining('Harbinger'));
    expect(getWireframe).toHaveBeenCalledWith('v-harb', expect.anything());
    expect(render()).toBeNull();
    expect(within(panel()).queryByTestId('ship-panel-backdrop')).toBeNull();
    expect(within(panel()).getByTestId('ship-panel-name')).toHaveTextContent('Harbinger');
    expect(panel()).toHaveClass('has-wire');
    // Stats leave the canvas: a strip directly under the panel, real (selectable) text.
    const stats = screen.getByTestId('ship-stats');
    expect(panel()).not.toContainElement(stats);
    expect(stats).toHaveClass('t-shipstats-strip');
    expect(stats).toHaveTextContent('Mass');
    expect(stats).toHaveTextContent('123,456 kg');
    expect(stats).toHaveTextContent('Guns');
    expect(panel().compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId('ship-stats')).toHaveLength(1);
    expect(note()).toBeNull();
    const sw = visualSwitch()!;
    expect(within(sw).getByRole('button', { name: 'Wireframe' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sw).getByRole('button', { name: 'Render' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows a loading state while the bundle is on its way', async () => {
    let resolve!: (b: ArrayBuffer) => void;
    getWireframe.mockImplementation(() => new Promise<ArrayBuffer>((r) => (resolve = r)));
    setup();
    expect(screen.getByTestId('wireframe-loading')).toBeInTheDocument();
    expect(viewer()).toBeNull();
    expect(render()).toBeNull();
    resolve(new ArrayBuffer(3));
    expect(await screen.findByTestId('wireframe-viewer')).toHaveAttribute('data-bytes', '3');
    expect(screen.queryByTestId('wireframe-loading')).toBeNull();
  });

  it('passes markers only for loadout slots with xyz, and selecting a marker calls onSelect', async () => {
    const { user, props } = setup();
    await screen.findByTestId('wireframe-viewer');
    const markers = screen.getAllByTestId('wire-marker');
    expect(markers.map((m) => m.textContent)).toEqual(['nose › class 2', 'quantum drive']);
    expect(markers[1]).toHaveAttribute('data-xyz', '0,1,2');
    await user.click(markers[1]);
    expect(props.onSelect).toHaveBeenCalledWith(QD);
  });

  it('the switch toggles to the render and back, and remembers the choice', async () => {
    const { user } = setup();
    await screen.findByTestId('wireframe-viewer');
    await user.click(within(visualSwitch()!).getByRole('button', { name: 'Render' }));
    expect(viewer()).toBeNull();
    expect(render()).toHaveAttribute('src', VEHICLE.image);
    expect(within(panel()).getByTestId('ship-panel-backdrop')).toBeInTheDocument();
    // Render mode keeps the stats as the overlay inside the panel.
    expect(panel()).not.toHaveClass('has-wire');
    expect(within(panel()).getByTestId('ship-stats')).not.toHaveClass('t-shipstats-strip');
    expect(screen.getAllByTestId('ship-stats')).toHaveLength(1);
    expect(window.localStorage.getItem('hangar.shipVisual')).toBe('render');
    expect(within(visualSwitch()!).getByRole('button', { name: 'Render' })).toHaveAttribute('aria-pressed', 'true');
    expect(note()).toBeNull();
    await user.click(within(visualSwitch()!).getByRole('button', { name: 'Wireframe' }));
    expect(await screen.findByTestId('wireframe-viewer')).toBeInTheDocument();
    expect(render()).toBeNull();
    expect(window.localStorage.getItem('hangar.shipVisual')).toBe('wireframe');
  });

  it('a remembered "render" choice shows the render without downloading the bundle', () => {
    window.localStorage.setItem('hangar.shipVisual', 'render');
    setup();
    expect(render()).toBeInTheDocument();
    expect(viewer()).toBeNull();
    expect(getWireframe).not.toHaveBeenCalled();
    expect(within(visualSwitch()!).getByRole('button', { name: 'Render' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('storage failure: defaults to the wireframe and the switch still works', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { user } = setup();
    expect(await screen.findByTestId('wireframe-viewer')).toBeInTheDocument();
    await user.click(within(visualSwitch()!).getByRole('button', { name: 'Render' }));
    expect(render()).toBeInTheDocument();
  });

  it('a vehicle without a wireframe renders the panel exactly as before', () => {
    setup({ vehicle: { ...VEHICLE, hasWireframe: false } });
    expect(render()).toBeInTheDocument();
    expect(viewer()).toBeNull();
    expect(visualSwitch()).toBeNull();
    expect(note()).toBeNull();
    expect(getWireframe).not.toHaveBeenCalled();
    // xyz-only positions draw no 2D markers.
    expect(screen.queryAllByTestId('port-marker')).toHaveLength(0);
  });

  it('bundle 404 (model deleted since the catalog was read): render panel with a note', async () => {
    getWireframe.mockImplementation(async () => null);
    setup();
    expect(await screen.findByTestId('ship-panel-note')).toHaveTextContent(/wireframe/i);
    expect(render()).toBeInTheDocument();
    expect(viewer()).toBeNull();
    expect(visualSwitch()).toBeNull();
  });

  it('bundle fetch error: one retry, then the render panel with a note', async () => {
    getWireframe.mockImplementation(async () => {
      throw new ApiError(503, 'unavailable', 'model store is not configured');
    });
    setup();
    expect(await screen.findByTestId('ship-panel-note', {}, { timeout: 4000 })).toHaveTextContent(/wireframe/i);
    expect(getWireframe).toHaveBeenCalledTimes(2);
    expect(render()).toBeInTheDocument();
    expect(viewer()).toBeNull();
    // The stats are back in the panel as the overlay.
    expect(within(panel()).getByTestId('ship-stats')).toBeInTheDocument();
  });

  it('a client error (403) is not retried', async () => {
    getWireframe.mockImplementation(async () => {
      throw new ApiError(403, 'forbidden', 'no');
    });
    setup();
    expect(await screen.findByTestId('ship-panel-note')).toBeInTheDocument();
    expect(getWireframe).toHaveBeenCalledTimes(1);
  });

  it('new positions for the vehicle (a re-upload) refetch the bundle without a reload', async () => {
    const { rerender } = setup();
    expect(await screen.findByTestId('wireframe-viewer')).toHaveAttribute('data-bytes', '5');
    getWireframe.mockImplementation(async () => new Uint8Array([9, 9, 9, 9, 9, 9, 9]).buffer);
    // Same payload identity: nothing is refetched.
    rerender({ selected: QD });
    expect(getWireframe).toHaveBeenCalledTimes(1);
    rerender({ positions: { ...POSITIONS, slots: { ...POSITIONS.slots, [RADAR]: { xyz: [1, 1, 1] } } } });
    await waitFor(() => expect(screen.getByTestId('wireframe-viewer')).toHaveAttribute('data-bytes', '7'));
    expect(getWireframe).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('wire-marker')).toHaveLength(3);
  });

  it('a refetch that returns the same bytes keeps the same bundle (the viewer is not rebuilt)', async () => {
    const seen: ArrayBuffer[] = [];
    getWireframe.mockImplementation(async () => {
      const b = new Uint8Array([1, 2, 3, 4, 5]).buffer;
      seen.push(b);
      return b;
    });
    const { rerender, client } = setup();
    await screen.findByTestId('wireframe-viewer');
    rerender({ positions: { ...POSITIONS } });
    await waitFor(() => expect(getWireframe).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.isFetching({ queryKey: ['wireframe', 'v-harb'] })).toBe(0));
    expect(client.getQueryData(['wireframe', 'v-harb'])).toBe(seen[0]);
  });

  it('a model uploaded after a 404 appears when the positions change', async () => {
    getWireframe.mockImplementation(async () => null);
    const { rerender } = setup({ positions: {} });
    expect(await screen.findByTestId('ship-panel-note')).toBeInTheDocument();
    getWireframe.mockImplementation(async () => new Uint8Array([1, 2, 3]).buffer);
    rerender({ positions: POSITIONS });
    expect(await screen.findByTestId('wireframe-viewer')).toHaveAttribute('data-bytes', '3');
    expect(note()).toBeNull();
    expect(visualSwitch()).not.toBeNull();
  });

  it('a model uploaded while the page is open (hasWireframe turns true) is fetched fresh, even over a cached 404', async () => {
    getWireframe.mockImplementation(async () => null);
    const { rerender, client } = setup();
    expect(await screen.findByTestId('ship-panel-note')).toBeInTheDocument();
    rerender({ vehicle: { ...VEHICLE, hasWireframe: false } });
    expect(note()).toBeNull();
    getWireframe.mockImplementation(async () => new Uint8Array([1, 2, 3, 4]).buffer);
    rerender({ vehicle: VEHICLE });
    expect(await screen.findByTestId('wireframe-viewer')).toHaveAttribute('data-bytes', '4');
    expect(client.getQueryState(['wireframe', 'v-harb'])?.data).not.toBeNull();
  });

  it('a viewer failure is forgotten when a new model arrives', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { user, rerender } = setup();
    await screen.findByTestId('wireframe-viewer');
    await user.click(screen.getByRole('button', { name: 'break viewer' }));
    expect(note()).not.toBeNull();
    getWireframe.mockImplementation(async () => new Uint8Array([7, 7]).buffer);
    rerender({ positions: { ...POSITIONS } });
    expect(await screen.findByTestId('wireframe-viewer')).toHaveAttribute('data-bytes', '2');
    expect(note()).toBeNull();
  });

  it('viewer failure (decode error, lost WebGL context): render panel with a note', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { user } = setup();
    await screen.findByTestId('wireframe-viewer');
    await user.click(screen.getByRole('button', { name: 'break viewer' }));
    expect(viewer()).toBeNull();
    expect(render()).toBeInTheDocument();
    expect(note()).toHaveTextContent(/wireframe/i);
    expect(visualSwitch()).toBeNull();
  });

  it.each([
    ['WebGLRenderingContext', /WebGL/],
    ['DecompressionStream', /browser/],
  ])('missing %s: render panel with a note, nothing downloaded', async (name, text) => {
    vi.stubGlobal(name, undefined);
    setup();
    expect(render()).toBeInTheDocument();
    expect(note()).toHaveTextContent(text);
    expect(viewer()).toBeNull();
    expect(visualSwitch()).toBeNull();
    await waitFor(() => expect(getWireframe).not.toHaveBeenCalled());
  });

  it('a model deleted while the page is open (hasWireframe flips false) goes back to the plain render panel', async () => {
    const { rerender } = setup();
    await screen.findByTestId('wireframe-viewer');
    rerender({ vehicle: { ...VEHICLE, hasWireframe: false } });
    expect(viewer()).toBeNull();
    expect(render()).toBeInTheDocument();
    expect(visualSwitch()).toBeNull();
    expect(note()).toBeNull();
  });

  it('a viewer failure on one ship does not stick to another', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { user, rerender } = setup();
    await screen.findByTestId('wireframe-viewer');
    await user.click(screen.getByRole('button', { name: 'break viewer' }));
    expect(viewer()).toBeNull();
    rerender({ vehicle: { ...VEHICLE, uuid: 'v-other', name: 'Other' } });
    expect(await screen.findByTestId('wireframe-viewer')).toBeInTheDocument();
    expect(getWireframe).toHaveBeenCalledWith('v-other', expect.anything());
    expect(note()).toBeNull();
  });

  it('with the wireframe showing, 2D view images and their chips are not drawn', async () => {
    const positions: VehiclePositions = {
      views: { top: { imageUrl: 'https://media.starcitizen.tools/top.png', width: 1600, height: 900 } },
      slots: { [QD]: { view: 'top', x: 0.5, y: 0.25, xyz: [0, 1, 2] } },
    };
    const { user } = setup({ positions });
    await screen.findByTestId('wireframe-viewer');
    expect(screen.queryByTestId('ship-view')).toBeNull();
    await user.click(within(visualSwitch()!).getByRole('button', { name: 'Render' }));
    expect(screen.getByTestId('ship-view')).toBeInTheDocument();
    expect(screen.getAllByTestId('port-marker')).toHaveLength(1);
  });
});
