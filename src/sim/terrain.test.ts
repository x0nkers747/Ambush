import { describe, expect, it } from 'vitest';
import { NO_FEATURES } from './environment';
import { createRngState, nextFloat } from './rng';
import {
  createSyntheticTerrain,
  flatElevation,
  ridgeElevation,
  slopeElevation,
} from './synthetic-terrain';
import {
  heightAt,
  isOnTerrain,
  terrainTriangleIndices,
  validateTerrain,
  type TerrainDataset,
} from './terrain';

/** One 10 m cell: SW = 0, SE = 10, NW = 20, NE = 40 (not planar). */
const ONE_CELL: TerrainDataset = {
  formatVersion: 2,
  georef: null,
  features: NO_FEATURES,
  heightfield: {
    originX: 0,
    originY: 0,
    cellSize: 10,
    columns: 2,
    rows: 2,
    elevations: [0, 10, 20, 40],
  },
};

/** Irregular 4 × 3-sample terrain with a non-zero origin. */
const BUMPY: TerrainDataset = {
  formatVersion: 2,
  georef: null,
  features: NO_FEATURES,
  heightfield: {
    originX: -15,
    originY: 40,
    cellSize: 5,
    columns: 4,
    rows: 3,
    elevations: [3, 7, 1, 4, 9, 2, 8, 6, 0, 5, 11, 2],
  },
};

function samplePoints(terrain: TerrainDataset, count: number, seed: number): [number, number][] {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const rng = createRngState(seed);
  return Array.from({ length: count }, () => [
    originX + nextFloat(rng) * (columns - 1) * cellSize,
    originY + nextFloat(rng) * (rows - 1) * cellSize,
  ]);
}

describe('heightAt', () => {
  it('returns sample elevations exactly at sample points', () => {
    const { originX, originY, cellSize, columns, rows, elevations } = BUMPY.heightfield;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        expect(heightAt(BUMPY, originX + c * cellSize, originY + r * cellSize)).toBe(
          elevations[r * columns + c],
        );
      }
    }
  });

  it('interpolates linearly on the SW–NE triangles, not bilinearly', () => {
    expect(heightAt(ONE_CELL, 5, 0)).toBe(5); // south edge
    expect(heightAt(ONE_CELL, 0, 5)).toBe(10); // west edge
    expect(heightAt(ONE_CELL, 10, 5)).toBe(25); // east edge
    expect(heightAt(ONE_CELL, 5, 10)).toBe(30); // north edge
    expect(heightAt(ONE_CELL, 5, 5)).toBe(20); // diagonal: mean of SW and NE (bilinear: 17.5)
    expect(heightAt(ONE_CELL, 7.5, 2.5)).toBe(15); // south-east triangle (bilinear: 14.375)
    expect(heightAt(ONE_CELL, 2.5, 7.5)).toBe(20); // north-west triangle (bilinear: 19.375)
  });

  it('is continuous across the diagonal and across cell edges', () => {
    const e = 1e-9;
    for (const t of [0.1, 0.37, 0.8]) {
      const onDiagonal = heightAt(ONE_CELL, 10 * t, 10 * t);
      expect(heightAt(ONE_CELL, 10 * t + e, 10 * t)).toBeCloseTo(onDiagonal, 6);
      expect(heightAt(ONE_CELL, 10 * t, 10 * t + e)).toBeCloseTo(onDiagonal, 6);
    }
    // Interior grid line x = -10 of BUMPY, approached from both sides.
    for (const y of [41, 44.4, 47, 49.9]) {
      expect(heightAt(BUMPY, -10 - e, y)).toBeCloseTo(heightAt(BUMPY, -10 + e, y), 6);
    }
  });

  it('reproduces planar terrain exactly everywhere', () => {
    const plane = slopeElevation({ base: 100, gradientX: 0.05, gradientY: -0.12 });
    const terrain = createSyntheticTerrain(
      { originX: -50, originY: -30, cellSize: 7, columns: 12, rows: 9 },
      plane,
    );
    for (const [x, y] of samplePoints(terrain, 500, 1)) {
      expect(heightAt(terrain, x, y)).toBeCloseTo(plane(x, y), 9);
    }
  });

  it('is deterministic', () => {
    const points = samplePoints(BUMPY, 200, 2);
    expect(points.map(([x, y]) => heightAt(BUMPY, x, y))).toEqual(
      points.map(([x, y]) => heightAt(BUMPY, x, y)),
    );
  });
});

describe('terrain boundaries', () => {
  const { originX, originY, cellSize, columns, rows } = BUMPY.heightfield;
  const maxX = originX + (columns - 1) * cellSize; // 0
  const maxY = originY + (rows - 1) * cellSize; // 50

  it('includes the boundary itself', () => {
    expect(heightAt(BUMPY, originX, originY)).toBe(3);
    expect(heightAt(BUMPY, maxX, originY)).toBe(4);
    expect(heightAt(BUMPY, originX, maxY)).toBe(0);
    expect(heightAt(BUMPY, maxX, maxY)).toBe(2);
    expect(heightAt(BUMPY, maxX, 45)).toBe(6); // east edge, mid-height sample
    expect(heightAt(BUMPY, -12.5, maxY)).toBe(2.5); // north edge, between samples 0 and 5
  });

  it.each([
    [originX - 1e-9, 45],
    [maxX + 1e-9, 45],
    [-5, originY - 1e-9],
    [-5, maxY + 1e-9],
    [-1000, -1000],
    [Number.NaN, 45],
    [-5, Number.POSITIVE_INFINITY],
  ])('refuses to extrapolate at (%s, %s)', (x, y) => {
    expect(isOnTerrain(BUMPY, x, y)).toBe(false);
    expect(() => heightAt(BUMPY, x, y)).toThrow(RangeError);
  });

  it('agrees with isOnTerrain', () => {
    expect(isOnTerrain(BUMPY, originX, originY)).toBe(true);
    expect(isOnTerrain(BUMPY, maxX, maxY)).toBe(true);
    expect(isOnTerrain(BUMPY, -7, 43)).toBe(true);
  });
});

describe('terrainTriangleIndices', () => {
  const indices = terrainTriangleIndices(BUMPY);
  const { originX, originY, cellSize, columns, elevations } = BUMPY.heightfield;
  const vertex = (i: number) => ({
    x: originX + (i % columns) * cellSize,
    y: originY + Math.floor(i / columns) * cellSize,
    z: elevations[i] ?? Number.NaN,
  });
  const triangles = Array.from({ length: indices.length / 3 }, (_, t) =>
    [0, 1, 2].map((k) => vertex(indices[t * 3 + k] ?? -1)),
  );

  it('has two triangles per cell, wound counter-clockwise seen from above', () => {
    expect(triangles).toHaveLength(2 * 3 * 2);
    for (const [a, b, c] of triangles) {
      if (!a || !b || !c) throw new Error('incomplete triangle');
      const area2 = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
      expect(area2).toBe(cellSize * cellSize);
    }
  });

  it('uses the SW–NE diagonal: (SW, SE, NE) then (SW, NE, NW)', () => {
    expect(terrainTriangleIndices(ONE_CELL)).toEqual([0, 1, 3, 0, 3, 2]);
  });

  it('defines the same surface as heightAt', () => {
    for (const [x, y] of samplePoints(BUMPY, 500, 3)) {
      const containing = triangles.flatMap(([a, b, c]) => {
        if (!a || !b || !c) return [];
        const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
        const wa = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / det;
        const wb = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / det;
        const wc = 1 - wa - wb;
        return Math.min(wa, wb, wc) >= -1e-12 ? [wa * a.z + wb * b.z + wc * c.z] : [];
      });
      expect(containing.length).toBeGreaterThan(0);
      for (const z of containing) expect(heightAt(BUMPY, x, y)).toBeCloseTo(z, 9);
    }
  });
});

describe('synthetic terrain', () => {
  const grid = { originX: -100, originY: -100, cellSize: 10, columns: 21, rows: 41 };

  it('creates valid terrain with no georeference', () => {
    const terrain = createSyntheticTerrain(grid, flatElevation(12));
    expect(() => {
      validateTerrain(terrain);
    }).not.toThrow();
    expect(terrain.georef).toBeNull();
    expect(terrain.heightfield.elevations).toHaveLength(21 * 41);
    expect(heightAt(terrain, 33.3, 255.5)).toBe(12);
  });

  it('samples a ridge whose profile is reproduced exactly between samples', () => {
    const terrain = createSyntheticTerrain(
      grid,
      ridgeElevation({ base: 50, height: 10, crestY: 100, halfWidth: 50 }),
    );
    expect(heightAt(terrain, 7, 100)).toBe(60);
    expect(heightAt(terrain, 7, 75)).toBe(55);
    expect(heightAt(terrain, 7, 125)).toBe(55);
    expect(heightAt(terrain, 7, 50)).toBe(50);
    expect(heightAt(terrain, 7, -100)).toBe(50);
    expect(heightAt(terrain, -63, 112.5)).toBeCloseTo(57.5, 12);
  });

  it('samples a slope', () => {
    const terrain = createSyntheticTerrain(
      grid,
      slopeElevation({ base: 0, gradientX: 0, gradientY: 0.1 }),
    );
    expect(heightAt(terrain, 0, 0)).toBe(0);
    expect(heightAt(terrain, 50, 200)).toBeCloseTo(20, 12);
  });
});
