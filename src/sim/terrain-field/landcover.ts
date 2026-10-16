import type { Building, EnvironmentFeatures, LandUseKind } from '../environment';
import type { Vec2 } from '../geometry';
import { gradientNoise } from './noise';

// What covers the ground, on a 2 m raster (research §5.3): it shapes the
// small-scale relief and the ground's materials. Polygons are filled by the
// even-odd rule (holes excluded), in a fixed order by priority and id, so the
// raster depends only on the features.

export const Cover = {
  Open: 0,
  Meadow: 1,
  Farmland: 2,
  Woodland: 3,
  Scrub: 4,
  Urban: 5,
  Beach: 6,
  Shingle: 7,
  Rock: 8,
  Mud: 9,
  Military: 10,
  Lawn: 11,
  Orchard: 12,
  Paved: 13,
  Copse: 14,
} as const;
export type Cover = (typeof Cover)[keyof typeof Cover];
export const COVER_COUNT = 15;

/** Wavelengths of the relief's octaves, metres (fixed, so covers blend by amplitude only). */
export const RELIEF_WAVELENGTHS = [28, 14, 7, 3.5] as const;

/** Relief amplitudes per octave (metres) and ground materials per cover. */
export interface CoverLook {
  readonly relief: readonly [number, number, number, number];
  /** Material weights: grass, bare soil, leaf litter (each 0–1). */
  readonly grass: number;
  readonly soil: number;
  readonly litter: number;
  /**
   * Share of the ground that is paved (0–1): towns are mostly paved (streets
   * and pavements, yards), mapped hard ground wholly (docs/adr/0048).
   */
  readonly paved: number;
  /** Share of the ground that is bare sand (0–1): beaches and dunes (absent: none). */
  readonly sand?: number;
}

export const COVER_LOOK: Readonly<Record<Cover, CoverLook>> = {
  [Cover.Open]: { relief: [0.08, 0.08, 0.04, 0.02], grass: 0.95, soil: 0.05, litter: 0, paved: 0 },
  [Cover.Meadow]: {
    relief: [0.08, 0.07, 0.035, 0.015],
    grass: 1,
    soil: 0.02,
    litter: 0,
    paved: 0,
  },
  [Cover.Farmland]: {
    relief: [0.1, 0.03, 0.015, 0.01],
    grass: 0.35,
    soil: 0.75,
    litter: 0,
    paved: 0,
  },
  [Cover.Woodland]: {
    relief: [0.15, 0.14, 0.1, 0.05],
    grass: 0.15,
    soil: 0.2,
    litter: 0.9,
    paved: 0,
  },
  [Cover.Scrub]: {
    relief: [0.08, 0.1, 0.08, 0.04],
    grass: 0.75,
    soil: 0.2,
    litter: 0.25,
    paved: 0,
  },
  // Towns: mostly paved; gardens and courtyards (field.ts) green.
  [Cover.Urban]: { relief: [0.02, 0.01, 0, 0], grass: 0.85, soil: 0.03, litter: 0, paved: 0.75 },
  // Sand: its own material over the whole beach (not soil in patches, nor only at the water's edge).
  [Cover.Beach]: {
    relief: [0.06, 0.07, 0.03, 0.01],
    grass: 0.05,
    soil: 0.1,
    litter: 0,
    paved: 0,
    sand: 1,
  },
  [Cover.Shingle]: { relief: [0.04, 0.04, 0.03, 0.015], grass: 0, soil: 0.1, litter: 0, paved: 0 },
  [Cover.Rock]: { relief: [0.1, 0.12, 0.1, 0.06], grass: 0.1, soil: 0.3, litter: 0, paved: 0 },
  [Cover.Mud]: { relief: [0.03, 0.03, 0.02, 0.01], grass: 0.1, soil: 0.4, litter: 0, paved: 0 },
  [Cover.Military]: {
    relief: [0.06, 0.08, 0.07, 0.04],
    grass: 0.9,
    soil: 0.12,
    litter: 0,
    paved: 0,
  },
  [Cover.Lawn]: { relief: [0.02, 0.02, 0.005, 0], grass: 1, soil: 0, litter: 0, paved: 0 },
  [Cover.Orchard]: {
    relief: [0.05, 0.04, 0.02, 0.01],
    grass: 0.95,
    soil: 0.05,
    litter: 0.1,
    paved: 0,
  },
  // A small wood (a copse, garden or street trees): grass under the trees, a little litter.
  [Cover.Copse]: {
    relief: [0.04, 0.03, 0.02, 0.01],
    grass: 0.8,
    soil: 0.05,
    litter: 0.3,
    paved: 0,
  },
  // Car parks, squares, pedestrian areas, mapped carriageways and footways: flat.
  // Their paving comes from their exact outlines (paved.ts), not from these 2 m
  // cells (whose edges are steps): here, grass as open ground.
  [Cover.Paved]: { relief: [0, 0, 0, 0], grass: 0.95, soil: 0.05, litter: 0, paved: 0 },
};

const LAND_USE_COVER: Readonly<Record<LandUseKind, Cover>> = {
  farmland: Cover.Farmland,
  meadow: Cover.Meadow,
  orchard: Cover.Orchard,
  residential: Cover.Urban,
  commercial: Cover.Urban,
  industrial: Cover.Urban,
  military: Cover.Military,
  cemetery: Cover.Lawn,
  recreation: Cover.Lawn,
  paved: Cover.Paved,
  other: Cover.Open,
  beach: Cover.Beach,
  shingle: Cover.Shingle,
  bareRock: Cover.Rock,
  mud: Cover.Mud,
};

/** Fill priority: a higher one paints over a lower one. */
const PRIORITY: Readonly<Record<Cover, number>> = {
  [Cover.Open]: 0,
  [Cover.Urban]: 1,
  [Cover.Military]: 1,
  [Cover.Lawn]: 2,
  [Cover.Paved]: 2.5,
  [Cover.Farmland]: 3,
  [Cover.Meadow]: 3,
  [Cover.Orchard]: 3,
  [Cover.Mud]: 4,
  [Cover.Beach]: 4,
  [Cover.Shingle]: 4,
  [Cover.Rock]: 4,
  [Cover.Scrub]: 5,
  [Cover.Woodland]: 6,
  [Cover.Copse]: 6,
};

export const COVER_CELL_M = 2;
/** Woods smaller than this (m²) are copses: grass under the trees, not a forest floor. */
export const COPSE_MAX_M2 = 2500;

function ringArea(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a && b) s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}
/** Cells this close to a building (metres) are built-up (roads get kerbs, not ditches). */
export const BUILT_UP_REACH_M = 20;
const BUILT_CELL_M = 8;

export interface CoverMap {
  readonly originX: number;
  readonly originY: number;
  readonly columns: number;
  readonly rows: number;
  readonly cover: Uint8Array;
  /** Cells near a boundary between covers (within reach of a wood's blended edge). */
  readonly edge: Uint8Array;
  /** Whether a point is in a built-up area (buildings within `BUILT_UP_REACH_M`). */
  builtUp(x: number, y: number): boolean;
  /** The cover of the cell at (x, y). */
  at(x: number, y: number): Cover;
}

function fillRings(
  rings: readonly (readonly Vec2[])[],
  cell: number,
  ox: number,
  oy: number,
  columns: number,
  rows: number,
  paint: (index: number) => void,
): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings)
    for (const p of ring) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  const r0 = Math.max(0, Math.ceil((minY - oy) / cell - 0.5));
  const r1 = Math.min(rows - 1, Math.floor((maxY - oy) / cell - 0.5));
  if (r1 < r0) return;
  const crossings: number[][] = [];
  for (let r = r0; r <= r1; r += 1) crossings.push([]);
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (!a || !b || a.y === b.y) continue;
      const lo = a.y < b.y ? a : b;
      const hi = a.y < b.y ? b : a;
      // Rows whose centre y is in [lo.y, hi.y).
      const ra = Math.max(r0, Math.ceil((lo.y - oy) / cell - 0.5));
      const rb = Math.min(r1, Math.ceil((hi.y - oy) / cell - 0.5) - 1);
      for (let r = ra; r <= rb; r += 1) {
        const y = oy + (r + 0.5) * cell;
        crossings[r - r0]?.push(lo.x + ((y - lo.y) * (hi.x - lo.x)) / (hi.y - lo.y));
      }
    }
  }
  for (let r = r0; r <= r1; r += 1) {
    const xs = crossings[r - r0];
    if (!xs || xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(((xs[k] ?? 0) - ox) / cell - 0.5));
      const c1 = Math.min(columns - 1, Math.floor(((xs[k + 1] ?? 0) - ox) / cell - 0.5));
      for (let c = c0; c <= c1; c += 1) paint(r * columns + c);
    }
  }
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function coverMap(
  features: EnvironmentFeatures,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): CoverMap {
  const cell = COVER_CELL_M;
  const ox = bounds.minX;
  const oy = bounds.minY;
  const columns = Math.ceil((bounds.maxX - ox) / cell) + 1;
  const rows = Math.ceil((bounds.maxY - oy) / cell) + 1;
  const cover = new Uint8Array(columns * rows);
  const areas: { cover: Cover; rings: (readonly Vec2[])[]; id: string }[] = [];
  for (const a of [...(features.landUse ?? [])].sort(byId))
    areas.push({
      cover: LAND_USE_COVER[a.kind],
      rings: [a.boundary, ...(a.holes ?? [])],
      id: a.id,
    });
  for (const v of [...features.vegetation].sort(byId))
    areas.push({
      cover:
        v.kind === 'scrub'
          ? Cover.Scrub
          : ringArea(v.boundary) < COPSE_MAX_M2
            ? Cover.Copse
            : Cover.Woodland,
      rings: [v.boundary, ...(v.holes ?? [])],
      id: v.id,
    });
  // Lower priorities first; ties in id order.
  areas.sort(
    (a, b) => PRIORITY[a.cover] - PRIORITY[b.cover] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const area of areas) {
    const value = area.cover;
    fillRings(area.rings, cell, ox, oy, columns, rows, (i) => {
      cover[i] = value;
    });
  }

  // Built-up: cells of 8 m within reach of a building's bounding box.
  const bc = Math.ceil((bounds.maxX - ox) / BUILT_CELL_M) + 1;
  const br = Math.ceil((bounds.maxY - oy) / BUILT_CELL_M) + 1;
  const built = new Uint8Array(bc * br);
  const mark = (b: Building) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of b.footprint) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    const c0 = Math.max(0, Math.floor((x0 - BUILT_UP_REACH_M - ox) / BUILT_CELL_M));
    const c1 = Math.min(bc - 1, Math.floor((x1 + BUILT_UP_REACH_M - ox) / BUILT_CELL_M));
    const r0 = Math.max(0, Math.floor((y0 - BUILT_UP_REACH_M - oy) / BUILT_CELL_M));
    const r1 = Math.min(br - 1, Math.floor((y1 + BUILT_UP_REACH_M - oy) / BUILT_CELL_M));
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) built[r * bc + c] = 1;
  };
  for (const b of features.buildings) mark(b);

  // Cells within reach of a boundary between covers: only there is a wood's edge blended.
  const edge = new Uint8Array(columns * rows);
  for (let r = 0; r < rows; r += 1)
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      const v = cover[i];
      if ((c + 1 < columns && cover[i + 1] !== v) || (r + 1 < rows && cover[i + columns] !== v))
        edge[i] = 1;
    }
  const reach = Math.ceil((EDGE_BLEND_M + EDGE_WARP_M) / cell) + 2;
  // Grown by `reach` cells: along the rows, then the columns.
  const along = (
    from: Uint8Array,
    n: number,
    count: number,
    at: (line: number, k: number) => number,
  ) => {
    const to = new Uint8Array(from.length);
    for (let line = 0; line < count; line += 1) {
      let last = -Infinity;
      for (let k = 0; k < n; k += 1) {
        if (from[at(line, k)]) last = k;
        if (k - last <= reach) to[at(line, k)] = 1;
      }
      let next = Infinity;
      for (let k = n - 1; k >= 0; k -= 1) {
        if (from[at(line, k)]) next = k;
        if (next - k <= reach) to[at(line, k)] = 1;
      }
    }
    return to;
  };
  const byRow = along(edge, columns, rows, (r, c) => r * columns + c);
  edge.set(along(byRow, rows, columns, (c, r) => r * columns + c));

  return {
    originX: ox,
    originY: oy,
    columns,
    rows,
    cover,
    edge,
    builtUp(x, y) {
      const c = Math.floor((x - ox) / BUILT_CELL_M);
      const r = Math.floor((y - oy) / BUILT_CELL_M);
      if (c < 0 || r < 0 || c >= bc || r >= br) return false;
      return built[r * bc + c] === 1;
    },
    at(x, y) {
      const c = Math.floor((x - ox) / cell);
      const r = Math.floor((y - oy) / cell);
      if (c < 0 || r < 0 || c >= columns || r >= rows) return Cover.Open;
      return (cover[r * columns + c] ?? 0) as Cover;
    },
  };
}

/**
 * Woods' edges (their litter, grass and soil, and relief) blend over this far
 * either side of the mapped edge, metres, along a line wavering by up to
 * `EDGE_WARP_M` over about `EDGE_WAVE_M`: a forest floor thins out into
 * grass, not along a straight line. Other edges (fields, towns, paved ground)
 * stay as mapped.
 */
export const EDGE_BLEND_M = 3.5;
export const EDGE_WARP_M = 3;
const EDGE_WAVE_M = 17;
/** Blur taps: the centre and eight round it, in units of `EDGE_BLEND_M`. */
const TAPS = [
  [0, 0, 2],
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [0.7, 0.7, 1],
  [-0.7, 0.7, 1],
  [0.7, -0.7, 1],
  [-0.7, -0.7, 1],
] as const;
const TAP_WEIGHT = TAPS.reduce((s, [, , w]) => s + w, 0);
/** Litter at which a point counts as at a wood's edge, fully blended. */
const EDGE_LITTER = 0.08;
const tap = new Float64Array(10);
const blur = new Float64Array(7);

/**
 * The cover's look at (x, y): blended bilinearly between the four nearest
 * cells, so relief and materials change smoothly across a boundary, and at a
 * wood's edge over a wider, wavering band (`EDGE_BLEND_M`). Writes
 * [amp0, amp1, amp2, amp3, grass, soil, litter, urban, paved, sand] into
 * `out` (urban: 1 in towns and on mapped hard ground; urban, paved and sand
 * never blended at a wood's edge).
 */
export function coverLookAt(map: CoverMap, x: number, y: number, out: Float64Array): void {
  sharpLookAt(map, x, y, out);
  const c = Math.floor((x - map.originX) / COVER_CELL_M);
  const r = Math.floor((y - map.originY) / COVER_CELL_M);
  if (c < 0 || r < 0 || c >= map.columns || r >= map.rows || !map.edge[r * map.columns + c]) return;
  const wx = x + EDGE_WARP_M * gradientNoise(x / EDGE_WAVE_M, y / EDGE_WAVE_M, 0x3e1d);
  const wy = y + EDGE_WARP_M * gradientNoise(x / EDGE_WAVE_M + 31.7, y / EDGE_WAVE_M, 0x7a59);
  blur.fill(0);
  for (const [dx, dy, w] of TAPS) {
    sharpLookAt(map, wx + dx * EDGE_BLEND_M, wy + dy * EDGE_BLEND_M, tap);
    for (let o = 0; o < 7; o += 1) blur[o] = (blur[o] ?? 0) + w * (tap[o] ?? 0);
  }
  const litter = Math.max(out[6] ?? 0, (blur[6] ?? 0) / TAP_WEIGHT);
  const t = litter >= EDGE_LITTER ? 1 : litter / EDGE_LITTER;
  if (t === 0) return;
  for (let o = 0; o < 7; o += 1)
    out[o] = (out[o] ?? 0) + t * ((blur[o] ?? 0) / TAP_WEIGHT - (out[o] ?? 0));
}

/** The cover's look at (x, y), blended bilinearly between the four nearest cells; as `coverLookAt`. */
function sharpLookAt(map: CoverMap, x: number, y: number, out: Float64Array): void {
  const gx = (x - map.originX) / COVER_CELL_M - 0.5;
  const gy = (y - map.originY) / COVER_CELL_M - 0.5;
  const c = Math.floor(gx);
  const r = Math.floor(gy);
  const tx = gx - c;
  const ty = gy - r;
  out.fill(0);
  for (let k = 0; k < 4; k += 1) {
    const cc = c + (k & 1);
    const rr = r + (k >> 1);
    const w = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty);
    if (w === 0) continue;
    const inside = cc >= 0 && rr >= 0 && cc < map.columns && rr < map.rows;
    const cov = (inside ? (map.cover[rr * map.columns + cc] ?? 0) : 0) as Cover;
    const look = COVER_LOOK[cov];
    for (let o = 0; o < 4; o += 1) out[o] = (out[o] ?? 0) + w * (look.relief[o] ?? 0);
    out[4] = (out[4] ?? 0) + w * look.grass;
    out[5] = (out[5] ?? 0) + w * look.soil;
    out[6] = (out[6] ?? 0) + w * look.litter;
    out[7] = (out[7] ?? 0) + w * (cov === Cover.Urban || cov === Cover.Paved ? 1 : 0);
    out[8] = (out[8] ?? 0) + w * look.paved;
    out[9] = (out[9] ?? 0) + w * (look.sand ?? 0);
  }
}
