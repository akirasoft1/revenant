import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportPreviewRow } from '../api/types';
import { ImportPreview, defaultSelections, toApplyRows, type Selections } from './ImportPreview';

const ROWS: ImportPreviewRow[] = [
  {
    rowIndex: 0,
    loadoutName: 'Harbinger PvE',
    vehicle: { uuid: 'v-harb', name: 'Harbinger' },
    patch: '4.3.1',
    changes: [
      { slot: 'hardpoint_quantum_drive', from: { uuid: 'q1', name: 'Atlas' }, to: { uuid: 'q2', name: 'XL-1' } },
      { slot: 'hardpoint_nose/hardpoint_class_2', from: null, to: { uuid: 'g1', name: 'CF-337 Panther' } },
    ],
    skipped: [
      { slot: 'hardpoint_missile_rack_left', reason: 'untracked_slot', detail: 'missiles are not tracked' },
      { slot: 'hardpoint_shield_generator', reason: 'unknown_item', detail: 'SHLD_XYZ_S02' },
    ],
    matchingShips: [
      { shipId: 'ship-a', label: 'Harbinger “Old Faithful”' },
      { shipId: 'ship-b', label: 'Harbinger' },
    ],
  },
  {
    rowIndex: 1,
    loadoutName: 'Mystery',
    vehicle: null,
    changes: [],
    skipped: [{ reason: 'unrecognized_format', detail: 'loadoutData could not be decoded' }],
    matchingShips: [],
  },
  {
    rowIndex: 2,
    loadoutName: 'Stock Cutty',
    vehicle: { uuid: 'v-cut', name: 'Cutlass Black' },
    changes: [],
    skipped: [],
    matchingShips: [],
  },
];

function Harness({ rows = ROWS, onSel }: { rows?: ImportPreviewRow[]; onSel?: (s: Selections) => void }) {
  const [sel, setSel] = useState<Selections>(() => defaultSelections(rows));
  onSel?.(sel);
  return <ImportPreview rows={rows} selections={sel} onChange={(i, n) => setSel((s) => ({ ...s, [i]: n }))} />;
}

describe('ImportPreview', () => {
  it('renders each change as from → to with readable slot names', () => {
    render(<Harness />);
    const harb = screen.getAllByTestId('import-row')[0];
    expect(within(harb).getByText('2 component changes')).toBeInTheDocument();
    const changes = within(harb).getAllByRole('listitem').filter((li) => li.closest('.changes'));
    expect(changes[0]).toHaveTextContent('quantum drive: Atlas → XL-1');
    expect(changes[1]).toHaveTextContent('nose › class 2: empty → CF-337 Panther');
    expect(within(harb).getByText('Harbinger · 4.3.1')).toBeInTheDocument();
  });

  it('renders every skipped entry with its reason and detail', () => {
    render(<Harness />);
    const [harb, mystery] = screen.getAllByTestId('import-row');
    expect(within(harb).getByText('Skipped (2)')).toBeInTheDocument();
    expect(within(harb).getByText('Slot not tracked by the hangar')).toBeInTheDocument();
    expect(within(harb).getByText(/missiles are not tracked/)).toBeInTheDocument();
    expect(within(harb).getByText('Item not found in the catalog')).toBeInTheDocument();
    expect(within(harb).getByText(/SHLD_XYZ_S02/)).toBeInTheDocument();
    expect(within(mystery).getByText('Could not read this loadout')).toBeInTheDocument();
    expect(within(mystery).getByText('ship not recognized')).toBeInTheDocument();
  });

  it('falls back to the raw reason code for unknown reasons', () => {
    const rows = [{ ...ROWS[2], skipped: [{ slot: 'x', reason: 'some_new_reason' }] }];
    render(<Harness rows={rows} />);
    expect(screen.getByText('some new reason')).toBeInTheDocument();
  });

  it('cannot import a row whose ship was not recognized', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Import Mystery')).toBeDisabled();
    expect(screen.getByLabelText('Import Mystery')).not.toBeChecked();
  });

  it('defaults to updating the first matching ship, else a new ship', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Ship to update for Harbinger PvE')).toHaveValue('ship-a');
    expect(screen.getByLabelText('Nickname for Stock Cutty')).toHaveAttribute('placeholder', 'Stock Cutty');
    const cutty = screen.getAllByTestId('import-row')[2];
    expect(within(cutty).getByRole('radio', { name: /Update existing/ })).toBeDisabled();
  });

  it('builds apply rows from the selections', async () => {
    const user = userEvent.setup();
    let latest: Selections = {};
    render(<Harness onSel={(s) => (latest = s)} />);
    expect(toApplyRows(ROWS, latest)).toEqual([
      { rowIndex: 0, mode: 'existing', shipId: 'ship-a' },
      { rowIndex: 2, mode: 'new' },
    ]);
    await user.selectOptions(screen.getByLabelText('Ship to update for Harbinger PvE'), 'ship-b');
    await user.type(screen.getByLabelText('Nickname for Stock Cutty'), 'Cutty');
    expect(toApplyRows(ROWS, latest)).toEqual([
      { rowIndex: 0, mode: 'existing', shipId: 'ship-b' },
      { rowIndex: 2, mode: 'new', nickname: 'Cutty' },
    ]);
    const harb = screen.getAllByTestId('import-row')[0];
    await user.click(within(harb).getByRole('radio', { name: 'New ship' }));
    await user.click(screen.getByLabelText('Import Stock Cutty'));
    expect(toApplyRows(ROWS, latest)).toEqual([{ rowIndex: 0, mode: 'new' }]);
  });

  it('says so when the file has no loadouts', () => {
    render(<ImportPreview rows={[]} selections={{}} onChange={() => {}} />);
    expect(screen.getByText('The file contains no saved loadouts.')).toBeInTheDocument();
  });
});
