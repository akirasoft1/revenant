import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fitSlot, getHangar, getVehiclePositions, getVehicleSlots, resetShip, resetSlot, slotOptionsScope, type SlotWrite } from '../api/client';
import type { Hangar, Ship, SlotOption } from '../api/types';
import { canEdit, useMe } from '../auth/AuthGate';
import { droppedNotice } from '../lib/dropped';
import { rsiBadgeText } from '../lib/pledge';
import { shipTitle } from '../components/HangarView';
import { ClassicShipView, groupSlots } from '../components/ClassicShipView';
import { TerminalBoundary } from '../components/terminal/TerminalBoundary';
import { ErrorNote, Loading, errorText } from '../components/Status';
import { loadViewPref, saveViewPref, type ViewPref } from '../lib/terminal';
import { MemberId, useMemberName } from './MemberHangarPage';

// The Terminal view (and its stylesheet) loads only when chosen.
const TerminalShipView = lazy(() =>
  import('../components/terminal/TerminalShipView').then((m) => ({ default: m.TerminalShipView })),
);

// Kept for existing importers.
export { groupSlots };

const WIDE_QUERY = '(min-width: 900px)';

function matchesWide(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches;
  } catch {
    return false;
  }
}

/** Live `(min-width: 900px)` match; false where matchMedia is unavailable. */
function useWide(): boolean {
  const [wide, setWide] = useState(matchesWide);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return wide;
}

export function ShipDetailPage() {
  const me = useMe();
  const qc = useQueryClient();
  const { memberId = '', shipId = '' } = useParams();
  const ownerName = useMemberName(memberId);
  const editable = canEdit(me, memberId);
  const wide = useWide();
  const [pref, setPref] = useState<ViewPref>(() => loadViewPref());
  const terminal = wide && pref === 'terminal';
  // Set when the Terminal chunk fails to load: Classic for this page load (not persisted).
  const [terminalFailed, setTerminalFailed] = useState(false);
  const choose = (v: ViewPref) => {
    setPref(v);
    saveViewPref(v);
    if (v === 'terminal') setTerminalFailed(false);
  };
  const terminalLoadFailed = () => {
    setTerminalFailed(true);
    setPref('classic');
  };
  const hangar = useQuery({ queryKey: ['hangar', memberId], queryFn: () => getHangar(memberId) });
  const ship = hangar.data?.ships.find((s) => s.shipId === shipId);
  const stock = useQuery({
    queryKey: ['vehicle-slots', ship?.vehicleUuid],
    queryFn: () => getVehicleSlots(ship!.vehicleUuid),
    enabled: !!ship && !ship.loadoutError,
    staleTime: 60 * 60_000,
  });
  // Hardpoint positions for the Terminal view's markers (absent/failed -> no markers).
  const positions = useQuery({
    queryKey: ['vehicle-positions', ship?.vehicleUuid],
    queryFn: () => getVehiclePositions(ship!.vehicleUuid),
    enabled: terminal && !!ship && !ship.loadoutError,
    staleTime: 60 * 60_000,
  });
  const stockBySlot = new Map((stock.data?.slots ?? []).map((s) => [s.slot, s.stockItem]));

  const putShip = (updated: Ship) =>
    qc.setQueryData<Hangar>(['hangar', memberId], (old) =>
      old ? { ...old, ships: old.ships.map((s) => (s.shipId === updated.shipId ? updated : s)) } : old,
    );
  // Child fittings the last fit/reset removed along with their parent, as one sentence.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setNotice(null), [memberId, shipId]);
  // Any loadout change can add or remove slots (a fitted turret brings its own gun
  // mounts) and changes what child slots accept, so the hangar is re-read and this
  // ship's cached slot options are dropped. Not awaited: the write is already done.
  const loadoutChanged = () => {
    void qc.invalidateQueries({ queryKey: ['hangar', memberId] });
    void qc.invalidateQueries({ queryKey: slotOptionsScope({ memberId, shipId }) });
  };
  // The response's ship is shown at once; the refetch then confirms it.
  const written = (result: SlotWrite) => {
    if (result.ship) putShip(result.ship);
    setNotice(droppedNotice(result.dropped));
    loadoutChanged();
  };

  const fit = useMutation({
    mutationFn: ({ slot, item }: { slot: string; item: SlotOption }) => fitSlot(memberId, shipId, slot, item.uuid),
    onSuccess: written,
  });
  const reset = useMutation({
    mutationFn: (slot: string) => resetSlot(memberId, shipId, slot),
    onSuccess: written,
  });
  // The whole-ship reset answers with the chat-edit shape, not a Ship: refetch the hangar.
  const resetAll = useMutation({
    mutationFn: () => resetShip(memberId, shipId),
    onSuccess: () => {
      setNotice(null);
      loadoutChanged();
    },
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
  const loadout = ship.loadout;
  const viewProps = loadout && {
    memberId,
    ship,
    loadout,
    stockBySlot,
    vehicle: stock.data?.vehicle,
    editable,
    onFit: (slot: string, item: SlotOption) => fit.mutateAsync({ slot, item }),
    onReset: (slot: string) => reset.mutateAsync(slot),
    onResetShip: () => resetAll.mutateAsync(),
    busy: fit.isPending || reset.isPending || resetAll.isPending,
    error: fit.isError ? errorText(fit.error) : resetAll.isError ? errorText(resetAll.error) : null,
    notice,
    onDismissError: () => {
      fit.reset();
      resetAll.reset();
    },
  };
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
      {ship.rsi && <p><span className="badge badge-stock">{rsiBadgeText(ship.rsi, ship.vehicleName)}</span></p>}
      {wide && loadout && loadout.length > 0 && (
        <div className="view-toggle" role="group" aria-label="Ship view">
          <button className={`btn btn-small${pref === 'classic' ? '' : ' btn-ghost'}`} aria-pressed={pref === 'classic'} onClick={() => choose('classic')}>
            Classic
          </button>
          <button className={`btn btn-small${pref === 'terminal' ? '' : ' btn-ghost'}`} aria-pressed={pref === 'terminal'} onClick={() => choose('terminal')}>
            Terminal
          </button>
        </div>
      )}

      {loadout == null ? (
        <p className="alert alert-warn">
          {ship.loadoutError === 'not_found'
            ? 'This ship is no longer in the game catalog, so its slots cannot be shown.'
            : 'The game catalog is unavailable right now; slots cannot be shown. Try again shortly.'}
        </p>
      ) : loadout.length === 0 ? (
        <p className="empty">This ship has no editable component slots.</p>
      ) : terminal ? (
        <TerminalBoundary onError={terminalLoadFailed}>
          <Suspense fallback={<Loading label="Booting terminal…" />}>
            <TerminalShipView {...viewProps!} positions={positions.data} me={me} onExit={() => choose('classic')} />
          </Suspense>
        </TerminalBoundary>
      ) : (
        <>
          {terminalFailed && (
            <p className="alert alert-warn" role="status">
              Terminal view failed to load — reload the page to try again.
            </p>
          )}
          <ClassicShipView {...viewProps!} />
        </>
      )}
    </>
  );
}
