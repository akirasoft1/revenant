import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addShip, searchVehicles } from '../api/client';
import type { VehicleSummary } from '../api/types';
import { errorText } from './Status';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function AddShipForm({ memberId, onDone }: { memberId: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<VehicleSummary | null>(null);
  const [nickname, setNickname] = useState('');
  const term = useDebounced(q.trim(), 250);

  const results = useQuery({
    queryKey: ['vehicles', term],
    queryFn: ({ signal }) => searchVehicles(term, signal),
    enabled: term.length >= 2 && !picked,
    staleTime: 10 * 60_000,
  });

  const add = useMutation({
    mutationFn: () => addShip(memberId, picked!.uuid, nickname.trim() || null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hangar', memberId] });
      void qc.invalidateQueries({ queryKey: ['members'] });
      setQ('');
      setPicked(null);
      setNickname('');
      onDone?.();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (picked) add.mutate();
  }

  return (
    <form className="panel add-ship" onSubmit={submit}>
      <h3>Add a ship</h3>
      {picked ? (
        <div className="picked">
          <span>
            <strong>{picked.name}</strong>
            {picked.manufacturer && <span className="muted"> · {picked.manufacturer}</span>}
          </span>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setPicked(null)}>
            Change
          </button>
        </div>
      ) : (
        <>
          <label className="field">
            <span>Ship</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search the catalog, e.g. Cutlass Black"
              autoComplete="off"
            />
          </label>
          {term.length >= 2 && (
            <ul className="results" aria-label="Matching ships">
              {results.isPending && <li className="muted">Searching…</li>}
              {results.isError && <li className="error-text">{errorText(results.error)}</li>}
              {results.data?.length === 0 && <li className="muted">No ships match “{term}”.</li>}
              {results.data?.map((v) => (
                <li key={v.uuid}>
                  <button type="button" className="result" onClick={() => setPicked(v)}>
                    <strong>{v.name}</strong>
                    {v.manufacturer && <span className="muted"> · {v.manufacturer}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <label className="field">
        <span>Nickname (optional)</span>
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={64} />
      </label>
      {add.isError && <p className="error-text">{errorText(add.error)}</p>}
      <button className="btn btn-primary" type="submit" disabled={!picked || add.isPending}>
        {add.isPending ? 'Adding…' : 'Add ship'}
      </button>
    </form>
  );
}
