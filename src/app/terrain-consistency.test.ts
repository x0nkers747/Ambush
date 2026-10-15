import { describe, expect, it } from 'vitest';
import { DEMO_TERRAIN } from '#exercise';
import {
  createSyntheticTerrain,
  gradeTerrain,
  heightAt,
  rectangle,
  refinementIndex,
  TERRAIN_MODEL,
  terrainModelId,
} from '#sim';
import { elevationAt } from '#view2d';
import { terrainGround } from '#view3d';
import { authoritativeTerrain } from './terrain-grading';

// One authoritative terrain for every system (docs/adr/0032): the 2D map's
// elevation readout and the 3D view's ground query give the same value as
// the simulation's `heightAt`, at every point, refined cells included.

const site = gradeTerrain(
  createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
    (x, y) => 100 + 0.05 * x + 6 * Math.exp(-(((y - 60) / 8) ** 2)),
    {
      roads: [
        {
          id: 'r',
          roadClass: 'paved',
          widthMeters: 6,
          centerline: [
            { x: -100, y: -180 },
            { x: -100, y: 180 },
          ],
        },
      ],
      buildings: [{ id: 'b', footprint: rectangle(100, 120, 16, 10, 20), heightMeters: 7 }],
      vegetation: [],
    },
  ),
);

describe('2D and 3D elevation queries', () => {
  for (const [name, terrain] of [
    ['a graded site', site],
    ['the demo', DEMO_TERRAIN],
  ] as const) {
    it(`agree exactly with each other and with the simulation on ${name}`, () => {
      expect(refinementIndex(terrain)).not.toBeNull();
      const ground3d = terrainGround(terrain);
      const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
      let state = 12345;
      const next = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
      };
      for (let i = 0; i < 5000; i += 1) {
        const x = originX + next() * (columns - 1) * cellSize;
        const y = originY + next() * (rows - 1) * cellSize;
        const z = heightAt(terrain, x, y);
        expect(elevationAt(terrain, x, y)).toBe(z);
        // The 3D view's axes: (x, y) on the map is (x, −y) on its ground.
        expect(ground3d(x, -y)).toBe(z);
      }
    });
  }
});

describe('the terrain a battlefield opens with (docs/adr/0033)', () => {
  const raw = createSyntheticTerrain(
    { originX: 0, originY: 0, cellSize: 10, columns: 31, rows: 31 },
    (x, y) => 20 + 0.02 * x + (x === 150 && y === 150 ? -782 : 0),
    { roads: [], buildings: [], vegetation: [] },
  );

  it('is the raw DEM cleaned, then graded: never a surface prepared by other rules', async () => {
    const prepared = await authoritativeTerrain('test-battlefield', raw, null);
    expect(terrainModelId(prepared.terrain)).toBe(TERRAIN_MODEL);
    expect(prepared.quality.repairedSamples).toBe(1);
    expect(heightAt(prepared.terrain, 150, 150)).toBeCloseTo(23, 0);
    // The stored raw terrain is unchanged.
    expect(heightAt(raw, 150, 150)).toBeLessThan(-700);
    // The same battlefield and rules: the same preparation, not another.
    expect(await authoritativeTerrain('test-battlefield', raw, null)).toBe(prepared);
    // 2D and 3D read the repaired ground too.
    expect(elevationAt(prepared.terrain, 150, 150)).toBe(heightAt(prepared.terrain, 150, 150));
    expect(terrainGround(prepared.terrain)(150, -150)).toBe(heightAt(prepared.terrain, 150, 150));
  });
});
