import type { Vec2 } from './geometry';
import {
  STANDING_EYE_HEIGHT_M,
  STANDING_TARGET_HEIGHT_M,
  traceSightLine,
  type LosOptions,
} from './los';
import { pointInPolygon } from './polygon';
import { noObstruction, sightLineTracer, type Obstruction } from './sight-tracer';
import { heightAt, type TerrainDataset } from './terrain';

// Viewsheds (docs/adr/0011, docs/adr/0020): which ground an observer can see,
// sampled on a regular grid. Each cell is decided as the sight-line trace of
// `lineOfSight` decides it, from the observer's eye to a standing target at
// the cell centre, so a viewshed never disagrees with a point query. The
// work is done by `sightLineTracer`, which reaches the same decision far
// faster, and most hidden cells are settled by a proof from a neighbour's
// obstruction instead of a trace.

/** Recent distinct obstructions tried as quick proofs for each cell. */
const RECENT_OBSTRUCTIONS = 4;

/** A regular grid of target points: cell (c, r) is centred on `origin + (c + ½, r + ½) × cellSize`. */
export interface ViewshedGrid {
  readonly originX: number;
  readonly originY: number;
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
}

export interface Viewshed {
  readonly grid: ViewshedGrid;
  readonly observer: Vec2;
  /** One byte per cell, row-major from the south-west: 1 visible, 0 not. */
  readonly visible: Uint8Array;
}

/**
 * Builds the terrain's visibility index (feature and edge buckets, polygon
 * rasters) now rather than on the first viewshed. Idempotent per terrain.
 */
export function prepareViewsheds(terrain: TerrainDataset): void {
  sightLineTracer(terrain);
}

/** The grid of whole `cellSize` cells covering the terrain, all centres on the terrain. */
export function viewshedGrid(terrain: TerrainDataset, cellSize: number): ViewshedGrid {
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
    throw new RangeError(`viewshed cell size must be a finite number > 0, got ${String(cellSize)}`);
  }
  const { originX, originY, cellSize: sample, columns, rows } = terrain.heightfield;
  return {
    originX,
    originY,
    cellSize,
    columns: Math.floor(((columns - 1) * sample) / cellSize),
    rows: Math.floor(((rows - 1) * sample) / cellSize),
  };
}

export function cellCentre(grid: ViewshedGrid, column: number, row: number): Vec2 {
  return {
    x: grid.originX + (column + 0.5) * grid.cellSize,
    y: grid.originY + (row + 0.5) * grid.cellSize,
  };
}

/**
 * Visibility of rows `rowStart` (inclusive) to `rowEnd` (exclusive) of the
 * grid from `observer`, every `rowStep`th row: one byte per cell, 1 visible,
 * 0 not, the rows packed in order. Every cell is decided on its own, so a
 * viewshed can be computed in parts, in any order, and assembled into an
 * identical result.
 *
 * `alreadyVisible` (packed like the result) marks cells already known to be
 * visible, e.g. to another Marine of a fire team (docs/adr/0022). They are
 * reported visible without being decided, so the result is the union of
 * `alreadyVisible` and this observer's visibility: every other cell is
 * decided exactly as without it. (A skipped cell records no obstruction for
 * its neighbours' proofs; proofs only ever show a cell hidden, so this can
 * cost time but never change a result.)
 */
export function computeViewshedRows(
  terrain: TerrainDataset,
  observer: Vec2,
  grid: ViewshedGrid,
  rowStart: number,
  rowEnd: number,
  options: LosOptions = {},
  rowStep = 1,
  alreadyVisible?: Uint8Array,
): Uint8Array {
  const eye = {
    x: observer.x,
    y: observer.y,
    z:
      heightAt(terrain, observer.x, observer.y) +
      (options.observerHeightMeters ?? STANDING_EYE_HEIGHT_M),
  };
  const aim = options.targetHeightMeters ?? STANDING_TARGET_HEIGHT_M;
  const out = new Uint8Array(Math.ceil((rowEnd - rowStart) / rowStep) * grid.columns);
  const tracer = sightLineTracer(terrain);
  // What obstructed the cell to the left and each cell of the row below, and
  // a few recent obstructions: usually what obstructs this cell too, which a
  // quick proof confirms. Proofs that need a short walk come next; a full
  // trace only when no proof succeeds.
  let below: Obstruction[] = Array.from({ length: grid.columns }, noObstruction);
  let current: Obstruction[] = Array.from({ length: grid.columns }, noObstruction);
  const recent: Obstruction[] = Array.from({ length: RECENT_OBSTRUCTIONS }, noObstruction);
  let nextRecent = 0;
  const target = { x: 0, y: 0, z: 0 };
  /** Two obstructions that would give the same proof. */
  const same = (o: Obstruction, p: Obstruction | undefined) =>
    o.kind === p?.kind && (o.kind === 2 ? o.building === p.building : o.x === p.x && o.y === p.y);
  /** The first of left, below and the recent obstructions that proves the cell hidden at a glance. */
  const quickProof = (left: Obstruction | undefined, under: Obstruction | undefined) => {
    if (left && left.kind !== 0 && tracer.provesQuickly(eye, target, left)) return left;
    if (under && under.kind !== 0 && !same(under, left) && tracer.provesQuickly(eye, target, under))
      return under;
    for (const o of recent) {
      if (o.kind !== 0 && !same(o, left) && !same(o, under) && tracer.provesQuickly(eye, target, o))
        return o;
    }
    return undefined;
  };
  for (let r = rowStart; r < rowEnd; r += rowStep) {
    let left: Obstruction | undefined;
    for (let c = 0; c < grid.columns; c += 1) {
      const here = current[c] ?? noObstruction();
      const index = ((r - rowStart) / rowStep) * grid.columns + c;
      if (alreadyVisible?.[index] === 1) {
        here.kind = 0;
        left = here;
        out[index] = 1;
        continue;
      }
      // `cellCentre`, without the allocation.
      const x = grid.originX + (c + 0.5) * grid.cellSize;
      const y = grid.originY + (r + 0.5) * grid.cellSize;
      target.x = x;
      target.y = y;
      target.z = heightAt(terrain, x, y) + aim;
      const under = below[c];
      let proof: Obstruction | undefined;
      if (x === eye.x && y === eye.y) {
        here.kind = 0;
      } else {
        proof = quickProof(left, under);
        if (!proof && left && tracer.provesByWalking(eye, target, left)) proof = left;
        if (!proof && under && under.kind !== 0 && !same(under, left)) {
          if (tracer.provesByWalking(eye, target, under)) proof = under;
        }
        if (proof) {
          Object.assign(here, proof);
        } else if (tracer.blocked(eye, target, here)) {
          // A new obstruction: remember it among the recent ones.
          const slot = recent[nextRecent];
          if (slot) Object.assign(slot, here);
          nextRecent = (nextRecent + 1) % RECENT_OBSTRUCTIONS;
          proof = here;
        }
      }
      left = here;
      out[index] = proof ? 0 : 1;
    }
    [below, current] = [current, below];
  }
  return out;
}

/**
 * The union of several observers' visibility of the same rows (see
 * `computeViewshedRows`): 1 where any of them sees, or where `known` (packed
 * like the result) already is 1. Each observer after the first decides only
 * the cells no earlier one sees, which saves most of the work when their
 * visible areas overlap (docs/adr/0022). Exactly the union of each one's
 * `computeViewshedRows`.
 */
export function computeUnionRows(
  terrain: TerrainDataset,
  observers: readonly Vec2[],
  grid: ViewshedGrid,
  rowStart: number,
  rowEnd: number,
  rowStep = 1,
  known: Uint8Array | null = null,
  options: LosOptions = {},
): Uint8Array {
  let out: Uint8Array | undefined = known ? known.slice() : undefined;
  for (const observer of observers) {
    out = computeViewshedRows(terrain, observer, grid, rowStart, rowEnd, options, rowStep, out);
  }
  return out ?? new Uint8Array(Math.ceil((rowEnd - rowStart) / rowStep) * grid.columns);
}

/**
 * The reference viewshed: every cell traced with `traceSightLine`, exactly as
 * viewsheds were computed before `sightLineTracer`. For tests and benchmarks.
 */
export function computeViewshedRowsReference(
  terrain: TerrainDataset,
  observer: Vec2,
  grid: ViewshedGrid,
  rowStart: number,
  rowEnd: number,
  options: LosOptions = {},
): Uint8Array {
  const eye = {
    x: observer.x,
    y: observer.y,
    z:
      heightAt(terrain, observer.x, observer.y) +
      (options.observerHeightMeters ?? STANDING_EYE_HEIGHT_M),
  };
  const aim = options.targetHeightMeters ?? STANDING_TARGET_HEIGHT_M;
  const out = new Uint8Array((rowEnd - rowStart) * grid.columns);
  for (let r = rowStart; r < rowEnd; r += 1) {
    for (let c = 0; c < grid.columns; c += 1) {
      const { x, y } = cellCentre(grid, c, r);
      const target = { x, y, z: heightAt(terrain, x, y) + aim };
      const clear = (x === eye.x && y === eye.y) || traceSightLine(terrain, eye, target) === null;
      out[(r - rowStart) * grid.columns + c] = clear ? 1 : 0;
    }
  }
  return out;
}

export function computeViewshed(
  terrain: TerrainDataset,
  observer: Vec2,
  grid: ViewshedGrid,
  options: LosOptions = {},
): Viewshed {
  return {
    grid,
    observer: { x: observer.x, y: observer.y },
    visible: computeViewshedRows(terrain, observer, grid, 0, grid.rows, options),
  };
}

/**
 * How much of a polygon (e.g. a kill zone) a viewshed sees: of the grid cells
 * whose centres lie inside or on the polygon, how many are visible.
 */
export function visibleCellsIn(
  viewshed: Viewshed,
  polygon: readonly Vec2[],
): { readonly cells: number; readonly visible: number } {
  const { grid, visible } = viewshed;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const c0 = Math.max(0, Math.floor((minX - grid.originX) / grid.cellSize - 0.5));
  const c1 = Math.min(grid.columns - 1, Math.ceil((maxX - grid.originX) / grid.cellSize - 0.5));
  const r0 = Math.max(0, Math.floor((minY - grid.originY) / grid.cellSize - 0.5));
  const r1 = Math.min(grid.rows - 1, Math.ceil((maxY - grid.originY) / grid.cellSize - 0.5));
  let cells = 0;
  let seen = 0;
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      if (!pointInPolygon(cellCentre(grid, c, r), polygon)) continue;
      cells += 1;
      seen += visible[r * grid.columns + c] ?? 0;
    }
  }
  return { cells, visible: seen };
}
