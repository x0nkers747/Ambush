import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO } from '#exercise';
import { createSession } from '#session';
import {
  buildingRoofElevations,
  createSyntheticTerrain,
  DEFAULT_TICK_RATE_HZ,
  gradeTerrain,
  heightAt,
  rectangle,
  type TerrainDataset,
} from '#sim';
import { buildingGeometry } from './building-geometry';
import { MIN_WALL_M } from './roof-geometry';
import { terrainGround } from './camera-math';
import { createDraper } from './drape';
import { roadGeometry, ROAD_STYLE } from './road-geometry';
import { terrainMesh, type TerrainMeshData } from './terrain-mesh';
import { random, triangles } from './test-helpers';
import { unitMarkers } from './unit-markers';

// The 3D view on the one authoritative, graded terrain (docs/adr/0032): the
// mesh, the roads on it, the buildings on their pads and the soldiers all on
// exactly the ground the simulation uses.

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

/** The mesh's height at (x, y), from its float32 triangles as the GPU interpolates them. */
function meshHeightAt(mesh: TerrainMeshData) {
  const buckets = new Map<string, number[]>();
  const p = mesh.positions;
  const vx = (i: number) => p[i * 3] ?? 0;
  const vy = (i: number) => -(p[i * 3 + 2] ?? 0);
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const v = [0, 1, 2].map((k) => mesh.indices[t * 3 + k] ?? 0);
    const xs = v.map(vx);
    const ys = v.map(vy);
    for (let bx = Math.floor(Math.min(...xs) / 5); bx <= Math.floor(Math.max(...xs) / 5); bx += 1) {
      for (
        let by = Math.floor(Math.min(...ys) / 5);
        by <= Math.floor(Math.max(...ys) / 5);
        by += 1
      ) {
        const key = `${String(bx)},${String(by)}`;
        buckets.set(key, [...(buckets.get(key) ?? []), t]);
      }
    }
  }
  return (x: number, y: number) => {
    let best = { h: NaN, inside: -Infinity };
    for (const t of buckets.get(`${String(Math.floor(x / 5))},${String(Math.floor(y / 5))}`) ??
      []) {
      const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t * 3 + k] ?? 0) as [
        number,
        number,
        number,
      ];
      const det = (vy(b) - vy(c)) * (vx(a) - vx(c)) + (vx(c) - vx(b)) * (vy(a) - vy(c));
      const l1 = ((vy(b) - vy(c)) * (x - vx(c)) + (vx(c) - vx(b)) * (y - vy(c))) / det;
      const l2 = ((vy(c) - vy(a)) * (x - vx(c)) + (vx(a) - vx(c)) * (y - vy(c))) / det;
      const l3 = 1 - l1 - l2;
      const inside = Math.min(l1, l2, l3);
      if (inside > best.inside) {
        best = {
          h: l1 * (p[a * 3 + 1] ?? 0) + l2 * (p[b * 3 + 1] ?? 0) + l3 * (p[c * 3 + 1] ?? 0),
          inside,
        };
      }
    }
    if (best.inside < -1e-6) throw new Error(`no triangle at ${String(x)}, ${String(y)}`);
    return best.h;
  };
}

function expectMeshIsGround(terrain: TerrainDataset, count = 6000) {
  const mesh = terrainMesh(terrain);
  const at = meshHeightAt(mesh);
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const next = random(17);
  let worst = 0;
  for (let i = 0; i < count; i += 1) {
    const x = originX + next() * (columns - 1) * cellSize;
    const y = originY + next() * (rows - 1) * cellSize;
    worst = Math.max(worst, Math.abs(at(x, y) - heightAt(terrain, x, y)));
  }
  expect(worst).toBeLessThan(TOLERANCE_M);
  return { mesh, at };
}

describe('the 3D view on graded terrain', () => {
  it('draws exactly the graded ground, refined cells included', () => {
    const { mesh, at } = expectMeshIsGround(graded);
    expect(mesh.vertexCount).toBeGreaterThan(41 * 41);
    // In the cutting and on the embankment, where grading changed the ground.
    for (const [x, y] of [
      [-100, 60],
      [0, -100],
      [107, 120], // inside the building, near its uphill side
    ] as const) {
      expect(Math.abs(at(x, y) - heightAt(graded, x, y))).toBeLessThan(TOLERANCE_M);
      expect(Math.abs(at(x, y) - heightAt(source, x, y))).toBeGreaterThan(0.3);
    }
    // And the demo battlefield, graded.
    expectMeshIsGround(DEMO_SCENARIO.terrain, 3000);
  });

  it('asks the same ground as the simulation for the camera', () => {
    const ground = terrainGround(graded);
    const next = random(5);
    for (let i = 0; i < 1000; i += 1) {
      const x = -200 + 400 * next();
      const y = -200 + 400 * next();
      expect(ground(x, -y)).toBe(heightAt(graded, x, y));
    }
  });

  it('lays the roads on the graded surface, across refined cells', () => {
    const layers = roadGeometry(graded.features.roads, createDraper(graded));
    for (const [layer, mesh] of layers) {
      const offset = ROAD_STYLE[layer].offset;
      for (const t of triangles(mesh)) {
        for (const v of [t.a, t.b, t.c]) {
          expect(Math.abs(v.z - offset - heightAt(graded, v.x, v.y))).toBeLessThan(TOLERANCE_M);
        }
        // Inside each triangle too: every piece lies in one fine triangle.
        const x = (t.a.x + t.b.x + t.c.x) / 3;
        const y = (t.a.y + t.b.y + t.c.y) / 3;
        const z = (t.a.z + t.b.z + t.c.z) / 3;
        expect(Math.abs(z - offset - heightAt(graded, x, y))).toBeLessThan(TOLERANCE_M);
      }
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

  it('places every soldier on the 3D surface', () => {
    const exercise = createExercise({
      config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
      scenario: DEMO_SCENARIO,
    });
    const at = meshHeightAt(terrainMesh(exercise.simulation.world.terrain));
    const markers = unitMarkers(exercise, createSession(), false);
    expect(markers.length).toBeGreaterThan(10);
    for (const m of markers) {
      expect(Math.abs(m.position.z - at(m.position.x, m.position.y))).toBeLessThan(TOLERANCE_M);
    }
  });
});
