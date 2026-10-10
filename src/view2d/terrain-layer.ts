import { terrainTriangleIndices, type TerrainDataset } from '#sim';

// Terrain imagery for the tactical map, computed once per terrain. Pure
// functions over the heightfield; the renderer turns them into canvas objects.

export interface TerrainRaster {
  readonly width: number;
  readonly height: number;
  /** RGBA, one pixel per elevation sample, row 0 = northernmost samples. */
  readonly data: Uint8ClampedArray;
}

/** Light from the north-west, 45° above the horizon (the cartographic convention). */
const LIGHT = { x: -0.5, y: 0.5, z: Math.SQRT1_2 };
/** Exaggerates relief in the shading so gentle terrain still reads. */
const SHADE_EXAGGERATION = 3;
/** Muted hypsometric tints from lowest to highest ground. */
const TINTS: readonly (readonly [number, number, number])[] = [
  [178, 196, 156],
  [206, 208, 165],
  [216, 200, 160],
  [196, 172, 136],
];

/** Elevation tint modulated by hillshade, one pixel per sample. */
export function terrainRaster(terrain: TerrainDataset): TerrainRaster {
  const { columns, rows, cellSize, elevations } = terrain.heightfield;
  const at = (c: number, r: number) =>
    elevations[
      Math.min(Math.max(r, 0), rows - 1) * columns + Math.min(Math.max(c, 0), columns - 1)
    ] ?? 0;
  const { min, max } = elevationRange(terrain);
  const range = max - min || 1;
  const flatShade = LIGHT.z;

  const data = new Uint8ClampedArray(columns * rows * 4);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const dzdx = ((at(c + 1, r) - at(c - 1, r)) / (2 * cellSize)) * SHADE_EXAGGERATION;
      const dzdy = ((at(c, r + 1) - at(c, r - 1)) / (2 * cellSize)) * SHADE_EXAGGERATION;
      const shade = Math.max(
        0,
        (-dzdx * LIGHT.x - dzdy * LIGHT.y + LIGHT.z) / Math.hypot(dzdx, dzdy, 1),
      );
      const brightness = 1 + 0.6 * (shade - flatShade);
      const [red, green, blue] = tint((at(c, r) - min) / range);
      const i = ((rows - 1 - r) * columns + c) * 4;
      data[i] = red * brightness;
      data[i + 1] = green * brightness;
      data[i + 2] = blue * brightness;
      data[i + 3] = 255;
    }
  }
  return { width: columns, height: rows, data };
}

function tint(t: number): [number, number, number] {
  const scaled = Math.min(Math.max(t, 0), 1) * (TINTS.length - 1);
  const i = Math.min(Math.floor(scaled), TINTS.length - 2);
  const f = scaled - i;
  const a = TINTS[i] ?? [0, 0, 0];
  const b = TINTS[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Contour spacing in metres: minor lines, and index lines (every fifth). */
export interface ContourIntervals {
  readonly minor: number;
  readonly index: number;
}

const NICE_INTERVALS = [1, 2, 5, 10, 20, 50, 100] as const;
/** At most this many minor contour levels across the terrain's relief. */
const MAX_CONTOUR_LEVELS = 40;

/**
 * Contour intervals for a terrain (docs/adr/0014). Terrain without source
 * metadata (the synthetic demo) keeps 2 m with 10 m index lines. For imported
 * terrain the interval is never finer than the elevation source supports
 * (about 1 m for 3 m lidar, 2 m for 10 m data, 5 m for 30 m data such as
 * SRTM: contours finer than that would only show resampling, not the
 * ground), and is widened until the relief needs at most 40 levels.
 */
export function contourIntervals(terrain: TerrainDataset): ContourIntervals {
  const metadata = terrain.metadata;
  if (!metadata) return { minor: 2, index: 10 };
  const res = metadata.elevationResolutionM;
  const finest = res === null ? 5 : res <= 3 ? 1 : res <= 10 ? 2 : res <= 30 ? 5 : 10;
  const { min, max } = elevationRange(terrain);
  const relief = Math.max(0, max - min);
  const minor = NICE_INTERVALS.find((v) => v >= finest && relief / v <= MAX_CONTOUR_LEVELS) ?? 100;
  return { minor, index: minor * 5 };
}

export interface ContourLevel {
  /** Elevation in metres. */
  readonly level: number;
  /** Line segments as map coordinates x1, y1, x2, y2, x1, … */
  readonly segments: readonly number[];
}

/**
 * Contour lines every `interval` metres, traced on the terrain triangles
 * (`terrainTriangleIndices`) so they match the simulated surface exactly.
 *
 * One pass over the triangles: each is visited only for the levels between
 * its lowest and highest corner (the only ones that can cross it), and each
 * level's segments come out in triangle order, as a pass per level gave them.
 */
export function contourLines(terrain: TerrainDataset, interval: number): ContourLevel[] {
  const { originX, originY, cellSize, columns, elevations } = terrain.heightfield;
  const triangles = terrainTriangleIndices(terrain);
  const x = (i: number) => originX + (i % columns) * cellSize;
  const y = (i: number) => originY + Math.floor(i / columns) * cellSize;
  const z = (i: number) => elevations[i] ?? 0;

  const { min, max } = elevationRange(terrain);
  const first = Math.ceil(min / interval);
  const levels: { level: number; segments: number[] }[] = [];
  for (let n = first; n * interval <= max; n += 1)
    levels.push({ level: n * interval, segments: [] });
  const corners = [0, 0, 0];
  for (let t = 0; t < triangles.length; t += 3) {
    corners[0] = triangles[t] ?? 0;
    corners[1] = triangles[t + 1] ?? 0;
    corners[2] = triangles[t + 2] ?? 0;
    const z0 = z(corners[0]);
    const z1 = z(corners[1]);
    const z2 = z(corners[2]);
    const low = Math.min(z0, z1, z2);
    const high = Math.max(z0, z1, z2);
    // A level crosses the triangle when some corner is below it and some at or above it.
    // Start one level early so that rounding in the division never skips a level.
    for (let k = Math.max(0, Math.floor(low / interval) - first - 1); k < levels.length; k += 1) {
      const entry = levels[k];
      if (!entry) break;
      const { level, segments } = entry;
      if (level > high) break;
      if (!(level > low)) continue;
      let found = 0;
      for (let e = 0; e < 3; e += 1) {
        const a = corners[e] ?? 0;
        const b = corners[(e + 1) % 3] ?? 0;
        // A corner exactly on the level counts as above it, so each crossing is found once.
        if (z(a) >= level !== z(b) >= level) {
          const f = (level - z(a)) / (z(b) - z(a));
          segments.push(x(a) + f * (x(b) - x(a)), y(a) + f * (y(b) - y(a)));
          found += 1;
        }
      }
      // Two crossings make a segment (always the case here; kept as a guard).
      if (found !== 2) segments.length -= 2 * found;
    }
  }
  return levels;
}

export function elevationRange(terrain: TerrainDataset): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const e of terrain.heightfield.elevations) {
    min = Math.min(min, e);
    max = Math.max(max, e);
  }
  return { min, max };
}

// --- Spot heights (docs/adr/0024) --------------------------------------------

/** A summit: where it is, its height, and how far it rises above the ground joining it to higher ground. */
export interface SpotHeight {
  readonly x: number;
  readonly y: number;
  /** Metres, as the heightfield gives it. */
  readonly elevation: number;
  /** Metres above the highest saddle leading to higher ground (the highest summit: above the lowest sample). */
  readonly prominence: number;
}

/** Summits less prominent than this are never marked. */
export const SPOT_HEIGHT_MIN_PROMINENCE_M = 2;
/** Summits this close to the terrain's edge may be slopes rising beyond it, and are not marked. */
export const SPOT_HEIGHT_EDGE_MARGIN_M = 50;
/** A sample this far above all its neighbours is taken for a data spike, not a summit. */
export const SPOT_HEIGHT_SPIKE_M = 15;

/**
 * The terrain's summits, most prominent first (then highest, then south-west
 * first). Prominence is found by flooding the heightfield from the top: samples
 * are taken highest first, each joining the "islands" of its eight
 * neighbours taken before it; where two islands meet, the summit of the lower
 * one gets its prominence (its height above the meeting point). A flat top is
 * marked at its middle sample. Summits near the edge, data spikes and summits
 * less prominent than `SPOT_HEIGHT_MIN_PROMINENCE_M` are left out.
 * Deterministic: equal heights are taken in sample order.
 */
export function spotHeights(terrain: TerrainDataset): SpotHeight[] {
  const { originX, originY, cellSize, columns: C, rows: R, elevations: E } = terrain.heightfield;
  const n = C * R;
  const z = (i: number) => E[i] ?? 0;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  order.sort((a, b) => z(b) - z(a) || a - b);
  const parent = new Int32Array(n).fill(-1);
  const summitOf = new Int32Array(n);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    // Path compression.
    let k = i;
    while (parent[k] !== r) {
      const next = parent[k] ?? r;
      parent[k] = r;
      k = next;
    }
    return r;
  };
  const prominence = new Map<number, number>();
  for (const i of order) {
    parent[i] = i;
    summitOf[i] = i;
    const c = i % C;
    const r = (i - c) / C;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const cc = c + dc;
        const rr = r + dr;
        if ((dr === 0 && dc === 0) || cc < 0 || rr < 0 || cc >= C || rr >= R) continue;
        const j = rr * C + cc;
        if (parent[j] === -1) continue;
        const a = find(i);
        const b = find(j);
        if (a === b) continue;
        const sa = summitOf[a] ?? a;
        const sb = summitOf[b] ?? b;
        // The island with the higher summit (the earlier in order on a tie) absorbs the other.
        const aHigher = z(sa) > z(sb) || (z(sa) === z(sb) && sa < sb);
        const [high, low] = aHigher ? [a, b] : [b, a];
        const lowSummit = summitOf[low] ?? low;
        prominence.set(lowSummit, z(lowSummit) - z(i));
        parent[low] = high;
      }
    }
  }
  const top = order[0];
  const bottom = order[n - 1];
  if (top !== undefined && bottom !== undefined) prominence.set(top, z(top) - z(bottom));

  const margin = Math.ceil(SPOT_HEIGHT_EDGE_MARGIN_M / cellSize);
  const spots: (SpotHeight & { readonly index: number })[] = [];
  for (const [summit, p] of prominence) {
    if (p < SPOT_HEIGHT_MIN_PROMINENCE_M) continue;
    // The middle of a flat top: its samples of exactly the summit's height.
    const flat = [summit];
    const seen = new Set(flat);
    // Iterating an array while appending to it visits the appended samples too.
    for (const i of flat) {
      const c = i % C;
      const r = (i - c) / C;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const cc = c + dc;
          const rr = r + dr;
          const j = rr * C + cc;
          if (cc < 0 || rr < 0 || cc >= C || rr >= R || seen.has(j) || z(j) !== z(summit)) continue;
          seen.add(j);
          flat.push(j);
        }
      }
    }
    const mc = flat.reduce((s, i) => s + (i % C), 0) / flat.length;
    const mr = flat.reduce((s, i) => s + Math.floor(i / C), 0) / flat.length;
    let at = summit;
    let best = Number.POSITIVE_INFINITY;
    for (const i of [...flat].sort((a, b) => a - b)) {
      const d = Math.hypot((i % C) - mc, Math.floor(i / C) - mr);
      if (d < best) {
        best = d;
        at = i;
      }
    }
    const c = at % C;
    const r = (at - c) / C;
    if (c < margin || r < margin || c >= C - margin || r >= R - margin) continue;
    // A single sample standing far above every neighbour is a data spike.
    let neighbours = Number.NEGATIVE_INFINITY;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr !== 0 || dc !== 0) neighbours = Math.max(neighbours, z((r + dr) * C + c + dc));
      }
    }
    if (z(at) - neighbours > SPOT_HEIGHT_SPIKE_M) continue;
    spots.push({
      x: originX + c * cellSize,
      y: originY + r * cellSize,
      elevation: z(at),
      prominence: p,
      index: at,
    });
  }
  spots.sort(
    (a, b) => b.prominence - a.prominence || b.elevation - a.elevation || a.index - b.index,
  );
  return spots.map(({ x, y, elevation, prominence: p }) => ({ x, y, elevation, prominence: p }));
}

/** A spot height's label: whole metres. */
export const spotHeightLabel = (s: SpotHeight): string => String(Math.round(s.elevation));

/** Approximate label width per character (10 px font) and height, for decluttering. */
const SPOT_CHAR_PX = 6;
const SPOT_LABEL_HEIGHT_PX = 12;
/** Gap from the dot to its label, and padding kept clear around each mark. */
export const SPOT_LABEL_OFFSET_PX = 5;
const SPOT_PADDING_PX = 4;

/**
 * The spot heights to show at a zoom (metres per screen pixel), most
 * prominent first: those at least twice as prominent as a screen pixel is
 * wide (so zooming in reveals smaller knolls), each placed only if its dot
 * and label clear every mark already placed. The same for the whole map
 * whatever part of it is drawn, so pieces of the map drawn separately agree.
 */
export function placeSpotHeights(
  spots: readonly SpotHeight[],
  metersPerPixel: number,
): SpotHeight[] {
  const minProminence = Math.max(SPOT_HEIGHT_MIN_PROMINENCE_M, 2 * metersPerPixel);
  const placed: { s: SpotHeight; x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const s of spots) {
    if (s.prominence < minProminence) continue;
    // The dot and the label to its right, in metres at this zoom.
    const width = SPOT_LABEL_OFFSET_PX + spotHeightLabel(s).length * SPOT_CHAR_PX;
    const box = {
      s,
      x0: s.x - (3 + SPOT_PADDING_PX) * metersPerPixel,
      x1: s.x + (width + SPOT_PADDING_PX) * metersPerPixel,
      y0: s.y - (SPOT_LABEL_HEIGHT_PX / 2 + SPOT_PADDING_PX) * metersPerPixel,
      y1: s.y + (SPOT_LABEL_HEIGHT_PX / 2 + SPOT_PADDING_PX) * metersPerPixel,
    };
    if (placed.some((p) => p.x0 < box.x1 && box.x0 < p.x1 && p.y0 < box.y1 && box.y0 < p.y1)) {
      continue;
    }
    placed.push(box);
  }
  return placed.map((p) => p.s);
}
