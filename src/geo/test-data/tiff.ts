// A small tiled GeoTIFF for tests (`#geo/fixtures`): one 8-bit band in square
// blocks, georeferenced like the canopy height map (EPSG:3857, the top-left
// corner and the pixel size). Blocks are given already encoded, so a test can
// store them raw (compression 1) or compressed (8) as it can.

export interface TestTiff {
  readonly width: number;
  readonly height: number;
  /** Block side, pixels. */
  readonly block: number;
  /** Encoded blocks, row by row from the top-left. */
  readonly blocks: readonly Uint8Array[];
  /** 1 none, 8 Deflate. */
  readonly compression: 1 | 8;
  readonly west: number;
  readonly north: number;
  readonly resolution: number;
}

/** A classic little-endian TIFF holding `t`. */
export function encodeTiff(t: TestTiff): Uint8Array {
  const n = t.blocks.length;
  const entries: [number, number, number, number[]][] = [
    // tag, type, count, values (for inline ones)
    [256, 3, 1, [t.width]],
    [257, 3, 1, [t.height]],
    [258, 3, 1, [8]],
    [259, 3, 1, [t.compression]],
    [277, 3, 1, [1]],
    [317, 3, 1, [1]],
    [322, 3, 1, [t.block]],
    [323, 3, 1, [t.block]],
    [324, 4, n, []],
    [325, 4, n, []],
    [33550, 12, 3, []],
    [33922, 12, 6, []],
  ];
  const ifd = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  const offsetsAt = ifd + ifdSize;
  const countsAt = offsetsAt + 4 * n;
  const scaleAt = countsAt + 4 * n;
  const tieAt = scaleAt + 24;
  let dataAt = tieAt + 48;
  const offsets: number[] = [];
  for (const b of t.blocks) {
    offsets.push(dataAt);
    dataAt += b.length;
  }
  const bytes = new Uint8Array(dataAt);
  const v = new DataView(bytes.buffer);
  bytes.set([73, 73]);
  v.setUint16(2, 42, true);
  v.setUint32(4, ifd, true);
  v.setUint16(ifd, entries.length, true);
  entries.forEach(([tag, type, count, values], i) => {
    const e = ifd + 2 + i * 12;
    v.setUint16(e, tag, true);
    v.setUint16(e + 2, type, true);
    v.setUint32(e + 4, count, true);
    if (tag === 324) v.setUint32(e + 8, n === 1 ? (offsets[0] ?? 0) : offsetsAt, true);
    else if (tag === 325) v.setUint32(e + 8, n === 1 ? (t.blocks[0]?.length ?? 0) : countsAt, true);
    else if (tag === 33550) v.setUint32(e + 8, scaleAt, true);
    else if (tag === 33922) v.setUint32(e + 8, tieAt, true);
    else v.setUint16(e + 8, values[0] ?? 0, true);
  });
  v.setUint32(ifd + 2 + entries.length * 12, 0, true);
  t.blocks.forEach((b, i) => {
    v.setUint32(offsetsAt + 4 * i, offsets[i] ?? 0, true);
    v.setUint32(countsAt + 4 * i, b.length, true);
    bytes.set(b, offsets[i] ?? 0);
  });
  [t.resolution, t.resolution, 0].forEach((x, i) => {
    v.setFloat64(scaleAt + 8 * i, x, true);
  });
  [0, 0, 0, t.west, t.north, 0].forEach((x, i) => {
    v.setFloat64(tieAt + 8 * i, x, true);
  });
  return bytes;
}
