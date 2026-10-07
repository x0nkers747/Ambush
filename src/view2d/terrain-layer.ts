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

export interface ContourLevel {
  /** Elevation in metres. */
  readonly level: number;
  /** Line segments as map coordinates x1, y1, x2, y2, x1, … */
  readonly segments: readonly number[];
}

/**
 * Contour lines every `interval` metres, traced on the terrain triangles
 * (`terrainTriangleIndices`) so they match the simulated surface exactly.
 */
export function contourLines(terrain: TerrainDataset, interval: number): ContourLevel[] {
  const { originX, originY, cellSize, columns, elevations } = terrain.heightfield;
  const triangles = terrainTriangleIndices(terrain);
  const x = (i: number) => originX + (i % columns) * cellSize;
  const y = (i: number) => originY + Math.floor(i / columns) * cellSize;
  const z = (i: number) => elevations[i] ?? 0;

  const levels: ContourLevel[] = [];
  const { min, max } = elevationRange(terrain);
  for (let n = Math.ceil(min / interval); n * interval <= max; n += 1) {
    const level = n * interval;
    const segments: number[] = [];
    for (let t = 0; t < triangles.length; t += 3) {
      const corners = [triangles[t] ?? 0, triangles[t + 1] ?? 0, triangles[t + 2] ?? 0];
      const crossings: number[] = [];
      for (let e = 0; e < 3; e += 1) {
        const a = corners[e] ?? 0;
        const b = corners[(e + 1) % 3] ?? 0;
        // A corner exactly on the level counts as above it, so each crossing is found once.
        if (z(a) >= level !== z(b) >= level) {
          const f = (level - z(a)) / (z(b) - z(a));
          crossings.push(x(a) + f * (x(b) - x(a)), y(a) + f * (y(b) - y(a)));
        }
      }
      if (crossings.length === 4) segments.push(...crossings);
    }
    levels.push({ level, segments });
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
