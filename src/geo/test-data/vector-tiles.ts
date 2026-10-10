import { pmtilesTileId } from '../pmtiles';
import type { MvtValue } from '../mvt';

// Test-only encoders for Mapbox Vector Tiles and PMTiles archives (docs/adr/0023),
// so tests can build exactly the tiles and archives they need. Exported
// through `#geo/fixtures`; the application never bundles them.

class Writer {
  readonly bytes: number[] = [];
  varint(n: number): this {
    let v = n;
    while (v >= 0x80) {
      this.bytes.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    this.bytes.push(v);
    return this;
  }
  key(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }
  message(field: number, body: Writer | Uint8Array): this {
    const b = body instanceof Writer ? body.bytes : [...body];
    this.key(field, 2).varint(b.length);
    this.bytes.push(...b);
    return this;
  }
  string(field: number, s: string): this {
    return this.message(field, new TextEncoderLite(s).bytes);
  }
  packed(field: number, values: readonly number[]): this {
    const w = new Writer();
    for (const v of values) w.varint(v);
    return this.message(field, w);
  }
  double(field: number, v: number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.key(field, 1);
    this.bytes.push(...b);
    return this;
  }
  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** UTF-8 encoding without `TextEncoder` (the geo layer has no DOM types). */
class TextEncoderLite {
  readonly bytes: Uint8Array;
  constructor(s: string) {
    const out: number[] = [];
    for (const ch of s) {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63),
          0x80 | (c & 63),
        );
    }
    this.bytes = new Uint8Array(out);
  }
}

const zigzag = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);

export interface TestFeature {
  readonly id?: number;
  /** 1 point, 2 line, 3 polygon. */
  readonly type: 1 | 2 | 3;
  readonly properties?: Readonly<Record<string, MvtValue>>;
  /** Points, lines or rings (not closed) in tile coordinates. */
  readonly geometry: readonly (readonly (readonly [number, number])[])[];
}

/** Encodes layers as an MVT 2.1 tile. */
export function encodeMvt(
  layers: readonly {
    readonly name: string;
    readonly extent?: number;
    readonly features: readonly TestFeature[];
  }[],
): Uint8Array {
  const tile = new Writer();
  for (const layer of layers) {
    const w = new Writer().key(15, 0).varint(2).string(1, layer.name);
    const keys: string[] = [];
    const values: MvtValue[] = [];
    const index = <T>(list: T[], v: T) => {
      const i = list.indexOf(v);
      return i >= 0 ? i : list.push(v) - 1;
    };
    for (const f of layer.features) {
      const fw = new Writer();
      if (f.id !== undefined) fw.key(1, 0).varint(f.id);
      const tags = Object.entries(f.properties ?? {}).flatMap(([k, v]) => [
        index(keys, k),
        index(values, v),
      ]);
      if (tags.length > 0) fw.packed(2, tags);
      fw.key(3, 0).varint(f.type);
      const commands: number[] = [];
      let cx = 0;
      let cy = 0;
      for (const part of f.geometry) {
        part.forEach(([x, y], i) => {
          if (i === 0) commands.push((1 & 7) | (1 << 3));
          else if (i === 1) commands.push((2 & 7) | ((part.length - 1) << 3));
          commands.push(zigzag(x - cx), zigzag(y - cy));
          cx = x;
          cy = y;
        });
        if (f.type === 3) commands.push(7 | (1 << 3));
      }
      fw.packed(4, commands);
      w.message(2, fw);
    }
    for (const k of keys) w.string(3, k);
    for (const v of values) {
      const vw = new Writer();
      if (typeof v === 'string') vw.string(1, v);
      else if (typeof v === 'boolean') vw.key(7, 0).varint(v ? 1 : 0);
      else if (Number.isInteger(v) && v >= 0) vw.key(5, 0).varint(v);
      else vw.double(3, v);
      w.message(4, vw);
    }
    w.key(5, 0).varint(layer.extent ?? 4096);
    tile.message(3, w);
  }
  return tile.done();
}

function directory(
  entries: readonly { tileId: number; offset: number; length: number; runLength: number }[],
): Uint8Array {
  const w = new Writer().varint(entries.length);
  let last = 0;
  for (const e of entries) {
    w.varint(e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) w.varint(e.runLength);
  for (const e of entries) w.varint(e.length);
  entries.forEach((e, i) => {
    const previous = entries[i - 1];
    w.varint(previous && e.offset === previous.offset + previous.length ? 0 : e.offset + 1);
  });
  return w.done();
}

/**
 * Builds an (uncompressed) PMTiles v3 archive of vector tiles. With
 * `leafSize`, the root directory points to leaf directories of that many
 * entries each, so readers' leaf handling is exercised. `compress`, when
 * given, compresses the directories and tiles (marked as gzip).
 */
export async function encodePmtiles(
  tiles: readonly {
    readonly z: number;
    readonly x: number;
    readonly y: number;
    readonly data: Uint8Array;
  }[],
  options: {
    leafSize?: number;
    compress?: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  } = {},
): Promise<Uint8Array> {
  const pack = async (b: Uint8Array) => (options.compress ? options.compress(b) : b);
  const sorted = (
    await Promise.all(
      tiles.map(async (t) => ({
        ...t,
        tileId: pmtilesTileId(t.z, t.x, t.y),
        data: await pack(t.data),
      })),
    )
  ).sort((a, b) => a.tileId - b.tileId);
  const entries: { tileId: number; offset: number; length: number; runLength: number }[] = [];
  const data: number[] = [];
  for (const t of sorted) {
    entries.push({ tileId: t.tileId, offset: data.length, length: t.data.length, runLength: 1 });
    data.push(...t.data);
  }
  let root: Uint8Array;
  let leaves = new Uint8Array(0);
  if (options.leafSize && options.leafSize < entries.length) {
    const leafBytes: number[] = [];
    const rootEntries: typeof entries = [];
    for (let i = 0; i < entries.length; i += options.leafSize) {
      const chunk = entries.slice(i, i + options.leafSize);
      const bytes = await pack(directory(chunk));
      rootEntries.push({
        tileId: chunk[0]?.tileId ?? 0,
        offset: leafBytes.length,
        length: bytes.length,
        runLength: 0,
      });
      leafBytes.push(...bytes);
    }
    root = await pack(directory(rootEntries));
    leaves = new Uint8Array(leafBytes);
  } else {
    root = await pack(directory(entries));
  }
  const header = new Uint8Array(127);
  header.set(Array.from('PMTiles', (c) => c.charCodeAt(0)));
  header[7] = 3;
  const view = new DataView(header.buffer);
  const u64 = (at: number, v: number) => {
    view.setUint32(at, v % 2 ** 32, true);
    view.setUint32(at + 4, Math.floor(v / 2 ** 32), true);
  };
  const rootOffset = 127;
  const leafOffset = rootOffset + root.length;
  const dataOffset = leafOffset + leaves.length;
  u64(8, rootOffset);
  u64(16, root.length);
  u64(24, dataOffset);
  u64(32, 0);
  u64(40, leafOffset);
  u64(48, leaves.length);
  u64(56, dataOffset);
  u64(64, data.length);
  u64(72, tiles.length);
  u64(80, tiles.length);
  u64(88, tiles.length);
  header[96] = 1;
  header[97] = options.compress ? 2 : 1;
  header[98] = options.compress ? 2 : 1;
  header[99] = 1;
  header[100] = Math.min(...tiles.map((t) => t.z));
  header[101] = Math.max(...tiles.map((t) => t.z));
  const out = new Uint8Array(dataOffset + data.length);
  out.set(header, 0);
  out.set(root, rootOffset);
  out.set(leaves, leafOffset);
  out.set(data, dataOffset);
  return out;
}
