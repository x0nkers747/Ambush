import { describe, expect, it } from 'vitest';
import { NO_FEATURES, rectangle, type EnvironmentFeatures } from './environment';
import { lineOfSight, STANDING_EYE_HEIGHT_M, STANDING_TARGET_HEIGHT_M } from './los';
import {
  createSyntheticTerrain,
  flatElevation,
  ridgeElevation,
  type ElevationFunction,
} from './synthetic-terrain';

/** 200 m square, 5 m cells; the observer looks due north from (0, −50) to (0, 50). */
function terrain(
  elevation: ElevationFunction = flatElevation(100),
  features: Partial<EnvironmentFeatures> = {},
) {
  return createSyntheticTerrain(
    { originX: -100, originY: -100, cellSize: 5, columns: 41, rows: 41 },
    elevation,
    { ...NO_FEATURES, ...features },
  );
}
const FROM = { x: 0, y: -50 };
const TO = { x: 0, y: 50 };

/** A wall across the sight line at y ∈ [−10, 10]. */
const building = (heightMeters: number) => ({
  id: 'B-1',
  footprint: rectangle(0, 0, 40, 20),
  heightMeters,
});
/** A vegetation strip across the sight line, `depth` metres deep, starting at y = `start`. */
const strip = (
  id: string,
  start: number,
  depth: number,
  seeThroughMeters: number,
  canopyHeightMeters = 10,
) => ({
  id,
  kind: 'woodland' as const,
  boundary: rectangle(0, start + depth / 2, 60, depth),
  canopyHeightMeters,
  seeThroughMeters,
});

describe('lineOfSight', () => {
  it('is clear across flat open terrain, from eye height to target height', () => {
    const result = lineOfSight(terrain(), FROM, TO);
    expect(result).toEqual({
      from: { x: 0, y: -50, z: 100 + STANDING_EYE_HEIGHT_M },
      to: { x: 0, y: 50, z: 100 + STANDING_TARGET_HEIGHT_M },
      distance: 100,
      clear: true,
      obstruction: null,
    });
  });

  it('is blocked by a ridge, at the exact point the ground rises above the line', () => {
    // Crest 10 m high at y = 0, sloping to nothing 30 m either side.
    const result = lineOfSight(
      terrain(ridgeElevation({ base: 100, height: 10, crestY: 0, halfWidth: 30 })),
      FROM,
      TO,
    );
    expect(result.clear).toBe(false);
    expect(result.obstruction?.cause).toEqual({ kind: 'terrain' });
    // The line at distance d is 101.7 − 0.002 d; the ground rises 1/3 m per metre from y = −30.
    const d = (1.7 + 20 / 3) / (1 / 3 + 0.002);
    expect(result.obstruction?.distance).toBeCloseTo(d, 9);
    expect(result.obstruction?.point.y).toBeCloseTo(-50 + d, 9);
  });

  it('is not blocked by low ground features below the line', () => {
    expect(
      lineOfSight(
        terrain(ridgeElevation({ base: 100, height: 1, crestY: 0, halfWidth: 30 })),
        FROM,
        TO,
      ).clear,
    ).toBe(true);
    // Looking down a slope over a dip.
    const valley: ElevationFunction = (_x, y) => 100 - 0.2 * y - 8 * Math.exp(-(y * y) / 200);
    expect(lineOfSight(terrain(valley), FROM, TO).clear).toBe(true);
  });

  it('is blocked by a building in the way, at its wall', () => {
    const result = lineOfSight(terrain(flatElevation(100), { buildings: [building(6)] }), FROM, TO);
    expect(result.obstruction).toEqual({
      cause: { kind: 'building', featureId: 'B-1' },
      point: { x: 0, y: -10, z: expect.closeTo(101.7 - 0.08, 9) as number },
      distance: 40,
    });
  });

  it('passes over a building lower than the line', () => {
    expect(
      lineOfSight(terrain(flatElevation(100), { buildings: [building(1)] }), FROM, TO).clear,
    ).toBe(true);
    // Looking down from a hill top over a 6 m building on the flat ground below.
    const hill: ElevationFunction = (_x, y) => 100 + 30 * Math.max(0, 1 - (y + 50) / 30);
    const result = lineOfSight(terrain(hill, { buildings: [building(6)] }), FROM, TO);
    expect(result.clear).toBe(true);
  });

  it('reports where a descending line meets a roof', () => {
    // Eye 10 m up (a tower), looking down at a standing target: the line clears the
    // wall at y = −10 and descends into the 6 m roof inside the footprint.
    const result = lineOfSight(
      terrain(flatElevation(100), { buildings: [building(6)] }),
      FROM,
      TO,
      {
        observerHeightMeters: 10,
      },
    );
    // Line: 110 at y = −50 to 101.5 at y = 50; it reaches the roof (106) at y = −50 + 4 / 0.085.
    expect(result.obstruction?.cause).toEqual({ kind: 'building', featureId: 'B-1' });
    expect(result.obstruction?.point.y).toBeCloseTo(-50 + 4 / 0.085, 9);
    expect(result.obstruction?.point.z).toBeCloseTo(106, 9);
  });

  it('is blocked by vegetation deeper than its see-through depth', () => {
    const result = lineOfSight(
      terrain(flatElevation(100), { vegetation: [strip('V-1', -10, 30, 20)] }),
      FROM,
      TO,
    );
    expect(result.obstruction?.cause).toEqual({ kind: 'vegetation', featureId: 'V-1' });
    expect(result.obstruction?.distance).toBeCloseTo(40 + 20, 9); // 20 m into it
  });

  it('can be seen through thin or sparse vegetation', () => {
    expect(
      lineOfSight(
        terrain(flatElevation(100), { vegetation: [strip('V-1', -10, 30, 40)] }),
        FROM,
        TO,
      ).clear,
    ).toBe(true);
    expect(
      lineOfSight(
        terrain(flatElevation(100), { vegetation: [strip('V-1', -10, 10, 20)] }),
        FROM,
        TO,
      ).clear,
    ).toBe(true);
  });

  it('is not obscured by vegetation lower than the line', () => {
    const scrub = strip('V-1', -10, 60, 5, 1); // canopy 1 m, line at ~1.6 m
    expect(lineOfSight(terrain(flatElevation(100), { vegetation: [scrub] }), FROM, TO).clear).toBe(
      true,
    );
  });

  it('adds up obscuration across separate areas and blames the one where it is reached', () => {
    const result = lineOfSight(
      terrain(flatElevation(100), {
        vegetation: [strip('V-1', -20, 15, 20), strip('V-2', 10, 15, 20)],
      }),
      FROM,
      TO,
    );
    // 15 m of V-1 gives 0.75; 5 m into V-2 gives the remaining 0.25.
    expect(result.obstruction?.cause).toEqual({ kind: 'vegetation', featureId: 'V-2' });
    expect(result.obstruction?.distance).toBeCloseTo(60 + 5, 9);
  });

  it('reports the first obstruction along the line', () => {
    const t = terrain(ridgeElevation({ base: 100, height: 10, crestY: 30, halfWidth: 10 }), {
      buildings: [building(6)],
      vegetation: [strip('V-1', -40, 25, 10)],
    });
    // Vegetation obscures 10 m in (at y = −30), before the building (y = −10) and the ridge.
    expect(lineOfSight(t, FROM, TO).obstruction?.cause).toEqual({
      kind: 'vegetation',
      featureId: 'V-1',
    });
    // Looking the other way, the ridge comes first.
    expect(lineOfSight(t, TO, FROM).obstruction?.cause).toEqual({ kind: 'terrain' });
  });

  it('honours custom eye and target heights', () => {
    const low = terrain(flatElevation(100), { buildings: [building(2)] });
    expect(lineOfSight(low, FROM, TO).clear).toBe(false);
    expect(
      lineOfSight(low, FROM, TO, { observerHeightMeters: 3, targetHeightMeters: 3 }).clear,
    ).toBe(true);
  });

  it('is deterministic', () => {
    const t = terrain(ridgeElevation({ base: 100, height: 4, crestY: 7, halfWidth: 33 }), {
      buildings: [building(3)],
      vegetation: [strip('V-1', -40, 25, 30)],
    });
    const runs = Array.from({ length: 5 }, () =>
      lineOfSight(t, { x: -37, y: -61 }, { x: 22, y: 71 }),
    );
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it('refuses endpoints off the terrain', () => {
    expect(() => lineOfSight(terrain(), FROM, { x: 0, y: 150 })).toThrow(RangeError);
  });
});
