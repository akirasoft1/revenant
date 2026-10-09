// The ONLY module that knows hangar-service URLs and wire shapes. Same origin
// as the SPA (served by hangar-service at https://hangar.aklabs.io), so plain
// `fetch` with the session cookie; the browser adds `Origin` to writes, which
// the service's CSRF check requires.
import type {
  Hangar,
  ImportApplyResult,
  ImportApplyRow,
  ImportPreviewRow,
  Me,
  MemberSummary,
  Ship,
  SlotOption,
  VehicleSlots,
  VehicleSummary,
} from './types';

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
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
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

/** Slot ids contain `/` for nested slots; `%2F`-encoded routes fine (README). */
export async function fitSlot(memberId: string, shipId: string, slot: string, item: string): Promise<Ship> {
  const r = await request<{ ship: Ship }>(`${member(memberId)}/ships/${enc(shipId)}/slots/${enc(slot)}`, {
    method: 'PUT',
    json: { item },
  });
  return r.ship;
}

export async function resetSlot(memberId: string, shipId: string, slot: string): Promise<Ship> {
  const r = await request<{ ship: Ship }>(`${member(memberId)}/ships/${enc(shipId)}/slots/${enc(slot)}`, {
    method: 'DELETE',
  });
  return r.ship;
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

/**
 * [Task 2] Compatible items for one slot. ASSUMPTION: response is
 * `{items: SlotOption[]}` (the spec gives the item shape, not the envelope);
 * a bare array is accepted too.
 */
export async function getSlotOptions(vehicleUuid: string, slot: string): Promise<SlotOption[]> {
  const r = await request<{ items: SlotOption[] } | SlotOption[]>(
    `${API_PREFIX}/catalog/slot-options?vehicle=${enc(vehicleUuid)}&slot=${enc(slot)}`,
  );
  return Array.isArray(r) ? r : (r.items ?? []);
}

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
