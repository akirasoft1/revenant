import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteShip, getHangar, renameShip } from '../api/client';
import type { Ship } from '../api/types';
import { useMe } from '../auth/AuthGate';
import { AddShipForm } from './AddShipForm';
import { ErrorNote, Loading, errorText } from './Status';

export function shipTitle(ship: Ship): string {
  return ship.nickname ? ship.nickname : ship.vehicleName;
}

function ShipCard({ ship, memberId, editable }: { ship: Ship; memberId: string; editable: boolean }) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(ship.nickname ?? '');
  const [confirming, setConfirming] = useState(false);
  const fittedCount = Object.keys(ship.fitted ?? {}).length;
  const slotCount = ship.loadout?.length ?? null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['hangar', memberId] });
    void qc.invalidateQueries({ queryKey: ['members'] });
  };
  const rename = useMutation({
    mutationFn: () => renameShip(memberId, ship.shipId, name.trim() || null),
    onSuccess: () => {
      setRenaming(false);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => deleteShip(memberId, ship.shipId), onSuccess: refresh });

  return (
    <li className="ship-card">
      <Link className="ship-card-main" to={`/members/${memberId}/ships/${ship.shipId}`}>
        <span className="ship-title">{shipTitle(ship)}</span>
        {ship.nickname && <span className="muted ship-sub">{ship.vehicleName}</span>}
        <span className="ship-meta">
          {ship.loadoutError ? (
            <span className="badge badge-warn">
              {ship.loadoutError === 'not_found' ? 'not in catalog' : 'catalog unavailable'}
            </span>
          ) : (
            <>
              {slotCount != null && <span className="muted">{slotCount} slots</span>}
              {fittedCount > 0 ? (
                <span className="badge badge-fitted">{fittedCount} fitted</span>
              ) : (
                <span className="badge badge-stock">stock</span>
              )}
            </>
          )}
        </span>
      </Link>
      {editable && (
        <div className="ship-actions">
          {renaming ? (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                rename.mutate();
              }}
            >
              <input
                aria-label="Nickname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
                placeholder={ship.vehicleName}
                autoFocus
              />
              <button className="btn btn-small btn-primary" type="submit" disabled={rename.isPending}>
                Save
              </button>
              <button className="btn btn-small btn-ghost" type="button" onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </form>
          ) : confirming ? (
            <>
              <span className="warn-text">Remove {shipTitle(ship)}?</span>
              <button
                className="btn btn-small btn-danger"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                {remove.isPending ? 'Removing…' : 'Yes, remove'}
              </button>
              <button className="btn btn-small btn-ghost" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-small btn-ghost" onClick={() => setRenaming(true)}>
                Rename
              </button>
              <button className="btn btn-small btn-ghost" onClick={() => setConfirming(true)}>
                Remove
              </button>
            </>
          )}
          {(rename.isError || remove.isError) && (
            <span className="error-text">{errorText(rename.error ?? remove.error)}</span>
          )}
        </div>
      )}
    </li>
  );
}

export function HangarView({ memberId, editable }: { memberId: string; editable: boolean }) {
  const me = useMe();
  const hangar = useQuery({ queryKey: ['hangar', memberId], queryFn: () => getHangar(memberId) });
  const [adding, setAdding] = useState(false);

  if (hangar.isPending) return <Loading label="Loading hangar…" />;
  if (hangar.isError) return <ErrorNote error={hangar.error} onRetry={() => void hangar.refetch()} />;

  const ships = [...hangar.data.ships].sort((a, b) =>
    shipTitle(a).localeCompare(shipTitle(b), undefined, { sensitivity: 'base' }),
  );
  return (
    <section>
      {editable && (
        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Close' : '+ Add ship'}
          </button>
          <Link
            className="btn btn-ghost"
            to={memberId === me.discordId ? '/import' : `/import?member=${encodeURIComponent(memberId)}`}
          >
            Import from spviewer
          </Link>
        </div>
      )}
      {editable && adding && <AddShipForm memberId={memberId} onDone={() => setAdding(false)} />}
      {ships.length === 0 ? (
        <p className="empty">{editable ? 'No ships yet — add one or import from spviewer.' : 'No ships.'}</p>
      ) : (
        <ul className="ship-grid">
          {ships.map((s) => (
            <ShipCard key={s.shipId} ship={s} memberId={memberId} editable={editable} />
          ))}
        </ul>
      )}
    </section>
  );
}
