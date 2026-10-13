import type { EnvironmentFeatures, VegetationArea } from '#sim';
import { localBounds, toGeo, type BattlefieldFrame } from './frame';
import { dilate, erode, mappedMasks, traceWoods, type WoodGrid } from './woods';

// Tree cover from canopy heights (docs/adr/0050): the woods OpenStreetMap
// does not map, found in the Meta / World Resources Institute global canopy
// height map (CHMv2, about 1.2 m, CC BY 4.0). The map is published as one
// Cloud Optimized GeoTIFF per zoom-10 Web Mercator tile (named by its
// quadkey), heights in whole metres. Downloading is acquire's; this is the
// pure part: which tiles a battlefield needs, reading their headers, the
// heights on the battlefield's 1 m grid, and the woods in them.

/** The zoom of the canopy map's tiles. */
export const CANOPY_ZOOM = 10;
/** Cells at least this tall (metres) are trees. */
export const CANOPY_TREE_M = 4;
/** The canopy map is moved by at most this much to line up with the mapped woods, metres. */
export const CANOPY_MAX_SHIFT_M = 16;
/** Mapped woods needed to line the canopy map up with them, m² (else it is used as published). */
export const CANOPY_ALIGN_MIN_M2 = 20_000;
/** How far a sight line sees into the woods added, metres: as a mixed broadleaf wood. */
export const CANOPY_SEE_THROUGH_M = 25;
/** The licence's credit, shown with the map. */
export const CANOPY_ATTRIBUTION =
  'Tree cover from canopy height maps © Meta and World Resources Institute (CC BY 4.0)';

/** Web Mercator (EPSG:3857) metres per radian of longitude: the sphere's radius. */
const R = 6378137;
const HALF_WORLD = Math.PI * R;

/** Web Mercator metres of a position. */
export function mercatorMetres(lat: number, lon: number): { x: number; y: number } {
  const phi = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return { x: (R * lon * Math.PI) / 180, y: R * Math.log(Math.tan(Math.PI / 4 + phi / 2)) };
}

/** A zoom-`z` tile's quadkey (Bing Maps tile naming). */
export function quadkey(x: number, y: number, z: number): string {
  let q = '';
  for (let i = z; i > 0; i -= 1) {
    const m = 1 << (i - 1);
    q += String((x & m ? 1 : 0) + (y & m ? 2 : 0));
  }
  return q;
}

/** A Web Mercator rectangle, metres. */
export interface MercatorBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** What to read of the canopy map for a battlefield. */
export interface CanopyPlan {
  /** The battlefield, with a margin for the alignment, in Web Mercator metres. */
  readonly box: MercatorBox;
  /** The tiles covering it. */
  readonly tiles: readonly { readonly quadkey: string; readonly box: MercatorBox }[];
}

/** The battlefield's corners and edges in Web Mercator, and the canopy tiles covering them. */
export function planCanopy(frame: BattlefieldFrame): CanopyPlan {
  const b = localBounds(frame);
  const margin = CANOPY_MAX_SHIFT_M + 4;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const steps = 8;
  for (let i = 0; i <= steps; i += 1)
    for (let j = 0; j <= steps; j += 1) {
      if (i !== 0 && i !== steps && j !== 0 && j !== steps) continue;
      const p = toGeo(frame, {
        x: b.minX - margin + ((b.maxX - b.minX + 2 * margin) * i) / steps,
        y: b.minY - margin + ((b.maxY - b.minY + 2 * margin) * j) / steps,
      });
      const m = mercatorMetres(p.lat, p.lon);
      minX = Math.min(minX, m.x);
      minY = Math.min(minY, m.y);
      maxX = Math.max(maxX, m.x);
      maxY = Math.max(maxY, m.y);
    }
  // A battlefield across ±180° gives a box wider than half the world: such
  // battlefields have no canopy tiles (rare, and only over the Pacific).
  const box = { minX, minY, maxX, maxY };
  const n = 2 ** CANOPY_ZOOM;
  const size = (2 * HALF_WORLD) / n;
  if (maxX - minX > HALF_WORLD) return { box, tiles: [] };
  const tiles: CanopyPlan['tiles'][number][] = [];
  const tx0 = Math.max(0, Math.floor((minX + HALF_WORLD) / size));
  const tx1 = Math.min(n - 1, Math.floor((maxX + HALF_WORLD) / size));
  const ty0 = Math.max(0, Math.floor((HALF_WORLD - maxY) / size));
  const ty1 = Math.min(n - 1, Math.floor((HALF_WORLD - minY) / size));
  for (let ty = ty0; ty <= ty1; ty += 1)
    for (let tx = tx0; tx <= tx1; tx += 1)
      tiles.push({
        quadkey: quadkey(tx, ty, CANOPY_ZOOM),
        box: {
          minX: -HALF_WORLD + tx * size,
          maxX: -HALF_WORLD + (tx + 1) * size,
          maxY: HALF_WORLD - ty * size,
          minY: HALF_WORLD - (ty + 1) * size,
        },
      });
  return { box, tiles };
}

// --- TIFF headers ------------------------------------------------------------------------------

/** A tiled image in a TIFF: what is needed to read windows of it. */
export interface TiffImage {
  readonly width: number;
  readonly height: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly bitsPerSample: number;
  readonly samplesPerPixel: number;
  /** 1 none, 8 Deflate (zlib), … */
  readonly compression: number;
  readonly predictor: number;
  /** 0 a full image; 1 an overview; 4 a mask. */
  readonly subfileType: number;
  readonly tileOffsets: readonly number[];
  readonly tileByteCounts: readonly number[];
  /** GeoTIFF: pixel size, and the model coordinates of the top-left pixel corner. */
  readonly pixelScale: readonly number[] | null;
  readonly tiepoint: readonly number[] | null;
}

/** The header ends past the bytes given: read at least `needed` bytes and parse again. */
export class TiffTruncatedError extends Error {
  override name = 'TiffTruncatedError';
  readonly needed: number;
  constructor(needed: number) {
    super(`the TIFF header needs ${String(needed)} bytes`);
    this.needed = needed;
  }
}

/** The images of a classic (not BigTIFF) TIFF, from its first bytes. */
export function parseTiffHeader(bytes: Uint8Array): TiffImage[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (end: number) => {
    if (end > bytes.byteLength) throw new TiffTruncatedError(end);
  };
  need(8);
  const order = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0);
  if (order !== 'II' && order !== 'MM') throw new Error('not a TIFF');
  const le = order === 'II';
  const u16 = (o: number) => view.getUint16(o, le);
  const u32 = (o: number) => view.getUint32(o, le);
  if (u16(2) === 43) throw new Error('BigTIFF is not supported');
  if (u16(2) !== 42) throw new Error('not a TIFF');
  const size: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8, 16: 8 };
  const images: TiffImage[] = [];
  let ifd = u32(4);
  for (let guard = 0; ifd !== 0 && guard < 64; guard += 1) {
    need(ifd + 2);
    const count = u16(ifd);
    need(ifd + 2 + count * 12 + 4);
    const tags = new Map<number, number[]>();
    for (let i = 0; i < count; i += 1) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const bytesPer = size[type] ?? 1;
      const at = n * bytesPer <= 4 ? e + 8 : u32(e + 8);
      need(at + n * bytesPer);
      const values: number[] = [];
      if (type === 3 || type === 4 || type === 12 || type === 1)
        for (let k = 0; k < n; k += 1)
          values.push(
            type === 3
              ? u16(at + 2 * k)
              : type === 4
                ? u32(at + 4 * k)
                : type === 12
                  ? view.getFloat64(at + 8 * k, le)
                  : (bytes[at + k] ?? 0),
          );
      tags.set(tag, values);
    }
    const one = (tag: number, fallback = 0) => tags.get(tag)?.[0] ?? fallback;
    images.push({
      width: one(256),
      height: one(257),
      tileWidth: one(322),
      tileHeight: one(323),
      bitsPerSample: one(258, 1),
      samplesPerPixel: one(277, 1),
      compression: one(259, 1),
      predictor: one(317, 1),
      subfileType: one(254),
      tileOffsets: tags.get(324) ?? [],
      tileByteCounts: tags.get(325) ?? [],
      pixelScale: tags.get(33550) ?? null,
      tiepoint: tags.get(33922) ?? null,
    });
    ifd = u32(ifd + 2 + count * 12);
  }
  return images;
}

// --- Heights on the battlefield's grid ----------------------------------------------------------

/** A window of the canopy map: heights in metres, row 0 the northernmost. */
export interface CanopyRaster {
  readonly quadkey: string;
  /** Web Mercator x of the window's west edge and y of its north edge, metres. */
  readonly west: number;
  readonly north: number;
  /** Pixel size, metres. */
  readonly resolution: number;
  readonly width: number;
  readonly height: number;
  readonly heights: Uint8Array;
}

/** Node spacing of the projection lattice (heights are sampled through it), metres. */
const LATTICE_M = 50;

/**
 * Canopy heights at the centres of the battlefield's 1 m cells (`grid`),
 * bilinear between the map's pixels. Cells no raster covers are 0.
 * Positions are projected exactly on a 50 m lattice and interpolated between
 * (the projection is smooth: well under a centimetre off).
 */
export function canopyOnGrid(
  frame: BattlefieldFrame,
  grid: WoodGrid,
  rasters: readonly CanopyRaster[],
): Uint8Array {
  const { x0, y0, width: W, height: H } = grid;
  const lc = Math.ceil(W / LATTICE_M) + 1;
  const lr = Math.ceil(H / LATTICE_M) + 1;
  const mx = new Float64Array(lc * lr);
  const my = new Float64Array(lc * lr);
  for (let j = 0; j < lr; j += 1)
    for (let i = 0; i < lc; i += 1) {
      const p = toGeo(frame, { x: x0 + i * LATTICE_M, y: y0 + j * LATTICE_M });
      const m = mercatorMetres(p.lat, p.lon);
      mx[j * lc + i] = m.x;
      my[j * lc + i] = m.y;
    }
  const out = new Uint8Array(W * H);
  // The lattice's row at this y, then linear along it.
  const rowX = new Float64Array(lc);
  const rowY = new Float64Array(lc);
  let last = rasters[0];
  for (let y = 0; y < H; y += 1) {
    const fy = (y + 0.5) / LATTICE_M;
    const j = Math.min(lr - 2, Math.floor(fy));
    const ty = fy - j;
    for (let i = 0; i < lc; i += 1) {
      const k = j * lc + i;
      rowX[i] = (mx[k] ?? 0) + ((mx[k + lc] ?? 0) - (mx[k] ?? 0)) * ty;
      rowY[i] = (my[k] ?? 0) + ((my[k + lc] ?? 0) - (my[k] ?? 0)) * ty;
    }
    for (let x = 0; x < W; x += 1) {
      const fx = (x + 0.5) / LATTICE_M;
      const i = Math.min(lc - 2, Math.floor(fx));
      const tx = fx - i;
      const ax = rowX[i] ?? 0;
      const ay = rowY[i] ?? 0;
      const px = ax + ((rowX[i + 1] ?? 0) - ax) * tx;
      const py = ay + ((rowY[i + 1] ?? 0) - ay) * tx;
      // The raster holding the point: the last one used, usually.
      let r = last;
      let fc = r ? (px - r.west) / r.resolution - 0.5 : -1;
      let fr = r ? (r.north - py) / r.resolution - 0.5 : -1;
      if (!r || fc < 0 || fr < 0 || fc > r.width - 1 || fr > r.height - 1) {
        r = undefined;
        for (const q of rasters) {
          fc = (px - q.west) / q.resolution - 0.5;
          fr = (q.north - py) / q.resolution - 0.5;
          if (fc >= 0 && fr >= 0 && fc <= q.width - 1 && fr <= q.height - 1) {
            r = q;
            break;
          }
        }
        if (!r) continue;
        last = r;
      }
      const w = r.width;
      const c = Math.min(w - 2, Math.floor(fc));
      const rr = Math.min(r.height - 2, Math.floor(fr));
      const u = fc - c;
      const v = fr - rr;
      const o = rr * w + c;
      const h = r.heights;
      const top = (h[o] ?? 0) + ((h[o + 1] ?? 0) - (h[o] ?? 0)) * u;
      const bottom = (h[o + w] ?? 0) + ((h[o + w + 1] ?? 0) - (h[o + w] ?? 0)) * u;
      out[y * W + x] = Math.round(top + (bottom - top) * v);
    }
  }
  return out;
}

// --- Woods ---------------------------------------------------------------------------------------

/** How the canopy map was used. */
export interface CanopyReport {
  /** The shift that lines the canopy map up with the mapped woods (a height is read dx east, dy north), metres. */
  readonly shiftM: readonly [number, number];
  /** Whether the shift was measured (false: too few mapped woods; the map is used as published). */
  readonly aligned: boolean;
  /** Overlap of the canopy map's trees and the mapped woods, at that shift (0–1). */
  readonly agreement: number;
  /** Mapped woods with canopy at least `CANOPY_TREE_M` tall there (0–1). */
  readonly mappedWoodsFound: number;
  readonly woods: number;
  readonly areaM2: number;
}

/**
 * The woods OpenStreetMap does not map, from canopy heights on the
 * battlefield's 1 m grid (`canopyOnGrid`): the canopy map first lined up with
 * the mapped woods (the shift that best overlaps them, up to
 * `CANOPY_MAX_SHIFT_M`; satellite canopies lean and mosaics are a few metres
 * out), then cells `CANOPY_TREE_M` or taller, thin lines (masts, wires)
 * removed, away from the mapped vegetation, buildings, roads, water and
 * paved ground, traced into woods. Each wood's canopy height is the upper
 * quartile of its cells'. Pure and deterministic.
 */
export function treeCoverFromCanopy(
  heights: Uint8Array,
  grid: WoodGrid,
  features: EnvironmentFeatures,
): { areas: VegetationArea[]; report: CanopyReport } {
  const { x0, y0, width: W, height: H } = grid;
  const masks = mappedMasks(grid, features);
  const tall = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k += 1) tall[k] = (heights[k] ?? 0) >= CANOPY_TREE_M ? 1 : 0;
  // What lining up compares: mapped woods 1, other open ground 0, ruled out 2.
  const reference = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k += 1)
    reference[k] = masks.blocked[k] ? 2 : masks.vegetation[k] ? 1 : 0;

  // Lining up: the shift with the best overlap of trees and mapped woods.
  let refCells = 0;
  for (let k = 0; k < W * H; k += 1) if (reference[k] === 1) refCells += 1;
  const overlap = (dx: number, dy: number, step: number) => {
    let both = 0;
    let either = 0;
    const m = CANOPY_MAX_SHIFT_M;
    const d = dy * W + dx;
    for (let y = m; y < H - m; y += step)
      for (let k = y * W + m, end = y * W + W - m; k < end; k += step) {
        const v = reference[k];
        if (v === 2) continue;
        const t = tall[k + d];
        if (t === 1 && v === 1) both += 1;
        if (t === 1 || v === 1) either += 1;
      }
    return either > 0 ? both / either : 0;
  };
  let shift: [number, number] = [0, 0];
  const aligned = refCells >= CANOPY_ALIGN_MIN_M2;
  if (aligned) {
    let best = -1;
    for (let dy = -CANOPY_MAX_SHIFT_M; dy <= CANOPY_MAX_SHIFT_M; dy += 2)
      for (let dx = -CANOPY_MAX_SHIFT_M; dx <= CANOPY_MAX_SHIFT_M; dx += 2) {
        const s = overlap(dx, dy, 5);
        if (s > best || (s === best && dx * dx + dy * dy < shift[0] ** 2 + shift[1] ** 2)) {
          best = s;
          shift = [dx, dy];
        }
      }
    // Then closer, on more cells: within 2 m on every other cell, within 1 m on every cell
    // (sparse samples can tie neighbouring shifts).
    for (const [reach, step] of [
      [2, 2],
      [1, 1],
    ] as const) {
      const [cx, cy] = shift;
      best = -1;
      for (let dy = cy - reach; dy <= cy + reach; dy += 1)
        for (let dx = cx - reach; dx <= cx + reach; dx += 1) {
          if (Math.abs(dx) > CANOPY_MAX_SHIFT_M || Math.abs(dy) > CANOPY_MAX_SHIFT_M) continue;
          const s = overlap(dx, dy, step);
          if (s > best || (s === best && dx * dx + dy * dy < shift[0] ** 2 + shift[1] ** 2)) {
            best = s;
            shift = [dx, dy];
          }
        }
    }
  }
  const [sx, sy] = shift;
  // The heights moved into line (edge cells repeated).
  const lined = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    const yy = Math.min(H - 1, Math.max(0, y + sy));
    for (let x = 0; x < W; x += 1)
      lined[y * W + x] = heights[yy * W + Math.min(W - 1, Math.max(0, x + sx))] ?? 0;
  }

  // Trees: tall cells, thin lines removed (an opening), where no mapped feature is.
  const tree = new Uint8Array(W * H);
  let found = 0;
  for (let k = 0; k < W * H; k += 1) {
    if ((lined[k] ?? 0) < CANOPY_TREE_M) continue;
    tree[k] = 1;
    if (reference[k] === 1) found += 1;
  }
  const opened = dilate(grid, erode(grid, tree, 1), 1);
  const keep = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k += 1)
    keep[k] = opened[k] && !masks.nearVegetation[k] && !masks.blocked[k] ? 1 : 0;

  const woods = traceWoods(grid, keep);
  const areas: VegetationArea[] = woods.map((w, i) => {
    const hs = Uint8Array.from(w.cells, (k) => lined[k] ?? 0).sort();
    const canopy = hs[Math.floor(hs.length * 0.75)] ?? CANOPY_TREE_M;
    const local = (ring: readonly [number, number][]) =>
      ring.map(([x, y]) => ({ x: x + x0, y: y + y0 }));
    return {
      id: `canopy-${String(i + 1)}`,
      kind: 'woodland',
      boundary: local(w.ring),
      ...(w.holes.length > 0 ? { holes: w.holes.map(local) } : {}),
      canopyHeightMeters: Math.max(CANOPY_TREE_M, canopy),
      seeThroughMeters: CANOPY_SEE_THROUGH_M,
      source: { ref: 'meta-chm-v2', estimated: ['seeThroughMeters'] },
    };
  });
  return {
    areas,
    report: {
      shiftM: shift,
      aligned,
      agreement: aligned ? +overlap(sx, sy, 1).toFixed(3) : 0,
      mappedWoodsFound: refCells > 0 ? +(found / refCells).toFixed(3) : 0,
      woods: areas.length,
      areaM2: woods.reduce((s, w) => s + w.areaM2, 0),
    },
  };
}

/** The battlefield's 1 m grid (for `canopyOnGrid` and `treeCoverFromCanopy`). */
export function canopyGrid(frame: BattlefieldFrame): WoodGrid {
  const b = localBounds(frame);
  return {
    x0: b.minX,
    y0: b.minY,
    width: Math.round(b.maxX - b.minX),
    height: Math.round(b.maxY - b.minY),
  };
}
