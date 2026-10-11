import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { MAX_MODEL_BYTES, deleteModel, getVehiclePositions, getWireframe, listModels, uploadModel } from '../api/client';
import type { ModelInfo } from '../api/types';
import { useMe } from '../auth/AuthGate';
import { ErrorNote, Loading, errorText } from '../components/Status';
import { ViewerBoundary } from '../components/wireframe/ViewerBoundary';
import { slotLabel } from '../lib/labels';
import { NotFoundPage } from './NotFoundPage';

// three.js stays in this lazily loaded chunk (preview only).
const WireframeViewer = lazy(() => import('../components/wireframe/WireframeViewer'));

/** Uploads in flight at once: enough to overlap round trips, small enough to be polite to the server. */
export const UPLOAD_CONCURRENCY = 3;

/**
 * Minimum gap between upload STARTS (about 30 a minute). Each upload makes the server do a Wiki detail
 * fetch for an uncached vehicle, and that limiter (60/min) is shared with every hangar read, so an
 * unpaced 220-ship batch would make the bot's hangar tools answer "unavailable" for minutes.
 */
export const UPLOAD_MIN_INTERVAL_MS = 2000;

function fmtEta(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.ceil(s / 60)} min`;
}

/** A model changed: every cache an open ship page derives from it is now suspect. */
export function invalidateModelCaches(qc: QueryClient): void {
  for (const key of ['models', 'vehicle-slots', 'vehicle-positions', 'wireframe']) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

type Status = 'queued' | 'uploading' | 'done' | 'failed';
interface Item {
  id: number;
  file: File;
  status: Status;
  result?: ModelInfo;
  error?: string;
  /** False for client-side rejections (retrying the same file cannot help). */
  retryable?: boolean;
}

/** Client-side check before sending; null when the file is acceptable. */
export function rejectReason(file: { name: string; size: number }): string | null {
  if (!file.name.toLowerCase().endsWith('.swf.gz')) return 'Not a .swf.gz wireframe bundle.';
  if (file.size > MAX_MODEL_BYTES) return `${fmtBytes(file.size)} is over the 2 MB limit.`;
  return null;
}

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
const fmtDate = (s?: string) => (s ? s.slice(0, 16).replace('T', ' ') : '');
const shipOf = (m: ModelInfo) => m.vehicleName ?? 'no matching ship';

function SlotLists({ slots }: { slots: ModelInfo['slots'] }) {
  const { missing = [], ambiguous = [] } = slots;
  if (missing.length === 0 && ambiguous.length === 0) return <p className="muted small">All slots matched.</p>;
  return (
    <>
      {missing.length > 0 && (
        <p className="small">
          <strong>Missing ({missing.length}):</strong> {missing.map(slotLabel).join(', ')}
        </p>
      )}
      {ambiguous.length > 0 && (
        <p className="small">
          <strong>Ambiguous ({ambiguous.length}):</strong> {ambiguous.map(slotLabel).join(', ')}
        </p>
      )}
    </>
  );
}

function UploadRow({ item }: { item: Item }) {
  const r = item.result;
  const label =
    item.status === 'done' && r
      ? `${shipOf(r)} · ${r.lines.toLocaleString()} lines · ${fmtBytes(r.bytes)} · ${r.slots.matched} matched / ${r.slots.missing.length} missing / ${r.slots.ambiguous.length} ambiguous`
      : item.status === 'failed'
        ? item.error
        : item.status === 'uploading'
          ? 'Uploading…'
          : 'Queued';
  const body = (
    <>
      <span className={`badge ${item.status === 'failed' ? 'badge-warn' : item.status === 'done' ? 'badge-fitted' : 'badge-stock'}`}>
        {item.status}
      </span>{' '}
      <span className="mono">{item.file.name}</span> <span className="muted small">{label}</span>
    </>
  );
  return (
    <li data-testid="upload-row">
      {item.status === 'done' && r ? (
        <details>
          <summary>{body}</summary>
          <SlotLists slots={r.slots} />
          {r.vehicleUuid === null && <p className="small warn-text">No ship in the catalog has class {r.className}; stored, but no positions were written.</p>}
        </details>
      ) : (
        body
      )}
    </li>
  );
}

function UploadSection() {
  const qc = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const nextId = useRef(1);
  const queue = useRef<Item[]>([]);
  const running = useRef(0);
  const succeeded = useRef(0);
  const lastStart = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);

  useEffect(
    () => () => {
      unmounted.current = true;
      queue.current = [];
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  const patch = useCallback((id: number, p: Partial<Item>) => {
    setItems((all) => all.map((i) => (i.id === id ? { ...i, ...p } : i)));
  }, []);

  const pump = useCallback(function pump() {
    if (unmounted.current) return;
    while (running.current < UPLOAD_CONCURRENCY && queue.current.length > 0) {
      const wait = lastStart.current + UPLOAD_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) {
        if (timer.current === null) {
          timer.current = setTimeout(() => {
            timer.current = null;
            pump();
          }, wait);
        }
        return;
      }
      lastStart.current = Date.now();
      const item = queue.current.shift()!;
      running.current += 1;
      patch(item.id, { status: 'uploading', error: undefined });
      uploadModel(item.file)
        .then((result) => {
          succeeded.current += 1;
          patch(item.id, { status: 'done', result });
        })
        .catch((err) => patch(item.id, { status: 'failed', error: errorText(err), retryable: true }))
        .finally(() => {
          running.current -= 1;
          if (queue.current.length === 0 && running.current === 0) {
            // One invalidation per drained batch, not one per file (213 refetches would hammer the list).
            if (succeeded.current > 0) invalidateModelCaches(qc);
            succeeded.current = 0;
          } else {
            pump();
          }
        });
    }
  }, [patch, qc]);

  const enqueue = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const added: Item[] = files.map((file) => {
        const reason = rejectReason(file);
        return {
          id: nextId.current++,
          file,
          status: reason ? 'failed' : 'queued',
          error: reason ?? undefined,
          retryable: !reason,
        };
      });
      setItems((all) => [...all, ...added]);
      queue.current.push(...added.filter((i) => i.status === 'queued'));
      pump();
    },
    [pump],
  );

  function retryFailed() {
    const again = items.filter((i) => i.status === 'failed' && i.retryable);
    if (again.length === 0) return;
    const ids = new Set(again.map((i) => i.id));
    setItems((all) => all.map((i) => (ids.has(i.id) ? { ...i, status: 'queued', error: undefined } : i)));
    queue.current.push(...again.map((i) => ({ ...i, status: 'queued' as const })));
    pump();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    enqueue(Array.from(e.dataTransfer?.files ?? []));
  }

  const total = items.length;
  const done = items.filter((i) => i.status === 'done');
  const failed = items.filter((i) => i.status === 'failed');
  const active = total - done.length - failed.length;
  const matched = done.filter((i) => i.result?.vehicleUuid).length;
  const noShip = done.length - matched;
  const retryable = failed.filter((i) => i.retryable).length;
  const queuedCount = items.filter((i) => i.status === 'queued').length;

  return (
    <section className="panel">
      <h2>Upload wireframe bundles</h2>
      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}`}
        data-testid="dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className="muted small">Drop .swf.gz files here (up to 2 MB each), or choose them. Many at once is fine.</p>
        <p className="muted small" data-testid="upload-pacing-note">
          Uploads are paced to about 30 a minute so the bot&apos;s hangar lookups keep working — a full set of ~220 ships takes about 8 minutes.
        </p>
        <input
          key={inputKey}
          type="file"
          multiple
          accept=".gz,.swf.gz"
          aria-label="Wireframe bundles"
          onChange={(e) => {
            enqueue(Array.from(e.target.files ?? []));
            setInputKey((k) => k + 1);
          }}
        />
      </div>
      {total > 0 && (
        <>
          <p role="status" data-testid="upload-progress">
            {done.length} / {total} uploaded, {failed.length} failed
            {active > 0 ? `, ${active} in progress` : ''}
            {queuedCount > 0 ? `, about ${fmtEta(queuedCount * UPLOAD_MIN_INTERVAL_MS)} left` : ''}
          </p>
          {active === 0 && (
            <div className="summary-box" data-testid="upload-summary">
              <p>
                <strong>Summary:</strong> {matched} matched a ship · {noShip} with no matching ship · {failed.length} failed
              </p>
              {failed.length > 0 && (
                <ul className="skipped">
                  {failed.map((i) => (
                    <li key={i.id}>
                      <span className="mono">{i.file.name}</span>: {i.error}
                    </li>
                  ))}
                </ul>
              )}
              <div className="toolbar">
                {retryable > 0 && (
                  <button className="btn" onClick={retryFailed}>
                    Retry failed
                  </button>
                )}
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setItems([]);
                  }}
                >
                  Clear list
                </button>
              </div>
            </div>
          )}
          <ul className="upload-list" aria-label="Upload results">
            {items.map((i) => (
              <UploadRow key={i.id} item={i} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function PreviewDialog({ model, onClose }: { model: ModelInfo; onClose(): void }) {
  const uuid = model.vehicleUuid!;
  const bundle = useQuery({ queryKey: ['wireframe', uuid], queryFn: ({ signal }) => getWireframe(uuid, signal), staleTime: 0 });
  const positions = useQuery({ queryKey: ['vehicle-positions', uuid], queryFn: () => getVehiclePositions(uuid) });
  const [viewerError, setViewerError] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const markers = useMemo(
    () =>
      Object.entries(positions.data?.slots ?? {}).flatMap(([id, p]) =>
        Array.isArray(p?.xyz) && p.xyz.length === 3 && p.xyz.every((n) => Number.isFinite(n))
          ? [{ id, label: slotLabel(id), xyz: [p.xyz[0], p.xyz[1], p.xyz[2]] as [number, number, number] }]
          : [],
      ),
    [positions.data],
  );
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Preview ${shipOf(model)}`} tabIndex={-1} ref={dialog} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h2>{shipOf(model)}</h2>
            <p className="muted small">
              {model.className} · {model.lines.toLocaleString()} lines · {markers.length} hardpoint markers
            </p>
          </div>
          <button className="btn btn-ghost btn-small" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="models-preview">
          {bundle.isError ? (
            <ErrorNote error={bundle.error} onRetry={() => void bundle.refetch()} />
          ) : viewerError ? (
            <p className="alert alert-error" role="alert">
              The viewer could not show this bundle.
            </p>
          ) : bundle.data === null ? (
            <p className="muted">No bundle is stored for this ship.</p>
          ) : bundle.data ? (
            <ViewerBoundary onError={() => setViewerError(true)}>
              <Suspense fallback={<Loading label="Loading viewer…" />}>
                <WireframeViewer
                  bundle={bundle.data}
                  markers={markers}
                  selected={selected}
                  onSelect={setSelected}
                  onError={() => setViewerError(true)}
                  label={`${shipOf(model)} wireframe — drag to rotate, scroll to zoom`}
                />
              </Suspense>
            </ViewerBoundary>
          ) : (
            <Loading label="Loading wireframe…" />
          )}
        </div>
      </div>
    </div>
  );
}

type SortKey = 'ship' | 'lines' | 'uploadedAt';

function ModelsTable() {
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ['models'], queryFn: listModels });
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'uploadedAt', dir: -1 });
  const [preview, setPreview] = useState<ModelInfo | null>(null);
  const del = useMutation({
    mutationFn: (m: ModelInfo) => deleteModel(m.kind, m.className),
    onSuccess: () => invalidateModelCaches(qc),
  });

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (models.data ?? []).filter(
      (m) => !q || `${m.vehicleName ?? ''} ${m.className} ${m.uploadedBy ?? ''}`.toLowerCase().includes(q),
    );
    const val = (m: ModelInfo): string | number =>
      sort.key === 'ship' ? shipOf(m).toLowerCase() : sort.key === 'lines' ? m.lines : (m.uploadedAt ?? '');
    return [...list].sort((a, b) => (val(a) < val(b) ? -sort.dir : val(a) > val(b) ? sort.dir : 0));
  }, [models.data, filter, sort]);

  function head(key: SortKey, text: string) {
    const on = sort.key === key;
    return (
      <th aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button className="btn btn-ghost btn-small" onClick={() => setSort({ key, dir: on ? (sort.dir === 1 ? -1 : 1) : 1 })}>
          {text}
          {on ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
        </button>
      </th>
    );
  }

  function confirmDelete(m: ModelInfo) {
    if (window.confirm(`Delete the wireframe for ${shipOf(m)} (${m.className})?`)) del.mutate(m);
  }

  return (
    <section className="panel">
      <h2>Stored models</h2>
      {models.isPending && <Loading />}
      {models.isError && <ErrorNote error={models.error} onRetry={() => void models.refetch()} />}
      {del.isError && <ErrorNote error={del.error} />}
      {models.data && (
        <>
          <div className="toolbar">
            <input type="search" placeholder="Filter by ship or class" aria-label="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="muted small">
              {rows.length} of {models.data.length}
            </span>
          </div>
          {models.data.length === 0 ? (
            <p className="muted">No models uploaded yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table models-table">
                <thead>
                  <tr>
                    {head('ship', 'Ship')}
                    <th>Class</th>
                    {head('lines', 'Lines')}
                    <th>Size</th>
                    <th>Matched</th>
                    <th>Missing</th>
                    <th>Ambiguous</th>
                    {head('uploadedAt', 'Uploaded')}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={`${m.kind}:${m.className}`} data-testid="model-row">
                      <td>{m.vehicleUuid ? m.vehicleName : <span className="muted">no matching ship</span>}</td>
                      <td className="mono">{m.className}</td>
                      <td>{m.lines.toLocaleString()}</td>
                      <td>{fmtBytes(m.bytes)}</td>
                      <td>{m.slots.matched}</td>
                      <td title={m.slots.missing.join(', ')}>{m.slots.missing.length}</td>
                      <td title={m.slots.ambiguous.join(', ')}>{m.slots.ambiguous.length}</td>
                      <td>
                        {fmtDate(m.uploadedAt)}
                        {m.uploadedBy ? <span className="muted small"> · {m.uploadedBy}</span> : null}
                      </td>
                      <td className="nowrap">
                        {m.vehicleUuid && (
                          <button className="btn btn-small" aria-label={`Preview ${m.className}`} onClick={() => setPreview(m)}>
                            Preview
                          </button>
                        )}{' '}
                        <button className="btn btn-small btn-danger" aria-label={`Delete ${m.className}`} disabled={del.isPending} onClick={() => confirmDelete(m)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {preview && <PreviewDialog model={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

/** `/admin/models`: admin-only (the server enforces it too; everyone else sees not-found). */
export function AdminModelsPage() {
  const me = useMe();
  if (!me.isAdmin) return <NotFoundPage />;
  return (
    <>
      <h1>Ship models</h1>
      <UploadSection />
      <ModelsTable />
    </>
  );
}
