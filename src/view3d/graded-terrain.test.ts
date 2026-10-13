import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO } from '#exercise';
import { createSession } from '#session';
import {
  buildingRoofElevations,
  createSyntheticTerrain,
  DEFAULT_TICK_RATE_HZ,
  gradeTerrain,
  groundFieldInput,
  heightAt,
  rectangle,
  REFINE_TOLERANCE_M,
  type TerrainDataset,
} from '#sim';
import { compileField, createSurface } from '#sim/terrain-field';
import { buildingGeometry } from './building-geometry';
import { MIN_WALL_M } from './roof-geometry';
import { terrainGround } from './camera-math';
import { random, triangles } from './test-helpers';
import { unitMarkers } from './unit-markers';

// The 3D view on the one authoritative terrain (docs/adr/0049): the ground
// drawn from the field the simulation's ground is sampled from, the roads, the
// buildings on their pads and the soldiers on the ground the simulation uses.

const TOLERANCE_M = 0.01;

/** A road cut through a ridge, another on an embankment over a ditch, a building pad on a slope. */
const source = createSyntheticTerrain(
  { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
  (x, y) =>
    100 + 0.05 * x - 5 * Math.max(0, 1 - Math.abs(x) / 12) + 6 * Math.exp(-(((y - 60) / 8) ** 2)),
  {
    roads: [
      {
        id: 'ridge',
        roadClass: 'paved',
        widthMeters: 6,
        centerline: [
          { x: -100, y: -180 },
          { x: -100, y: 180 },
        ],
      },
      {
        id: 'ditch',
        roadClass: 'major',
        widthMeters: 8,
        centerline: [
          { x: -180, y: -100 },
          { x: 180, y: -100 },
        ],
      },
    ],
    buildings: [{ id: 'house', footprint: rectangle(100, 120, 16, 10, 20), heightMeters: 7 }],
    vegetation: [],
  },
);
const graded = gradeTerrain(source);

/** The drawn ground's height at random points against the simulation's; the worst difference. */
function worstDifference(terrain: TerrainDataset, count = 4000): number {
  const surface = createSurface(compileField(groundFieldInput(terrain)), { spacing: 0.5 });
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const next = random(17);
  let worst = 0;
  for (let i = 0; i < count; i += 1) {
    const x = originX + next() * (columns - 1) * cellSize;
    const y = originY + next() * (rows - 1) * cellSize;
    worst = Math.max(worst, Math.abs(surface.heightAt(x, y) - heightAt(terrain, x, y)));
  }
  return worst;
}

describe('the 3D view on graded terrain', () => {
  it(
    'draws the simulated ground: the same field, to within its sampling',
    { timeout: 30_000 },
    () => {
      // The simulation samples the field every metre where it has detail; the
      // view every half metre: between samples they differ by a few centimetres.
      expect(worstDifference(graded)).toBeLessThan(REFINE_TOLERANCE_M * 2);
      for (const [x, y] of [
        [-100, 60],
        [0, -100],
      ] as const) {
        expect(Math.abs(heightAt(graded, x, y) - heightAt(source, x, y))).toBeGreaterThan(0.3);
      }
      expect(worstDifference(DEMO_SCENARIO.terrain, 2000)).toBeLessThan(REFINE_TOLERANCE_M * 2);
    },
  );

  it('asks the same ground as the simulation for the camera', () => {
    const ground = terrainGround(graded);
    const next = random(5);
    for (let i = 0; i < 1000; i += 1) {
      const x = -200 + 400 * next();
      const y = -200 + 400 * next();
      expect(ground(x, -y)).toBe(heightAt(graded, x, y));
    }
  });

  it('stands buildings on their pads, roofs where line of sight finds them', () => {
    const built = buildingGeometry(graded);
    const pad = heightAt(graded, 100, 120);
    const roof = buildingRoofElevations(graded).get('house') ?? NaN;
    expect(roof).toBeCloseTo(pad + 7, 6);
    const zs = triangles(built.surfaces).flatMap((t) => [t.a.z, t.b.z, t.c.z]);
    // A pitched roof's ridge stands as far above line of sight's roof as its
    // eaves stand below; a flat one lies at it (docs/adr/0035).
    const top = Math.max(...zs);
    expect(top).toBeGreaterThanOrEqual(roof - 1e-3);
    expect(top - roof).toBeLessThan(roof - pad - MIN_WALL_M + 1e-3);
    // The walls stop just under the level pad: no visible foundation step.
    expect(Math.min(...zs)).toBeGreaterThan(pad - 0.6);
    expect(Math.min(...zs)).toBeLessThan(pad);
    expect(built.buried).toBe(0);
  });

  it('places every soldier on the ground', () => {
    const exercise = createExercise({
      config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
      scenario: DEMO_SCENARIO,
    });
    const ground = terrainGround(exercise.simulation.world.terrain);
    const markers = unitMarkers(exercise, createSession(), false);
    expect(markers.length).toBeGreaterThan(10);
    for (const m of markers) {
      expect(Math.abs(m.position.z - (ground(m.position.x, -m.position.y) ?? NaN))).toBeLessThan(
        TOLERANCE_M,
      );
    }
  });
});
