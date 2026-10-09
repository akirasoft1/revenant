import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate } from '../auth/AuthGate';
import { ImportPage } from './ImportPage';
import { SPVIEWER_EXPORT_SNIPPET } from '../components/ExportSnippet';
import { ME, mockFetch, renderWithProviders } from '../test/utils';
import type { ImportPreviewRow, Ship } from '../api/types';

const EXPORT = [{ id: 1, vehicleClassName: 'RSI_Harbinger', loadoutData: 'N4Ig...' }];

const PREVIEW: ImportPreviewRow[] = [
  {
    rowIndex: 0,
    loadoutName: 'Harbinger PvE',
    vehicle: { uuid: 'v-harb', name: 'Harbinger' },
    changes: [{ slot: 'hardpoint_quantum_drive', from: { uuid: 'q1', name: 'Atlas' }, to: { uuid: 'q2', name: 'XL-1' } }],
    skipped: [{ slot: 'hardpoint_paint', reason: 'untracked_slot', detail: 'paint' }],
    matchingShips: [],
  },
];

const SHIP: Ship = {
  shipId: 'new-1',
  vehicleUuid: 'v-harb',
  vehicleName: 'Harbinger',
  vehicleClassName: 'RSI_Harbinger',
  nickname: 'Harbinger PvE',
  fitted: { hardpoint_quantum_drive: { uuid: 'q2', name: 'XL-1' } },
  loadout: [],
  loadoutError: null,
};

function upload(data: unknown, name = 'spviewer-loadouts.json') {
  return new File([typeof data === 'string' ? data : JSON.stringify(data)], name, { type: 'application/json' });
}

function renderPage() {
  return renderWithProviders(
    <AuthGate>
      <ImportPage />
    </AuthGate>,
    { route: '/import' },
  );
}

describe('ImportPage', () => {
  it('shows the export snippet verbatim with instructions and a copy button', async () => {
    mockFetch({ 'GET /api/me': { body: ME } });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    renderPage();
    const pre = await screen.findByLabelText('spviewer export snippet');
    expect(pre.textContent).toBe(SPVIEWER_EXPORT_SNIPPET);
    expect(SPVIEWER_EXPORT_SNIPPET).toContain("indexedDB.open('SCSPVDatabase')");
    expect(screen.getByRole('link', { name: 'https://www.spviewer.eu' })).toHaveAttribute('href', 'https://www.spviewer.eu');
    expect(screen.getByText('F12')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(SPVIEWER_EXPORT_SNIPPET);
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('uploads → previews → applies, sending the parsed file and selections', async () => {
    const { calls } = mockFetch({
      'GET /api/me': { body: ME },
      'POST /api/v1/import/spviewer/preview': { body: { rows: PREVIEW } },
      'POST /api/v1/import/spviewer/apply': { body: { ships: [SHIP] } },
    });
    const user = userEvent.setup();
    renderPage();
    await user.upload(await screen.findByLabelText('Loadout file'), upload(EXPORT));

    const row = await screen.findByTestId('import-row');
    expect(within(row).getByText(/Atlas/)).toBeInTheDocument();
    expect(within(row).getByText('XL-1')).toBeInTheDocument();
    expect(within(row).getByText('Slot not tracked by the hangar')).toBeInTheDocument();
    const previewCall = calls.find((c) => c.url === '/api/v1/import/spviewer/preview')!;
    expect(previewCall.body).toEqual({ file: EXPORT });

    await user.type(screen.getByLabelText('Nickname for Harbinger PvE'), 'Big H');
    await user.click(screen.getByRole('button', { name: 'Import 1 loadout' }));

    const summary = await screen.findByRole('region', { name: 'Import summary' });
    expect(within(summary).getByText('1 ship saved to your hangar.')).toBeInTheDocument();
    expect(within(summary).getByRole('link', { name: 'Harbinger PvE' })).toHaveAttribute('href', '/members/111/ships/new-1');
    const applyCall = calls.find((c) => c.url === '/api/v1/import/spviewer/apply')!;
    expect(applyCall.body).toEqual({ file: EXPORT, rows: [{ rowIndex: 0, mode: 'new', nickname: 'Big H' }] });
  });

  it('rejects a non-JSON file without calling the server', async () => {
    const { calls } = mockFetch({ 'GET /api/me': { body: ME } });
    const user = userEvent.setup();
    renderPage();
    await user.upload(await screen.findByLabelText('Loadout file'), upload('not json at all'));
    expect(await screen.findByText(/That file is not JSON/)).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes('/import/'))).toHaveLength(0);
  });

  it('shows the server error when preview fails', async () => {
    mockFetch({
      'GET /api/me': { body: ME },
      'POST /api/v1/import/spviewer/preview': { status: 400, body: { error: 'invalid_request', message: 'file too large' } },
    });
    const user = userEvent.setup();
    renderPage();
    await user.upload(await screen.findByLabelText('Loadout file'), upload(EXPORT));
    await waitFor(() => expect(screen.getByText('file too large')).toBeInTheDocument());
  });
});
