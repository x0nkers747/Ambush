import { validateFeatures, type EnvironmentFeatures } from './environment';

// Runtime terrain format (docs/adr/0006, docs/adr/0008, docs/adr/0011).
// Immutable reference data: it is not part of SimState, is never mutated, and
// is not snapshotted.

/** Relates the simulation frame to a projected CRS. `null` for synthetic terrain. */
export interface GeoReference {
  /** Projected CRS code, e.g. "EPSG:32633" (UTM zone 33N). */
  readonly crs: string;
  /** Projected coordinates of the simulation origin, in metres. */
  readonly falseEasting: number;
  readonly falseNorthing: number;
  /** Vertical datum of the elevations, e.g. "EGM2008". */
  readonly verticalDatum: string;
}

/**
 * A regular grid of elevation samples in the simulation frame.
 *
 * Sample (column c, row r) lies at
 * `(originX + c * cellSize, originY + r * cellSize)` and its elevation is
 * `elevations[r * columns + c]`: rows run south to north, columns west to east.
 * The terrain covers `[originX, originX + (columns − 1) * cellSize]` ×
 * `[originY, originY + (rows − 1) * cellSize]`, boundaries included.
 */
export interface Heightfield {
  readonly originX: number;
  readonly originY: number;
  /** Spacing between samples in X and Y, in metres. */
  readonly cellSize: number;
  /** Number of samples west to east (≥ 2). */
  readonly columns: number;
  /** Number of samples south to north (≥ 2). */
  readonly rows: number;
  /** Elevation (Z) of each sample in metres, row-major from the south-west corner. */
  readonly elevations: readonly number[];
}

/** Elevation plus the environment features standing on it. */
export interface TerrainDataset {
  /** 2 added `features`. */
  readonly formatVersion: 2;
  readonly georef: GeoReference | null;
  readonly heightfield: Heightfield;
  readonly features: EnvironmentFeatures;
}

/** Throws a RangeError describing the first invalid field. */
export function validateTerrain(terrain: TerrainDataset): void {
  const { originX, originY, cellSize, columns, rows, elevations } = terrain.heightfield;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    throw new RangeError('terrain origin must be finite');
  }
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
    throw new RangeError(`terrain cellSize must be a finite number > 0, got ${String(cellSize)}`);
  }
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 2 || rows < 2) {
    throw new RangeError(
      `terrain needs at least 2 × 2 samples, got ${String(columns)} × ${String(rows)}`,
    );
  }
  if (elevations.length !== columns * rows) {
    throw new RangeError(
      `terrain has ${String(elevations.length)} elevations, expected ${String(columns * rows)}`,
    );
  }
  if (!elevations.every(Number.isFinite)) throw new RangeError('terrain elevations must be finite');
  validateFeatures(terrain.features, ({ x, y }) => isOnTerrain(terrain, x, y));
}

/** Whether (x, y) lies on the terrain, boundaries included. */
export function isOnTerrain(terrain: TerrainDataset, x: number, y: number): boolean {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  return (
    x >= originX &&
    x <= originX + (columns - 1) * cellSize &&
    y >= originY &&
    y <= originY + (rows - 1) * cellSize
  );
}

/**
 * Terrain elevation at (x, y), interpolated linearly on the terrain triangles
 * (see `terrainTriangleIndices`). Throws a RangeError off the terrain; it never
 * extrapolates.
 */
export function heightAt(terrain: TerrainDataset, x: number, y: number): number {
  if (!isOnTerrain(terrain, x, y)) {
    throw new RangeError(`(${String(x)}, ${String(y)}) is outside the terrain`);
  }
  const { originX, originY, cellSize, columns, rows, elevations } = terrain.heightfield;
  const gx = (x - originX) / cellSize;
  const gy = (y - originY) / cellSize;
  // The last row/column of samples belongs to the cell below/left of it.
  const c = Math.min(Math.floor(gx), columns - 2);
  const r = Math.min(Math.floor(gy), rows - 2);
  const u = gx - c;
  const v = gy - r;

  const at = (col: number, row: number): number => elevations[row * columns + col] ?? Number.NaN;
  const sw = at(c, r);
  const se = at(c + 1, r);
  const nw = at(c, r + 1);
  const ne = at(c + 1, r + 1);

  // Each cell is split along its SW–NE diagonal.
  return u >= v
    ? sw + u * (se - sw) + v * (ne - se) // south-east triangle: SW, SE, NE
    : sw + v * (nw - sw) + u * (ne - nw); // north-west triangle: SW, NE, NW
}

/**
 * The terrain triangulation: the single convention shared by `heightAt` and any
 * rendered terrain mesh, so that what is drawn matches what is simulated.
 *
 * Returns sample indices (`row * columns + col`), three per triangle, two
 * triangles per cell in row-major cell order: (SW, SE, NE) then (SW, NE, NW).
 * Both are counter-clockwise seen from above (+Z).
 */
export function terrainTriangleIndices(terrain: TerrainDataset): number[] {
  const { columns, rows } = terrain.heightfield;
  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < columns - 1; c += 1) {
      const sw = r * columns + c;
      const se = sw + 1;
      const nw = sw + columns;
      const ne = nw + 1;
      indices.push(sw, se, ne, sw, ne, nw);
    }
  }
  return indices;
}
