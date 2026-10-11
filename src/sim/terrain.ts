import { validateFeatures, type EnvironmentFeatures } from './environment';
import type { TerrainCleaning } from './dem-quality';
import { refinementIndex, sampleSurface } from './terrain-surface';

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

/**
 * What is known about an imported heightfield's source (docs/adr/0014). Not
 * used by the simulation: it lets tools state how far to trust the terrain.
 */
export interface TerrainMetadata {
  /**
   * Native horizontal resolution of the elevation source, in metres (the
   * finest listed; the grid's `cellSize` may be finer, which adds no detail).
   */
  readonly elevationResolutionM: number | null;
  /** `DTM`: bare earth; `DSM`: includes canopy and buildings; `mixed` or `unknown`. */
  readonly surfaceModel: 'DTM' | 'DSM' | 'mixed' | 'unknown';
}

/**
 * Local refinement of the heightfield (docs/adr/0032): some cells of the
 * regular grid are replaced by a finer regular grid of their own, where the
 * ground has detail the grid cannot hold (graded roads and building
 * foundations). A refined cell (c, r) is `factor` × `factor` fine cells, each
 * split along its south-west to north-east diagonal like the coarse cells.
 * Its samples on the cell's edges equal the neighbouring surface: the
 * coarse corners are the heightfield's own samples, and along an edge shared
 * with an unrefined cell the samples lie on that cell's straight edge, so the
 * surface is continuous everywhere.
 */
export interface TerrainRefinement {
  /** Fine cells per coarse cell side (≥ 2). */
  readonly factor: number;
  /** Refined coarse cells, ascending, as `r * (columns − 1) + c`. */
  readonly cells: readonly number[];
  /**
   * `(factor + 1)²` samples per refined cell, in `cells` order, each row-major
   * from the cell's south-west corner.
   */
  readonly samples: readonly number[];
}

/** How a graded terrain was made from its source (docs/adr/0032). */
export interface TerrainGrading {
  /** `GRADING_VERSION` of the rules that made it. */
  readonly version: number;
  /** Spacing of the refined samples, in metres. */
  readonly fineSpacingM: number;
}

/** Elevation plus the environment features standing on it. */
export interface TerrainDataset {
  /**
   * 2 added `features`; 3 (imported terrain, docs/adr/0014) adds water,
   * waterways, land use, vegetation holes, feature sources and `metadata`.
   * Format 2 data stays valid as it is.
   */
  readonly formatVersion: 2 | 3;
  readonly georef: GeoReference | null;
  readonly heightfield: Heightfield;
  readonly features: EnvironmentFeatures;
  readonly metadata?: TerrainMetadata;
  /** Finer samples in some cells; part of the surface (docs/adr/0032). */
  readonly refinement?: TerrainRefinement;
  /** Present on a cleaned terrain: the DEM after quality repair (docs/adr/0033). */
  readonly cleaning?: TerrainCleaning;
  /** Present on a graded terrain: the authoritative ground every system uses. */
  readonly grading?: TerrainGrading;
}

/** Throws a RangeError describing the first invalid field. */
export function validateTerrain(terrain: TerrainDataset): void {
  // Stored data is checked at run time, whatever its static type says.
  const format: number = terrain.formatVersion;
  if (format !== 2 && format !== 3) {
    throw new RangeError(`terrain format ${String(format)} is not supported`);
  }
  if (terrain.formatVersion === 3) {
    const { water, waterways, landUse } = terrain.features;
    if (!Array.isArray(water) || !Array.isArray(waterways) || !Array.isArray(landUse)) {
      throw new RangeError('terrain format 3 needs water, waterways and land use lists');
    }
  }
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
  if (terrain.refinement) validateRefinement(terrain);
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
 * (see `terrainTriangleIndices`), or on a refined cell's fine triangles where
 * the terrain is refined (docs/adr/0032). The one elevation query every
 * system uses. Throws a RangeError off the terrain; it never extrapolates.
 */
export function heightAt(terrain: TerrainDataset, x: number, y: number): number {
  if (!isOnTerrain(terrain, x, y)) {
    throw new RangeError(`(${String(x)}, ${String(y)}) is outside the terrain`);
  }
  return sampleSurface(
    terrain.heightfield,
    terrain.heightfield.elevations,
    refinementIndex(terrain),
    x,
    y,
  );
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

/** Checks a terrain's refinement (docs/adr/0032); throws a RangeError. */
function validateRefinement(terrain: TerrainDataset): void {
  const { columns, rows, elevations } = terrain.heightfield;
  const ref = terrain.refinement;
  if (!ref) return;
  const { factor, cells, samples } = ref;
  if (!Number.isInteger(factor) || factor < 2) {
    throw new RangeError(`terrain refinement factor must be an integer ≥ 2, got ${String(factor)}`);
  }
  const n1 = factor + 1;
  if (samples.length !== cells.length * n1 * n1) {
    throw new RangeError('terrain refinement has the wrong number of samples');
  }
  if (!samples.every(Number.isFinite))
    throw new RangeError('terrain refinement samples must be finite');
  const cellCount = (columns - 1) * (rows - 1);
  cells.forEach((cell, k) => {
    if (!Number.isInteger(cell) || cell < 0 || cell >= cellCount) {
      throw new RangeError(`terrain refinement cell ${String(cell)} is off the grid`);
    }
    if (k > 0 && !(cell > (cells[k - 1] ?? -1))) {
      throw new RangeError('terrain refinement cells must be ascending and distinct');
    }
    // The fine corners are the coarse samples: the surface stays continuous.
    const c = cell % (columns - 1);
    const r = Math.floor(cell / (columns - 1));
    const o = k * n1 * n1;
    const corners: [number, number][] = [
      [o, r * columns + c],
      [o + factor, r * columns + c + 1],
      [o + factor * n1, (r + 1) * columns + c],
      [o + factor * n1 + factor, (r + 1) * columns + c + 1],
    ];
    for (const [fine, coarse] of corners) {
      if (Math.abs((samples[fine] ?? NaN) - (elevations[coarse] ?? NaN)) > 1e-6) {
        throw new RangeError(`terrain refinement cell ${String(cell)} does not meet its corners`);
      }
    }
    // Along an edge shared with an unrefined cell the samples lie on that
    // cell's straight edge.
    const refined = (cc: number, rr: number) =>
      cc < 0 || rr < 0 || cc >= columns - 1 || rr >= rows - 1
        ? true
        : binarySearch(cells, rr * (columns - 1) + cc);
    const edges: [boolean, (m: number) => number, number, number][] = [
      [refined(c, r - 1), (m) => o + m, o, o + factor],
      [refined(c, r + 1), (m) => o + factor * n1 + m, o + factor * n1, o + factor * n1 + factor],
      [refined(c - 1, r), (m) => o + m * n1, o, o + factor * n1],
      [refined(c + 1, r), (m) => o + m * n1 + factor, o + factor, o + factor * n1 + factor],
    ];
    for (const [shared, at, from, to] of edges) {
      if (shared) continue;
      for (let m = 1; m < factor; m += 1) {
        const expected =
          (samples[from] ?? NaN) + (m / factor) * ((samples[to] ?? NaN) - (samples[from] ?? NaN));
        if (Math.abs((samples[at(m)] ?? NaN) - expected) > 1e-6) {
          throw new RangeError(
            `terrain refinement cell ${String(cell)} does not meet its unrefined neighbour`,
          );
        }
      }
    }
  });
}

function binarySearch(sorted: readonly number[], value: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid] ?? 0;
    if (v === value) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}
