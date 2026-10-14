import { heightAt, type TerrainDataset, type VegetationArea } from '#sim';
import { vegetationExclusions, type ExclusionReason, type Exclusions } from './exclusion';
import { hashInts, hashString, unit, valueNoise } from './hash';
import { PLANTS, PLANTS_BY_KIND, type PlantKind } from './plant-models';
import { polygonIndex, polylineSegments, segmentGrid } from './spatial-index';

// Where the plants stand (docs/adr/0031). Trees and shrubs are placed only in
// the battlefield's vegetation areas, the same areas that obscure line of
// sight in the simulation, and sized from them: crowns top out about the
// area's canopy height. They are visual only: the simulation still treats
// each area as a uniform volume, and no tree is an obstacle.
//
// - Woodland: dart throwing on a global grid in row order, so trees keep a
//   natural minimum spacing (blue noise) with no rows. Spacing follows each
//   tree's crown and a slow noise field (denser and sparser stands); rare
//   small gaps; stands of conifers and of each broadleaf species; smaller
//   trees along the edges, as on a real forest edge; a few dead trees.
// - Tree lines and hedges: planted along the strip's long axis.
// - Scrub: shrubs in clusters, with open patches between.
//
// No plant stands on a road or its verge, in or against a building, or in
// open water (exclusion.ts). Every plant stands on the ground: its foot is at
// `heightAt`. Everything comes from hashes of positions and ids: the same
// battlefield always grows the same plants, in whatever order its features
// were loaded.

/**
 * The share of conifers among a wood's trees at map point (x, y): stands of
 * conifers and of broadleaf trees, from slow noise. The ground under them
 * (needles or leaf litter, docs/adr/0038) follows the same noise.
 */
export function coniferShareAt(x: number, y: number): number {
  return coniferShare(valueNoise(x, y, CONIFER_NOISE.scale, CONIFER_NOISE.seed));
}

/** The noise behind `coniferShareAt`, for callers that sample it in bulk. */
export const CONIFER_NOISE = { scale: 140, seed: 0x6c } as const;

/** `coniferShareAt` from its noise value. */
export function coniferShare(noise: number): number {
  return Math.min(0.95, Math.max(0.05, 0.4 + 0.75 * noise));
}

export interface TileIndex {
  readonly originX: number;
  readonly originY: number;
  readonly size: number;
  readonly columns: number;
  readonly rows: number;
  /**
   * Instances are ordered by plant, then tile, then rank. The run of plant p
   * in tile t is [starts[p·tiles + t], starts[p·tiles + t + 1]).
   */
  readonly starts: Uint32Array;
  /** Per tile: the lowest foot and the highest crown top, metres. */
  readonly zMin: Float32Array;
  readonly zMax: Float32Array;
}

export interface VegetationInstances {
  readonly count: number;
  /** Index into `PLANTS`. */
  readonly plant: Uint8Array;
  /** Foot of the trunk: x, y (map metres) and z (`heightAt`). */
  readonly position: Float32Array;
  /** Rotation about the vertical, radians. */
  readonly yaw: Float32Array;
  /** Crown-width and height scale relative to the model, two per instance. */
  readonly scale: Float32Array;
  /** Colour multipliers, linear RGB. */
  readonly tint: Float32Array;
  /** In [0, 1): the order in which distant plants are thinned out. */
  readonly rank: Float32Array;
  readonly tiles: TileIndex;
}

export interface PlacementStats {
  readonly trees: number;
  readonly shrubs: number;
  /** Roadside and settlement details drawn as instances (docs/adr/0036). */
  readonly props: number;
  readonly byPlant: readonly number[];
  readonly excluded: Readonly<Record<ExclusionReason, number>>;
  /** Whether `maxInstances` thinned the result. */
  readonly capped: boolean;
  readonly ms: number;
}

export interface PlacementOptions {
  /** At most this many plants; beyond it the lowest-ranked are dropped. */
  readonly maxInstances?: number;
  /**
   * Plants and props placed elsewhere (the roadside details, docs/adr/0036),
   * drawn with the rest: each at its foot on the ground, as given.
   */
  readonly extra?: readonly PlacedInstance[];
}

/** An instance placed by another generator. */
export interface PlacedInstance {
  /** Index into `PLANTS`. */
  readonly plant: number;
  readonly x: number;
  readonly y: number;
  /** Rotation about the vertical: the model's +x turns to this map direction, radians. */
  readonly yaw: number;
  /** Horizontal and vertical scale relative to the model. */
  readonly scaleW: number;
  readonly scaleH: number;
  /** Colour multiplier, linear RGB. */
  readonly tint: readonly [number, number, number];
  /** For ranking (distant thinning). */
  readonly seed: number;
}

/** Bump when placement changes, e.g. to key a cache. */
export const PLACEMENT_VERSION = 3;
export const TILE_M = 100;
export const DEFAULT_MAX_INSTANCES = 500_000;

/** Trees keep at least this far apart; the tree grid's cells are small enough to hold one each. */
const TREE_MIN_SPACING_M = 4.2;
const TREE_CELL_M = 2.9;
const TREE_MAX_SPACING_M = 9.5;
const SHRUB_MIN_SPACING_M = 1.6;
const SHRUB_CELL_M = 1.1;
const SHRUB_MAX_SPACING_M = 3.4;
/** Attempts per grid cell. */
const ATTEMPTS = 2;
/** Trunks stand at least this share of their crown's radius inside the area's edge. */
const EDGE_INSET = 0.35;
/** Below this canopy a tree line is a hedge, planted with shrubs. */
const HEDGE_CANOPY_M = 4;

interface Candidate {
  plant: number;
  height: number;
  crown: number;
  spacing: number;
}

/** A grid holding at most one accepted plant per cell, for spacing tests. */
class SpacingGrid {
  readonly cells: Int32Array;
  readonly columns: number;
  readonly rows: number;
  readonly originX: number;
  readonly originY: number;
  readonly cell: number;
  /** The widest spacing any plant asks for. */
  readonly reach: number;
  readonly xs: number[];
  readonly ys: number[];
  readonly rs: number[];
  constructor(
    origin: { x: number; y: number; width: number; height: number },
    cell: number,
    reach: number,
    plants: { xs: number[]; ys: number[]; rs: number[] },
  ) {
    this.originX = origin.x;
    this.originY = origin.y;
    this.cell = cell;
    this.reach = reach;
    this.xs = plants.xs;
    this.ys = plants.ys;
    this.rs = plants.rs;
    this.columns = Math.ceil(origin.width / cell) + 1;
    this.rows = Math.ceil(origin.height / cell) + 1;
    this.cells = new Int32Array(this.columns * this.rows).fill(-1);
  }
  index(x: number, y: number): number {
    const i = Math.floor((x - this.originX) / this.cell);
    const j = Math.floor((y - this.originY) / this.cell);
    if (i < 0 || j < 0 || i >= this.columns || j >= this.rows) return -1;
    return j * this.columns + i;
  }
  /** Whether a plant needing `r` of room at (x, y) keeps clear of every accepted one. */
  fits(x: number, y: number, r: number): boolean {
    const i = Math.floor((x - this.originX) / this.cell);
    const j = Math.floor((y - this.originY) / this.cell);
    // Neighbours further than the widest possible spacing cannot conflict.
    const k = Math.ceil((r + this.reach) / 2 / this.cell);
    for (let jj = Math.max(0, j - k); jj <= Math.min(this.rows - 1, j + k); jj += 1) {
      for (let ii = Math.max(0, i - k); ii <= Math.min(this.columns - 1, i + k); ii += 1) {
        const q = this.cells[jj * this.columns + ii] ?? -1;
        if (q < 0) continue;
        const d = (r + (this.rs[q] ?? 0)) / 2;
        const dx = x - (this.xs[q] ?? 0);
        const dy = y - (this.ys[q] ?? 0);
        if (dx * dx + dy * dy < d * d) return false;
      }
    }
    return true;
  }
}

const byId = (a: VegetationArea, b: VegetationArea) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function placeVegetation(
  terrain: TerrainDataset,
  { maxInstances = DEFAULT_MAX_INSTANCES, extra = [] }: PlacementOptions = {},
): { instances: VegetationInstances; stats: PlacementStats } {
  const started = performance.now();
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const width = (columns - 1) * cellSize;
  const height = (rows - 1) * cellSize;
  const exclusions = vegetationExclusions(terrain.features);
  const excluded: Record<ExclusionReason, number> = { road: 0, building: 0, water: 0 };

  // Accepted plants.
  const px: number[] = [];
  const py: number[] = [];
  const pr: number[] = [];
  const plantOf: number[] = [];
  const heights: number[] = [];
  const crowns: number[] = [];
  const seeds: number[] = [];
  const extent = { x: originX, y: originY, width, height };
  const placed = { xs: px, ys: py, rs: pr };
  const trees = new SpacingGrid(extent, TREE_CELL_M, TREE_MAX_SPACING_M, placed);
  const shrubs = new SpacingGrid(extent, SHRUB_CELL_M, SHRUB_MAX_SPACING_M, placed);

  const accept = (grid: SpacingGrid, x: number, y: number, c: Candidate, seed: number) => {
    const i = px.length;
    px.push(x);
    py.push(y);
    pr.push(c.spacing);
    plantOf.push(c.plant);
    heights.push(c.height);
    crowns.push(c.crown);
    seeds.push(seed);
    const cell = grid.index(x, y);
    if (cell >= 0) grid.cells[cell] = i;
  };
  const allowed = (x: number, y: number, crown: number, ex: Exclusions) => {
    const why = ex.reason(x, y, crown);
    if (why) excluded[why] += 1;
    return why === null;
  };

  const areas = [...terrain.features.vegetation].sort(byId);

  /**
   * Fills an area by dart throwing on `grid`, row by row. `choose` picks the
   * plant for a candidate, given its hash, or null to leave the spot empty.
   */
  const fill = (
    area: VegetationArea,
    grid: SpacingGrid,
    choose: (x: number, y: number, h: number, edge: () => number) => Candidate | null,
  ) => {
    const rings = [area.boundary, ...(area.holes ?? [])];
    const inside = polygonIndex(rings);
    const edges = segmentGrid(
      polylineSegments(
        rings.map((points) => ({ points, halfWidth: 0 })),
        true,
      ),
      12,
    );
    const seed = hashString(area.id);
    const i0 = Math.max(0, Math.floor((inside.minX - grid.originX) / grid.cell));
    const i1 = Math.min(grid.columns - 1, Math.floor((inside.maxX - grid.originX) / grid.cell));
    const j0 = Math.max(0, Math.floor((inside.minY - grid.originY) / grid.cell));
    const j1 = Math.min(grid.rows - 1, Math.floor((inside.maxY - grid.originY) / grid.cell));
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        for (let a = 0; a < ATTEMPTS; a += 1) {
          if ((grid.cells[j * grid.columns + i] ?? -1) >= 0) break;
          // Candidates depend on the grid cell only, not on the area.
          const h = hashInts(i * 4 + a, j, grid.cell === TREE_CELL_M ? 0x7e1 : 0x5b2);
          const x = grid.originX + (i + unit(h)) * grid.cell;
          const y = grid.originY + (j + unit(hashInts(h, a, 0x13))) * grid.cell;
          if (!inside.contains(x, y)) continue;
          // Too close to a plant already for even the smallest: no need to look further.
          if (!grid.fits(x, y, grid.cell * 1.42)) continue;
          let edgeDistance = -1;
          const edge = () => {
            if (edgeDistance < 0) edgeDistance = edges.distance(x, y, 12);
            return edgeDistance;
          };
          const c = choose(x, y, h, edge);
          if (!c) continue;
          if (!grid.fits(x, y, c.spacing)) continue;
          if (edge() < EDGE_INSET * c.crown) continue;
          if (!allowed(x, y, c.crown, exclusions)) continue;
          accept(grid, x, y, c, hashInts(h, seed, 0x99));
          break;
        }
      }
    }
  };

  /** A tree of `kind` about `canopy` tall, sized and spaced from its model. */
  const tree = (
    plant: number,
    canopy: number,
    heightShare: number,
    h: number,
    extraSpacing = 1,
  ): Candidate => {
    const spec = PLANTS[plant] ?? PLANTS[0];
    const height = Math.min(canopy * heightShare, canopy * 1.22);
    const crown =
      (height / (spec?.height ?? 1)) *
      (spec?.crown ?? 1) *
      (0.88 + 0.24 * unit(hashInts(h, 3, 0x21)));
    const spacing = Math.min(
      TREE_MAX_SPACING_M,
      Math.max(TREE_MIN_SPACING_M, crown * (spec?.kind === 'conifer' ? 1.45 : 1.25) * extraSpacing),
    );
    return { plant, height, crown, spacing };
  };
  const pick = (kind: PlantKind, u: number) => {
    const list = PLANTS_BY_KIND[kind];
    return list[Math.min(list.length - 1, Math.floor(u * list.length))] ?? 0;
  };
  const shrub = (canopy: number, h: number, sizeShare: number): Candidate => {
    const plant = pick('shrub', unit(hashInts(h, 5, 0x31)));
    const spec = PLANTS[plant];
    const height = Math.max(0.6, canopy * sizeShare);
    const crown =
      (height / (spec?.height ?? 1)) *
      (spec?.crown ?? 1) *
      (0.8 + 0.45 * unit(hashInts(h, 6, 0x31)));
    return {
      plant,
      height,
      crown,
      spacing: Math.min(SHRUB_MAX_SPACING_M, Math.max(SHRUB_MIN_SPACING_M, crown * 1.15)),
    };
  };

  // Woodland first, then tree lines, then scrub: trees claim their room before shrubs.
  for (const area of areas.filter((a) => a.kind === 'woodland')) {
    const canopy = area.canopyHeightMeters;
    fill(area, trees, (x, y, h, edge) => {
      // Rare small gaps.
      if (valueNoise(x, y, 30, 0x6a) > 0.78) return null;
      const u = unit(hashInts(h, 1, 0x41));
      const v = unit(hashInts(h, 2, 0x41));
      // Denser and sparser stands.
      const sparse = 1 + 0.28 * Math.max(0, valueNoise(x, y, 70, 0x6b));
      if (u < 0.015) return tree(pick('deadTree', 0), canopy, 0.6 + 0.35 * v, h, sparse);
      // Smaller trees along the edge, and a few in the stand.
      const atEdge = edge() < 9;
      if (unit(hashInts(h, 4, 0x41)) < (atEdge ? 0.25 : 0.05)) {
        return tree(pick('smallTree', 0), canopy, 0.4 + 0.25 * v, h, sparse);
      }
      // Stands: conifers where the slow noise says so, else broadleaf.
      const coniferShare = coniferShareAt(x, y);
      const edgeShare = atEdge ? 0.92 : 1;
      if (u < coniferShare) {
        const pine = valueNoise(x, y, 220, 0x6d) > 0.1;
        return pine
          ? tree(pick('pine', 0), canopy, (0.9 + 0.25 * v) * edgeShare, h, sparse)
          : tree(pick('conifer', 0), canopy, (0.9 + 0.3 * v) * edgeShare, h, sparse);
      }
      // Broadleaf: mostly the stand's species, some mixed in.
      const stand = (valueNoise(x, y, 90, 0x6e) + 1) / 2;
      const species = unit(hashInts(h, 7, 0x41)) < 0.7 ? stand : unit(hashInts(h, 8, 0x41));
      return tree(pick('broadleaf', species), canopy, (0.85 + 0.25 * v) * edgeShare, h, sparse);
    });
  }

  for (const area of areas.filter((a) => a.kind === 'treeLine')) {
    plantLine(area, area.canopyHeightMeters < HEDGE_CANOPY_M);
  }

  for (const area of areas.filter((a) => a.kind === 'scrub')) {
    const canopy = area.canopyHeightMeters;
    fill(area, shrubs, (x, y, h) => {
      // Clusters with open ground between.
      const p = Math.min(1, Math.max(0, 0.55 + 0.8 * valueNoise(x, y, 18, 0x71)));
      if (unit(hashInts(h, 9, 0x41)) >= p) return null;
      return shrub(canopy, h, 0.5 + 0.5 * unit(hashInts(h, 10, 0x41)));
    });
  }

  /** Plants along a strip's long axis (tree rows, hedges). */
  function plantLine(area: VegetationArea, hedge: boolean) {
    const pts = area.boundary;
    const n = pts.length;
    const cx = pts.reduce((s, p) => s + p.x, 0) / n;
    const cy = pts.reduce((s, p) => s + p.y, 0) / n;
    // Principal axis of the corners.
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of pts) {
      sxx += (p.x - cx) ** 2;
      syy += (p.y - cy) ** 2;
      sxy += (p.x - cx) * (p.y - cy);
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let t0 = Infinity;
    let t1 = -Infinity;
    let w0 = Infinity;
    let w1 = -Infinity;
    for (const p of pts) {
      const t = (p.x - cx) * dx + (p.y - cy) * dy;
      const w = -(p.x - cx) * dy + (p.y - cy) * dx;
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
      w0 = Math.min(w0, w);
      w1 = Math.max(w1, w);
    }
    const canopy = area.canopyHeightMeters;
    const inside = polygonIndex([area.boundary, ...(area.holes ?? [])]);
    const grid = hedge ? shrubs : trees;
    const seed = hashString(area.id);
    // Wider than a row: fill it like a wood.
    if (w1 - w0 > 20) {
      fill(area, grid, (_x, _y, h) =>
        hedge
          ? shrub(canopy, h, 0.7 + 0.3 * unit(hashInts(h, 10, 0x41)))
          : tree(
              pick('broadleaf', unit(hashInts(h, 7, 0x41))),
              canopy,
              0.85 + 0.25 * unit(hashInts(h, 2, 0x41)),
              h,
            ),
      );
      return;
    }
    const step = hedge ? 1.5 : 6.5;
    let t = t0 + unit(hashInts(seed, 1, 0x51)) * step * 0.5;
    for (let k = 0; t <= t1; k += 1) {
      const h = hashInts(seed, k, 0x52);
      const lateral = (w0 + w1) / 2 + (unit(hashInts(h, 1, 0x53)) - 0.5) * 0.3 * (w1 - w0);
      const x = cx + dx * t - dy * lateral;
      const y = cy + dy * t + dx * lateral;
      const c = hedge
        ? shrub(canopy, h, 0.75 + 0.35 * unit(hashInts(h, 2, 0x53)))
        : unit(hashInts(h, 3, 0x53)) < 0.2
          ? tree(pick('conifer', 0), canopy, 0.85 + 0.3 * unit(hashInts(h, 4, 0x53)), h)
          : tree(
              pick('broadleaf', unit(hashInts(h, 5, 0x53))),
              canopy,
              0.85 + 0.3 * unit(hashInts(h, 4, 0x53)),
              h,
            );
      if (
        inside.contains(x, y) &&
        grid.fits(x, y, c.spacing * 0.85) &&
        allowed(x, y, c.crown, exclusions)
      ) {
        accept(grid, x, y, { ...c, spacing: c.spacing * 0.85 }, hashInts(h, seed, 0x99));
      }
      t += step * (0.8 + 0.4 * unit(hashInts(h, 6, 0x53)));
    }
  }

  // Instances placed elsewhere keep their own orientation, size and colour.
  const fixed = new Map<number, PlacedInstance>();
  for (const e of extra) {
    const spec = PLANTS[e.plant];
    if (!spec) continue;
    fixed.set(px.length, e);
    px.push(e.x);
    py.push(e.y);
    pr.push(0);
    plantOf.push(e.plant);
    heights.push(spec.height * e.scaleH);
    crowns.push(spec.crown * e.scaleW);
    seeds.push(e.seed);
  }

  // --- Instances, ordered by plant, tile and rank --------------------------------
  let order = px.map((_, i) => i);
  const rankOf = seeds.map((s) => unit(hashInts(s, 0, 0x77)));
  let capped = false;
  if (order.length > maxInstances) {
    capped = true;
    order = [...order].sort((a, b) => (rankOf[a] ?? 0) - (rankOf[b] ?? 0)).slice(0, maxInstances);
  }
  const tileColumns = Math.ceil(width / TILE_M);
  const tileRows = Math.ceil(height / TILE_M);
  const tileCount = tileColumns * tileRows;
  const tileOf = (i: number) =>
    Math.min(tileRows - 1, Math.max(0, Math.floor(((py[i] ?? 0) - originY) / TILE_M))) *
      tileColumns +
    Math.min(tileColumns - 1, Math.max(0, Math.floor(((px[i] ?? 0) - originX) / TILE_M)));
  const key = order.map((i) => ({
    i,
    plant: plantOf[i] ?? 0,
    tile: tileOf(i),
    rank: rankOf[i] ?? 0,
  }));
  key.sort((a, b) => a.plant - b.plant || a.tile - b.tile || a.rank - b.rank || a.i - b.i);

  const count = key.length;
  const plant = new Uint8Array(count);
  const position = new Float32Array(count * 3);
  const yaw = new Float32Array(count);
  const scale = new Float32Array(count * 2);
  const tint = new Float32Array(count * 3);
  const rank = new Float32Array(count);
  const starts = new Uint32Array(PLANTS.length * tileCount + 1);
  const zMin = new Float32Array(tileCount).fill(Infinity);
  const zMax = new Float32Array(tileCount).fill(-Infinity);
  const byPlant = PLANTS.map(() => 0);
  key.forEach(({ i, plant: p, tile }, k) => {
    const x = px[i] ?? 0;
    const y = py[i] ?? 0;
    const z = heightAt(terrain, x, y);
    const s = seeds[i] ?? 0;
    const spec = PLANTS[p];
    plant[k] = p;
    position[k * 3] = x;
    position[k * 3 + 1] = y;
    position[k * 3 + 2] = z;
    const placed = fixed.get(i);
    yaw[k] = placed ? placed.yaw : unit(hashInts(s, 1, 0x78)) * Math.PI * 2;
    scale[k * 2] = placed ? placed.scaleW : (crowns[i] ?? 1) / (spec?.crown ?? 1);
    scale[k * 2 + 1] = placed ? placed.scaleH : (heights[i] ?? 1) / (spec?.height ?? 1);
    // Colour: a little lighter or darker per plant and per stand, a little
    // warmer or cooler.
    const bright =
      (0.88 + 0.22 * unit(hashInts(s, 2, 0x78))) * (1 + 0.07 * valueNoise(x, y, 45, 0x79));
    const warm = (unit(hashInts(s, 3, 0x78)) - 0.5) * 0.12;
    tint[k * 3] = placed ? placed.tint[0] : bright * (1 + warm);
    tint[k * 3 + 1] = placed ? placed.tint[1] : bright;
    tint[k * 3 + 2] = placed ? placed.tint[2] : bright * (1 - warm);
    rank[k] = key[k]?.rank ?? 0;
    zMin[tile] = Math.min(zMin[tile] ?? z, z - 1);
    zMax[tile] = Math.max(zMax[tile] ?? z, z + (heights[i] ?? 0));
    starts[p * tileCount + tile + 1] = (starts[p * tileCount + tile + 1] ?? 0) + 1;
    byPlant[p] = (byPlant[p] ?? 0) + 1;
  });
  for (let r = 1; r < starts.length; r += 1) starts[r] = (starts[r] ?? 0) + (starts[r - 1] ?? 0);

  const shrubCount = PLANTS_BY_KIND.shrub.reduce((s, p) => s + (byPlant[p] ?? 0), 0);
  const propCount = PLANTS_BY_KIND.prop.reduce((s, p) => s + (byPlant[p] ?? 0), 0);
  return {
    instances: {
      count,
      plant,
      position,
      yaw,
      scale,
      tint,
      rank,
      tiles: {
        originX,
        originY,
        size: TILE_M,
        columns: tileColumns,
        rows: tileRows,
        starts,
        zMin,
        zMax,
      },
    },
    stats: {
      trees: count - shrubCount - propCount,
      shrubs: shrubCount,
      props: propCount,
      byPlant,
      excluded,
      capped,
      ms: performance.now() - started,
    },
  };
}
