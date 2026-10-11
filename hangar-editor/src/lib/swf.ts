// Wireframe bundle (`.swf.gz`) decoding. Format (hangar-service `src/swf.py`,
// written by `tools/wireframes`): gzip of `SWF1` + uint32 LE header length +
// header JSON (UTF-8) + int16 LE x `lines * 6`. A value v on axis a is the
// coordinate `center[a] + v / 32767 * halfExtent` (glTF Y-up, metres).
// Optional hidden-line data: when the header has `views` (1-32 unit vectors
// pointing from the ship toward a viewer), uint32 LE x `lines` follows the
// lines; bit i of a line's value = that line can be seen from views[i].
// No three.js here: this module is safe to import from the main bundle.

export interface SwfNode {
  name: string;
  parent: number;
  pos: [number, number, number];
}

export interface SwfHeader {
  format: 1;
  kind: string;
  className: string;
  sourceName: string;
  space: string;
  center: [number, number, number];
  halfExtent: number;
  lines: number;
  nodes: SwfNode[];
  build: Record<string, unknown>;
  /** Unit vectors toward the baked viewers; present only with per-line visibility masks. */
  views?: [number, number, number][];
}

export interface DecodedBundle {
  header: SwfHeader;
  /** `lines * 6` floats: x,y,z of each segment's two ends, in the bundle's own space. */
  positions: Float32Array;
  /** Per-view visibility for hidden-line removal; absent in bundles built without it. */
  visibility?: {
    /** `n * 3` floats: the header's `views`. */
    views: Float32Array;
    /** One per line: bit i set = visible from view i. */
    masks: Uint32Array;
  };
}

/** The bundle is malformed (or cannot be read in this browser); the message names the problem. */
export class SwfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwfError';
  }
}

/** Same ceiling as the server's upload validation. */
export const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAGIC = [0x53, 0x57, 0x46, 0x31]; // "SWF1"

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') throw new SwfError('DecompressionStream is not available in this browser');
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  // A bad stream rejects the write side too; the read side reports it.
  const written = writer
    .write(new Uint8Array(buf))
    .then(() => writer.close())
    .catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DECOMPRESSED_BYTES) {
        void reader.cancel().catch(() => {});
        throw new SwfError(`decompressed size is over the ${MAX_DECOMPRESSED_BYTES / (1024 * 1024)} MB limit`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof SwfError) throw e;
    throw new SwfError(`not a valid gzip stream: ${(e as Error)?.message ?? e}`);
  } finally {
    await written;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function parseHeader(json: string): SwfHeader {
  let h: unknown;
  try {
    h = JSON.parse(json);
  } catch {
    throw new SwfError('header is not valid JSON');
  }
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw new SwfError('header must be a JSON object');
  const o = h as Record<string, unknown>;
  if (o.format !== 1) throw new SwfError(`format must be 1, got ${JSON.stringify(o.format)}`);
  const c = o.center;
  if (!Array.isArray(c) || c.length !== 3 || !c.every(finite)) throw new SwfError('center must be three numbers');
  if (!finite(o.halfExtent) || o.halfExtent <= 0) throw new SwfError('halfExtent must be a positive number');
  if (!Number.isInteger(o.lines) || (o.lines as number) < 0) throw new SwfError('lines must be a non-negative integer');
  if (o.views !== undefined) {
    const v = o.views;
    const ok = Array.isArray(v) && v.length >= 1 && v.length <= 32 && v.every((d) => Array.isArray(d) && d.length === 3 && d.every(finite));
    if (!ok) throw new SwfError('views must be 1 to 32 [x, y, z] vectors');
  }
  return h as SwfHeader;
}

/** Gunzip, validate and dequantise a bundle. Rejects with `SwfError` on any malformed input. */
export async function decodeBundle(buf: ArrayBuffer): Promise<DecodedBundle> {
  const raw = await gunzip(buf);
  if (raw.length < 8) throw new SwfError('truncated header');
  if (!MAGIC.every((b, i) => raw[i] === b)) throw new SwfError('bad magic: expected SWF1');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLen = view.getUint32(4, true);
  const start = 8 + headerLen;
  if (start > raw.length) throw new SwfError('header length runs past the end of the bundle');
  const header = parseHeader(new TextDecoder().decode(raw.subarray(8, start)));
  const count = header.lines * 6;
  const need = count * 2 + (header.views ? header.lines * 4 : 0);
  if (raw.length - start !== need) {
    throw new SwfError(`payload is ${raw.length - start} bytes but lines=${header.lines} needs ${need}`);
  }
  const positions = new Float32Array(count);
  const scale = header.halfExtent / 32767;
  const [cx, cy, cz] = header.center;
  // DataView: the payload may start at an odd offset, and it is little-endian by contract.
  for (let i = 0; i < count; i += 3) {
    const at = start + i * 2;
    positions[i] = cx + view.getInt16(at, true) * scale;
    positions[i + 1] = cy + view.getInt16(at + 2, true) * scale;
    positions[i + 2] = cz + view.getInt16(at + 4, true) * scale;
  }
  if (!header.views) return { header, positions };
  const masks = new Uint32Array(header.lines);
  const at = start + count * 2;
  for (let l = 0; l < header.lines; l++) masks[l] = view.getUint32(at + l * 4, true);
  return { header, positions, visibility: { views: new Float32Array(header.views.flat()), masks } };
}
