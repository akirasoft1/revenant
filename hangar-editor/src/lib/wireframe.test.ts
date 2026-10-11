import { describe, expect, it, vi } from 'vitest';
import {
  VISUAL_PREF_KEY,
  boundsOf,
  HIDDEN_LINE_ALPHA,
  MAX_LINES_PER_PX,
  blendViews,
  writeLineAlpha,
  MIN_LOD_LINES,
  fitDistance,
  lineCountAtLeast,
  lodLineCount,
  loadVisualPref,
  markerRadius,
  orbitFitDistance,
  prefersReducedMotion,
  needsFrame,
  sameBytes,
  sortedLineLengths,
  worldPerPixel,
  saveVisualPref,
  wireframeStaleTime,
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

describe('needsFrame', () => {
  const idle = { visible: true, sized: true, dirty: false, autoRotate: false, easing: false, pulsing: false };

  it('draws nothing while nothing changes', () => {
    expect(needsFrame(idle)).toBe(false);
  });

  it.each(['dirty', 'autoRotate', 'easing', 'pulsing'] as const)('draws while %s', (k) => {
    expect(needsFrame({ ...idle, [k]: true })).toBe(true);
  });

  it('never draws off-screen, in a hidden document or with no size, whatever is animating', () => {
    const busy = { ...idle, dirty: true, autoRotate: true, easing: true, pulsing: true };
    expect(needsFrame(busy)).toBe(true);
    expect(needsFrame({ ...busy, visible: false })).toBe(false);
    expect(needsFrame({ ...busy, sized: false })).toBe(false);
  });
});

describe('sameBytes', () => {
  const buf = (...v: number[]) => new Uint8Array(v).buffer;

  it('compares content, not identity', () => {
    expect(sameBytes(buf(1, 2, 3), buf(1, 2, 3))).toBe(true);
    expect(sameBytes(buf(1, 2, 3), buf(1, 2, 4))).toBe(false);
    expect(sameBytes(buf(1, 2, 3), buf(1, 2))).toBe(false);
    expect(sameBytes(buf(), buf())).toBe(true);
  });

  it('is false when either side is missing', () => {
    expect(sameBytes(null, buf(1))).toBe(false);
    expect(sameBytes(buf(1), undefined)).toBe(false);
    expect(sameBytes(null, null)).toBe(false);
  });
});

describe('wireframeStaleTime', () => {
  it('keeps a stored bundle fresh for a day, but a 404 (or nothing yet) only briefly', () => {
    expect(wireframeStaleTime(new ArrayBuffer(4))).toBe(24 * 60 * 60_000);
    expect(wireframeStaleTime(null)).toBe(30_000);
    expect(wireframeStaleTime(undefined)).toBe(30_000);
  });
});

describe('level of detail', () => {
  /** Lines along X with the given lengths, in the given order. */
  const linesOf = (lengths: number[]) => {
    const p = new Float32Array(lengths.length * 6);
    lengths.forEach((l, i) => {
      p[i * 6 + 1] = i;
      p[i * 6 + 3] = l;
      p[i * 6 + 4] = i;
    });
    return p;
  };

  it('sortedLineLengths: a longest-first bundle gives its lengths', () => {
    expect(Array.from(sortedLineLengths(linesOf([8, 4, 2, 1]))!)).toEqual([8, 4, 2, 1]);
  });

  it('sortedLineLengths: quantisation jitter between near-equal neighbours is absorbed (stays non-increasing)', () => {
    const got = Array.from(sortedLineLengths(linesOf([8, 4, 4.1, 2]))!);
    expect(got[0]).toBe(8);
    expect(got[1]).toBe(4);
    expect(got[2]).toBe(4);
    expect(got[3]).toBe(2);
  });

  it('sortedLineLengths: a bundle in some other order is not thinned (null)', () => {
    expect(sortedLineLengths(linesOf([1, 8, 2, 9, 3, 7]))).toBeNull();
  });

  it('sortedLineLengths: no lines -> empty', () => {
    expect(sortedLineLengths(new Float32Array(0))).toHaveLength(0);
  });

  it('lineCountAtLeast counts the leading lines at or above the threshold', () => {
    const l = [8, 4, 4, 2, 1];
    expect(lineCountAtLeast(l, 100)).toBe(0);
    expect(lineCountAtLeast(l, 4)).toBe(3);
    expect(lineCountAtLeast(l, 3)).toBe(3);
    expect(lineCountAtLeast(l, 1)).toBe(5);
    expect(lineCountAtLeast(l, 0)).toBe(5);
    expect(lineCountAtLeast([], 1)).toBe(0);
  });

  it('worldPerPixel: view height at the distance divided by the pixel height; 0 when unsized', () => {
    expect(worldPerPixel(10, 90, 100)).toBeCloseTo(0.2, 6);
    expect(worldPerPixel(10, 90, 0)).toBe(0);
    expect(worldPerPixel(0, 90, 100)).toBe(0);
  });

  it('lodLineCount: far away drops the short lines, close up draws them all, and a floor is kept', () => {
    const lengths = new Float32Array(MIN_LOD_LINES * 4);
    for (let i = 0; i < lengths.length; i++) lengths[i] = i < MIN_LOD_LINES * 2 ? 10 : 0.01;
    // fov 90, 100 px tall: 1 px = dist / 50 world units; lines under 2 px are skipped.
    const big = 1e9; // a radius so large the density cap never bites
    expect(lodLineCount(lengths, 1, 90, 100, big)).toBe(MIN_LOD_LINES * 2); // 2 px = 0.04 > 0.01
    expect(lodLineCount(lengths, 0.1, 90, 100, big)).toBe(lengths.length); // 2 px = 0.004
    expect(lodLineCount(lengths, 10_000, 90, 100, big)).toBe(MIN_LOD_LINES); // nothing is 2 px long: the floor
    expect(lodLineCount(lengths, 1, 90, 0, big)).toBe(lengths.length); // unsized: no thinning
    expect(lodLineCount([5, 4], 10_000, 90, 100, big)).toBe(2); // fewer lines than the floor
  });

  it('lodLineCount: a dense ship drawn small is capped per pixel of its on-screen size', () => {
    const lengths = new Float32Array(60_000).fill(10); // every line long enough
    // fov 90, 100 px tall, distance 50: 1 px = 1 world unit.
    expect(lodLineCount(lengths, 50, 90, 100, 125)).toBe(250 * MAX_LINES_PER_PX); // 250 px across
    expect(lodLineCount(lengths, 50, 90, 100, 750)).toBe(60_000); // 1500 px across: everything
    expect(lodLineCount(lengths, 50, 90, 100, 1)).toBe(MIN_LOD_LINES); // a speck: the floor
    expect(lodLineCount(lengths, 50, 90, 100, 0)).toBe(60_000); // unknown size: no cap
    // With hidden-line data the per-pixel cap is off: most lines are hidden for any one view anyway.
    expect(lodLineCount(lengths, 50, 90, 100, 125, false)).toBe(60_000);
    expect(lodLineCount(lengths, 50, 90, 100, 1, false)).toBe(60_000);
  });
});

describe('hidden-line removal', () => {
  const norm = (v: number[]) => {
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
  };
  // +x, +y, -x and the diagonal between +x and +y
  const VIEWS = [1, 0, 0, 0, 1, 0, -1, 0, 0, ...norm([1, 1, 0])];

  it('blendViews: looking straight down a baked view uses it at full weight; far views drop out', () => {
    const b = blendViews(VIEWS, [1, 0, 0]);
    expect(b.bits[0]).toBe(1);
    expect(b.weights[0]).toBe(1);
    expect(b.bits).not.toContain(2); // +y is 90 degrees away
    expect(b.bits).not.toContain(4); // -x is behind
    expect(b.bits).not.toContain(8); // the diagonal is 45 degrees away: past the cut-off
  });

  it('blendViews: between two views both contribute, the nearer one more, and the best is always 1', () => {
    const a = (30 * Math.PI) / 180; // 30 degrees from +x toward +y: 15 from the diagonal
    const b = blendViews(VIEWS, [Math.cos(a), Math.sin(a), 0]);
    const w = Object.fromEntries(b.bits.map((bit, i) => [bit, b.weights[i]]));
    expect(w[8]).toBe(1);
    expect(w[1]).toBeGreaterThan(0);
    expect(w[1]).toBeLessThan(1);
    expect(w[2]).toBeUndefined();
  });

  it('blendViews: when no view is close enough the nearest one is used alone', () => {
    expect(blendViews([1, 0, 0, -1, 0, 0], [0, 1, 0.001])).toEqual({ bits: [1], weights: [1] });
    expect(blendViews([], [1, 0, 0])).toEqual({ bits: [], weights: [] });
  });

  it('blendViews: bit 31 is usable (unsigned)', () => {
    const views = new Float32Array(32 * 3);
    views[31 * 3] = 1; // only view 31 points along +x; the rest are zero vectors
    const b = blendViews(views, [1, 0, 0]);
    expect(b.bits).toEqual([2 ** 31]);
    const rgba = new Uint8Array(16).fill(255);
    writeLineAlpha(rgba, new Uint32Array([0x80000000, 0x7fffffff]), b);
    expect([rgba[3], rgba[7], rgba[11], rgba[15]]).toEqual([255, 255, HIDDEN_LINE_ALPHA, HIDDEN_LINE_ALPHA]);
  });

  it('writeLineAlpha: a line gets the largest weight among the views that see it; unseen lines keep a faint ghost', () => {
    const rgba = new Uint8Array(4 * 8).fill(200);
    const masks = new Uint32Array([0b01, 0b10, 0b11, 0b100]);
    writeLineAlpha(rgba, masks, { bits: [1, 2], weights: [0.5, 1] });
    const alpha = [0, 1, 2, 3].map((l) => [rgba[l * 8 + 3], rgba[l * 8 + 7]]);
    expect(alpha).toEqual([
      [128, 128],
      [255, 255],
      [255, 255],
      [HIDDEN_LINE_ALPHA, HIDDEN_LINE_ALPHA],
    ]);
    // colour bytes are left alone
    expect(rgba[0]).toBe(200);
    expect(rgba[4]).toBe(200);
  });

  it('writeLineAlpha: no active view leaves every line a ghost, and short buffers are not overrun', () => {
    const rgba = new Uint8Array(8).fill(255);
    writeLineAlpha(rgba, new Uint32Array([1, 1, 1]), { bits: [], weights: [] });
    expect([rgba[3], rgba[7]]).toEqual([HIDDEN_LINE_ALPHA, HIDDEN_LINE_ALPHA]);
  });
});
