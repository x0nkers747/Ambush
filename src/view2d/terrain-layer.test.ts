import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIO } from '#exercise';
import {
  createSyntheticTerrain,
  flatElevation,
  heightAt,
  isOnTerrain,
  ridgeElevation,
  slopeElevation,
  terrainTriangleIndices,
  type TerrainDataset,
} from '#sim';
import { contourIntervals, contourLines, elevationRange, terrainRaster } from './terrain-layer';
import { gridSpacing } from './render';

const GRID = { originX: 0, originY: 0, cellSize: 10, columns: 21, rows: 11 };

function pixel(raster: ReturnType<typeof terrainRaster>, col: number, row: number) {
  const i = (row * raster.width + col) * 4;
  return [
    raster.data[i] ?? 0,
    raster.data[i + 1] ?? 0,
    raster.data[i + 2] ?? 0,
    raster.data[i + 3] ?? 0,
  ];
}
const brightness = (rgba: number[]) => (rgba[0] ?? 0) + (rgba[1] ?? 0) + (rgba[2] ?? 0);

describe('terrainRaster', () => {
  it('has one opaque pixel per sample', () => {
    const raster = terrainRaster(createSyntheticTerrain(GRID, flatElevation(5)));
    expect([raster.width, raster.height]).toEqual([21, 11]);
    expect(raster.data).toHaveLength(21 * 11 * 4);
    const first = pixel(raster, 0, 0);
    for (let r = 0; r < 11; r += 1)
      for (let c = 0; c < 21; c += 1) expect(pixel(raster, c, r)).toEqual(first);
    expect(first[3]).toBe(255);
  });

  it('puts the northernmost samples in the top row', () => {
    // Rising to the north: higher ground has the browner (less green) tint.
    const raster = terrainRaster(
      createSyntheticTerrain(GRID, slopeElevation({ base: 0, gradientX: 0, gradientY: 0.05 })),
    );
    expect(pixel(raster, 10, 0)[1]).toBeLessThan(pixel(raster, 10, 10)[1] ?? 0);
  });

  it('lights north-west-facing slopes and shades south-east-facing ones', () => {
    const terrain = createSyntheticTerrain(
      GRID,
      ridgeElevation({ base: 0, height: 20, crestY: 50, halfWidth: 50 }),
    );
    const raster = terrainRaster(terrain);
    // Row 2 (y = 80) is on the north-facing slope, row 8 (y = 20) on the south-facing one;
    // both are at the same elevation, so only the shading differs.
    expect(brightness(pixel(raster, 10, 2))).toBeGreaterThan(brightness(pixel(raster, 10, 8)));
  });
});

describe('contourLines', () => {
  it('traces exactly what a pass over every triangle for each level traces', () => {
    // Rough synthetic ground with plateaus exactly on levels (corners on a level count as above it).
    const terrain = createSyntheticTerrain(
      { originX: -100, originY: -50, cellSize: 5, columns: 41, rows: 23 },
      (x, y) => Math.round(20 * Math.sin(x / 17) + 15 * Math.cos(y / 11) + (x * y) / 900) / 2,
    );
    const reference = (interval: number) => {
      const { originX, originY, cellSize, columns, elevations } = terrain.heightfield;
      const triangles = terrainTriangleIndices(terrain);
      const { min, max } = elevationRange(terrain);
      const levels: { level: number; segments: number[] }[] = [];
      for (let n = Math.ceil(min / interval); n * interval <= max; n += 1) {
        const level = n * interval;
        const segments: number[] = [];
        for (let t = 0; t < triangles.length; t += 3) {
          const crossings: number[] = [];
          for (let e = 0; e < 3; e += 1) {
            const a = triangles[t + e] ?? 0;
            const b = triangles[t + ((e + 1) % 3)] ?? 0;
            const za = elevations[a] ?? 0;
            const zb = elevations[b] ?? 0;
            if (za >= level !== zb >= level) {
              const f = (level - za) / (zb - za);
              const ax = originX + (a % columns) * cellSize;
              const ay = originY + Math.floor(a / columns) * cellSize;
              const bx = originX + (b % columns) * cellSize;
              const by = originY + Math.floor(b / columns) * cellSize;
              crossings.push(ax + f * (bx - ax), ay + f * (by - ay));
            }
          }
          if (crossings.length === 4) segments.push(...crossings);
        }
        levels.push({ level, segments });
      }
      return levels;
    };
    for (const interval of [0.5, 1, 2, 5, 7.5]) {
      const levels = contourLines(terrain, interval);
      expect(levels).toEqual(reference(interval));
      expect(levels.some((l) => l.segments.length > 0)).toBe(true);
    }
  });

  function expectOnLevels(terrain: TerrainDataset, interval: number) {
    const levels = contourLines(terrain, interval);
    let segments = 0;
    for (const { level, segments: s } of levels) {
      expect(s.length % 4).toBe(0);
      for (let i = 0; i < s.length; i += 2) {
        const x = s[i] ?? Number.NaN;
        const y = s[i + 1] ?? Number.NaN;
        expect(isOnTerrain(terrain, x, y)).toBe(true);
        expect(heightAt(terrain, x, y)).toBeCloseTo(level, 6);
      }
      segments += s.length / 4;
    }
    return { levels, segments };
  }

  it('traces straight contours on a slope at every interval', () => {
    const terrain = createSyntheticTerrain(
      GRID,
      slopeElevation({ base: 3, gradientX: 0.1, gradientY: 0 }),
    );
    const { levels } = expectOnLevels(terrain, 2);
    // Elevations 3 … 23: levels 4, 6, …, 22.
    expect(levels.map((l) => l.level)).toEqual([4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    for (const { level, segments } of levels) {
      for (let i = 0; i < segments.length; i += 2)
        expect(segments[i]).toBeCloseTo((level - 3) / 0.1, 9);
    }
  });

  it('lies exactly on the simulated surface of the demo terrain', () => {
    const { segments } = expectOnLevels(DEMO_SCENARIO.terrain, 2);
    expect(segments).toBeGreaterThan(1000);
  });

  it('produces no lines on flat terrain between levels', () => {
    expect(contourLines(createSyntheticTerrain(GRID, flatElevation(5)), 2)).toEqual([]);
  });

  it('reports the elevation range', () => {
    expect(
      elevationRange(
        createSyntheticTerrain(GRID, slopeElevation({ base: 3, gradientX: 0.1, gradientY: 0 })),
      ),
    ).toEqual({
      min: 3,
      max: 23,
    });
  });
});

describe('gridSpacing', () => {
  it('keeps grid lines at least 70 px apart with round spacings', () => {
    for (const mpp of [0.05, 0.3, 0.77, 1, 3, 12]) {
      const spacing = gridSpacing(mpp);
      expect(spacing / mpp).toBeGreaterThanOrEqual(70);
      expect([10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]).toContain(spacing);
    }
  });
});

describe('contour intervals', () => {
  const imported = (res: number | null, low: number, high: number): TerrainDataset => {
    const t = createSyntheticTerrain(
      { originX: 0, originY: 0, cellSize: 10, columns: 3, rows: 2 },
      (x) => (x === 0 ? low : high),
    );
    return { ...t, formatVersion: 3, metadata: { elevationResolutionM: res, surfaceModel: 'DSM' } };
  };

  it('keeps 2 m with 10 m index lines for terrain without source metadata (the demo)', () => {
    const demo = createSyntheticTerrain(
      { originX: 0, originY: 0, cellSize: 10, columns: 2, rows: 2 },
      () => 0,
    );
    expect(contourIntervals(demo)).toEqual({ minor: 2, index: 10 });
  });

  it('is never finer than the elevation source supports', () => {
    expect(contourIntervals(imported(3, 100, 120))).toEqual({ minor: 1, index: 5 });
    expect(contourIntervals(imported(10, 100, 120))).toEqual({ minor: 2, index: 10 });
    expect(contourIntervals(imported(30, 100, 120))).toEqual({ minor: 5, index: 25 });
    expect(contourIntervals(imported(null, 100, 120))).toEqual({ minor: 5, index: 25 });
  });

  it('widens to keep the relief to at most 40 levels', () => {
    expect(contourIntervals(imported(3, 0, 300))).toEqual({ minor: 10, index: 50 });
    expect(contourIntervals(imported(30, 0, 1500))).toEqual({ minor: 50, index: 250 });
  });
});
