// Mapbox Vector Tile decoding (MVT 2.1, the format of Overture Maps' tiles,
// docs/adr/0023). Pure: bytes in, layers out. Only what the importer needs:
// layers, feature ids, properties and geometry in the tile's own integer
// coordinates (x east, y south, 0 to `extent` across the tile; features may
// reach into a buffer beyond).

export type MvtValue = string | number | boolean;

export interface MvtFeature {
  /** The feature's numeric id, when the tile has one. */
  readonly id: number | undefined;
  /** 1 point, 2 line, 3 polygon; 0 unknown. */
  readonly type: number;
  readonly properties: Readonly<Record<string, MvtValue>>;
  /**
   * Points, lines or rings in tile coordinates. Polygon rings are not closed
   * (the last point is not repeated); exterior rings have a positive
   * `ringArea`, holes a negative one.
   */
  readonly geometry: readonly (readonly (readonly [number, number])[])[];
}

export interface MvtLayer {
  readonly name: string;
  readonly extent: number;
  readonly features: readonly MvtFeature[];
}

export class MvtError extends Error {
  override name = 'MvtError';
}

/** A minimal protocol-buffers reader over a byte array. */
class Reader {
  pos: number;
  readonly bytes: Uint8Array;
  readonly end: number;
  constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
  }
  get done(): boolean {
    return this.pos >= this.end;
  }
  /** An unsigned varint, exact up to 2^53. */
  varint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i += 1) {
      if (this.pos >= this.end) throw new MvtError('truncated varint');
      const b = this.bytes[this.pos] ?? 0;
      this.pos += 1;
      result += (b & 0x7f) * scale;
      if (b < 0x80) return result;
      scale *= 128;
    }
    throw new MvtError('varint too long');
  }
  /** A field key: its number and wire type. */
  key(): { field: number; wire: number } {
    const k = this.varint();
    return { field: Math.floor(k / 8), wire: k % 8 };
  }
  bytesField(): Reader {
    const length = this.varint();
    const start = this.pos;
    if (start + length > this.end) throw new MvtError('truncated field');
    this.pos += length;
    return new Reader(this.bytes, start, start + length);
  }
  string(): string {
    const r = this.bytesField();
    return utf8(this.bytes.subarray(r.pos, r.end));
  }
  fixed(bytes: 4 | 8): DataView {
    if (this.pos + bytes > this.end) throw new MvtError('truncated fixed field');
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, bytes);
    this.pos += bytes;
    return view;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new MvtError(`unsupported wire type ${String(wire)}`);
  }
  /** A packed repeated varint field. */
  packed(): number[] {
    const r = this.bytesField();
    const values: number[] = [];
    while (!r.done) values.push(r.varint());
    return values;
  }
}

/** UTF-8 bytes to a string (this layer has no `TextDecoder`); invalid sequences become U+FFFD. */
export function utf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i] ?? 0;
    const size = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
    let code = size === 1 ? b : size === 2 ? b & 0x1f : size === 3 ? b & 0x0f : b & 0x07;
    let ok = size > 0 && i + size <= bytes.length;
    for (let k = 1; ok && k < size; k += 1) {
      const c = bytes[i + k] ?? 0;
      ok = (c & 0xc0) === 0x80;
      code = code * 64 + (c & 0x3f);
    }
    out += ok ? String.fromCodePoint(code) : '\uFFFD';
    i += ok ? size : 1;
  }
  return out;
}

const zigzag = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function value(r: Reader): MvtValue {
  let v: MvtValue = '';
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1) v = r.string();
    else if (field === 2) v = r.fixed(4).getFloat32(0, true);
    else if (field === 3) v = r.fixed(8).getFloat64(0, true);
    else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = zigzag(r.varint());
    else if (field === 7) v = r.varint() !== 0;
    else r.skip(wire);
  }
  return v;
}

/** Geometry commands (MoveTo, LineTo, ClosePath) to points, lines or rings. */
function decodeGeometry(commands: readonly number[]): [number, number][][] {
  const parts: [number, number][][] = [];
  let current: [number, number][] | null = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < commands.length) {
    const c = commands[i] ?? 0;
    i += 1;
    const id = c & 7;
    const count = c >>> 3;
    if (id === 7) {
      current = null;
      continue;
    }
    if (id !== 1 && id !== 2) throw new MvtError(`unknown geometry command ${String(id)}`);
    for (let k = 0; k < count; k += 1) {
      if (i + 1 >= commands.length) throw new MvtError('truncated geometry');
      x += zigzag(commands[i] ?? 0);
      y += zigzag(commands[i + 1] ?? 0);
      i += 2;
      if (id === 1 || !current) {
        current = [];
        parts.push(current);
      }
      current.push([x, y]);
    }
  }
  return parts;
}

function feature(r: Reader, keys: readonly string[], values: readonly MvtValue[]): MvtFeature {
  let id: number | undefined;
  let type = 0;
  let tags: number[] = [];
  let geometry: number[] = [];
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1) id = r.varint();
    else if (field === 2) tags = r.packed();
    else if (field === 3) type = r.varint();
    else if (field === 4) geometry = r.packed();
    else r.skip(wire);
  }
  const properties: Record<string, MvtValue> = {};
  for (let t = 0; t + 1 < tags.length; t += 2) {
    const key = keys[tags[t] ?? -1];
    const v = values[tags[t + 1] ?? -1];
    if (key !== undefined && v !== undefined) properties[key] = v;
  }
  return { id, type, properties, geometry: decodeGeometry(geometry) };
}

function layer(r: Reader): MvtLayer {
  let name = '';
  let extent = 4096;
  const keys: string[] = [];
  const values: MvtValue[] = [];
  const featureReaders: Reader[] = [];
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1) name = r.string();
    else if (field === 2) featureReaders.push(r.bytesField());
    else if (field === 3) keys.push(r.string());
    else if (field === 4) values.push(value(r.bytesField()));
    else if (field === 5) extent = r.varint();
    else r.skip(wire);
  }
  // Keys and values may come after the features, so features are decoded last.
  return { name, extent, features: featureReaders.map((f) => feature(f, keys, values)) };
}

/** Decodes an (uncompressed) vector tile. Throws an `MvtError` for malformed data. */
export function decodeMvt(bytes: Uint8Array): MvtLayer[] {
  const r = new Reader(bytes);
  const layers: MvtLayer[] = [];
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 3) layers.push(layer(r.bytesField()));
    else r.skip(wire);
  }
  return layers;
}

/** The signed area of a ring in tile coordinates: positive for exterior rings (y south). */
export function ringArea(ring: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    if (p && q) a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
