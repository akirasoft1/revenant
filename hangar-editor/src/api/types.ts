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
