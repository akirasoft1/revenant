import { useState, type ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MAX_IMPORT_BYTES, getHangar, importApply, importPreview } from '../api/client';
import type { ImportApplyResult, ImportPreviewRow } from '../api/types';
import { canEdit, useMe } from '../auth/AuthGate';
import { useMemberName } from './MemberHangarPage';
import { ExportSnippet } from '../components/ExportSnippet';
import {
  ImportPreview,
  defaultSelections,
  toApplyRows,
  type FittedCounts,
  type Selections,
} from '../components/ImportPreview';
import { shipTitle } from '../components/HangarView';
import { errorText } from '../components/Status';

/** Read + parse the uploaded export. Throws a user-facing Error. */
export async function readExportFile(file: File): Promise<unknown> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 2 MB.`);
  }
  const text = await file.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not JSON. Upload the spviewer-loadouts.json the snippet downloaded.');
  }
  if (!Array.isArray(data)) {
    throw new Error('Unexpected file contents: expected the list of loadouts the snippet downloads.');
  }
  return data;
}

export function ImportPage() {
  const me = useMe();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  // Admins import into another member's hangar via /import?member=<id>.
  const target = params.get('member') || me.discordId;
  const forOther = target !== me.discordId;
  const targetName = useMemberName(target);
  // Display names are member-chosen; the ID beside them can't be spoofed.
  const targetLabel = targetName !== target ? `${targetName} (${target})` : target;
  const allowed = canEdit(me, target);
  const [inputKey, setInputKey] = useState(0);
  const [fittedCounts, setFittedCounts] = useState<FittedCounts>({});
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileData, setFileData] = useState<unknown>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportPreviewRow[] | null>(null);
  const [selections, setSelections] = useState<Selections>({});
  const [result, setResult] = useState<ImportApplyResult | null>(null);

  const preview = useMutation({
    mutationFn: async (data: unknown) => {
      const [r, hangar] = await Promise.all([
        importPreview(data, forOther ? target : undefined),
        // Fresh fitted counts decide the safe default (see defaultSelection).
        // A failed hangar fetch must not fail the preview: the counts are then
        // unknown, which defaults every row to "New ship" (never overwrites).
        qc
          .fetchQuery({ queryKey: ['hangar', target], queryFn: () => getHangar(target), staleTime: 0 })
          .catch(() => null),
      ]);
      const counts: FittedCounts = hangar
        ? Object.fromEntries(hangar.ships.map((s) => [s.shipId, Object.keys(s.fitted ?? {}).length]))
        : {};
      return { rows: r, counts };
    },
    onSuccess: ({ rows: r, counts }) => {
      setRows(r);
      setFittedCounts(counts);
      setSelections(defaultSelections(r, counts));
    },
  });
  const apply = useMutation({
    mutationFn: () => importApply(fileData, toApplyRows(rows ?? [], selections), forOther ? target : undefined),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['hangar', target] });
      void qc.invalidateQueries({ queryKey: ['members'] });
    },
  });

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setRows(null);
    setResult(null);
    setFileError(null);
    preview.reset();
    apply.reset();
    if (!file) return;
    setFileName(file.name);
    try {
      const data = await readExportFile(file);
      setFileData(data);
      preview.mutate(data);
    } catch (err) {
      setFileData(null);
      setFileError((err as Error).message);
    }
  }

  function startOver() {
    setInputKey((k) => k + 1); // fresh <input type=file> so the same file can be picked again
    setFileName(null);
    setFileData(null);
    setRows(null);
    setResult(null);
    setFileError(null);
    preview.reset();
    apply.reset();
  }

  const applyRows = rows ? toApplyRows(rows, selections) : [];
  const shipLink = (shipId: string) => `/members/${target}/ships/${shipId}`;

  if (!allowed) {
    return (
      <>
        <h1>Import from spviewer</h1>
        <p className="alert alert-error" role="alert">
          Only admins can import into another member’s hangar.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Import from spviewer</h1>
      {forOther && (
        <p className="alert alert-warn" data-testid="import-target">
          <span>
            Importing into {targetLabel}’s hangar.
          </span>
        </p>
      )}

      <section className="panel">
        <h2>1. Export your saved loadouts</h2>
        <ol className="steps">
          <li>
            Open{' '}
            <a href="https://www.spviewer.eu" target="_blank" rel="noreferrer">
              https://www.spviewer.eu
            </a>{' '}
            in this browser (where your loadouts are saved).
          </li>
          <li>
            Press <kbd>F12</kbd> and open the <strong>Console</strong> tab.
          </li>
          <li>
            Paste the snippet below and press <kbd>Enter</kbd>. It downloads <code>spviewer-loadouts.json</code>.
            (If the console asks you to type <code>allow pasting</code> first, do that.)
          </li>
          <li>Upload that file here.</li>
        </ol>
        <ExportSnippet />
      </section>

      <section className="panel">
        <h2>2. Upload the file</h2>
        <label className="file">
          <input key={inputKey} type="file" accept=".json,application/json" onChange={(e) => void onFile(e)} aria-label="Loadout file" />
        </label>
        {fileName && !fileError && <p className="muted small">{fileName}</p>}
        {fileError && (
          <p className="alert alert-error" role="alert">
            {fileError}
          </p>
        )}
        {preview.isPending && (
          <p className="muted" role="status">
            Reading loadouts…
          </p>
        )}
        {preview.isError && (
          <p className="alert alert-error" role="alert">
            {errorText(preview.error)}
          </p>
        )}
      </section>

      {rows && !result && (
        <section className="panel">
          <h2>3. Review and choose where each loadout goes</h2>
          <p className="muted small">
            Nothing is saved until you press Import. Only tracked component slots are imported; everything else is listed
            as skipped.
          </p>
          <ImportPreview
            rows={rows}
            selections={selections}
            fittedCounts={fittedCounts}
            disabled={apply.isPending}
            onChange={(i, next) => setSelections((s) => ({ ...s, [i]: next }))}
          />
          {apply.isError && (
            <p className="alert alert-error" role="alert">
              {errorText(apply.error)}
            </p>
          )}
          <div className="toolbar">
            <button
              className="btn btn-primary"
              disabled={applyRows.length === 0 || apply.isPending}
              onClick={() => apply.mutate()}
            >
              {apply.isPending
                ? 'Importing…'
                : `Import ${applyRows.length} ${applyRows.length === 1 ? 'loadout' : 'loadouts'}`}
            </button>
            <button className="btn btn-ghost" onClick={startOver} disabled={apply.isPending}>
              Start over
            </button>
          </div>
        </section>
      )}

      {result && (
        <section className="panel" aria-label="Import summary">
          <h2>Done</h2>
          <p>
            {result.ships.length} {result.ships.length === 1 ? 'ship' : 'ships'} saved to{' '}
            {forOther ? `${targetLabel}’s` : 'your'} hangar.
          </p>
          <ul className="summary">
            {result.ships.map((s) => (
              <li key={s.shipId}>
                <Link to={shipLink(s.shipId)}>{shipTitle(s)}</Link>{' '}
                <span className="muted">
                  {s.vehicleName} · {Object.keys(s.fitted ?? {}).length} fitted
                </span>
              </li>
            ))}
          </ul>
          {result.errors.length > 0 && (
            <>
              <h3 className="warn-text">Not imported</h3>
              <ul className="skipped">
                {result.errors.map((e, i) => (
                  <li key={i}>
                    {e.rowIndex != null && rows?.find((r) => r.rowIndex === e.rowIndex)?.loadoutName}
                    {e.rowIndex != null && ': '}
                    {e.message || e.error}
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
