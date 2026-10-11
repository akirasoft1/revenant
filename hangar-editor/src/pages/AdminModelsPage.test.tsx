import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate } from '../auth/AuthGate';
import { App } from '../App';
import { AdminModelsPage, UPLOAD_CONCURRENCY, UPLOAD_MIN_INTERVAL_MS, rejectReason } from './AdminModelsPage';
import { ME, mockFetch, renderWithProviders } from '../test/utils';
import type { ModelInfo } from '../api/types';

vi.mock('../components/wireframe/WireframeViewer', () => ({
  default: (p: { bundle: ArrayBuffer; markers: { id: string }[] }) => (
    <div data-testid="viewer" data-bytes={p.bundle.byteLength} data-markers={p.markers.length} />
  ),
}));

const ADMIN = { ...ME, isAdmin: true };
const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  kind: 'vehicle',
  className: 'RSI_Constellation_Andromeda',
  vehicleUuid: 'v-con',
  vehicleName: 'Constellation Andromeda',
  lines: 12000,
  bytes: 150000,
  slots: { matched: 20, missing: ['hardpoint_a'], ambiguous: ['hardpoint_b'] },
  uploadedBy: '111',
  uploadedAt: '2026-10-11T10:00:00Z',
  ...over,
});
const file = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: 'application/gzip' });

function renderPage() {
  return renderWithProviders(
    <AuthGate>
      <AdminModelsPage />
    </AuthGate>,
    { route: '/admin/models' },
  );
}

describe('rejectReason', () => {
  it('accepts .swf.gz under 2 MB only', () => {
    expect(rejectReason({ name: 'a.swf.gz', size: 5 })).toBeNull();
    expect(rejectReason({ name: 'a.glb', size: 5 })).toMatch(/swf\.gz/);
    expect(rejectReason({ name: 'a.swf.gz', size: 3 * 1024 * 1024 })).toMatch(/2 MB/);
  });
});

describe('admin gating', () => {
  it('non-admin gets the not-found page and no nav link', async () => {
    mockFetch({ 'GET /api/me': { body: ME } });
    renderWithProviders(
      <AuthGate>
        <App />
      </AuthGate>,
      { route: '/admin/models' },
    );
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ship models' })).toBeNull();
  });

  it('admin sees the nav link and the page', async () => {
    mockFetch({ 'GET /api/me': { body: ADMIN }, 'GET /api/v1/models': { body: { models: [] } } });
    renderWithProviders(
      <AuthGate>
        <App />
      </AuthGate>,
      { route: '/admin/models' },
    );
    expect(await screen.findByRole('heading', { name: 'Ship models' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ship models' })).toBeInTheDocument();
  });
});

describe('stored models table', () => {
  it('lists, filters and sorts', async () => {
    mockFetch({
      'GET /api/me': { body: ADMIN },
      'GET /api/v1/models': {
        body: {
          models: [
            model(),
            model({ className: 'AEGS_Avenger', vehicleName: 'Avenger', lines: 5000, uploadedAt: '2026-10-12T10:00:00Z' }),
            model({ className: 'XXXX_Unknown', vehicleUuid: null, vehicleName: null, lines: 800 }),
          ],
        },
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('model-row');
    expect(screen.getByText('no matching ship')).toBeInTheDocument();
    // default: newest upload first
    expect(within(screen.getAllByTestId('model-row')[0]).getByText('AEGS_Avenger')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Lines/ }));
    expect(within(screen.getAllByTestId('model-row')[0]).getByText('XXXX_Unknown')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Lines/ }));
    expect(within(screen.getAllByTestId('model-row')[0]).getByText('RSI_Constellation_Andromeda')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Filter models'), 'aveng');
    expect(screen.getAllByTestId('model-row')).toHaveLength(1);
  });

  it('previews a model with the lazy viewer, only for models with a ship', async () => {
    mockFetch({
      'GET /api/me': { body: ADMIN },
      'GET /api/v1/models/vehicle/v-con/wireframe': () => ({ body: {} }),
      'GET /api/v1/models': { body: { models: [model(), model({ className: 'X', vehicleUuid: null, vehicleName: null })] } },
      'GET /api/v1/catalog/vehicles/v-con/positions': { body: { slots: { hardpoint_a: { xyz: [1, 2, 3] }, hardpoint_b: {} } } },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('model-row');
    expect(screen.queryByRole('button', { name: 'Preview X' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Preview RSI_Constellation_Andromeda' }));
    const viewer = await screen.findByTestId('viewer');
    await waitFor(() => expect(viewer.dataset.markers).toBe('1'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('delete asks for confirmation, calls the API and refreshes', async () => {
    let listed = [model()];
    const { calls } = mockFetch({
      'GET /api/me': { body: ADMIN },
      'DELETE /api/v1/models/vehicle/RSI_Constellation_Andromeda': () => {
        listed = [];
        return { status: 204 };
      },
      'GET /api/v1/models': () => ({ body: { models: listed } }),
    });
    const confirm = vi.spyOn(window, 'confirm');
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('model-row');
    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Delete RSI_Constellation_Andromeda' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Delete RSI_Constellation_Andromeda' }));
    await waitFor(() => expect(screen.queryAllByTestId('model-row')).toHaveLength(0));
    expect(await screen.findByText('No models uploaded yet.')).toBeInTheDocument();
    confirm.mockRestore();
  });
});

describe('upload', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uploads many files with bounded concurrency, continues past failures, summarises, retries', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const attempts: Record<string, number> = {};
    const names = Array.from({ length: 8 }, (_, i) => `SHIP_${i}.swf.gz`);
    const releases: (() => void)[] = [];
    const fetchMock = mockFetch({
      'GET /api/me': { body: ADMIN },
      'GET /api/v1/models': { body: { models: [] } },
    });
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'POST' && String(input) === '/api/v1/models') {
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
        const f = init.body as File;
        attempts[f.name] = (attempts[f.name] ?? 0) + 1;
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise<void>((r) => releases.push(r));
        inflight--;
        if (f.name === 'SHIP_3.swf.gz' && attempts[f.name] === 1) {
          return new Response(JSON.stringify({ error: 'invalid_request', message: 'bad gzip' }), { status: 400 });
        }
        const n = Number(f.name.match(/\d+/)![0]);
        return new Response(
          JSON.stringify(model({ className: `C${n}`, vehicleUuid: n === 5 ? null : `v${n}`, vehicleName: n === 5 ? null : `Ship ${n}` })),
          { status: 200 },
        );
      }
      return base(input, init);
    }) as typeof fetch;
    void fetchMock;
    const flush = async () => {
      for (let i = 0; i < 40; i++) {
        await act(async () => {
          releases.splice(0).forEach((r) => r());
          await vi.advanceTimersByTimeAsync(UPLOAD_MIN_INTERVAL_MS);
        });
      }
    };
    renderPage();
    await screen.findByLabelText('Wireframe bundles');
    const bad = file('notes.txt');
    const big = file('HUGE.swf.gz', 3 * 1024 * 1024);
    fireEvent.change(screen.getByLabelText('Wireframe bundles'), { target: { files: [...names.map((n) => file(n)), bad, big] } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPLOAD_MIN_INTERVAL_MS * UPLOAD_CONCURRENCY);
    });
    expect(inflight).toBe(UPLOAD_CONCURRENCY);
    await flush();
    await waitFor(() => expect(screen.getByTestId('upload-progress')).toHaveTextContent('7 / 10 uploaded, 3 failed'));
    expect(maxInflight).toBe(UPLOAD_CONCURRENCY);
    const summary = screen.getByTestId('upload-summary');
    expect(summary).toHaveTextContent('6 matched a ship · 1 with no matching ship · 3 failed');
    expect(summary).toHaveTextContent('notes.txt');
    expect(summary).toHaveTextContent('bad gzip');
    expect(summary).toHaveTextContent('over the 2 MB limit');
    // client-side rejects were never sent
    expect(attempts['notes.txt']).toBeUndefined();
    expect(attempts['HUGE.swf.gz']).toBeUndefined();
    // expandable slot lists on a finished row
    const row = screen.getAllByTestId('upload-row').find((r) => r.textContent?.includes('SHIP_0.swf.gz'))!;
    expect(within(row).getByText(/Missing \(1\)/)).toBeInTheDocument();
    // retry only the retryable failure
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
    await flush();
    await waitFor(() => expect(screen.getByTestId('upload-progress')).toHaveTextContent('8 / 10 uploaded, 2 failed'));
    expect(attempts['SHIP_3.swf.gz']).toBe(2);
    globalThis.fetch = base;
  });

  it('drag-and-drop uploads and invalidates the model-derived caches afterwards', async () => {
    mockFetch({
      'GET /api/me': { body: ADMIN },
      'GET /api/v1/models': { body: { models: [] } },
      'POST /api/v1/models': { body: model() },
    });
    const { client } = renderPage();
    const spy = vi.spyOn(client, 'invalidateQueries');
    await screen.findByTestId('dropzone');
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [file('A.swf.gz')] } });
    await waitFor(() => expect(screen.getByTestId('upload-progress')).toHaveTextContent('1 / 1 uploaded, 0 failed'));
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    for (const k of ['models', 'vehicle-slots', 'vehicle-positions', 'wireframe']) expect(keys).toContain(k);
  });

  /** Fetch mock that records every upload start time and never resolves until released. */
  function pacedFetch() {
    const starts: number[] = [];
    const releases: (() => void)[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const base = globalThis.fetch;
    mockFetch({ 'GET /api/me': { body: ADMIN }, 'GET /api/v1/models': { body: { models: [] } } });
    const inner = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'POST' && String(input) === '/api/v1/models') {
        starts.push(Date.now());
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        const f = init.body as File;
        await new Promise<void>((r) => releases.push(r));
        inflight--;
        if (f.name.startsWith('BAD')) return new Response(JSON.stringify({ error: 'invalid_request', message: 'bad' }), { status: 400 });
        return new Response(JSON.stringify(model()), { status: 200 });
      }
      return inner(input, init);
    }) as typeof fetch;
    return { starts, releases, max: () => maxInflight, restore: () => { globalThis.fetch = base; } };
  }

  it('paces upload starts at least UPLOAD_MIN_INTERVAL_MS apart and never exceeds the concurrency cap', async () => {
    const p = pacedFetch();
    renderPage();
    await screen.findByLabelText('Wireframe bundles');
    fireEvent.change(screen.getByLabelText('Wireframe bundles'), {
      target: { files: Array.from({ length: 6 }, (_, i) => file(`S${i}.swf.gz`)) },
    });
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UPLOAD_MIN_INTERVAL_MS);
        p.releases.splice(0).forEach((r) => r());
      });
    }
    expect(p.starts).toHaveLength(6);
    for (let i = 1; i < p.starts.length; i++) expect(p.starts[i] - p.starts[i - 1]).toBeGreaterThanOrEqual(UPLOAD_MIN_INTERVAL_MS);
    expect(p.max()).toBeLessThanOrEqual(UPLOAD_CONCURRENCY);
    expect(screen.getByTestId('upload-pacing-note')).toHaveTextContent('30 a minute');
    p.restore();
  });

  it('shows an ETA while files are queued', async () => {
    const p = pacedFetch();
    renderPage();
    await screen.findByLabelText('Wireframe bundles');
    fireEvent.change(screen.getByLabelText('Wireframe bundles'), {
      target: { files: Array.from({ length: 6 }, (_, i) => file(`S${i}.swf.gz`)) },
    });
    await waitFor(() => expect(screen.getByTestId('upload-progress')).toHaveTextContent(/about \d+ s left/));
    p.restore();
  });

  it('retry-failed is paced too', async () => {
    const p = pacedFetch();
    renderPage();
    await screen.findByLabelText('Wireframe bundles');
    fireEvent.change(screen.getByLabelText('Wireframe bundles'), {
      target: { files: ['BAD1', 'BAD2', 'BAD3', 'BAD4'].map((n) => file(`${n}.swf.gz`)) },
    });
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UPLOAD_MIN_INTERVAL_MS);
        p.releases.splice(0).forEach((r) => r());
      });
    }
    expect(p.starts).toHaveLength(4);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry failed' }));
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UPLOAD_MIN_INTERVAL_MS);
        p.releases.splice(0).forEach((r) => r());
      });
    }
    expect(p.starts).toHaveLength(8);
    for (let i = 5; i < p.starts.length; i++) expect(p.starts[i] - p.starts[i - 1]).toBeGreaterThanOrEqual(UPLOAD_MIN_INTERVAL_MS);
    p.restore();
  });

  it('unmounting clears the pacing timer and stops further uploads', async () => {
    const p = pacedFetch();
    const { unmount } = renderPage();
    await screen.findByLabelText('Wireframe bundles');
    fireEvent.change(screen.getByLabelText('Wireframe bundles'), {
      target: { files: Array.from({ length: 3 }, (_, i) => file(`S${i}.swf.gz`)) },
    });
    await waitFor(() => expect(p.starts.length).toBe(1));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const before = vi.getTimerCount();
    unmount();
    expect(vi.getTimerCount()).toBeLessThan(before);
    await vi.advanceTimersByTimeAsync(UPLOAD_MIN_INTERVAL_MS * 5);
    expect(p.starts).toHaveLength(1);
    p.restore();
  });
});
