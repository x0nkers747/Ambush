import { toGeo, type BattlefieldFrame } from './frame';
import {
  mercatorPixel,
  TILE_SIZE,
  tileKey,
  tilesForPixelRange,
  wrapTileX,
  type TileId,
} from './tiles';

// Terrarium elevation tiles (docs/adr/0014): 256 × 256 PNG tiles in Web
// Mercator whose red, green and blue channels encode the height in metres as
// R·256 + G + B/256 − 32768. This module works on decoded RGBA pixels, so it
// needs no image library; the browser decodes the PNGs (src/acquire).

/** A decoded tile: elevations in metres, row-major from the north-west; `null` when unavailable. */
export interface ElevationTile extends TileId {
  readonly elevations: Float32Array | null;
}

/** Elevations of a tile from its RGBA pixels (4 bytes per pixel, alpha ignored). */
export function decodeTerrarium(
  rgba: ArrayLike<number>,
  width = TILE_SIZE,
  height = TILE_SIZE,
): Float32Array {
  if (rgba.length !== width * height * 4) {
    throw new RangeError(
      `expected ${String(width * height * 4)} RGBA bytes for a ${String(width)} × ${String(height)} tile, got ${String(rgba.length)}`,
    );
  }
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    out[i] =
      (rgba[i * 4] ?? 0) * 256 + (rgba[i * 4 + 1] ?? 0) + (rgba[i * 4 + 2] ?? 0) / 256 - 32768;
  }
  return out;
}

/** RGBA pixels encoding the given elevations (the inverse of `decodeTerrarium`; for tests and fixtures). */
export function encodeTerrarium(elevations: ArrayLike<number>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(elevations.length * 4);
  for (let i = 0; i < elevations.length; i += 1) {
    const v = (elevations[i] ?? 0) + 32768;
    const r = Math.floor(v / 256);
    const g = Math.floor(v - r * 256);
    const b = Math.round((v - r * 256 - g) * 256);
    out[i * 4] = r;
    out[i * 4 + 1] = g + Math.floor(b / 256);
    out[i * 4 + 2] = b % 256;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** The local sample grid an imported heightfield uses. */
export interface SampleGrid {
  readonly originX: number;
  readonly originY: number;
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
}

/** The square grid covering a battlefield at `cellSizeM`, edges included (e.g. 101 × 101 for 1 km at 10 m). */
export function battlefieldGrid(frame: BattlefieldFrame, cellSizeM: number): SampleGrid {
  const columns = Math.round(frame.widthM / cellSizeM) + 1;
  const rows = Math.round(frame.heightM / cellSizeM) + 1;
  return {
    originX: -((columns - 1) * cellSizeM) / 2,
    originY: -((rows - 1) * cellSizeM) / 2,
    cellSize: cellSizeM,
    columns,
    rows,
  };
}

/** Global pixel positions of every grid sample, row-major from the south-west. */
function samplePixels(frame: BattlefieldFrame, grid: SampleGrid, zoom: number): Float64Array {
  const px = new Float64Array(grid.columns * grid.rows * 2);
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.columns; c += 1) {
      const g = toGeo(frame, {
        x: grid.originX + c * grid.cellSize,
        y: grid.originY + r * grid.cellSize,
      });
      const p = mercatorPixel(g, zoom);
      const i = (r * grid.columns + c) * 2;
      px[i] = p.x;
      px[i + 1] = p.y;
    }
  }
  return px;
}

/**
 * The tiles needed to sample `grid` at `zoom` with bilinear interpolation,
 * including the neighbours of samples near a tile edge.
 */
export function tilesForGrid(frame: BattlefieldFrame, grid: SampleGrid, zoom: number): TileId[] {
  const px = samplePixels(frame, grid, zoom);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  // Pixel x is continuous across the antimeridian here: unwrap relative to the first sample.
  const world = TILE_SIZE * 2 ** zoom;
  const x0 = px[0] ?? 0;
  for (let i = 0; i < px.length; i += 2) {
    let x = px[i] ?? 0;
    if (x - x0 > world / 2) x -= world;
    if (x0 - x > world / 2) x += world;
    const y = px[i + 1] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  // Bilinear sampling reads the pixel centres either side: one pixel of margin.
  return tilesForPixelRange(zoom, minX - 1, minY - 1, maxX + 1, maxY + 1);
}

export interface ResampleResult {
  /** Row-major from the south-west, metres, rounded to the centimetre. */
  readonly elevations: number[];
  /** Samples whose source pixels were missing and were filled from neighbours. */
  readonly filled: number;
}

/**
 * Samples the tiles at every grid point by bilinear interpolation between
 * pixel centres. Points whose pixels fall in a missing tile are filled from
 * the nearest valid samples (and counted). Throws when more than
 * `maxMissingShare` of the grid has no data at all.
 */
export function resampleToGrid(
  frame: BattlefieldFrame,
  grid: SampleGrid,
  zoom: number,
  tiles: readonly ElevationTile[],
  maxMissingShare = 0.25,
): ResampleResult {
  const byKey = new Map(tiles.map((t) => [tileKey(t), t.elevations]));
  const n = 2 ** zoom;
  const pixel = (x: number, y: number): number => {
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    if (ty < 0 || ty >= n) return Number.NaN;
    const data = byKey.get(tileKey({ z: zoom, x: wrapTileX(tx, zoom), y: ty }));
    if (!data) return Number.NaN;
    const ix = x - tx * TILE_SIZE;
    const iy = y - ty * TILE_SIZE;
    return data[iy * TILE_SIZE + ix] ?? Number.NaN;
  };
  const px = samplePixels(frame, grid, zoom);
  const count = grid.columns * grid.rows;
  const values = new Float64Array(count);
  let missing = 0;
  for (let i = 0; i < count; i += 1) {
    // Pixel (i, j) covers [i, i+1) × [j, j+1); its value belongs to its centre.
    const fx = (px[i * 2] ?? 0) - 0.5;
    const fy = (px[i * 2 + 1] ?? 0) - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const v =
      pixel(x0, y0) * (1 - tx) * (1 - ty) +
      pixel(x0 + 1, y0) * tx * (1 - ty) +
      pixel(x0, y0 + 1) * (1 - tx) * ty +
      pixel(x0 + 1, y0 + 1) * tx * ty;
    values[i] = v;
    if (Number.isNaN(v)) missing += 1;
  }
  if (missing === count || missing > count * maxMissingShare) {
    throw new RangeError(
      `elevation data is missing for ${String(Math.round((missing / count) * 100))}% of the battlefield`,
    );
  }
  const filled = fillMissing(values, grid.columns, grid.rows);
  return { elevations: Array.from(values, (v) => Math.round(v * 100) / 100), filled };
}

/**
 * Fills NaN samples in place with the mean of their valid 8-neighbours,
 * repeating outward until none remain. Deterministic. Returns how many were filled.
 */
export function fillMissing(values: Float64Array, columns: number, rows: number): number {
  let remaining = values.reduce((n, v) => n + (Number.isNaN(v) ? 1 : 0), 0);
  const total = remaining;
  while (remaining > 0) {
    const updates: [number, number][] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        const i = r * columns + c;
        if (!Number.isNaN(values[i] ?? 0)) continue;
        let sum = 0;
        let k = 0;
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            const rr = r + dr;
            const cc = c + dc;
            if ((dr === 0 && dc === 0) || rr < 0 || cc < 0 || rr >= rows || cc >= columns) continue;
            const v = values[rr * columns + cc] ?? Number.NaN;
            if (!Number.isNaN(v)) {
              sum += v;
              k += 1;
            }
          }
        }
        if (k > 0) updates.push([i, sum / k]);
      }
    }
    if (updates.length === 0) break;
    for (const [i, v] of updates) values[i] = v;
    remaining -= updates.length;
  }
  return total - remaining;
}
