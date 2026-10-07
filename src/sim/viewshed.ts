import type { Vec2 } from './geometry';
import {
  STANDING_EYE_HEIGHT_M,
  STANDING_TARGET_HEIGHT_M,
  traceSightLine,
  type LosOptions,
} from './los';
import { pointInPolygon } from './polygon';
import { heightAt, type TerrainDataset } from './terrain';

// Viewsheds (docs/adr/0011): which ground an observer can see, sampled on a
// regular grid. Each cell is decided by exactly the same sight-line trace as
// `lineOfSight`, from the observer's eye to a standing target at the cell
// centre, so a viewshed never disagrees with a point query. The interface
// (a grid in, a visibility field out) lets a faster algorithm replace the
// per-cell trace later without changing callers.

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
 * grid from `observer`: one byte per cell, 1 visible, 0 not. Rows are
 * independent, so a viewshed can be computed in parts, in any order, and
 * assembled into an identical result.
 */
export function computeViewshedRows(
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
