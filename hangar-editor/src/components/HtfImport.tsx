import { useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MAX_IMPORT_BYTES, htfApply, htfPreview } from '../api/client';
import type { HtfApplyResult, HtfChoices, HtfPreview, HtfPreviewRow } from '../api/types';
import { formatCost } from '../lib/pledge';
import { errorText } from './Status';

async function readHtfFile(file: File): Promise<unknown> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 2 MB.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('That file is not JSON. Upload the shiplist.json HangarXPLOR downloaded.');
  }
  if (!Array.isArray(data)) {
    throw new Error('Unexpected file contents: expected the list of pledged items HangarXPLOR downloads.');
  }
  return data;
}

const KIND_LABEL: Record<HtfPreviewRow['kind'], string> = {
  new: 'New ship',
  existing: 'Already imported',
  link: 'Matches a ship you have',
  skipped: 'Skipped',
};

const REASON_LABEL: Record<string, string> = {
  not_a_ship: 'not a ship',
  unmatched: 'not in game yet',
  invalid: 'invalid entry',
};

/** Explicit link picks, row index -> shipId | "new". Absent = the server's default. */
type LinkPicks = Record<number, string>;

function optionsFor(row: HtfPreviewRow, picks: LinkPicks) {
  // A ship another row explicitly chose can't be chosen again (server 400s on it).
  const taken = new Set(
    Object.entries(picks)
      .filter(([i, v]) => Number(i) !== row.index && v !== 'new')
      .map(([, v]) => v),
  );
  return row.linkCandidates.filter((c) => !taken.has(c.shipId));
}

export function HtfImport({
  target,
  forOther,
  targetLabel,
  targetName,
}: {
  target: string;
  forOther: boolean;
  targetLabel: string;
  targetName: string;
}) {
  const qc = useQueryClient();
  const [inputKey, setInputKey] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileData, setFileData] = useState<unknown>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [data, setData] = useState<HtfPreview | null>(null);
  const [picks, setPicks] = useState<LinkPicks>({});
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<HtfApplyResult | null>(null);
  const memberParam = forOther ? target : undefined;

  const preview = useMutation({
    mutationFn: (file: unknown) => htfPreview(file, memberParam),
    onSuccess: (p) => {
      setData(p);
      setPicks({});
      setRemove(new Set(p.missing.filter((m) => m.defaultRemove).map((m) => m.shipId)));
    },
  });
  const apply = useMutation({
    mutationFn: () => {
      const choices: HtfChoices = {
        links: Object.fromEntries(Object.entries(picks).map(([i, v]) => [String(i), v])),
        remove: (data?.missing ?? []).filter((m) => remove.has(m.shipId)).map((m) => m.shipId),
      };
      return htfApply(fileData, choices, memberParam);
    },
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['hangar', target] });
      void qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['leaderboard'] });
    },
  });

  function reset() {
    setData(null);
    setResult(null);
    setFileError(null);
    setPicks({});
    preview.reset();
    apply.reset();
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    reset();
    if (!file) return;
    setFileName(file.name);
    try {
      const d = await readHtfFile(file);
      setFileData(d);
      preview.mutate(d);
    } catch (err) {
      setFileData(null);
      setFileError((err as Error).message);
    }
  }

  function startOver() {
    setInputKey((k) => k + 1);
    setFileName(null);
    setFileData(null);
    reset();
  }

  const rows = data?.rows ?? [];
  const importable = rows.filter((r) => r.kind !== 'skipped').length;
  const counted = rows.filter((r) => r.kind === 'skipped' && r.countedInTotals).length;

  return (
    <>
      <section className="panel">
        <h2>Import from HangarXPLOR</h2>
        <p className="muted small">
          Brings in the ships from your RSI pledges, with pledge name, cost and LTI, and keeps your fittings on re-import.
        </p>
        <ol className="steps">
          <li>
            Install the HangarXPLOR browser extension from{' '}
            <a href="https://hangarxplor.space" target="_blank" rel="noreferrer">
              https://hangarxplor.space
            </a>
            .
          </li>
          <li>
            Open your RSI hangar (
            <a href="https://robertsspaceindustries.com/account/pledges" target="_blank" rel="noreferrer">
              robertsspaceindustries.com/account/pledges
            </a>
            ).
          </li>
          <li>
            Use HangarXPLOR’s <strong>Download JSON</strong> button. It saves <code>shiplist.json</code>.
          </li>
          <li>Upload that file here.</li>
        </ol>
        <label className="file">
          <input
            key={inputKey}
            type="file"
            accept=".json,application/json"
            onChange={(e) => void onFile(e)}
            aria-label="HangarXPLOR file"
          />
        </label>
        {fileName && !fileError && <p className="muted small">{fileName}</p>}
        {fileError && (
          <p className="alert alert-error" role="alert">
            {fileError}
          </p>
        )}
        {preview.isPending && (
          <p className="muted" role="status">
            Reading pledges…
          </p>
        )}
        {preview.isError && (
          <p className="alert alert-error" role="alert">
            {errorText(preview.error)}
          </p>
        )}
      </section>

      {data && !result && (
        <section className="panel">
          <h3>Review</h3>
          {(data.partial || data.ledgerPartial) && (
            <p className="alert alert-warn" role="status">
              This export looks like a selection — nothing will be removed by default.
            </p>
          )}
          <p className="muted small">
            Nothing is saved until you press Import.
            {counted > 0 && ` ${counted} pledged ${counted === 1 ? 'item counts' : 'items count'} toward your pledge total without being added to the hangar.`}
          </p>
          <ul className="htf-rows">
            {rows.map((r) => (
              <li key={r.index} className="htf-row" data-kind={r.kind}>
                <span className={r.kind === 'skipped' ? 'badge badge-warn' : r.kind === 'new' ? 'badge badge-fitted' : 'badge badge-stock'}>
                  {KIND_LABEL[r.kind]}
                </span>{' '}
                <strong>{r.vehicle?.name ?? r.pledge?.name ?? `Entry ${r.index + 1}`}</strong>
                {r.nickname && <span className="muted"> “{r.nickname}”</span>}
                {r.pledge && (
                  <span className="muted small">
                    {' '}
                    · {r.pledge.name}
                    {formatCost(r.pledge.cost) ? ` · ${formatCost(r.pledge.cost)}` : ''}
                    {r.pledge.lti ? ' · LTI' : ''}
                  </span>
                )}
                {r.kind === 'existing' && r.existing && <span className="muted small"> · {r.existing.label}</span>}
                {r.kind === 'skipped' && (
                  <div className="muted small">
                    {REASON_LABEL[r.reason ?? ''] ?? r.reason}
                    {r.detail ? `: ${r.detail}` : ''}
                    {r.countedInTotals && ' — counted in pledge total, not added to hangar — not in game yet'}
                  </div>
                )}
                {r.kind === 'link' && <LinkSelect row={r} picks={picks} setPicks={setPicks} disabled={apply.isPending} />}
              </li>
            ))}
          </ul>

          {data.missing.length > 0 && (
            <>
              <h3>In your hangar but not in this file</h3>
              <p className="muted small">Tick the ships to remove. Ships with fittings are kept unless you tick them.</p>
              <ul className="htf-missing">
                {data.missing.map((m) => (
                  <li key={m.shipId}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Remove ${m.label}`}
                        checked={remove.has(m.shipId)}
                        disabled={apply.isPending}
                        onChange={(e) =>
                          setRemove((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(m.shipId);
                            else n.delete(m.shipId);
                            return n;
                          })
                        }
                      />{' '}
                      {m.label}
                      {m.hasFittings && <span className="badge badge-fitted"> has fittings</span>}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}

          {apply.isError && (
            <p className="alert alert-error" role="alert">
              {errorText(apply.error)}
            </p>
          )}
          <div className="toolbar">
            <button className="btn btn-primary" disabled={apply.isPending} onClick={() => apply.mutate()}>
              {apply.isPending ? 'Importing…' : `Import ${importable} ${importable === 1 ? 'ship' : 'ships'}`}
            </button>
            <button className="btn btn-ghost" onClick={startOver} disabled={apply.isPending}>
              Start over
            </button>
          </div>
        </section>
      )}

      {result && (
        <section className="panel" aria-label="HangarXPLOR import summary">
          <h2>Done</h2>
          <p>{summaryText(result)} in {forOther ? `${targetLabel}’s` : 'your'} hangar.</p>
          {!result.ledgerSynced && (
            <p className="alert alert-warn" role="alert">
              The ships were saved, but the pledge ledger could not be updated — pledge totals may be out of date. Import
              again to retry.
            </p>
          )}
          {result.rows.some((r) => r.result === 'error') && (
            <>
              <h3 className="warn-text">Not imported</h3>
              <ul className="skipped">
                {result.rows
                  .filter((r) => r.result === 'error')
                  .map((r) => (
                    <li key={r.index}>
                      {data?.rows.find((x) => x.index === r.index)?.vehicle?.name ?? `Entry ${r.index + 1}`}:{' '}
                      {r.message || r.error}
                    </li>
                  ))}
              </ul>
            </>
          )}
          <div className="toolbar">
            <Link className="btn btn-primary" to={forOther ? `/members/${target}` : '/'}>
              {forOther ? `Go to ${targetName}’s hangar` : 'Go to my hangar'}
            </Link>
            <button className="btn btn-ghost" onClick={startOver}>
              Import another file
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function summaryText(r: HtfApplyResult): string {
  const n = (k: string) => r.rows.filter((x) => x.result === k).length;
  return [
    `${n('created')} created`,
    `${n('linked')} linked`,
    `${n('updated')} updated`,
    `${n('unchanged')} unchanged`,
    `${r.removed.length} removed`,
  ].join(', ');
}

function LinkSelect({
  row,
  picks,
  setPicks,
  disabled,
}: {
  row: HtfPreviewRow;
  picks: LinkPicks;
  setPicks: (f: (p: LinkPicks) => LinkPicks) => void;
  disabled: boolean;
}) {
  const options = optionsFor(row, picks);
  const value = picks[row.index] ?? options[0]?.shipId ?? 'new';
  return (
    <div>
      <select
        aria-label={`Link row ${row.index}`}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          setPicks((p) => {
            const n = { ...p };
            // Back to the default pick = no explicit choice.
            if (v === row.linkCandidates[0]?.shipId) delete n[row.index];
            else n[row.index] = v;
            return n;
          });
        }}
      >
        {options.map((c) => (
          <option key={c.shipId} value={c.shipId}>
            Link to {c.label}
          </option>
        ))}
        <option value="new">Add as a new ship</option>
      </select>
    </div>
  );
}
