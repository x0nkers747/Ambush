import { heightAt, waterQuery, type TerrainDataset } from '#sim';
import type { MeshData } from './drape';
import { srgbToLinear } from './terrain-mesh';
import { urbanGrid, type UrbanGrid } from './water-profiles';

// Shorelines in 3D (docs/adr/0046). The graded ground (sim/grading.ts) meets
// the water's level at the mapped shore, but where a building pad or a road
// embankment overlaps a water area the grading keeps it above the water, and
// the shore is the ground's 2.5 m lattice wherever it crosses the level: seen
// in 3D, lattice triangles of bank stand out of the water along the shore.
// The authoritative ground stays as it is; the 3D view instead
//
// - cuts the terrain's pixels that stand above the water inside it (the
//   terrain shader reads a shore mask: the signed distance to the shore and
//   the water's level, sampled on a grid of 1–2 m), so the land ends exactly
//   at the mapped shore, straight where the shore is straight;
// - closes the cut with a wall along the shore, from the ground down into the
//   water: a vertical brick quay on a built-up shore, a short earth bank
//   sloping into the water elsewhere. Only where the ground at the shore
//   stands above the water: a shore graded down to the level needs none.
//
// Pure and deterministic: everything comes from the graded terrain and its
// features. Computed in the generation worker with the other features.

/** Signed distances are kept to ±this, metres (8-bit, about 3 cm a step). */
export const SHORE_RANGE_M = 4;
/** The cut and the walls stand this far inside the mapped water, metres (covers the mask's rounding at corners). */
export const SHORE_INSET_M = 0.3;
/**
 * Terrain is cut where it stands more than this above the water, metres:
 * also ground the grading held at the level, which would show through the
 * water in flecks along its triangles' edges.
 */
export const SHORE_CUT_M = 0.02;
/** The mask's spacing: as fine as this, metres… */
export const MASK_MIN_STEP_M = 1;
/** …with at most this many samples along a side. */
export const MASK_MAX_SAMPLES = 2560;
/** Water levels in the mask, metres a step (16 bits from `levelBase`). */
export const MASK_LEVEL_STEP_M = 0.01;
/** Walls reach this far below the water, metres. */
export const WALL_FOOT_M = 0.5;
/** The damp band on a quay above the water, metres. */
const WET_BAND_M = 0.3;
/** Walls lower than this above the water are one quad per piece, their top lifted a little to cover the ground's edge, metres. */
const LOW_WALL_M = 0.3;
const LOW_WALL_LIFT_M = 0.03;
/** A quay's coping reaches this far back from the wall: past the steep bank the 2.5 m lattice makes, metres. */
export const QUAY_CAP_M = 2;
/** A built-up shore gets a quay where the street behind it stands this far above the water, metres. */
export const QUAY_MIN_M = 0.25;
/** Quay tops follow the street, sampled at least this often along the shore, metres. */
const QUAY_STEP_M = 4;
/** The coping stands this far above the street (it covers the ground's edge there), metres. */
const QUAY_LIFT_M = 0.03;
/** Shore polylines are simplified to within this, metres: a straight shore is one straight wall. */
const SIMPLIFY_M = 0.05;
/** Banks slope into the water this much per metre of their height, at most this far, metres. */
const BANK_RUN = 0.9;
const BANK_MAX_RUN_M = 1.5;

/** Where the mask's samples are: sample (c, r) at (originX + c·step, originY + r·step). */
export interface ShoreGrid {
  readonly originX: number;
  readonly originY: number;
  readonly step: number;
  readonly columns: number;
  readonly rows: number;
}

/**
 * The shore's signed distance and the water's level on a grid: distance to
 * the nearest shore of levelled water, negative in the water (±`SHORE_RANGE_M`
 * at most), and in the water its level (NaN elsewhere).
 */
export interface ShoreField {
  readonly grid: ShoreGrid;
  readonly distance: Float32Array;
  readonly level: Float32Array;
}

/** The mask the shaders read: RGBA8, R the signed distance, G and B the level, A natural shallows. */
export interface ShoreMask {
  readonly grid: ShoreGrid;
  /** The level G·256 + B steps above this, metres. */
  readonly levelBase: number;
  readonly pixels: Uint8Array;
}

/** A wall mesh, with world-space texture coordinates (metres along the wall, and up). */
export interface WallMesh extends MeshData {
  readonly uvs: Float32Array;
}

export interface ShorelineStats {
  readonly maskSamples: number;
  /** Samples in levelled water, and in it with the ground above the water (the cut). */
  readonly waterSamples: number;
  readonly cutSamples: number;
  readonly quayMeters: number;
  readonly bankMeters: number;
  readonly ms: number;
}

export interface Shoreline {
  readonly mask: ShoreMask;
  readonly quay: WallMesh;
  readonly bank: WallMesh;
  readonly stats: ShorelineStats;
}

/** The mask's grid for a terrain: its extent, square samples. */
export function shoreGrid(terrain: TerrainDataset): ShoreGrid {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const width = (columns - 1) * cellSize;
  const height = (rows - 1) * cellSize;
  const step = Math.max(MASK_MIN_STEP_M, Math.max(width, height) / (MASK_MAX_SAMPLES - 1));
  return {
    originX,
    originY,
    step,
    columns: Math.max(2, Math.ceil(width / step) + 1),
    rows: Math.max(2, Math.ceil(height / step) + 1),
  };
}

/** The shore field of a graded terrain, or null when it has no levelled water. */
export function shoreField(terrain: TerrainDataset): ShoreField | null {
  const surfaces = terrain.grading?.water;
  if (!surfaces) return null;
  const grid = shoreGrid(terrain);
  const { originX, originY, step, columns, rows } = grid;
  const hf = terrain.heightfield;
  // Blocks of B×B samples: a block whose corners have no water within the
  // query's reach has none at all, and one whose corners are all that deep
  // in water is water throughout.
  const B = 4;
  const query = waterQuery(
    terrain.features,
    surfaces,
    {
      originX: hf.originX,
      originY: hf.originY,
      maxX: hf.originX + (hf.columns - 1) * hf.cellSize,
      maxY: hf.originY + (hf.rows - 1) * hf.cellSize,
    },
    SHORE_RANGE_M + B * step * Math.SQRT2,
  );
  if (!query.any) return null;
  const distance = new Float32Array(columns * rows).fill(SHORE_RANGE_M);
  const level = new Float32Array(columns * rows).fill(Number.NaN);
  for (let r0 = 0; r0 < rows; r0 += B) {
    for (let c0 = 0; c0 < columns; c0 += B) {
      const r1 = Math.min(rows - 1, r0 + B);
      const c1 = Math.min(columns - 1, c0 + B);
      const corners = [
        query.at(originX + c0 * step, originY + r0 * step),
        query.at(originX + c1 * step, originY + r0 * step),
        query.at(originX + c0 * step, originY + r1 * step),
        query.at(originX + c1 * step, originY + r1 * step),
      ];
      if (corners.every((a) => a === null)) continue;
      const rEnd = Math.min(rows, r0 + B);
      const cEnd = Math.min(columns, c0 + B);
      if (corners.every((a) => a?.inWater && a.shoreDistance >= query.reach)) {
        // Deep in water: the level between the corners' (levels change slowly).
        const [l00, l10, l01, l11] = corners.map((x) => x?.level ?? 0) as [
          number,
          number,
          number,
          number,
        ];
        for (let r = r0; r < rEnd; r += 1) {
          const v = r1 > r0 ? (r - r0) / (r1 - r0) : 0;
          for (let c = c0; c < cEnd; c += 1) {
            const u = c1 > c0 ? (c - c0) / (c1 - c0) : 0;
            const i = r * columns + c;
            distance[i] = -SHORE_RANGE_M;
            level[i] = (l00 * (1 - u) + l10 * u) * (1 - v) + (l01 * (1 - u) + l11 * u) * v;
          }
        }
        continue;
      }
      for (let r = r0; r < rEnd; r += 1) {
        for (let c = c0; c < cEnd; c += 1) {
          const at = query.at(originX + c * step, originY + r * step);
          if (!at) continue;
          const i = r * columns + c;
          const d = Math.min(at.shoreDistance, SHORE_RANGE_M);
          distance[i] = at.inWater ? -d : d;
          if (at.inWater) level[i] = at.level;
        }
      }
    }
  }
  return { grid, distance, level };
}

/**
 * Takes convex polygons (flat [x0, y0, x1, y1, …]) out of the water: where the
 * 3D view cuts its water sheet away (under low bridge decks, over roads on a
 * bank, docs/adr/0044), the ground is never cut either. In place.
 */
export function carveShoreField(field: ShoreField, polygons: readonly (readonly number[])[]): void {
  const { originX, originY, step, columns, rows } = field.grid;
  for (const poly of polygons) {
    const n = poly.length / 2;
    if (n < 3) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let area = 0;
    for (let i = 0; i < n; i += 1) {
      const x = poly[2 * i] ?? 0;
      const y = poly[2 * i + 1] ?? 0;
      const j = (i + 1) % n;
      area += x * (poly[2 * j + 1] ?? 0) - (poly[2 * j] ?? 0) * y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (Math.abs(area) < 1e-9) continue;
    const sign = area > 0 ? 1 : -1;
    const c0 = Math.max(0, Math.floor((minX - SHORE_RANGE_M - originX) / step));
    const c1 = Math.min(columns - 1, Math.ceil((maxX + SHORE_RANGE_M - originX) / step));
    const r0 = Math.max(0, Math.floor((minY - SHORE_RANGE_M - originY) / step));
    const r1 = Math.min(rows - 1, Math.ceil((maxY + SHORE_RANGE_M - originY) / step));
    for (let r = r0; r <= r1; r += 1) {
      const y = originY + r * step;
      for (let c = c0; c <= c1; c += 1) {
        const i = r * columns + c;
        const here = field.distance[i] ?? SHORE_RANGE_M;
        if (here >= SHORE_RANGE_M) continue;
        const x = originX + c * step;
        // Signed distance to the convex polygon, negative inside it.
        let inside = true;
        let d = Infinity;
        for (let k = 0; k < n; k += 1) {
          const ax = poly[2 * k] ?? 0;
          const ay = poly[2 * k + 1] ?? 0;
          const bx = poly[2 * ((k + 1) % n)] ?? 0;
          const by = poly[2 * ((k + 1) % n) + 1] ?? 0;
          if (sign * ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) < 0) inside = false;
          d = Math.min(d, segmentDistance(x, y, ax, ay, bx, by));
        }
        const sd = inside ? -d : d;
        // Water minus the polygon.
        field.distance[i] = Math.min(SHORE_RANGE_M, Math.max(here, -sd));
      }
    }
  }
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** The field's signed distance at (x, y), bilinear (as the shaders sample it). */
export function shoreDistanceAt(field: ShoreField, x: number, y: number): number {
  const { originX, originY, step, columns, rows } = field.grid;
  const gx = Math.min(Math.max((x - originX) / step, 0), columns - 1);
  const gy = Math.min(Math.max((y - originY) / step, 0), rows - 1);
  const c = Math.min(Math.floor(gx), columns - 2);
  const r = Math.min(Math.floor(gy), rows - 2);
  const u = gx - c;
  const v = gy - r;
  const d = field.distance;
  const i = r * columns + c;
  return (
    ((d[i] ?? 0) * (1 - u) + (d[i + 1] ?? 0) * u) * (1 - v) +
    ((d[i + columns] ?? 0) * (1 - u) + (d[i + columns + 1] ?? 0) * u) * v
  );
}

/**
 * The water's level near (x, y) when it is in or at the edge of levelled
 * water (within `margin` of its shore), else null: for display geometry that
 * should reach into the water (building walls, bridge piers).
 */
export function waterLevelNear(field: ShoreField, x: number, y: number, margin = 1): number | null {
  if (shoreDistanceAt(field, x, y) > margin) return null;
  const { originX, originY, step, columns, rows } = field.grid;
  const c = Math.round((x - originX) / step);
  const r = Math.round((y - originY) / step);
  // The nearest sample in the water (the point itself may be just ashore).
  let best = Number.NaN;
  let bestD = Infinity;
  const reach = Math.ceil((margin + SHORE_INSET_M) / step) + 1;
  for (let dr = -reach; dr <= reach; dr += 1) {
    for (let dc = -reach; dc <= reach; dc += 1) {
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= columns || rr >= rows) continue;
      const l = field.level[rr * columns + cc] ?? Number.NaN;
      if (Number.isNaN(l)) continue;
      const d = dc * dc + dr * dr;
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
  }
  return Number.isNaN(best) ? null : best;
}

/** Whether the 3D view cuts the ground away at (x, y): in the water, standing above it. */
export function groundCut(
  terrain: TerrainDataset,
  field: ShoreField,
  x: number,
  y: number,
): boolean {
  if (shoreDistanceAt(field, x, y) >= -SHORE_INSET_M) return false;
  const level = waterLevelNear(field, x, y, 0);
  const hf = terrain.heightfield;
  const cx = Math.min(hf.originX + (hf.columns - 1) * hf.cellSize, Math.max(hf.originX, x));
  const cy = Math.min(hf.originY + (hf.rows - 1) * hf.cellSize, Math.max(hf.originY, y));
  return level !== null && heightAt(terrain, cx, cy) > level + SHORE_CUT_M;
}

/** The mask for the shaders: natural shallows where the shore is not built-up. */
export function shoreMask(field: ShoreField, urban: UrbanGrid): ShoreMask {
  const { originX, originY, step, columns, rows } = field.grid;
  let base = Infinity;
  for (const l of field.level) if (!Number.isNaN(l)) base = Math.min(base, l);
  base = Number.isFinite(base) ? Math.floor(base) - 1 : 0;
  const pixels = new Uint8Array(columns * rows * 4);
  for (let r = 0; r < rows; r += 1) {
    const y = originY + r * step;
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      const d = field.distance[i] ?? SHORE_RANGE_M;
      const o = i * 4;
      pixels[o] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + d / (2 * SHORE_RANGE_M))));
      const l = field.level[i] ?? Number.NaN;
      if (!Number.isNaN(l)) {
        const q = Math.min(65535, Math.max(0, Math.round((l - base) / MASK_LEVEL_STEP_M)));
        pixels[o + 1] = q >> 8;
        pixels[o + 2] = q & 255;
      }
      pixels[o + 3] = d < SHORE_RANGE_M && !urban.at(originX + c * step, y) ? 255 : 0;
    }
  }
  return { grid: field.grid, levelBase: base, pixels };
}

/** The level a mask holds at sample (c, r), as the terrain shader decodes it. */
export function maskLevel(mask: ShoreMask, c: number, r: number): number {
  const o = (r * mask.grid.columns + c) * 4;
  return (
    mask.levelBase +
    ((mask.pixels[o + 1] ?? 0) * 256 + (mask.pixels[o + 2] ?? 0)) * MASK_LEVEL_STEP_M
  );
}

/** Floats appended to a typed array (no JavaScript array behind them: walls run to many thousands). */
class Floats {
  private data = new Float32Array(1024);
  length = 0;
  push(a: number, b: number, c?: number): void {
    const n = c === undefined ? 2 : 3;
    if (this.length + n > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length] = a;
    this.data[this.length + 1] = b;
    if (c !== undefined) this.data[this.length + 2] = c;
    this.length += n;
  }
  done(): Float32Array {
    return this.data.slice(0, this.length);
  }
}

interface WallBuffers {
  readonly positions: Floats;
  readonly normals: Floats;
  readonly colors: Floats;
  readonly uvs: Floats;
}

const wallBuffers = (): WallBuffers => ({
  positions: new Floats(),
  normals: new Floats(),
  colors: new Floats(),
  uvs: new Floats(),
});

const lin = (c: number): [number, number, number] => [
  srgbToLinear((c >> 16) & 255),
  srgbToLinear((c >> 8) & 255),
  srgbToLinear(c & 255),
];
/** Vertex colours (multiplying the walls' textures): dry above, damp at the water, dark below. */
const QUAY_DRY = lin(0xd8d0c8);
const QUAY_DAMP = lin(0x6e6a5c);
const QUAY_UNDER = lin(0x30382c);
const BANK_DRY = lin(0xc8bba6);
const BANK_DAMP = lin(0x6a5e4c);
const BANK_UNDER = lin(0x3a3a30);
/** A quay's coping: paving along its top. */
const QUAY_CAP = lin(0xa89c90);

function finishWalls(b: WallBuffers): WallMesh {
  return {
    positions: b.positions.done(),
    normals: b.normals.done(),
    colors: b.colors.done(),
    uvs: b.uvs.done(),
    triangleCount: b.positions.length / 9,
  };
}

/** One vertex of a wall: map x, y, z, its colour and texture coordinates. */
interface Row {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly u: number;
  readonly v: number;
  readonly color: readonly [number, number, number];
}

type Normal = readonly [number, number, number];

/** Two triangles between rows a and b over a span, each only if not a sliver, front faces along the normals. */
function quad(out: WallBuffers, a0: Row, a1: Row, b0: Row, b1: Row, n0: Normal, n1: Normal) {
  const tri = (p: Row, q: Row, s: Row, np: Normal, nq: Normal, ns: Normal) => {
    const ux = q.x - p.x;
    const uy = q.y - p.y;
    const uz = q.z - p.z;
    const vx = s.x - p.x;
    const vy = s.y - p.y;
    const vz = s.z - p.z;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-8) return;
    // Front face along the normals (towards the water, or up).
    const facing =
      cx * (np[0] + nq[0] + ns[0]) + cy * (np[1] + nq[1] + ns[1]) + cz * (np[2] + nq[2] + ns[2]);
    const order = facing >= 0 ? [p, q, s] : [p, s, q];
    const norms = facing >= 0 ? [np, nq, ns] : [np, ns, nq];
    order.forEach((v, k) => {
      const n = norms[k] ?? np;
      out.positions.push(v.x, v.z, -v.y);
      out.normals.push(n[0], n[2], -n[1]);
      out.colors.push(v.color[0], v.color[1], v.color[2]);
      out.uvs.push(v.u, v.v);
    });
  };
  tri(a0, a1, b0, n0, n1, n0);
  tri(a1, b1, b0, n1, n1, n0);
}

/** A point of the shore's contour, with the water's level beside it. */
interface ShorePoint {
  readonly x: number;
  readonly y: number;
  readonly level: number;
}

/** Douglas–Peucker: the points of `pts` that keep it within `tolerance` (its ends always). */
function simplify(pts: readonly ShorePoint[], tolerance: number): ShorePoint[] {
  if (pts.length <= 2) return [...pts];
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop() ?? [0, 0];
    const a = pts[i];
    const b = pts[j];
    if (!a || !b) continue;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k += 1) {
      const p = pts[k];
      if (!p) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = dx * dx + dy * dy;
      const t = l > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
      const e = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
      if (e > worst) {
        worst = e;
        at = k;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k] === 1);
}

/**
 * Walls along the shore: the field's contour `SHORE_INSET_M` inside the water
 * (marching squares), chained into polylines and simplified, so a straight
 * shore is one straight wall.
 *
 * - On a built-up shore, a quay: a vertical wall from the street's height
 *   down into the water, its top flat across the steep bank the elevation
 *   grid makes there (sampled `QUAY_CAP_M` behind the shore), with a coping
 *   strip back to the ground. Wherever the street stands above the water.
 * - Elsewhere, an earth bank sloping into the water, where the ground at the
 *   shore stands above it: its top follows the ground exactly (split where it
 *   crosses the terrain's lattice).
 */
export function shoreWalls(
  terrain: TerrainDataset,
  field: ShoreField,
  urban: UrbanGrid,
): { quay: WallMesh; bank: WallMesh; quayMeters: number; bankMeters: number } {
  const { originX, originY, step, columns, rows } = field.grid;
  const hf = terrain.heightfield;
  const maxX = hf.originX + (hf.columns - 1) * hf.cellSize;
  const maxY = hf.originY + (hf.rows - 1) * hf.cellSize;
  const ground = (x: number, y: number) =>
    heightAt(
      terrain,
      Math.min(maxX, Math.max(hf.originX, x)),
      Math.min(maxY, Math.max(hf.originY, y)),
    );
  const lattice = terrain.refinement ? hf.cellSize / terrain.refinement.factor : hf.cellSize;
  const iso = -SHORE_INSET_M;
  const d = field.distance;
  const sample = (i: number, j: number) =>
    d[Math.min(rows - 1, Math.max(0, j)) * columns + Math.min(columns - 1, Math.max(0, i))] ?? 0;
  // Gradient of the field at samples (central differences), interpolated:
  // continuous along the contour, so neighbouring pieces share their normals.
  const towardsWater = (x: number, y: number): [number, number] => {
    const gx = Math.min(Math.max((x - originX) / step, 0), columns - 1);
    const gy = Math.min(Math.max((y - originY) / step, 0), rows - 1);
    const c = Math.min(Math.floor(gx), columns - 2);
    const r = Math.min(Math.floor(gy), rows - 2);
    const u = gx - c;
    const v = gy - r;
    let sx = 0;
    let sy = 0;
    for (const [dc, dr, w] of [
      [0, 0, (1 - u) * (1 - v)],
      [1, 0, u * (1 - v)],
      [0, 1, (1 - u) * v],
      [1, 1, u * v],
    ] as const) {
      sx += w * (sample(c + dc + 1, r + dr) - sample(c + dc - 1, r + dr));
      sy += w * (sample(c + dc, r + dr + 1) - sample(c + dc, r + dr - 1));
    }
    const l = Math.hypot(sx, sy);
    return l < 1e-9 ? [0, 0] : [-sx / l, -sy / l];
  };

  // --- Marching squares: crossings on grid edges, linked through cells --------------
  // Edge keys: 2·i for the edge east of sample i, 2·i + 1 for the edge north of it.
  const points = new Map<number, ShorePoint>();
  const links = new Map<number, number[]>();
  const crossing = (
    key: number,
    i: number,
    j: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => {
    if (points.has(key)) return;
    const a = d[i] ?? 0;
    const b = d[j] ?? 0;
    const t = Math.abs(b - a) < 1e-12 ? 0.5 : (iso - a) / (b - a);
    // The level of the edge's sample in the water.
    const level = field.level[a < iso ? i : j] ?? Number.NaN;
    points.set(key, { x: x0 + t * (x1 - x0), y: y0 + t * (y1 - y0), level });
  };
  const link = (p: number, q: number) => {
    links.set(p, [...(links.get(p) ?? []), q]);
    links.set(q, [...(links.get(q) ?? []), p]);
  };
  for (let r = 0; r + 1 < rows; r += 1) {
    for (let c = 0; c + 1 < columns; c += 1) {
      const i = r * columns + c;
      const v0 = d[i] ?? 0; // (c, r)
      const v1 = d[i + 1] ?? 0; // (c+1, r)
      const v2 = d[i + columns + 1] ?? 0; // (c+1, r+1)
      const v3 = d[i + columns] ?? 0; // (c, r+1)
      const k = (v0 < iso ? 1 : 0) | (v1 < iso ? 2 : 0) | (v2 < iso ? 4 : 0) | (v3 < iso ? 8 : 0);
      if (k === 0 || k === 15) continue;
      const x0 = originX + c * step;
      const y0 = originY + r * step;
      const x1 = x0 + step;
      const y1 = y0 + step;
      // Edges: 0 south, 1 east, 2 north, 3 west.
      const keys = [2 * i, 2 * (i + 1) + 1, 2 * (i + columns), 2 * i + 1] as const;
      const edge = (e: 0 | 1 | 2 | 3): number => {
        switch (e) {
          case 0:
            crossing(keys[0], i, i + 1, x0, y0, x1, y0);
            break;
          case 1:
            crossing(keys[1], i + 1, i + columns + 1, x1, y0, x1, y1);
            break;
          case 2:
            crossing(keys[2], i + columns, i + columns + 1, x0, y1, x1, y1);
            break;
          case 3:
            crossing(keys[3], i, i + columns, x0, y0, x0, y1);
            break;
        }
        return keys[e];
      };
      const seg = (a: 0 | 1 | 2 | 3, b: 0 | 1 | 2 | 3) => {
        link(edge(a), edge(b));
      };
      const centre = (v0 + v1 + v2 + v3) / 4 < iso;
      switch (k) {
        case 1:
        case 14:
          seg(3, 0);
          break;
        case 2:
        case 13:
          seg(0, 1);
          break;
        case 3:
        case 12:
          seg(3, 1);
          break;
        case 4:
        case 11:
          seg(1, 2);
          break;
        case 6:
        case 9:
          seg(0, 2);
          break;
        case 7:
        case 8:
          seg(3, 2);
          break;
        case 5:
          // Corners 0 and 2 in the water: joined through the centre, or apart.
          if (centre) {
            seg(3, 2);
            seg(0, 1);
          } else {
            seg(3, 0);
            seg(1, 2);
          }
          break;
        case 10:
          if (centre) {
            seg(3, 0);
            seg(1, 2);
          } else {
            seg(3, 2);
            seg(0, 1);
          }
          break;
        default:
          break;
      }
    }
  }

  // --- Polylines: open ones from their ends, then closed loops, in key order --------
  const visited = new Set<number>();
  const polylines: ShorePoint[][] = [];
  const keys = [...links.keys()].sort((a, b) => a - b);
  const walk = (start: number) => {
    const line: ShorePoint[] = [];
    let prev = -1;
    let cur = start;
    for (;;) {
      visited.add(cur);
      const p = points.get(cur);
      if (p) line.push(p);
      const next = (links.get(cur) ?? []).find((n) => n !== prev && !visited.has(n));
      if (next === undefined) {
        // A loop closes on its start.
        if ((links.get(cur) ?? []).includes(start) && line.length > 2 && start !== cur) {
          const s = points.get(start);
          if (s) line.push(s);
        }
        break;
      }
      prev = cur;
      cur = next;
    }
    if (line.length >= 2) polylines.push(line);
  };
  for (const k of keys) if (!visited.has(k) && (links.get(k)?.length ?? 0) === 1) walk(k);
  for (const k of keys) if (!visited.has(k)) walk(k);

  const quayOut = wallBuffers();
  const bankOut = wallBuffers();
  let quayMeters = 0;
  let bankMeters = 0;

  /** Points along a→b: its ends and where it crosses the lattice's rows, columns and diagonals. */
  const latticeTs = (ax: number, ay: number, bx: number, by: number): number[] => {
    const ts = [0, 1];
    const cross = (a: number, b: number, o: number) => {
      if (Math.abs(b - a) < 1e-12) return;
      const lo = Math.ceil((Math.min(a, b) - o) / lattice);
      const hi = Math.floor((Math.max(a, b) - o) / lattice);
      for (let m = lo; m <= hi; m += 1) {
        const t = (o + m * lattice - a) / (b - a);
        if (t > 1e-6 && t < 1 - 1e-6) ts.push(t);
      }
    };
    cross(ax, bx, hf.originX);
    cross(ay, by, hf.originY);
    cross(ax - ay, bx - by, hf.originX - hf.originY);
    return ts.sort((p, q) => p - q);
  };

  const quaySpan = (a: ShorePoint, b: ShorePoint, length: number) => {
    const n = Math.max(1, Math.ceil(length / QUAY_STEP_M));
    const alongX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const pts = Array.from({ length: n + 1 }, (_, k) => {
      const t = k / n;
      const x = a.x + t * (b.x - a.x);
      const y = a.y + t * (b.y - a.y);
      const level = a.level + t * (b.level - a.level);
      let [nx, ny] = towardsWater(x, y);
      if (nx === 0 && ny === 0) [nx, ny] = [-(b.y - a.y) / length, (b.x - a.x) / length];
      // The coping's back edge, on the ground; the wall's top the highest
      // ground behind it, over the bank (a function of the place alone, so
      // neighbouring pieces meet).
      const ox = x - nx * QUAY_CAP_M;
      const oy = y - ny * QUAY_CAP_M;
      const street = ground(ox, oy);
      let top = -Infinity;
      for (let r = 0; r <= QUAY_CAP_M + 0.5 + 1e-9; r += 0.5) {
        for (const side of [-1, 0, 1]) {
          top = Math.max(top, ground(x - nx * r - ny * side, y - ny * r + nx * side));
        }
      }
      top += QUAY_LIFT_M;
      return { x, y, level, nx, ny, ox, oy, street, top };
    });
    // A quay where the street stands above the water (and wherever the ground at the shore does).
    if (
      pts.every((p) => p.street - p.level < QUAY_MIN_M && ground(p.x, p.y) - p.level <= SHORE_CUT_M)
    )
      return false;
    for (let k = 0; k + 1 < pts.length; k += 1) {
      const p = pts[k];
      const q = pts[k + 1];
      if (!p || !q) continue;
      const wallRow = (v: typeof p, z: number, color: Row['color']): Row => ({
        x: v.x,
        y: v.y,
        z,
        u: alongX ? v.x : v.y,
        v: z,
        color,
      });
      const np: Normal = [p.nx, p.ny, 0];
      const nq: Normal = [q.nx, q.ny, 0];
      const top = (v: typeof p) => wallRow(v, v.top, QUAY_DRY);
      const band = (v: typeof p) => wallRow(v, Math.min(v.top, v.level + WET_BAND_M), QUAY_DAMP);
      const under = (v: typeof p) => wallRow(v, v.level - WALL_FOOT_M, QUAY_UNDER);
      quad(quayOut, top(p), top(q), band(p), band(q), np, nq);
      quad(quayOut, band(p), band(q), under(p), under(q), np, nq);
      // The coping: from the wall's top back to the street.
      const capRow = (v: typeof p, outer: boolean): Row => {
        const x = outer ? v.ox : v.x;
        const y = outer ? v.oy : v.y;
        return { x, y, z: outer ? v.street + QUAY_LIFT_M : v.top, u: x, v: y, color: QUAY_CAP };
      };
      const up: Normal = [0, 0, 1];
      quad(quayOut, capRow(p, false), capRow(q, false), capRow(p, true), capRow(q, true), up, up);
    }
    return true;
  };

  const bankSpan = (a: ShorePoint, b: ShorePoint, length: number) => {
    const alongX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const za = ground(a.x, a.y);
    const zb = ground(b.x, b.y);
    const low = Math.max(za, zb) - Math.max(a.level, b.level) < LOW_WALL_M && length < 2 * step;
    const ts = low ? [0, 0.5, 1] : latticeTs(a.x, a.y, b.x, b.y);
    const pts = ts.map((t) => {
      const x = a.x + t * (b.x - a.x);
      const y = a.y + t * (b.y - a.y);
      let [nx, ny] = towardsWater(x, y);
      if (nx === 0 && ny === 0) [nx, ny] = [-(b.y - a.y) / length, (b.x - a.x) / length];
      return {
        x,
        y,
        z: ground(x, y) + (low ? LOW_WALL_LIFT_M : 0.01),
        level: a.level + t * (b.level - a.level),
        nx,
        ny,
      };
    });
    if (pts.every((p) => p.z - p.level <= SHORE_CUT_M + (low ? LOW_WALL_LIFT_M : 0.01)))
      return false;
    let any = false;
    for (let k = 0; k + 1 < pts.length; k += 1) {
      const p = pts[k];
      const q = pts[k + 1];
      if (!p || !q) continue;
      if (p.z - p.level <= SHORE_CUT_M && q.z - q.level <= SHORE_CUT_M) continue;
      any = true;
      // An earth bank sloping into the water.
      const slope = (v: typeof p, z: number, color: Row['color']): Row => {
        const h = Math.max(0, v.z - v.level);
        const run = Math.min(BANK_MAX_RUN_M, BANK_RUN * (h + WALL_FOOT_M));
        const t = h + WALL_FOOT_M > 0 ? (v.z - z) / (h + WALL_FOOT_M) : 0;
        const x = v.x + v.nx * run * t;
        const y = v.y + v.ny * run * t;
        return { x, y, z, u: alongX ? x : y, v: z, color };
      };
      const tilt = (v: typeof p): Normal => {
        const h = Math.max(0, v.z - v.level) + WALL_FOOT_M;
        const run = Math.min(BANK_MAX_RUN_M, BANK_RUN * h);
        // The face's normal: up and towards the water.
        const l = Math.hypot(h, run);
        return [(v.nx * h) / l, (v.ny * h) / l, run / l];
      };
      const top = (v: typeof p) => slope(v, v.z, BANK_DRY);
      const wl = (v: typeof p) => slope(v, Math.min(v.z, v.level + 0.04), BANK_DAMP);
      const foot = (v: typeof p) => slope(v, v.level - WALL_FOOT_M, BANK_UNDER);
      quad(bankOut, top(p), top(q), wl(p), wl(q), tilt(p), tilt(q));
      quad(bankOut, wl(p), wl(q), foot(p), foot(q), tilt(p), tilt(q));
    }
    return any;
  };

  for (const line of polylines) {
    if (line.some((p) => Number.isNaN(p.level))) continue;
    const pts = simplify(line, SIMPLIFY_M);
    for (let k = 0; k + 1 < pts.length; k += 1) {
      const a = pts[k];
      const b = pts[k + 1];
      if (!a || !b) continue;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-6) continue;
      // Split where the shore turns built-up or open (every few metres).
      const n = Math.max(1, Math.ceil(length / QUAY_STEP_M));
      const at = (t: number): ShorePoint => ({
        x: a.x + t * (b.x - a.x),
        y: a.y + t * (b.y - a.y),
        level: a.level + t * (b.level - a.level),
      });
      let from = 0;
      for (let m = 1; m <= n; m += 1) {
        const built = urban.at(at((from + 0.5) / n).x, at((from + 0.5) / n).y);
        const next = m < n ? urban.at(at((m + 0.5) / n).x, at((m + 0.5) / n).y) : !built;
        if (next === built) continue;
        const p = at(from / n);
        const q = at(m / n);
        const l = (length * (m - from)) / n;
        if (built) {
          if (quaySpan(p, q, l)) quayMeters += l;
        } else if (bankSpan(p, q, l)) bankMeters += l;
        from = m;
      }
    }
  }
  return { quay: finishWalls(quayOut), bank: finishWalls(bankOut), quayMeters, bankMeters };
}

/** The 3D view's shoreline for a graded terrain: its mask and walls, or null with no levelled water. */
export function shoreline(
  terrain: TerrainDataset,
  field: ShoreField | null = shoreField(terrain),
): Shoreline | null {
  if (!field) return null;
  const started = performance.now();
  const urban = urbanGrid(terrain);
  const mask = shoreMask(field, urban);
  const walls = shoreWalls(terrain, field, urban);
  let waterSamples = 0;
  let cutSamples = 0;
  const { originX, originY, step, columns, rows } = field.grid;
  const hf = terrain.heightfield;
  const maxX = hf.originX + (hf.columns - 1) * hf.cellSize;
  const maxY = hf.originY + (hf.rows - 1) * hf.cellSize;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      const l = field.level[i] ?? Number.NaN;
      if (Number.isNaN(l) || (field.distance[i] ?? 0) >= 0) continue;
      waterSamples += 1;
      const x = Math.min(maxX, originX + c * step);
      const y = Math.min(maxY, originY + r * step);
      if ((field.distance[i] ?? 0) < -SHORE_INSET_M && heightAt(terrain, x, y) > l + SHORE_CUT_M)
        cutSamples += 1;
    }
  }
  return {
    mask,
    quay: walls.quay,
    bank: walls.bank,
    stats: {
      maskSamples: columns * rows,
      waterSamples,
      cutSamples,
      quayMeters: walls.quayMeters,
      bankMeters: walls.bankMeters,
      ms: performance.now() - started,
    },
  };
}
