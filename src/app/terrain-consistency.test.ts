import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIO } from '#exercise';
import { createSyntheticTerrain, gradeTerrain, heightAt, rectangle, refinementIndex } from '#sim';
import { elevationAt } from '#view2d';
import { terrainGround } from '#view3d';

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
    ['the demo', DEMO_SCENARIO.terrain],
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
