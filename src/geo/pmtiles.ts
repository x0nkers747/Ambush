// PMTiles version 3 (docs/adr/0023): a single-file tile archive read with
// HTTP range requests, as Overture Maps publishes its tiles. Pure parsing of
// the header and directories and the tile addressing; fetching and
// decompression are the acquisition layer's.

/** The fixed header at the start of every archive. */
export const PMTILES_HEADER_BYTES = 127;
/** The root directory lies within the archive's first 16 KiB, header included. */
export const PMTILES_ROOT_BYTES = 16384;

/** Compression as the header records it. */
export const PMTILES_COMPRESSION = { unknown: 0, none: 1, gzip: 2, brotli: 3, zstd: 4 } as const;
export const PMTILES_TILE_TYPE = { unknown: 0, mvt: 1, png: 2, jpeg: 3, webp: 4, avif: 5 } as const;

export interface PmtilesHeader {
  readonly rootDirectoryOffset: number;
  readonly rootDirectoryLength: number;
  readonly metadataOffset: number;
  readonly metadataLength: number;
  readonly leafDirectoryOffset: number;
  readonly leafDirectoryLength: number;
  readonly tileDataOffset: number;
  readonly tileDataLength: number;
  readonly clustered: boolean;
  /** Compression of the directories and metadata. */
  readonly internalCompression: number;
  readonly tileCompression: number;
  readonly tileType: number;
  readonly minZoom: number;
  readonly maxZoom: number;
}

/** One directory entry: a run of tiles, or (`runLength` 0) a leaf directory. */
export interface PmtilesEntry {
  readonly tileId: number;
  /** Bytes from the start of the tile data (or, for a leaf, of the leaf directories). */
  readonly offset: number;
  readonly length: number;
  readonly runLength: number;
}

export class PmtilesError extends Error {
  override name = 'PmtilesError';
}

/** Reads the header from the archive's first bytes. */
export function parsePmtilesHeader(bytes: Uint8Array): PmtilesHeader {
  if (bytes.length < PMTILES_HEADER_BYTES) throw new PmtilesError('the header is incomplete');
  const magic = String.fromCharCode(...bytes.subarray(0, 7));
  if (magic !== 'PMTiles') throw new PmtilesError('this is not a PMTiles archive');
  if (bytes[7] !== 3)
    throw new PmtilesError(`PMTiles version ${String(bytes[7])} is not supported (3 is)`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 64-bit offsets and lengths: exact as numbers up to 2^53 bytes.
  const u64 = (at: number) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
  return {
    rootDirectoryOffset: u64(8),
    rootDirectoryLength: u64(16),
    metadataOffset: u64(24),
    metadataLength: u64(32),
    leafDirectoryOffset: u64(40),
    leafDirectoryLength: u64(48),
    tileDataOffset: u64(56),
    tileDataLength: u64(64),
    clustered: bytes[96] === 1,
    internalCompression: bytes[97] ?? 0,
    tileCompression: bytes[98] ?? 0,
    tileType: bytes[99] ?? 0,
    minZoom: bytes[100] ?? 0,
    maxZoom: bytes[101] ?? 0,
  };
}

/** Reads an (uncompressed) directory: varint-encoded columns of tile ids, run lengths, lengths and offsets. */
export function parsePmtilesDirectory(bytes: Uint8Array): PmtilesEntry[] {
  let pos = 0;
  const varint = (): number => {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i += 1) {
      if (pos >= bytes.length) throw new PmtilesError('the directory is truncated');
      const b = bytes[pos] ?? 0;
      pos += 1;
      result += (b & 0x7f) * scale;
      if (b < 0x80) return result;
      scale *= 128;
    }
    throw new PmtilesError('the directory has an invalid number');
  };
  const n = varint();
  const tileIds: number[] = [];
  let last = 0;
  for (let i = 0; i < n; i += 1) {
    last += varint();
    tileIds.push(last);
  }
  const runLengths = Array.from({ length: n }, varint);
  const lengths = Array.from({ length: n }, varint);
  const entries: PmtilesEntry[] = [];
  for (let i = 0; i < n; i += 1) {
    const v = varint();
    const previous = entries[i - 1];
    // 0 after the first entry: right after the previous one; otherwise the offset plus one.
    const offset = v === 0 && previous ? previous.offset + previous.length : v - 1;
    entries.push({
      tileId: tileIds[i] ?? 0,
      offset,
      length: lengths[i] ?? 0,
      runLength: runLengths[i] ?? 0,
    });
  }
  return entries;
}

/**
 * The archive's id for a tile: tiles are numbered zoom by zoom, and along a
 * Hilbert curve within a zoom.
 */
export function pmtilesTileId(z: number, x: number, y: number): number {
  if (z > 26) throw new PmtilesError('zoom levels above 26 are not supported');
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n || !Number.isInteger(x) || !Number.isInteger(y)) {
    throw new PmtilesError(`tile ${String(z)}/${String(x)}/${String(y)} does not exist`);
  }
  // Tiles of the zoom levels before this one: (4^z − 1) / 3.
  const before = (4 ** z - 1) / 3;
  let tx = x;
  let ty = y;
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    // Rotate the quadrant.
    if (ry === 0) {
      if (rx === 1) {
        tx = s - 1 - tx;
        ty = s - 1 - ty;
      }
      [tx, ty] = [ty, tx];
    }
  }
  return before + d;
}

/**
 * Where a tile is according to one directory: its tile data (`tile`), the
 * leaf directory to read next (`leaf`), or nowhere (`null`: the archive has
 * no such tile).
 */
export function findPmtilesEntry(
  entries: readonly PmtilesEntry[],
  tileId: number,
): { readonly kind: 'tile' | 'leaf'; readonly entry: PmtilesEntry } | null {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid];
    if (!e) break;
    if (e.tileId === tileId) return { kind: e.runLength === 0 ? 'leaf' : 'tile', entry: e };
    if (e.tileId < tileId) lo = mid + 1;
    else hi = mid - 1;
  }
  // The last entry before the tile: a run that covers it, or a leaf directory for it.
  const e = entries[hi];
  if (!e) return null;
  if (e.runLength === 0) return { kind: 'leaf', entry: e };
  return tileId - e.tileId < e.runLength ? { kind: 'tile', entry: e } : null;
}
