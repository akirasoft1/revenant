// The ONLY module that knows hangar-service URLs and wire shapes. Same origin
// as the SPA (served by hangar-service at https://hangar.aklabs.io), so plain
// `fetch` with the session cookie; the browser adds `Origin` to writes, which
// the service's CSRF check requires.
import type {
  Hangar,
  HtfApplyResult,
  HtfChoices,
  HtfPreview,
  PledgeLeaderboard,
  ImportApplyResult,
  ImportApplyRow,
  ImportPreviewRow,
  Me,
  MemberSummary,
  ModelInfo,
  Ship,
  SlotOption,
  VehiclePositions,
  VehicleSlots,
  VehicleSummary,
} from './types';
import { parseDropped, type DroppedFitting } from '../lib/dropped';

export const API_PREFIX = '/api/v1';
/** Server-side upload cap (spec: <= 2 MB); checked client-side for a fast, clear error. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** Error body is always `{error, message, ...}` (hangar-service README). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;

  constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function isUnauthenticated(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

export function isUnavailable(e: unknown): boolean {
  return e instanceof ApiError && e.status === 503;
}

/** Full-page navigation target for "Sign in with Discord" (not a fetch). */
export function loginUrl(nextPath: string): string {
  return `/api/auth/login?next=${encodeURIComponent(nextPath || '/')}`;
}

interface RequestOptions {
  method?: string;
  json?: unknown;
  /** Raw body sent as `application/octet-stream` (wireframe upload). */
  raw?: BodyInit;
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.raw !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
    body = opts.raw;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', `Network error: ${(e as Error).message ?? e}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const code = typeof obj.error === 'string' ? obj.error : `http_${res.status}`;
    const message =
      typeof obj.message === 'string' && obj.message
        ? obj.message
        : `${res.status} ${res.statusText || 'request failed'}`;
    throw new ApiError(res.status, code, message, obj);
  }
  return data as T;
}

const enc = encodeURIComponent;
const member = (id: string) => `${API_PREFIX}/members/${enc(id)}`;

// ----- auth -----

export const getMe = () => request<Me>('/api/me');
export const logout = () => request<void>('/api/auth/logout', { method: 'POST' });

// ----- members / hangars -----

export async function listMembers(): Promise<MemberSummary[]> {
  const r = await request<{ members: MemberSummary[] }>(`${API_PREFIX}/members`);
  return r.members ?? [];
}

export const getHangar = (memberId: string) => request<Hangar>(`${member(memberId)}/hangar`);

export async function addShip(memberId: string, vehicle: string, nickname?: string | null): Promise<Ship> {
  const r = await request<{ ship: Ship }>(`${member(memberId)}/ships`, {
    method: 'POST',
    json: { vehicle, nickname: nickname || null },
  });
  return r.ship;
}

export async function renameShip(memberId: string, shipId: string, nickname: string | null): Promise<Ship> {
  const r = await request<{ ship: Ship }>(`${member(memberId)}/ships/${enc(shipId)}`, {
    method: 'PATCH',
    json: { nickname: nickname || null },
  });
  return r.ship;
}

export const deleteShip = (memberId: string, shipId: string) =>
  request<{ deleted: true; shipId: string }>(`${member(memberId)}/ships/${enc(shipId)}`, { method: 'DELETE' });

/**
 * Result of fitting or resetting one slot: the updated ship plus the child
 * fittings the server removed because the parent changed (`lib/dropped.ts`
 * knows that list's wire shape; empty when the server reports none).
 */
export interface SlotWrite {
  ship: Ship;
  dropped: DroppedFitting[];
}

/** Slot ids contain `/` for nested slots; `%2F`-encoded routes fine (README). */
export async function fitSlot(memberId: string, shipId: string, slot: string, item: string): Promise<SlotWrite> {
  const r = await request<{ ship: Ship }>(`${member(memberId)}/ships/${enc(shipId)}/slots/${enc(slot)}`, {
    method: 'PUT',
    json: { item },
  });
  return { ship: r.ship, dropped: parseDropped(r) };
}

export async function resetSlot(memberId: string, shipId: string, slot: string): Promise<SlotWrite> {
  const r = await request<{ ship: Ship }>(`${member(memberId)}/ships/${enc(shipId)}/slots/${enc(slot)}`, {
    method: 'DELETE',
  });
  return { ship: r.ship, dropped: parseDropped(r) };
}

// ----- catalog -----

export async function searchVehicles(q: string, signal?: AbortSignal): Promise<VehicleSummary[]> {
  const r = await request<{ vehicles: VehicleSummary[] }>(
    `${API_PREFIX}/catalog/vehicles?q=${enc(q)}&limit=25`,
    { signal },
  );
  return r.vehicles ?? [];
}

export const getVehicleSlots = (uuid: string) =>
  request<VehicleSlots>(`${API_PREFIX}/catalog/vehicles/${enc(uuid)}/slots`);

export const getVehiclePositions = (uuid: string) =>
  request<VehiclePositions>(`${API_PREFIX}/catalog/vehicles/${enc(uuid)}/positions`);

/**
 * A vehicle's wireframe bundle: the stored gzip bytes, served WITHOUT
 * `Content-Encoding` (decode with `lib/swf`). `null` when none is stored (404).
 * `cache: 'no-cache'` revalidates the browser's copy against the server's ETag
 * on every fetch, so a re-uploaded model never sits beside fresh positions.
 */
export async function getWireframe(uuid: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}/models/vehicle/${enc(uuid)}/wireframe`, {
      headers: { Accept: 'application/octet-stream' },
      credentials: 'same-origin',
      cache: 'no-cache',
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', `Network error: ${(e as Error).message ?? e}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    let obj: Record<string, unknown> = {};
    try {
      const data: unknown = JSON.parse(await res.text());
      if (data && typeof data === 'object') obj = data as Record<string, unknown>;
    } catch {
      /* not JSON (e.g. a gateway error page) */
    }
    const code = typeof obj.error === 'string' ? obj.error : `http_${res.status}`;
    const message =
      typeof obj.message === 'string' && obj.message ? obj.message : `${res.status} ${res.statusText || 'request failed'}`;
    throw new ApiError(res.status, code, message, obj);
  }
  return res.arrayBuffer();
}

/** Whole-ship reset. Response is the chat-edit shape (`{ship:{shipId,label}, changes}`), NOT a Ship. */
export const resetShip = (memberId: string, shipId: string) =>
  request<unknown>(`${member(memberId)}/ships/${enc(shipId)}/reset`, { method: 'POST', json: { slot: 'all' } });

const reportedImages = new Set<string>();

/** Fire-and-forget: tell the server an image failed to load. One report per URL per page load. */
export function reportImageError(url: string, context: string): void {
  if (reportedImages.has(url)) return;
  reportedImages.add(url);
  try {
    void fetch(`${API_PREFIX}/client-events/image-error`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, context }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let telemetry break the UI */
  }
}

/** The member's ship a slot is being edited on. */
export interface ShipRef {
  memberId: string;
  shipId: string;
}

/**
 * [Task 2] Compatible items for one slot. ASSUMPTION: response is
 * `{items: SlotOption[]}` (the spec gives the item shape, not the envelope);
 * a bare array is accepted too.
 *
 * With `ship` the request adds `member` + `ship`, and the server looks the slot
 * up in THAT ship's resolved slots — the only way to find a slot that belongs
 * to a fitted item (a turret's gun mounts are not ports of the stock vehicle).
 * Every picker opened from a ship page passes it; without it the lookup is the
 * stock vehicle's.
 */
export async function getSlotOptions(vehicleUuid: string, slot: string, ship?: ShipRef): Promise<SlotOption[]> {
  const scope = ship ? `&member=${enc(ship.memberId)}&ship=${enc(ship.shipId)}` : '';
  const r = await request<{ items: SlotOption[] } | SlotOption[]>(
    `${API_PREFIX}/catalog/slot-options?vehicle=${enc(vehicleUuid)}&slot=${enc(slot)}${scope}`,
  );
  return Array.isArray(r) ? r : (r.items ?? []);
}

/**
 * Query key for one slot's options. Member + ship come first so two ships of
 * one model never share an entry, and so `slotOptionsScope` can invalidate
 * every slot of a ship when its loadout changes (a refitted parent changes
 * what its children accept).
 */
export const slotOptionsKey = (vehicleUuid: string, slot: string | undefined, ship?: ShipRef) =>
  [...slotOptionsScope(ship), vehicleUuid, slot] as const;

export const slotOptionsScope = (ship?: ShipRef) =>
  ['slot-options', ship?.memberId ?? null, ship?.shipId ?? null] as const;

// ----- [Task 2] spviewer import -----

/**
 * ASSUMPTIONS (spec allows "multipart or JSON body"): the editor parses the
 * downloaded file itself and sends it as JSON `{file: <the parsed export array>}`;
 * `member` (admins importing for someone else) rides as a query parameter.
 * Response: `{rows: ImportPreviewRow[]}` (a bare array is accepted too).
 */
export async function importPreview(file: unknown, memberId?: string): Promise<ImportPreviewRow[]> {
  const q = memberId ? `?member=${enc(memberId)}` : '';
  const r = await request<{ rows: ImportPreviewRow[] } | ImportPreviewRow[]>(
    `${API_PREFIX}/import/spviewer/preview${q}`,
    { method: 'POST', json: { file } },
  );
  const rows = Array.isArray(r) ? r : (r.rows ?? []);
  return rows.map((row) => ({
    ...row,
    changes: row.changes ?? [],
    skipped: row.skipped ?? [],
    matchingShips: row.matchingShips ?? [],
  }));
}

/**
 * `{rows, file}` per spec; the server re-decodes `file` and never trusts
 * client-side changes. Response: "the updated ships" -> ASSUMED `{ships: Ship[]}`,
 * with optional `errors[]`; a bare array of ships is accepted too.
 */
export async function importApply(
  file: unknown,
  rows: ImportApplyRow[],
  memberId?: string,
): Promise<ImportApplyResult> {
  const q = memberId ? `?member=${enc(memberId)}` : '';
  const r = await request<Partial<ImportApplyResult> | Ship[]>(`${API_PREFIX}/import/spviewer/apply${q}`, {
    method: 'POST',
    json: { rows, file },
  });
  if (Array.isArray(r)) return { ships: r, errors: [] };
  return { ships: r.ships ?? [], errors: r.errors ?? [] };
}

// ----- HTF (HangarXPLOR) import -----

export async function htfPreview(file: unknown, memberId?: string): Promise<HtfPreview> {
  const q = memberId ? `?member=${enc(memberId)}` : '';
  const r = await request<Partial<HtfPreview>>(`${API_PREFIX}/import/htf/preview${q}`, {
    method: 'POST',
    json: { file },
  });
  return { rows: r.rows ?? [], missing: r.missing ?? [], partial: !!r.partial, ledgerPartial: !!r.ledgerPartial, summary: r.summary ?? {} };
}

export async function htfApply(file: unknown, choices: HtfChoices, memberId?: string): Promise<HtfApplyResult> {
  const q = memberId ? `?member=${enc(memberId)}` : '';
  const r = await request<Partial<HtfApplyResult>>(`${API_PREFIX}/import/htf/apply${q}`, {
    method: 'POST',
    json: { file, choices },
  });
  return { rows: r.rows ?? [], removed: r.removed ?? [], ledgerSynced: r.ledgerSynced !== false };
}

export const getPledgeLeaderboard = () => request<PledgeLeaderboard>(`${API_PREFIX}/pledges/leaderboard`);

// ----- admin: wireframe models -----

/** Server-side cap for one wireframe bundle (checked client-side too). */
export const MAX_MODEL_BYTES = 2 * 1024 * 1024;

export const uploadModel = (file: Blob) =>
  request<ModelInfo>(`${API_PREFIX}/models`, { method: 'POST', raw: file });

export async function listModels(): Promise<ModelInfo[]> {
  const r = await request<{ models: ModelInfo[] }>(`${API_PREFIX}/models`);
  return r.models ?? [];
}

export const deleteModel = (kind: string, className: string) =>
  request<void>(`${API_PREFIX}/models/${enc(kind)}/${enc(className)}`, { method: 'DELETE' });
