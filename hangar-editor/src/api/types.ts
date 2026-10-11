// Wire shapes of hangar-service (`hangar-service/src/app.py`, README "API").
// Routes marked [Task 2] were coded against the design spec before the server
// side existed; their exact shapes are isolated here and in `client.ts`.

export interface Me {
  discordId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string;
  isAdmin: boolean;
}

export interface MemberSummary {
  discordId: string;
  shipCount: number;
  displayName?: string;
}

export interface ItemRef {
  uuid: string;
  name: string;
}

export interface CompatibleType {
  type: string;
  subTypes: string[];
}

/** One entry of `Ship.loadout` (effective loadout, stock merged with `fitted`). */
export interface LoadoutSlot {
  slot: string;
  type: string;
  sizeMin: number | null;
  sizeMax: number | null;
  compatibleTypes: CompatibleType[];
  item: ItemRef | null;
  source: 'stock' | 'fitted';
}

export interface Ship {
  shipId: string;
  vehicleUuid: string;
  vehicleName: string;
  vehicleClassName: string | null;
  nickname: string | null;
  fitted: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string | null;
  ownerName?: string | null;
  loadout: LoadoutSlot[] | null;
  loadoutError: 'unavailable' | 'not_found' | null;
}

export interface Hangar {
  member: string;
  ships: Ship[];
}

export interface VehicleSummary {
  uuid: string;
  name: string;
  gameName?: string | null;
  slug?: string | null;
  className?: string | null;
  manufacturer?: string | null;
  image?: string;
  dimension?: { length?: number; width?: number; height?: number };
  mass?: number;
  crew?: { min?: number; max?: number };
  portCounts?: Record<string, number>;
}

export interface StockItem {
  uuid: string;
  name: string;
  className?: string | null;
  type?: string | null;
  size?: number | null;
}

/** `GET /api/v1/catalog/vehicles/{uuid}/slots` -> `slots[]`. */
export interface SlotDef {
  slot: string;
  type: string;
  subType: string | null;
  sizeMin: number | null;
  sizeMax: number | null;
  compatibleTypes: CompatibleType[];
  stockItem: StockItem | null;
}

export interface VehicleSlots {
  vehicle: VehicleSummary;
  slots: SlotDef[];
}

// ----- [Task 2] slot options -----

export interface KeyStat {
  name: string;
  value: number | null;
  lowerIsBetter: boolean;
}

export interface CheapestPrice {
  price: number;
  shop: string;
  location: string;
}

export interface StatValue {
  key: string;
  label: string;
  value: number;
  unit: string | null;
  lowerIsBetter: boolean;
}

/** `GET /api/v1/catalog/slot-options?vehicle=&slot=` -> `items[]` (spec shape). */
export interface SlotOption {
  uuid: string;
  name: string;
  type: string;
  size: number | null;
  grade: string | null;
  class: string | null;
  keyStat: KeyStat | null;
  cheapestPrice?: CheapestPrice;
  image?: string;
  manufacturer?: string | null;
  description?: string;
  stats?: StatValue[];
}

// ----- terminal view -----

export interface PositionPoint {
  view?: string;
  x?: number;
  y?: number;
  xyz?: [number, number, number];
}

/** `GET /api/v1/catalog/vehicles/{uuid}/positions` (`{}` when none known). */
export interface VehiclePositions {
  views?: Record<string, { imageUrl: string; width: number; height: number }>;
  slots?: Record<string, PositionPoint>;
  source?: string;
  gameVersion?: string;
}

/** Props shared by the Classic and Terminal ship views (same data, same writes). */
export interface ShipViewProps {
  memberId: string;
  ship: Ship;
  loadout: LoadoutSlot[];
  stockBySlot: Map<string, StockItem | null>;
  vehicle?: VehicleSummary;
  editable: boolean;
  onFit(slot: string, item: SlotOption): Promise<unknown>;
  onReset(slot: string): Promise<unknown>;
  onResetShip(): Promise<unknown>;
  busy: boolean;
  error: string | null;
  /** Clear a stale fit error (e.g. when the Classic picker closes). */
  onDismissError?(): void;
}

/** Terminal adds the exit hook (Esc / Classic button: switch to Classic and persist). */
export interface TerminalViewProps extends ShipViewProps {
  onExit(): void;
}

// ----- [Task 2] spviewer import -----

export interface ImportChange {
  slot: string;
  /** Spec leaves `from` untyped: tolerate an item ref, a plain name, or empty. */
  from: ItemRef | string | null;
  to: ItemRef;
}

export interface ImportSkip {
  slot?: string;
  reason: string;
  detail?: string;
}

export interface MatchingShip {
  shipId: string;
  label: string;
}

export interface ImportPreviewRow {
  rowIndex: number;
  loadoutName: string;
  vehicle: ItemRef | null;
  patch?: string | null;
  changes: ImportChange[];
  skipped: ImportSkip[];
  matchingShips: MatchingShip[];
}

export interface ImportApplyRow {
  rowIndex: number;
  mode: 'new' | 'existing';
  shipId?: string;
  nickname?: string;
}

export interface ImportApplyResult {
  ships: Ship[];
  /** Optional per-row failures, if the server reports them. */
  errors: { rowIndex?: number; error: string; message: string }[];
}
