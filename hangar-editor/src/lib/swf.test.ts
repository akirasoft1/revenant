import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { SwfError, decodeBundle, type SwfHeader } from './swf';

const HEADER: SwfHeader = {
  format: 1,
  kind: 'vehicle',
  className: 'TEST_Box',
  sourceName: 'box.glb',
  space: 'gltf-y-up-m',
  center: [10, -2, 0.5],
  halfExtent: 4,
  lines: 2,
  nodes: [{ name: 'hardpoint_a', parent: -1, pos: [1, 2, 3] }],
  build: { creaseDeg: 60, minEdgeFrac: 0.0025, maxLines: 60000, visibility: true, depthRes: 640, tool: 'wireframes/test' },
};

/** Raw (un-gzipped) bundle bytes. `pad` shifts the payload to an odd offset. */
function rawBundle(header: object, values: number[], opts: { magic?: string; pad?: boolean; headerLen?: number } = {}): Uint8Array {
  let json = JSON.stringify(header);
  if (opts.pad && (8 + new TextEncoder().encode(json).length) % 2 === 0) json += ' ';
  const head = new TextEncoder().encode(json);
  const out = new Uint8Array(8 + head.length + values.length * 2);
  out.set(new TextEncoder().encode(opts.magic ?? 'SWF1'), 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, opts.headerLen ?? head.length, true);
  out.set(head, 8);
  values.forEach((v, i) => dv.setInt16(8 + head.length + i * 2, v, true));
  return out;
}

const gz = (raw: Uint8Array): ArrayBuffer => {
  const b = gzipSync(raw);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const VALUES = [32767, 0, -32767, 0, 16384, 0, -32767, -32767, -32767, 32767, 32767, 32767];

describe('decodeBundle', () => {
  it('round-trips header and dequantised positions (center + int16/32767 * halfExtent)', async () => {
    const { header, positions } = await decodeBundle(gz(rawBundle(HEADER, VALUES)));
    expect(header).toEqual(HEADER);
    expect(positions).toBeInstanceOf(Float32Array);
    expect(positions).toHaveLength(12);
    const want = VALUES.map((v, i) => HEADER.center[i % 3] + (v / 32767) * HEADER.halfExtent);
    want.forEach((w, i) => expect(positions[i]).toBeCloseTo(w, 4));
    expect(positions[0]).toBeCloseTo(14, 4);
    expect(positions[2]).toBeCloseTo(-3.5, 4);
  });

  it('reads a payload that starts at an odd byte offset', async () => {
    const { positions } = await decodeBundle(gz(rawBundle(HEADER, VALUES, { pad: true })));
    expect(positions[0]).toBeCloseTo(14, 4);
    expect(positions[11]).toBeCloseTo(4.5, 4);
  });

  it('accepts an empty wireframe', async () => {
    const { positions } = await decodeBundle(gz(rawBundle({ ...HEADER, lines: 0 }, [])));
    expect(positions).toHaveLength(0);
  });

  it('rejects bad magic', async () => {
    await expect(decodeBundle(gz(rawBundle(HEADER, VALUES, { magic: 'NOPE' })))).rejects.toThrow(/magic/i);
    await expect(decodeBundle(gz(rawBundle(HEADER, VALUES, { magic: 'NOPE' })))).rejects.toBeInstanceOf(SwfError);
  });

  it('rejects data that is not gzip', async () => {
    const raw = rawBundle(HEADER, VALUES);
    await expect(decodeBundle(raw.buffer.slice(0) as ArrayBuffer)).rejects.toBeInstanceOf(SwfError);
  });

  it('rejects a truncated gzip stream', async () => {
    const whole = new Uint8Array(gz(rawBundle(HEADER, VALUES)));
    await expect(decodeBundle(whole.slice(0, whole.length - 12).buffer as ArrayBuffer)).rejects.toBeInstanceOf(SwfError);
  });

  it('rejects a header length past the end, bad JSON and a bad header', async () => {
    await expect(decodeBundle(gz(rawBundle(HEADER, VALUES, { headerLen: 1_000_000 })))).rejects.toThrow(/header/i);
    const junk = new Uint8Array([0x53, 0x57, 0x46, 0x31, 2, 0, 0, 0, 0x7b, 0x7b]);
    await expect(decodeBundle(gz(junk))).rejects.toThrow(/JSON/);
    await expect(decodeBundle(gz(rawBundle({ ...HEADER, format: 2 }, VALUES)))).rejects.toThrow(/format/);
    await expect(decodeBundle(gz(rawBundle({ ...HEADER, halfExtent: 0 }, VALUES)))).rejects.toThrow(/halfExtent/);
    await expect(decodeBundle(gz(rawBundle({ ...HEADER, center: [0, 1] }, VALUES)))).rejects.toThrow(/center/);
    await expect(decodeBundle(gz(rawBundle({ ...HEADER, lines: -1 }, VALUES)))).rejects.toThrow(/lines/);
  });

  it('rejects a payload whose size does not match lines', async () => {
    await expect(decodeBundle(gz(rawBundle({ ...HEADER, lines: 3 }, VALUES)))).rejects.toThrow(/payload/);
    await expect(decodeBundle(gz(rawBundle(HEADER, VALUES.slice(0, 11))))).rejects.toThrow(/payload/);
  });

  it('rejects when DecompressionStream is missing', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    await expect(decodeBundle(gz(rawBundle(HEADER, VALUES)))).rejects.toThrow(/DecompressionStream/);
  });

  /** A bundle with per-view visibility: lines, then one uint32 per line. */
  function viewsBundle(views: unknown, masks: number[], values = VALUES): Uint8Array {
    const base = rawBundle({ ...HEADER, views }, values);
    const out = new Uint8Array(base.length + masks.length * 4);
    out.set(base, 0);
    const dv = new DataView(out.buffer);
    masks.forEach((m, i) => dv.setUint32(base.length + i * 4, m, true));
    return out;
  }

  it('reads per-view visibility: the views and one uint32 mask per line', async () => {
    const views = [[1, 0, 0], [0, -1, 0], [0, 0, 1]];
    const d = await decodeBundle(gz(viewsBundle(views, [0b101, 0x80000001])));
    expect(d.positions).toHaveLength(12);
    expect(Array.from(d.visibility!.views)).toEqual(views.flat());
    expect(d.visibility!.masks).toBeInstanceOf(Uint32Array);
    expect(Array.from(d.visibility!.masks)).toEqual([0b101, 0x80000001]);
  });

  it('a bundle without views has no visibility', async () => {
    expect((await decodeBundle(gz(rawBundle(HEADER, VALUES)))).visibility).toBeUndefined();
  });

  it('rejects a views bundle without its masks, and masks without views', async () => {
    await expect(decodeBundle(gz(viewsBundle([[1, 0, 0]], [])))).rejects.toThrow(/payload is 24 bytes but lines=2 needs 32/);
    const extra = new Uint8Array(rawBundle(HEADER, VALUES).length + 8);
    extra.set(rawBundle(HEADER, VALUES), 0);
    await expect(decodeBundle(gz(extra))).rejects.toThrow(/needs 24/);
  });

  it('rejects malformed views', async () => {
    for (const bad of [[], 'x', [[1, 0]], [[1, 0, 'a']], Array.from({ length: 33 }, () => [1, 0, 0]), { a: 1 }]) {
      await expect(decodeBundle(gz(viewsBundle(bad, [1, 1])))).rejects.toThrow(/views must be/);
    }
  });
});
