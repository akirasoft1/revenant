import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate } from '../auth/AuthGate';
import { HtfImport } from './HtfImport';
import { ME, mockFetch, renderWithProviders } from '../test/utils';
import type { HtfPreview } from '../api/types';

const FILE = [{ id: 1 }];
const cost = { amount: 350, currency: 'USD', raw: '$350.00 USD' };
const pledge = { id: '10', name: 'Standalone Ship - Cutlass', date: 'Jan 1, 2020', cost, lti: true, warbond: false };

const PREVIEW: HtfPreview = {
  partial: true,
  summary: {},
  rows: [
    { index: 0, kind: 'new', rsiKey: '10:cutlass:0', vehicle: { uuid: 'v1', name: 'Cutlass Black' }, nickname: null, pledge, existing: null, linkCandidates: [], reason: null },
    { index: 1, kind: 'existing', rsiKey: '11:aurora:0', vehicle: { uuid: 'v2', name: 'Aurora' }, nickname: null, pledge, existing: { shipId: 'e1', label: 'Aurora' }, linkCandidates: [], reason: null },
    {
      index: 2, kind: 'link', rsiKey: '12:c2:0', vehicle: { uuid: 'v3', name: 'C2 Hercules' }, nickname: null, pledge, existing: null, reason: null,
      linkCandidates: [{ shipId: 'h1', label: 'Herc One (C2 Hercules)' }, { shipId: 'h2', label: 'C2 Hercules' }],
    },
    {
      index: 3, kind: 'link', rsiKey: '13:c2:0', vehicle: { uuid: 'v3', name: 'C2 Hercules' }, nickname: null, pledge, existing: null, reason: null,
      linkCandidates: [{ shipId: 'h2', label: 'C2 Hercules' }, { shipId: 'h1', label: 'Herc One (C2 Hercules)' }],
    },
    { index: 4, kind: 'skipped', rsiKey: null, vehicle: null, nickname: null, pledge, existing: null, linkCandidates: [], reason: 'unmatched', countedInTotals: true, detail: 'No catalog match for Idris' },
    { index: 5, kind: 'skipped', rsiKey: null, vehicle: null, nickname: null, pledge: null, existing: null, linkCandidates: [], reason: 'not_a_ship', countedInTotals: false, detail: 'Paint' },
  ],
  missing: [
    { shipId: 'm1', label: 'Old Ship', rsiKey: 'x', hasFittings: false, defaultRemove: true },
    { shipId: 'm2', label: 'Fitted Ship', rsiKey: 'y', hasFittings: true, defaultRemove: false },
  ],
};

function setup(preview: HtfPreview = PREVIEW, applyBody: unknown = { rows: [{ index: 0, result: 'created', shipId: 'n1' }, { index: 2, result: 'linked', shipId: 'h2' }, { index: 3, result: 'error', error: 'x', message: 'boom' }], removed: ['m1'], ledgerSynced: true }) {
  const m = mockFetch({
    'GET /api/me': { body: ME },
    'POST /api/v1/import/htf/preview': { body: preview },
    'POST /api/v1/import/htf/apply': { body: applyBody },
  });
  renderWithProviders(
    <AuthGate>
      <HtfImport target="111" forOther={false} targetLabel="111" targetName="Pilot" />
    </AuthGate>,
  );
  return m;
}

async function upload(user: ReturnType<typeof userEvent.setup>) {
  const input = await screen.findByLabelText('HangarXPLOR file');
  await user.upload(input, new File([JSON.stringify(FILE)], 'shiplist.json', { type: 'application/json' }));
}

describe('HtfImport', () => {
  it('shows instructions', async () => {
    setup();
    expect(await screen.findByRole('link', { name: 'https://hangarxplor.space' })).toBeInTheDocument();
    expect(screen.getByText(/Download JSON/)).toBeInTheDocument();
  });

  it('previews rows, reasons, link selects, missing defaults and partial banner', async () => {
    const user = userEvent.setup();
    setup();
    await upload(user);
    expect(await screen.findByText(/looks like a selection/)).toBeInTheDocument();
    expect(screen.getByText(/counted in pledge total, not added to hangar — not in game yet/)).toBeInTheDocument();
    expect(screen.getByText(/not a ship: Paint/)).toBeInTheDocument();
    const sel = screen.getByLabelText('Link row 2') as HTMLSelectElement;
    expect(sel.value).toBe('h1');
    expect((screen.getByLabelText('Link row 3') as HTMLSelectElement).value).toBe('h2');
    expect(screen.getByLabelText('Remove Old Ship')).toBeChecked();
    expect(screen.getByLabelText('Remove Fitted Ship')).not.toBeChecked();
  });

  it('applies exactly the user choices and renders results', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await upload(user);
    await screen.findByLabelText('Link row 2');
    // change row 2 to a new ship; untouched row 3 keeps the default (not sent)
    await user.selectOptions(screen.getByLabelText('Link row 2'), 'new');
    await user.click(screen.getByLabelText('Remove Old Ship'));
    await user.click(screen.getByLabelText('Remove Fitted Ship'));
    await user.click(screen.getByRole('button', { name: /Import/ }));
    await screen.findByText(/Done/);
    const apply = calls.find((c) => c.url.startsWith('/api/v1/import/htf/apply'))!;
    expect(apply.body).toEqual({ file: FILE, choices: { links: { '2': 'new' }, remove: ['m2'] } });
    expect(screen.getByText(/1 removed/)).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('does not offer a ship another row explicitly chose', async () => {
    const user = userEvent.setup();
    setup();
    await upload(user);
    await user.selectOptions(await screen.findByLabelText('Link row 2'), 'h2');
    const row3 = screen.getByLabelText('Link row 3');
    expect(within(row3).queryByRole('option', { name: /^C2 Hercules$/ })).toBeNull();
  });

  it('warns when the ledger did not sync', async () => {
    const user = userEvent.setup();
    setup({ ...PREVIEW, partial: false }, { rows: [], removed: [], ledgerSynced: false });
    await upload(user);
    await user.click(await screen.findByRole('button', { name: /Import/ }));
    await waitFor(() => expect(screen.getByText(/pledge totals may be out of date/i)).toBeInTheDocument());
  });

  it('shows the selection banner when only the ledger looks partial', async () => {
    const user = userEvent.setup();
    setup({ ...PREVIEW, partial: false, ledgerPartial: true }, { rows: [], removed: [], ledgerSynced: true });
    await upload(user);
    expect(await screen.findByText(/looks like a selection/)).toBeInTheDocument();
  });
});
