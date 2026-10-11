import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSlotOptions } from '../../api/client';
import type { LoadoutSlot, Me, ShipViewProps, SlotOption, VehiclePositions } from '../../api/types';
import { slotLabel, typeLabel } from '../../lib/labels';
import { sizeLabel } from '../../lib/picker';
import { READONLY_TYPES, portsForTab, sortOptions, stepPort, type TabId } from '../../lib/terminal';
import { errorText } from '../Status';
import { ActionBar } from './ActionBar';
import { CategoryTabs } from './CategoryTabs';
import { ComparePanel } from './ComparePanel';
import { ItemGrid } from './ItemGrid';
import { PortRail } from './PortRail';
import { ShipStatsSidebar } from './ShipStatsSidebar';
import { ShipVisual } from './ShipVisual';
import './terminal.css';

const SAVED_MS = 2500;

export type TerminalShipViewProps = ShipViewProps & {
  positions?: VehiclePositions;
  me: Me | null;
  onExit(): void;
};

/** The fitted item as a SlotOption (from the options list when present, else a minimal stand-in). */
function currentOption(port: LoadoutSlot, options: SlotOption[]): SlotOption {
  const found = port.item ? options.find((o) => o.uuid === port.item!.uuid) : undefined;
  return (
    found ?? {
      uuid: port.item?.uuid ?? '',
      name: port.item?.name ?? 'EMPTY',
      type: port.type,
      size: null,
      grade: null,
      class: null,
      keyStat: null,
    }
  );
}

/**
 * Terminal-style ship view (inspired by the in-game loadout terminal). Same
 * props and writes as Classic; selecting a card is a preview — only Install,
 * Reset port and Reset ship write.
 */
export function TerminalShipView({
  ship,
  loadout,
  stockBySlot,
  vehicle,
  editable,
  onFit,
  onReset,
  onResetShip,
  busy,
  onDismissError,
  positions,
  me,
  onExit,
}: TerminalShipViewProps) {
  const [tab, setTab] = useState<TabId>('all');
  const ports = useMemo(() => portsForTab(loadout, tab), [loadout, tab]);
  const [selected, setSelected] = useState<string | null>(() => ports[0]?.slot ?? null);
  const port = loadout.find((s) => s.slot === selected) ?? ports[0] ?? null;
  const [candidate, setCandidate] = useState<SlotOption | null>(null);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), SAVED_MS);
    return () => clearTimeout(t);
  }, [savedAt]);

  const readOnlyPort = port != null && READONLY_TYPES.has(port.type);
  const options = useQuery({
    queryKey: ['slot-options', ship.vehicleUuid, port?.slot],
    queryFn: () => getSlotOptions(ship.vehicleUuid, port!.slot),
    enabled: port != null && !readOnlyPort,
    staleTime: 10 * 60_000,
  });
  const sorted = useMemo(() => sortOptions(options.data ?? []), [options.data]);
  const current = port ? currentOption(port, sorted) : null;
  const stockUuid = port ? (stockBySlot.get(port.slot)?.uuid ?? null) : null;

  const disabled = busy || working;
  const canWritePort = editable && port != null && !readOnlyPort;
  const anyFitted = loadout.some((s) => s.source === 'fitted');

  const select = (slot: string | null) => {
    if (slot === port?.slot) return;
    setSelected(slot);
    setCandidate(null);
  };
  const chooseTab = (t: TabId) => {
    setTab(t);
    const list = portsForTab(loadout, t);
    if (!list.some((p) => p.slot === port?.slot)) select(list[0]?.slot ?? null);
  };
  const selectAnywhere = (slot: string) => {
    if (!ports.some((p) => p.slot === slot)) setTab('all');
    select(slot);
  };

  async function write(action: () => Promise<unknown>) {
    setWorking(true);
    setFailure(null);
    try {
      await action();
      if (!mounted.current) return;
      setCandidate(null);
      setSavedAt(Date.now());
    } catch (e) {
      if (mounted.current) setFailure(errorText(e));
    } finally {
      if (mounted.current) setWorking(false);
    }
  }

  const install = () => {
    if (!port || !candidate || disabled) return;
    const item = candidate;
    void write(() => onFit(port.slot, item));
  };
  const resetPort = () => {
    if (!port || !canWritePort || disabled || port.source !== 'fitted') return;
    if (!window.confirm(`Reset ${slotLabel(port.slot)} to stock${stockUuid ? ` (${stockBySlot.get(port.slot)?.name})` : ''}?`)) return;
    void write(() => onReset(port.slot));
  };
  const resetShip = () => {
    if (disabled || !anyFitted) return;
    if (!window.confirm(`Reset every slot of ${ship.nickname || ship.vehicleName} to stock?`)) return;
    void write(() => onResetShip());
  };
  const dismiss = () => {
    setFailure(null);
    onDismissError?.();
  };

  const signedIn = me ? (me.globalName ?? me.username) : null;
  const shipName = ship.nickname || ship.vehicleName;
  const notice = readOnlyPort
    ? "Missiles aren't tracked by the hangar — this rack is shown for reference only."
    : !editable
      ? 'Read-only: this is another member’s hangar.'
      : null;

  return (
    <div className="terminal" data-testid="terminal-view">
      <span className="t-scanlines" aria-hidden="true" />
      <header className="t-topbar t-frame" data-testid="terminal-topbar">
        <div className="t-brand">
          <span className="t-brand-mark" aria-hidden="true" />
          <span className="t-brand-title">Hangar Configuration Terminal</span>
        </div>
        <div className="t-ship-id">
          <span className="t-ship-name">{shipName}</span>
          <span className="t-ship-model">
            {[vehicle?.manufacturer, ship.vehicleName].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div className="t-topbar-right">
          <span className={`t-saved${savedAt != null ? ' is-on' : ''}`} role="status" aria-live="polite">
            {savedAt != null && <span key={savedAt}>Changes saved</span>}
          </span>
          {signedIn && (
            <span className="t-user">
              Signed in as <b>{signedIn}</b>
            </span>
          )}
        </div>
      </header>

      {failure && (
        <div className="t-alert" role="alert">
          <span>{failure}</span>
          <button type="button" className="t-btn t-btn-ghost" onClick={dismiss} aria-label="Dismiss error">
            ✕
          </button>
        </div>
      )}

      <div className="t-body">
        <section className="t-left" aria-label="Items">
          <CategoryTabs loadout={loadout} tab={tab} onSelect={chooseTab} />
          {port && (
            <div className="t-port-title">
              <span className="t-eyebrow">{typeLabel(port.type)}</span>
              <span className="t-port-title-name" title={port.slot}>
                {slotLabel(port.slot)} <small>{sizeLabel(port.sizeMin, port.sizeMax)}</small>
              </span>
            </div>
          )}
          <div className="t-grid-wrap">
            {!port ? (
              <p className="t-empty">No ports in this category.</p>
            ) : readOnlyPort ? (
              <p className="t-empty">{notice}</p>
            ) : options.isPending ? (
              <p className="t-empty t-loading" role="status">
                Scanning compatible items…
              </p>
            ) : options.isError ? (
              <div className="t-empty" role="alert">
                <p>Couldn’t load compatible items: {errorText(options.error)}</p>
                <button type="button" className="t-btn" onClick={() => void options.refetch()}>
                  Retry
                </button>
              </div>
            ) : (
              <ItemGrid
                options={sorted}
                port={port}
                stockUuid={stockUuid}
                candidateUuid={candidate?.uuid ?? null}
                onSelect={setCandidate}
              />
            )}
          </div>
        </section>

        <section className="t-centre">
          {port && current ? (
            <ComparePanel
              current={current}
              candidate={candidate}
              options={sorted}
              portType={port.type}
              canInstall={canWritePort}
              installing={disabled}
              onInstall={install}
              notice={readOnlyPort ? null : notice}
            />
          ) : (
            <p className="t-empty">Select a port.</p>
          )}
        </section>

        <section className="t-right" aria-label="Ship">
          <ShipStatsSidebar vehicle={vehicle} />
          <ShipVisual vehicle={vehicle} positions={positions} loadout={loadout} selected={port?.slot ?? null} onSelect={selectAnywhere} />
          <PortRail ports={ports} selected={port?.slot ?? null} onSelect={select} />
        </section>
      </div>

      <ActionBar
        handlers={{
          prev: () => select(stepPort(ports, port?.slot ?? null, -1)),
          next: () => select(stepPort(ports, port?.slot ?? null, 1)),
          resetPort: editable && !readOnlyPort ? resetPort : undefined,
          resetShip: editable ? resetShip : undefined,
          exit: onExit,
        }}
        resetPortEnabled={port?.source === 'fitted'}
        resetShipEnabled={anyFitted}
        disabled={disabled}
      />
    </div>
  );
}
