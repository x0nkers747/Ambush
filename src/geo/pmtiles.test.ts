import { describe, expect, it } from 'vitest';
import { encodeMvt, encodePmtiles } from '#geo/fixtures';
import {
  findPmtilesEntry,
  parsePmtilesDirectory,
  parsePmtilesHeader,
  PMTILES_HEADER_BYTES,
  PmtilesError,
  pmtilesTileId,
} from './pmtiles';

// PMTiles v3 parsing (docs/adr/0023).

describe('pmtilesTileId', () => {
  it('numbers tiles zoom by zoom along a Hilbert curve', () => {
    expect(pmtilesTileId(0, 0, 0)).toBe(0);
    // Zoom 1: the Hilbert order is (0,0), (0,1), (1,1), (1,0).
    expect([
      pmtilesTileId(1, 0, 0),
      pmtilesTileId(1, 0, 1),
      pmtilesTileId(1, 1, 1),
      pmtilesTileId(1, 1, 0),
    ]).toEqual([1, 2, 3, 4]);
    expect(pmtilesTileId(2, 0, 0)).toBe(5);
    // Values checked against the reference implementation (the pmtiles package).
    expect(pmtilesTileId(14, 4672, 6288)).toBe(138_159_701);
    expect(pmtilesTileId(14, 4674, 6288)).toBe(138_159_715);
  });

  it('gives every tile of a zoom a distinct id in its range', () => {
    const ids = new Set<number>();
    for (let x = 0; x < 8; x += 1) for (let y = 0; y < 8; y += 1) ids.add(pmtilesTileId(3, x, y));
    expect(ids.size).toBe(64);
    expect(Math.min(...ids)).toBe(21);
    expect(Math.max(...ids)).toBe(84);
  });

  it('refuses tiles that do not exist', () => {
    expect(() => pmtilesTileId(2, 4, 0)).toThrow(PmtilesError);
    expect(() => pmtilesTileId(2, 0, -1)).toThrow(PmtilesError);
    expect(() => pmtilesTileId(27, 0, 0)).toThrow(PmtilesError);
  });
});

describe('PMTiles archives', () => {
  const tile = (n: number) =>
    encodeMvt([{ name: 'building', features: [{ id: n, type: 1, geometry: [[[n, n]]] }] }]);
  const tiles = [
    { z: 14, x: 4672, y: 6288, data: tile(1) },
    { z: 14, x: 4673, y: 6288, data: tile(2) },
    { z: 14, x: 4672, y: 6289, data: tile(3) },
    { z: 14, x: 100, y: 200, data: tile(4) },
  ];

  /** Finds a tile's bytes by walking the directories, as a reader does. */
  const lookUp = (archive: Uint8Array, z: number, x: number, y: number) => {
    const h = parsePmtilesHeader(archive);
    const id = pmtilesTileId(z, x, y);
    let entries = parsePmtilesDirectory(
      archive.subarray(h.rootDirectoryOffset, h.rootDirectoryOffset + h.rootDirectoryLength),
    );
    for (;;) {
      const found = findPmtilesEntry(entries, id);
      if (!found) return null;
      const start = found.kind === 'tile' ? h.tileDataOffset : h.leafDirectoryOffset;
      const bytes = archive.subarray(
        start + found.entry.offset,
        start + found.entry.offset + found.entry.length,
      );
      if (found.kind === 'tile') return bytes;
      entries = parsePmtilesDirectory(bytes);
    }
  };

  it('reads the header and finds every tile, and no others', async () => {
    const archive = await encodePmtiles(tiles);
    const h = parsePmtilesHeader(archive);
    expect(h).toMatchObject({
      rootDirectoryOffset: PMTILES_HEADER_BYTES,
      internalCompression: 1,
      tileCompression: 1,
      tileType: 1,
      minZoom: 14,
      maxZoom: 14,
      clustered: true,
    });
    for (const t of tiles) expect(lookUp(archive, t.z, t.x, t.y)).toEqual(t.data);
    expect(lookUp(archive, 14, 4674, 6288)).toBeNull();
    expect(lookUp(archive, 13, 0, 0)).toBeNull();
  });

  it('follows leaf directories', async () => {
    const archive = await encodePmtiles(tiles, { leafSize: 2 });
    const h = parsePmtilesHeader(archive);
    expect(h.leafDirectoryLength).toBeGreaterThan(0);
    const root = parsePmtilesDirectory(
      archive.subarray(h.rootDirectoryOffset, h.rootDirectoryOffset + h.rootDirectoryLength),
    );
    expect(root.every((e) => e.runLength === 0)).toBe(true);
    for (const t of tiles) expect(lookUp(archive, t.z, t.x, t.y)).toEqual(t.data);
    expect(lookUp(archive, 14, 4674, 6288)).toBeNull();
  });

  it('finds tiles inside a run of identical tiles', () => {
    const entries = [
      { tileId: 10, offset: 0, length: 5, runLength: 1 },
      { tileId: 20, offset: 5, length: 7, runLength: 3 },
    ];
    expect(findPmtilesEntry(entries, 22)).toEqual({ kind: 'tile', entry: entries[1] });
    expect(findPmtilesEntry(entries, 23)).toBeNull();
    expect(findPmtilesEntry(entries, 9)).toBeNull();
    expect(findPmtilesEntry(entries, 11)).toBeNull();
  });

  it('decodes offsets written as "right after the previous entry"', () => {
    // Two entries; the second's offset is encoded as 0 (follows the first).
    const bytes = new Uint8Array([2, 4, 1, 1, 1, 10, 20, 1, 0]);
    expect(parsePmtilesDirectory(bytes)).toEqual([
      { tileId: 4, offset: 0, length: 10, runLength: 1 },
      { tileId: 5, offset: 10, length: 20, runLength: 1 },
    ]);
  });

  it('refuses what is not a version 3 archive', () => {
    const notPm = new Uint8Array(PMTILES_HEADER_BYTES);
    expect(() => parsePmtilesHeader(notPm)).toThrow(/not a PMTiles archive/);
    const v2 = new Uint8Array(PMTILES_HEADER_BYTES);
    v2.set(Array.from('PMTiles', (c) => c.charCodeAt(0)));
    v2[7] = 2;
    expect(() => parsePmtilesHeader(v2)).toThrow(/version 2 is not supported/);
    expect(() => parsePmtilesHeader(new Uint8Array(10))).toThrow(/incomplete/);
    expect(() => parsePmtilesDirectory(new Uint8Array([3, 1]))).toThrow(PmtilesError);
  });
});
