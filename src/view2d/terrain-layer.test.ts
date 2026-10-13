import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIO } from '#exercise';
import {
  createSyntheticTerrain,
  flatElevation,
  gradeTerrain,
  heightAt,
  isOnTerrain,
  rectangle,
  ridgeElevation,
  slopeElevation,
  terrainTriangleIndices,
  type TerrainDataset,
} from '#sim';
import {
  contourIntervals,
  contourLines,
  elevationAt,
  elevationRange,
  placeSpotHeights,
  spotHeightLabel,
  spotHeights,
  terrainRaster,
  type SpotHeight,
} from './terrain-layer';
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
        // Refined samples are Float32: within their precision.
        expect(heightAt(terrain, x, y)).toBeCloseTo(level, 5);
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

// Spot heights (docs/adr/0024).
describe('spotHeights', () => {
  /**
   * Terrain shaped by a profile along x (heights at columns 0–20, 10 m apart),
   * highest along the middle row (row 5) and falling 1 m per row away from
   * it: summits lie on the middle row, and the ridge along it is the highest
   * way between them, so its lowest point between two summits is their saddle.
   */
  const profiled = (profile: readonly number[]) =>
    createSyntheticTerrain(
      GRID,
      (x, y) => (profile[Math.round(x / 10)] ?? 0) - Math.abs(Math.round(y / 10) - 5),
    );
  // Rises to 50 m at column 6, dips to 35 m at column 10, rises to 45 m at column 14.
  const TWO_HILLS = [
    0, 8, 16, 24, 32, 40, 50, 46, 42, 38, 35, 38, 41, 43, 45, 40, 30, 20, 10, 5, 0,
  ];

  it('finds each summit with its height and prominence, most prominent first', () => {
    expect(spotHeights(profiled(TWO_HILLS))).toEqual([
      // The highest summit: above the lowest sample (0 m at column 0, 5 m below the middle row).
      { x: 60, y: 50, elevation: 50, prominence: 55 },
      // The other: above the saddle at column 10.
      { x: 140, y: 50, elevation: 45, prominence: 10 },
    ]);
  });

  it('marks a flat top at its middle', () => {
    const flat = [0, 10, 20, 30, 40, 45, 50, 50, 50, 50, 50, 50, 50, 45, 40, 30, 20, 10, 5, 2, 0];
    expect(spotHeights(profiled(flat)).map((s) => [s.x, s.y, s.elevation])).toEqual([[90, 50, 50]]);
  });

  it('leaves out summits near the edge, low knolls and single-sample spikes', () => {
    // A summit 20 m from the west edge, a 1 m knoll, and a 30 m spike on a slope.
    const profile = [10, 15, 30, 20, 15, 12, 13, 12, 10, 8, 6, 4, 2, 1, 0, 0, 0, 0, 0, 0, 0];
    const terrain = profiled(profile);
    const spiked: TerrainDataset = {
      ...terrain,
      heightfield: {
        ...terrain.heightfield,
        elevations: terrain.heightfield.elevations.map((z, i) => (i === 5 * 21 + 10 ? z + 30 : z)),
      },
    };
    expect(spotHeights(terrain)).toEqual([]);
    expect(spotHeights(spiked)).toEqual([]);
  });

  it('is deterministic and puts every summit on a local maximum (the demo battlefield)', () => {
    const terrain = DEMO_SCENARIO.terrain;
    const spots = spotHeights(terrain);
    expect(spots.length).toBeGreaterThan(0);
    expect(spotHeights(terrain)).toEqual(spots);
    const { originX, originY, cellSize, columns, elevations } = terrain.heightfield;
    for (const s of spots) {
      const c = Math.round((s.x - originX) / cellSize);
      const r = Math.round((s.y - originY) / cellSize);
      expect(s.elevation).toBe(elevations[r * columns + c]);
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          expect(s.elevation).toBeGreaterThanOrEqual(elevations[(r + dr) * columns + c + dc] ?? 0);
        }
      }
      expect(s.prominence).toBeGreaterThanOrEqual(2);
    }
    const order = spots.map((s) => s.prominence);
    expect(order).toEqual([...order].sort((a, b) => b - a));
  });
});

describe('placeSpotHeights', () => {
  const spot = (x: number, prominence: number, elevation = 100): SpotHeight => ({
    x,
    y: 0,
    elevation,
    prominence,
  });

  it('shows more modest summits as the map zooms in', () => {
    const spots = [spot(0, 40), spot(1000, 12), spot(2000, 3)];
    expect(placeSpotHeights(spots, 10).map((s) => s.prominence)).toEqual([40]);
    expect(placeSpotHeights(spots, 5).map((s) => s.prominence)).toEqual([40, 12]);
    expect(placeSpotHeights(spots, 1).map((s) => s.prominence)).toEqual([40, 12, 3]);
  });

  it('keeps marks from overlapping, the more prominent summit winning', () => {
    const spots = [spot(0, 30, 123), spot(20, 10, 118)];
    // 1 m per pixel: 20 px apart, closer than a label is wide.
    expect(placeSpotHeights(spots, 1)).toEqual([spots[0]]);
    // 0.1 m per pixel: 200 px apart.
    expect(placeSpotHeights(spots, 0.1)).toEqual(spots);
  });

  it('labels heights in whole metres', () => {
    expect(spotHeightLabel(spot(0, 5, 64.6))).toBe('65');
    expect(spotHeightLabel(spot(0, 5, -3.2))).toBe('-3');
  });
});

describe('the 2D map on graded terrain (docs/adr/0032)', () => {
  // A road cut through a ridge and a building pad on a slope.
  const source = createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
    (x, y) => 100 + 0.04 * x + 6 * Math.exp(-(((y - 60) / 8) ** 2)),
    {
      roads: [
        {
          id: 'cut',
          roadClass: 'paved',
          widthMeters: 6,
          centerline: [
            { x: -100, y: -180 },
            { x: -100, y: 180 },
          ],
        },
      ],
      buildings: [{ id: 'pad', footprint: rectangle(100, -50, 18, 12, 15), heightMeters: 6 }],
      vegetation: [],
    },
  );
  const graded = gradeTerrain(source);

  it('traces contours on the graded ground, cuttings and pads included', () => {
    const levels = contourLines(graded, 1);
    let points = 0;
    let changed = 0;
    for (const { level, segments } of levels) {
      for (let i = 0; i < segments.length; i += 2) {
        const x = segments[i] ?? 0;
        const y = segments[i + 1] ?? 0;
        points += 1;
        // On the graded surface, to the centimetre…
        expect(Math.abs(heightAt(graded, x, y) - level)).toBeLessThan(0.01);
        // …and where grading changed the ground, not on the source's contour.
        if (Math.abs(heightAt(source, x, y) - level) > 0.5) changed += 1;
      }
    }
    expect(points).toBeGreaterThan(1000);
    expect(changed).toBeGreaterThan(20);
    // The cutting's floor is lower than any source ground there: it is in the range.
    expect(elevationRange(graded).min).toBeLessThanOrEqual(elevationRange(source).min + 1e-9);
  });

  it("reads the pointer's elevation from the graded ground", () => {
    expect(elevationAt(graded, -100, 60)).toBe(heightAt(graded, -100, 60));
    expect(elevationAt(graded, -100, 60)).not.toBe(heightAt(source, -100, 60));
    expect(elevationAt(graded, 500, 0)).toBeNull();
  });
});
