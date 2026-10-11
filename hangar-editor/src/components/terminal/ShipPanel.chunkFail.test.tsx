import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { VehicleSummary } from '../../api/types';
import { renderWithProviders } from '../../test/utils';

vi.mock('../../api/client', async (orig) => {
  const actual = await orig<typeof import('../../api/client')>();
  return { ...actual, getWireframe: async () => new ArrayBuffer(4), reportImageError: vi.fn() };
});

// Simulates a stale/404'd content-hashed viewer chunk: the lazy import rejects.
vi.mock('../wireframe/WireframeViewer', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const { ShipPanel } = await import('./ShipPanel');

const VEHICLE: VehicleSummary = {
  uuid: 'v-harb',
  name: 'Harbinger',
  image: 'https://media.starcitizen.tools/harbinger.png',
  hasWireframe: true,
};

describe('ShipPanel viewer chunk failure', () => {
  it('falls back to the render panel with a note', async () => {
    window.localStorage.clear();
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {});
    vi.stubGlobal('DecompressionStream', function DecompressionStream() {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderWithProviders(
      <div className="terminal">
        <ShipPanel vehicle={VEHICLE} modelName="Harbinger" loadout={[]} selected={null} onSelect={() => {}} />
      </div>,
    );
    expect(await screen.findByTestId('ship-panel-note')).toHaveTextContent(/wireframe/i);
    const panel = screen.getByTestId('ship-panel');
    expect(within(panel).getByRole('img', { name: 'Harbinger render' })).toBeInTheDocument();
    expect(screen.queryByTestId('wireframe-viewer')).toBeNull();
  });
});
