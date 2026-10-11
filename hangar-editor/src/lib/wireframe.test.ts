import { describe, expect, it, vi } from 'vitest';
import {
  VISUAL_PREF_KEY,
  boundsOf,
  fitDistance,
  loadVisualPref,
  markerRadius,
  orbitFitDistance,
  prefersReducedMotion,
  saveVisualPref,
  viewInset,
  wireframeSupport,
} from './wireframe';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
} as unknown as Storage;

describe('visual preference', () => {
  it('uses the key hangar.shipVisual', () => {
    expect(VISUAL_PREF_KEY).toBe('hangar.shipVisual');
  });

  it('defaults to wireframe; only "render" selects the render', () => {
    expect(loadVisualPref(fakeStorage())).toBe('wireframe');
    expect(loadVisualPref(fakeStorage({ [VISUAL_PREF_KEY]: 'render' }))).toBe('render');
    expect(loadVisualPref(fakeStorage({ [VISUAL_PREF_KEY]: 'junk' }))).toBe('wireframe');
    expect(loadVisualPref(null)).toBe('wireframe');
  });

  it('round-trips and survives a throwing storage', () => {
    const s = fakeStorage();
    saveVisualPref('render', s);
    expect(s.getItem(VISUAL_PREF_KEY)).toBe('render');
    expect(loadVisualPref(s)).toBe('render');
    saveVisualPref('wireframe', s);
    expect(loadVisualPref(s)).toBe('wireframe');
    expect(loadVisualPref(throwing)).toBe('wireframe');
    expect(() => saveVisualPref('render', throwing)).not.toThrow();
  });
});

describe('wireframeSupport', () => {
  it('names the missing capability, or null when both exist', () => {
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {});
    vi.stubGlobal('DecompressionStream', function DecompressionStream() {});
    expect(wireframeSupport()).toBeNull();
    vi.stubGlobal('WebGLRenderingContext', undefined);
    expect(wireframeSupport()).toBe('webgl');
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {});
    vi.stubGlobal('DecompressionStream', undefined);
    expect(wireframeSupport()).toBe('decompression');
  });
});

describe('prefersReducedMotion', () => {
  it('reads the media query and is false without matchMedia', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('boundsOf', () => {
  it('is the box centre and the farthest vertex distance from it', () => {
    const b = boundsOf(new Float32Array([-10, 0, 0, 30, 0, 0, 10, 4, -2, 10, -4, 2]));
    expect(b.center).toEqual([10, 0, 0]);
    expect(b.radius).toBeCloseTo(20, 5);
  });

  it('ignores non-finite values and never returns a zero radius', () => {
    const b = boundsOf(new Float32Array([1, 1, 1, NaN, 0, 0, 1, 1, 1]));
    expect(b.center).toEqual([1, 1, 1]);
    expect(b.radius).toBeGreaterThan(0);
    expect(boundsOf(new Float32Array(0))).toEqual({ center: [0, 0, 0], radius: 1 });
  });
});

describe('fitDistance', () => {
  it('fits the bounding sphere inside the vertical field of view on a wide panel', () => {
    const d = fitDistance(10, 35, 2, 1);
    expect(d).toBeCloseTo(10 / Math.sin((35 * Math.PI) / 360), 5);
  });

  it('uses the horizontal field of view when the panel is narrower than tall', () => {
    const wide = fitDistance(10, 35, 2, 1);
    const tall = fitDistance(10, 35, 0.5, 1);
    expect(tall).toBeGreaterThan(wide);
    const hfov = 2 * Math.atan(Math.tan((35 * Math.PI) / 360) * 0.5);
    expect(tall).toBeCloseTo(10 / Math.sin(hfov / 2), 5);
  });

  it('scales with ship size and margin, and tolerates a bad aspect', () => {
    expect(fitDistance(100, 35, 2, 1)).toBeCloseTo(fitDistance(10, 35, 2, 1) * 10, 4);
    expect(fitDistance(10, 35, 2, 1.2)).toBeCloseTo(fitDistance(10, 35, 2, 1) * 1.2, 5);
    expect(Number.isFinite(fitDistance(10, 35, 0))).toBe(true);
    expect(Number.isFinite(fitDistance(10, 35, NaN))).toBe(true);
  });
});

describe('markerRadius', () => {
  it('is proportional to the ship radius', () => {
    expect(markerRadius(20)).toBeCloseTo(markerRadius(10) * 2, 6);
    // The approved spike: 0.29 m spheres on a ~21 m radius ship.
    expect(markerRadius(20.8)).toBeCloseTo(0.29, 1);
    expect(markerRadius(0)).toBeGreaterThan(0);
  });
});

describe('orbitFitDistance', () => {
  const f32 = (...v: number[]) => new Float32Array(v);

  it('keeps a wide ship inside the horizontal field of view at every yaw of the orbit', () => {
    // fov 90 on a square panel: tan(half) = 1 on both axes. Two points 10 m either
    // side of the target need d = 10 broadside-on and 10*sqrt(2) at 45 degrees.
    const d = orbitFitDistance(f32(-10, 0, 0, 10, 0, 0), [0, 0, 0], 0, 90, 1, 1);
    expect(d).toBeCloseTo(10 * Math.SQRT2, 3);
  });

  it('a tall ship is limited by the vertical field of view, whatever the panel width', () => {
    const d = orbitFitDistance(f32(0, -5, 0, 0, 5, 0), [0, 0, 0], 0, 90, 3, 1);
    expect(d).toBeCloseTo(5, 4);
  });

  it('a wider panel lets a long ship sit closer', () => {
    const pts = f32(0, 0, -20, 0, 0, 20, 2, 1, 0, -2, -1, 0);
    const square = orbitFitDistance(pts, [0, 0, 0], 0.34, 35, 1, 1);
    const wide = orbitFitDistance(pts, [0, 0, 0], 0.34, 35, 2, 1);
    expect(wide).toBeLessThan(square);
    // Tighter than the bounding-sphere fit for a long thin ship on a wide panel.
    expect(wide).toBeLessThan(fitDistance(boundsOf(pts).radius, 35, 2, 1));
  });

  it('measures from the orbit target, scales with size and margin', () => {
    const a = orbitFitDistance(f32(-10, 0, 0, 10, 0, 0), [0, 0, 0], 0.3, 35, 1.8, 1);
    expect(orbitFitDistance(f32(90, 7, 3, 110, 7, 3), [100, 7, 3], 0.3, 35, 1.8, 1)).toBeCloseTo(a, 3);
    expect(orbitFitDistance(f32(-100, 0, 0, 100, 0, 0), [0, 0, 0], 0.3, 35, 1.8, 1)).toBeCloseTo(a * 10, 2);
    expect(orbitFitDistance(f32(-10, 0, 0, 10, 0, 0), [0, 0, 0], 0.3, 35, 1.8, 1.25)).toBeCloseTo(a * 1.25, 3);
  });

  it('subsampling a large wireframe stays close to the exact answer', () => {
    const n = 40_000;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      pts[i * 3] = Math.cos(t) * 8;
      pts[i * 3 + 1] = Math.sin(t * 3) * 2;
      pts[i * 3 + 2] = Math.sin(t) * 30;
    }
    const exact = orbitFitDistance(pts, [0, 0, 0], 0.34, 35, 1.8, 1, 24, Infinity);
    const sampled = orbitFitDistance(pts, [0, 0, 0], 0.34, 35, 1.8, 1);
    expect(Math.abs(sampled - exact) / exact).toBeLessThan(0.01);
  });

  it('falls back to the bounding-sphere fit when there is nothing to measure', () => {
    expect(orbitFitDistance(f32(), [0, 0, 0], 0.3, 35, 2, 1)).toBeCloseTo(fitDistance(1, 35, 2, 1), 5);
    expect(orbitFitDistance(f32(NaN, 0, 0), [0, 0, 0], 0.3, 35, 2, 1)).toBeCloseTo(fitDistance(1, 35, 2, 1), 5);
    expect(orbitFitDistance(f32(3, 3, 3), [3, 3, 3], 0.3, 35, 2, 1)).toBeGreaterThan(0);
  });
});

describe('viewInset', () => {
  it('centres the ship in the part of the panel the stats overlay leaves free', () => {
    // 500 px panel, 150 px covered on the right: frame for 350 px, shift the view 75 px left.
    expect(viewInset(500, 150)).toEqual({ freeWidth: 350, shift: 75 });
    expect(viewInset(500, 0)).toEqual({ freeWidth: 500, shift: 0 });
  });

  it('never gives up more than 40% of the panel, and ignores junk', () => {
    expect(viewInset(300, 200)).toEqual({ freeWidth: 180, shift: 60 });
    expect(viewInset(300, -5)).toEqual({ freeWidth: 300, shift: 0 });
    expect(viewInset(300, NaN)).toEqual({ freeWidth: 300, shift: 0 });
    expect(viewInset(0, 50)).toEqual({ freeWidth: 0, shift: 0 });
  });
});
