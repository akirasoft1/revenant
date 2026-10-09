import { useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MAX_IMPORT_BYTES, importApply, importPreview } from '../api/client';
import type { ImportApplyResult, ImportPreviewRow } from '../api/types';
import { useMe } from '../auth/AuthGate';
import { ExportSnippet } from '../components/ExportSnippet';
import {
  ImportPreview,
  defaultSelections,
  toApplyRows,
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
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileData, setFileData] = useState<unknown>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportPreviewRow[] | null>(null);
  const [selections, setSelections] = useState<Selections>({});
  const [result, setResult] = useState<ImportApplyResult | null>(null);

  const preview = useMutation({
    mutationFn: (data: unknown) => importPreview(data),
    onSuccess: (r) => {
      setRows(r);
      setSelections(defaultSelections(r));
    },
  });
  const apply = useMutation({
    mutationFn: () => importApply(fileData, toApplyRows(rows ?? [], selections)),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['hangar', me.discordId] });
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
    setFileName(null);
    setFileData(null);
    setRows(null);
    setResult(null);
    setFileError(null);
    preview.reset();
    apply.reset();
  }

  const applyRows = rows ? toApplyRows(rows, selections) : [];

  return (
    <>
      <h1>Import from spviewer</h1>

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
          <input type="file" accept=".json,application/json" onChange={(e) => void onFile(e)} aria-label="Loadout file" />
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
            {result.ships.length} {result.ships.length === 1 ? 'ship' : 'ships'} saved to your hangar.
          </p>
          <ul className="summary">
            {result.ships.map((s) => (
              <li key={s.shipId}>
                <Link to={`/members/${me.discordId}/ships/${s.shipId}`}>{shipTitle(s)}</Link>{' '}
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
            <Link className="btn btn-primary" to="/">
              Go to my hangar
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
