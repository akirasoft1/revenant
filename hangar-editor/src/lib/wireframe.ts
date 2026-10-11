// Pure helpers for the wireframe ship panel (no three.js: safe in the main bundle).

// ----- visual preference -----

export const VISUAL_PREF_KEY = 'hangar.shipVisual';
export type VisualPref = 'wireframe' | 'render';

function store(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Wireframe unless the browser remembers "render" (unreadable storage -> wireframe). */
export function loadVisualPref(storage?: Storage | null): VisualPref {
  try {
    return store(storage)?.getItem(VISUAL_PREF_KEY) === 'render' ? 'render' : 'wireframe';
  } catch {
    return 'wireframe';
  }
}

export function saveVisualPref(v: VisualPref, storage?: Storage | null): void {
  try {
    store(storage)?.setItem(VISUAL_PREF_KEY, v);
  } catch {
    /* ignore */
  }
}

// ----- capability checks -----

/** What this browser lacks for the viewer, or null when it can run. */
export function wireframeSupport(): 'webgl' | 'decompression' | null {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.WebGLRenderingContext === 'undefined') return 'webgl';
  if (typeof g.DecompressionStream === 'undefined') return 'decompression';
  return null;
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

// ----- camera framing -----

export type Vec3 = [number, number, number];

export interface Bounds {
  center: Vec3;
  radius: number;
}

/** Box centre of the vertices and the farthest vertex distance from it (a tight-enough bounding sphere). */
export function boundsOf(positions: ArrayLike<number>): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const n = positions.length - (positions.length % 3);
  const ok = (i: number) => Number.isFinite(positions[i]) && Number.isFinite(positions[i + 1]) && Number.isFinite(positions[i + 2]);
  let any = false;
  for (let i = 0; i < n; i += 3) {
    if (!ok(i)) continue;
    any = true;
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!any) return { center: [0, 0, 0], radius: 1 };
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let r2 = 0;
  for (let i = 0; i < n; i += 3) {
    if (!ok(i)) continue;
    const dx = positions[i] - center[0];
    const dy = positions[i + 1] - center[1];
    const dz = positions[i + 2] - center[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  return { center, radius: r2 > 0 ? Math.sqrt(r2) : 1 };
}

/**
 * Camera distance at which a sphere of `radius` fits the view, whatever the
 * panel's shape: the tighter of the vertical and horizontal fields of view decides.
 */
export function fitDistance(radius: number, vfovDeg: number, aspect: number, margin = 1.08): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const half = (vfovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(half) * a);
  return (Math.max(radius, 1e-6) / Math.sin(Math.min(half, halfH))) * margin;
}

/** Marker sphere radius, relative to ship size (0.29 m on a Vanguard, the approved look). */
export function markerRadius(radius: number): number {
  return Math.max(radius, 0.5) * 0.014;
}

/**
 * Camera distance from `target` at which every vertex stays in view for EVERY
 * yaw of an orbit at `elevationRad` (the viewer auto-rotates about the Y axis),
 * on a panel of the given shape. Exact per vertex and yaw step — much tighter
 * than a bounding sphere for a long, flat ship on a wide panel. Large
 * wireframes are subsampled (`maxSamples` vertices).
 */
export function orbitFitDistance(
  positions: ArrayLike<number>,
  target: Vec3,
  elevationRad: number,
  vfovDeg: number,
  aspect: number,
  margin = 1.08,
  yawSteps = 24,
  maxSamples = 6000,
): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const tanV = Math.tan((vfovDeg * Math.PI) / 360);
  const tanH = tanV * a;
  const count = Math.floor(positions.length / 3);
  const stride = Math.max(1, Math.ceil(count / maxSamples));
  const sinE = Math.sin(elevationRad);
  const cosE = Math.cos(elevationRad);
  let best = 0;
  let any = false;
  for (let step = 0; step < yawSteps; step++) {
    const yaw = (step / yawSteps) * Math.PI * 2;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    // Camera basis for this yaw: `dir` points from the target to the camera.
    const dx = cosE * s, dy = sinE, dz = cosE * c;
    const rx = c, rz = -s;
    const ux = -sinE * s, uy = cosE, uz = -sinE * c;
    for (let i = 0; i < count; i += stride) {
      const px = positions[i * 3] - target[0];
      const py = positions[i * 3 + 1] - target[1];
      const pz = positions[i * 3 + 2] - target[2];
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
      any = true;
      const depth = px * dx + py * dy + pz * dz;
      const d = depth + Math.max(Math.abs(px * rx + pz * rz) / tanH, Math.abs(px * ux + py * uy + pz * uz) / tanV);
      if (d > best) best = d;
    }
  }
  if (!any || !(best > 0)) return fitDistance(any ? 1e-3 : 1, vfovDeg, a, margin);
  return best * margin;
}

// ----- render on demand -----

export interface FrameState {
  /** On screen (IntersectionObserver) in a visible document. */
  visible: boolean;
  /** The canvas has a non-zero size. */
  sized: boolean;
  /** Something changed since the last draw: camera, markers, selection, hover, size. */
  dirty: boolean;
  autoRotate: boolean;
  /** The view is easing toward a selected port. */
  easing: boolean;
  /** A selected marker is pulsing (never with reduced motion). */
  pulsing: boolean;
}

/**
 * Whether the viewer should draw another frame. A still wireframe costs nothing:
 * frames are drawn only while something moves or after a change, and never when
 * the canvas cannot be seen.
 */
export function needsFrame(s: FrameState): boolean {
  if (!s.visible || !s.sized) return false;
  return s.dirty || s.autoRotate || s.easing || s.pulsing;
}

// ----- bundle query -----

const DAY_MS = 24 * 60 * 60_000;

/** A stored bundle is fresh for a day (the ETag revalidates it anyway); "none stored" only for 30 s. */
export function wireframeStaleTime(data: ArrayBuffer | null | undefined): number {
  return data ? DAY_MS : 30_000;
}

/** Same bytes? Lets a refetch that returned an unchanged bundle keep the old buffer (and the live viewer). */
export function sameBytes(a: ArrayBuffer | null | undefined, b: ArrayBuffer | null | undefined): boolean {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  if (a === b) return true;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
