import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fitSlot, getHangar, getVehicleSlots, resetSlot } from '../api/client';
import type { Hangar, LoadoutSlot, Ship, SlotOption } from '../api/types';
import { canEdit, useMe } from '../auth/AuthGate';
import { TYPE_ORDER, slotLabel, typeLabel } from '../lib/labels';
import { sizeLabel } from '../lib/picker';
import { shipTitle } from '../components/HangarView';
import { SlotPicker } from '../components/SlotPicker';
import { ErrorNote, Loading, errorText } from '../components/Status';
import { MemberId, useMemberName } from './MemberHangarPage';

export function groupSlots(loadout: LoadoutSlot[]): [string, LoadoutSlot[]][] {
  const groups = new Map<string, LoadoutSlot[]>();
  for (const s of loadout) {
    const list = groups.get(s.type) ?? [];
    list.push(s);
    groups.set(s.type, list);
  }
  const rank = (t: string) => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

export function ShipDetailPage() {
  const me = useMe();
  const qc = useQueryClient();
  const { memberId = '', shipId = '' } = useParams();
  const ownerName = useMemberName(memberId);
  const editable = canEdit(me, memberId);
  const hangar = useQuery({ queryKey: ['hangar', memberId], queryFn: () => getHangar(memberId) });
  const ship = hangar.data?.ships.find((s) => s.shipId === shipId);
  const stock = useQuery({
    queryKey: ['vehicle-slots', ship?.vehicleUuid],
    queryFn: () => getVehicleSlots(ship!.vehicleUuid),
    enabled: !!ship && !ship.loadoutError,
    staleTime: 60 * 60_000,
  });
  const stockBySlot = new Map((stock.data?.slots ?? []).map((s) => [s.slot, s.stockItem]));
  const [picking, setPicking] = useState<LoadoutSlot | null>(null);

  const putShip = (updated: Ship) =>
    qc.setQueryData<Hangar>(['hangar', memberId], (old) =>
      old ? { ...old, ships: old.ships.map((s) => (s.shipId === updated.shipId ? updated : s)) } : old,
    );

  const fit = useMutation({
    mutationFn: ({ slot, item }: { slot: string; item: SlotOption }) => fitSlot(memberId, shipId, slot, item.uuid),
    onSuccess: (updated) => {
      putShip(updated);
      setPicking(null);
    },
  });
  const reset = useMutation({
    mutationFn: (slot: string) => resetSlot(memberId, shipId, slot),
    onSuccess: putShip,
  });

  if (hangar.isPending) return <Loading label="Loading ship…" />;
  if (hangar.isError) return <ErrorNote error={hangar.error} onRetry={() => void hangar.refetch()} />;
  if (!ship) {
    return (
      <>
        <h1>Ship not found</h1>
        <p>
          This ship is not in the hangar any more.{' '}
          <Link to={memberId === me.discordId ? '/' : `/members/${memberId}`}>Back to the hangar</Link>
        </p>
      </>
    );
  }

  const hangarLink = memberId === me.discordId ? '/' : `/members/${memberId}`;
  return (
    <>
      <p className="crumbs">
        <Link to={hangarLink}>{memberId === me.discordId ? 'My hangar' : `${ownerName}’s hangar`}</Link>
        {memberId !== me.discordId && (
          <>
            {' '}
            <MemberId id={memberId} name={ownerName} />
          </>
        )}{' '}
        ›
      </p>
      <h1>
        {shipTitle(ship)} {!editable && <span className="badge">read-only</span>}
      </h1>
      {ship.nickname && <p className="muted">{ship.vehicleName}</p>}

      {ship.loadout == null ? (
        <p className="alert alert-warn">
          {ship.loadoutError === 'not_found'
            ? 'This ship is no longer in the game catalog, so its slots cannot be shown.'
            : 'The game catalog is unavailable right now; slots cannot be shown. Try again shortly.'}
        </p>
      ) : ship.loadout.length === 0 ? (
        <p className="empty">This ship has no editable component slots.</p>
      ) : (
        <>
          {reset.isError && <p className="alert alert-error">{errorText(reset.error)}</p>}
          {groupSlots(ship.loadout).map(([type, slots]) => (
            <section key={type} className="slot-group">
              <h2>{typeLabel(type)}</h2>
              <table className="slot-table">
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th>Size</th>
                    <th>Item</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map((s) => {
                    const stockItem = stockBySlot.get(s.slot);
                    return (
                      <tr key={s.slot}>
                        <td data-label="Slot" className="slot-name" title={s.slot}>
                          {slotLabel(s.slot)}
                        </td>
                        <td data-label="Size">{sizeLabel(s.sizeMin, s.sizeMax)}</td>
                        <td data-label="Item">
                          <span className="item-name">{s.item?.name ?? <em className="muted">empty</em>}</span>{' '}
                          <span className={s.source === 'fitted' ? 'badge badge-fitted' : 'badge badge-stock'}>
                            {s.source}
                          </span>
                          {s.source === 'fitted' && stockItem && (
                            <span className="muted small stock-note"> stock: {stockItem.name}</span>
                          )}
                        </td>
                        <td className="slot-actions">
                          {editable && (
                            <>
                              <button className="btn btn-small" onClick={() => setPicking(s)}>
                                Change
                              </button>
                              {s.source === 'fitted' && (
                                <button
                                  className="btn btn-small btn-ghost"
                                  disabled={reset.isPending && reset.variables === s.slot}
                                  onClick={() => reset.mutate(s.slot)}
                                >
                                  Reset to stock
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))}
        </>
      )}

      {picking && (
        <SlotPicker
          vehicleUuid={ship.vehicleUuid}
          slot={picking}
          stockUuid={stockBySlot.get(picking.slot)?.uuid ?? null}
          busy={fit.isPending}
          error={fit.isError ? errorText(fit.error) : null}
          onPick={(item) => fit.mutate({ slot: picking.slot, item })}
          onClose={() => {
            setPicking(null);
            fit.reset();
          }}
        />
      )}
    </>
  );
}
