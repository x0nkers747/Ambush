import { NO_FEATURES, type EnvironmentFeatures } from './environment';
import type { TerrainDataset } from './terrain';

// Synthetic terrain for tests and early scenarios: a heightfield sampled from
// a simple elevation function. Imported real-world terrain arrives later.

export interface TerrainGrid {
  readonly originX: number;
  readonly originY: number;
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
}

/** Elevation in metres at map point (x, y). */
export type ElevationFunction = (x: number, y: number) => number;

export function createSyntheticTerrain(
  grid: TerrainGrid,
  elevationAt: ElevationFunction,
  features: EnvironmentFeatures = NO_FEATURES,
): TerrainDataset {
  const { originX, originY, cellSize, columns, rows } = grid;
  const elevations: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      elevations.push(elevationAt(originX + c * cellSize, originY + r * cellSize));
    }
  }
  return {
    formatVersion: 2,
    georef: null,
    heightfield: { originX, originY, cellSize, columns, rows, elevations },
    features,
  };
}

export const flatElevation =
  (elevation: number): ElevationFunction =>
  () =>
    elevation;

/** A uniform slope: rises `gradientX` metres per metre east and `gradientY` per metre north. */
export const slopeElevation =
  ({
    base,
    gradientX,
    gradientY,
  }: {
    base: number;
    gradientX: number;
    gradientY: number;
  }): ElevationFunction =>
  (x, y) =>
    base + gradientX * x + gradientY * y;

/**
 * A straight east–west ridge with its crest along `crestY`, rising `height`
 * metres above `base` and falling linearly to `base` at `halfWidth` metres
 * north and south of the crest.
 */
export const ridgeElevation =
  ({
    base,
    height,
    crestY,
    halfWidth,
  }: {
    base: number;
    height: number;
    crestY: number;
    halfWidth: number;
  }): ElevationFunction =>
  (_x, y) =>
    base + height * Math.max(0, 1 - Math.abs(y - crestY) / halfWidth);
