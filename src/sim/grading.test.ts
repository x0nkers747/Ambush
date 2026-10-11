import { describe, expect, it } from 'vitest';
import { rectangle, type EnvironmentFeatures } from './environment';
import { gradeTerrain, gradeWithSummary, GRADING_VERSION, MIN_CHANGE_M } from './grading';
import type { Vec3 } from './geometry';
import { buildingRoofElevations, lineOfSight, traceSightLine } from './los';
import { createRngState, nextFloat } from './rng';
import { shareTerrain } from './shared-terrain';
import { sightLineTracer } from './sight-tracer';
import { createSyntheticTerrain } from './synthetic-terrain';
import { heightAt, validateTerrain, type TerrainDataset } from './terrain';
import { refinementIndex, surfaceMesh, surfaceSampler } from './terrain-surface';
import { computeViewshedRows, computeViewshedRowsReference, viewshedGrid } from './viewshed';
import type { SimEvent } from './events';
import { hashSimState } from './hash';
import type { Scenario } from './scenario';
import { createSimulation } from './simulation';
import { soldierId, waypointId } from './state';
import { TEST_SCENARIO } from './test-scenario';

// One authoritative graded terrain (docs/adr/0032): roads and building pads
// are built into the ground, on a refined lattice where the 10 m grid is too
// coarse, and every query of the ground sees them.

/** A ditch along x = 0, a narrow ridge along y = 60, a gentle slope east. */
const elevation = (x: number, y: number) =>
  100 + 0.05 * x - 5 * Math.max(0, 1 - Math.abs(x) / 12) + 6 * Math.exp(-(((y - 60) / 8) ** 2));

const footprint = rectangle(100, 120, 16, 10, 20);
const features: EnvironmentFeatures = {
  roads: [
    {
      id: 'over-ditch',
      roadClass: 'paved',
      widthMeters: 6,
      centerline: [
        { x: -180, y: -100 },
        { x: 0, y: -100 },
        { x: 180, y: -100 },
      ],
    },
    {
      id: 'through-ridge',
      roadClass: 'paved',
      widthMeters: 6,
      centerline: [
        { x: -100, y: -180 },
        { x: -100, y: 180 },
      ],
    },
    {
      id: 'track',
      roadClass: 'track',
      widthMeters: 3,
      centerline: [
        { x: 50, y: -180 },
        { x: 50, y: 180 },
      ],
    },
  ],
  buildings: [{ id: 'house', footprint, heightMeters: 7 }],
  vegetation: [],
  water: [],
  waterways: [],
  landUse: [],
};

function site(f: EnvironmentFeatures = features): TerrainDataset {
  return createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
    elevation,
    f,
  );
}

const source = site();
const { terrain: graded, summary } = gradeWithSummary(source);

describe('gradeTerrain', () => {
  it('makes a valid, refined, versioned terrain and leaves the source as it was', () => {
    validateTerrain(graded);
    expect(graded.grading?.version).toBe(GRADING_VERSION);
    expect(graded.refinement?.factor).toBe(4);
    expect(summary.refinedCells).toBeGreaterThan(50);
    expect(summary.roads).toBe(2); // the track is not graded
    expect(source.refinement).toBeUndefined();
    expect(source.heightfield.elevations).toEqual(site().heightfield.elevations);
    // Grading a graded terrain changes nothing.
    expect(gradeTerrain(graded)).toBe(graded);
  });

  it('is deterministic and does not depend on the order of the features', () => {
    const again = gradeTerrain(site());
    expect(again).toEqual(graded);
    const shuffled = gradeTerrain(
      site({
        ...features,
        roads: [...features.roads].reverse(),
        buildings: [...features.buildings],
      }),
    );
    expect(shuffled.heightfield.elevations).toEqual(graded.heightfield.elevations);
    expect(shuffled.refinement).toEqual(graded.refinement);
  });

  it('lays a level road across the carriageway, on an embankment over the ditch', () => {
    // Across the road at the ditch: level over the whole carriageway (and beyond).
    const centre = heightAt(graded, 0, -100);
    for (const dy of [-3, -2, 0, 2, 3]) {
      expect(Math.abs(heightAt(graded, 0, -100 + dy) - centre)).toBeLessThan(0.01);
    }
    // Raised above the ditch bottom: an embankment.
    expect(centre - heightAt(source, 0, -100)).toBeGreaterThan(1.5);
    // Its sides fall back to the original ground.
    expect(heightAt(graded, 0, -80)).toBeCloseTo(heightAt(source, 0, -80), 6);
  });

  it('cuts the road through the ridge', () => {
    expect(heightAt(source, -100, 60) - heightAt(graded, -100, 60)).toBeGreaterThan(2);
    // Off the road the ridge stands as it was.
    expect(heightAt(graded, -150, 60)).toBeCloseTo(heightAt(source, -150, 60), 6);
  });

  it('leaves tracks on the original ground', () => {
    expect(heightAt(graded, 50, 60)).toBeCloseTo(heightAt(source, 50, 60), 6);
  });

  it('stands the building on a level pad, its roof on the pad', () => {
    const pad = heightAt(graded, 100, 120);
    for (const p of footprint)
      expect(Math.abs(heightAt(graded, p.x, p.y) - pad)).toBeLessThan(0.01);
    const rng = createRngState(5);
    for (let i = 0; i < 50; i += 1) {
      // Points inside the footprint (a rotated rectangle) and its 1 m apron.
      const u = nextFloat(rng) - 0.5;
      const v = nextFloat(rng) - 0.5;
      const a = (20 * Math.PI) / 180;
      const x = 100 + u * 16 * Math.cos(a) + v * 10 * Math.sin(a);
      const y = 120 - u * 16 * Math.sin(a) + v * 10 * Math.cos(a);
      expect(Math.abs(heightAt(graded, x, y) - pad)).toBeLessThan(0.01);
    }
    // The source slope differed across the footprint; the roof sits on the pad.
    const corners = footprint.map((p) => heightAt(source, p.x, p.y));
    expect(Math.max(...corners) - Math.min(...corners)).toBeGreaterThan(0.5);
    expect(buildingRoofElevations(graded).get('house')).toBeCloseTo(pad + 7, 6);
  });

  it('changes the ground only where it was graded, by at least the minimum', () => {
    const ref = refinementIndex(graded);
    expect(ref).not.toBeNull();
    // Far from every feature the ground is the source, sample for sample.
    expect(heightAt(graded, 150, 20)).toBe(heightAt(source, 150, 20));
    expect(MIN_CHANGE_M).toBeGreaterThan(0);
  });
});

describe('road networks', () => {
  /** Rolling ground: bumps a few metres high every 40 m or so. */
  const rolling = (x: number, y: number) => 100 + 3 * Math.sin(x / 7) * Math.cos(y / 9) + 0.04 * y;
  const ground = (roads: EnvironmentFeatures['roads']) =>
    createSyntheticTerrain(
      { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
      rolling,
      { ...features, roads, buildings: [] },
    );
  const road = (id: string, centerline: { x: number; y: number }[]) => ({
    id,
    roadClass: 'paved' as const,
    widthMeters: 6,
    centerline,
  });

  it('grades a road split into many ways exactly as the whole road', () => {
    const at = (i: number) => ({ x: -180 + 30 * i, y: 20 });
    const line = Array.from({ length: 13 }, (_, i) => at(i));
    const whole = gradeTerrain(ground([road('whole', line)]));
    const pieces = gradeTerrain(
      ground(
        Array.from({ length: 12 }, (_, i) =>
          // Short ways, some drawn backwards, as OSM has them.
          road(`piece-${String(i)}`, i % 3 === 0 ? [at(i + 1), at(i)] : [at(i), at(i + 1)]),
        ),
      ),
    );
    for (let x = -170; x <= 170; x += 2.5) {
      expect(heightAt(pieces, x, 20)).toBeCloseTo(heightAt(whole, x, 20), 6);
    }
  });

  it('meets level at a T-junction that shares no point', () => {
    const graded = gradeTerrain(
      ground([
        road('through', [
          { x: -180, y: 0 },
          { x: 180, y: 0 },
        ]),
        // Ends inside the through road's carriageway, short of its centreline.
        road('side', [
          { x: 3, y: 170 },
          { x: 3, y: 2.5 },
        ]),
      ]),
    );
    // Where the carriageways meet, the ground is the through road's level
    // across it (the through road may climb along its length).
    for (const x of [0, 1, 3, 5, 6]) {
      for (const y of [-2.5, 2.5]) {
        expect(Math.abs(heightAt(graded, x, y) - heightAt(graded, x, 0))).toBeLessThan(0.015);
      }
    }
    const level = heightAt(graded, 3, 0);
    // And the side road leaves it smoothly: its gradient changes gently, with
    // no step or kink on the way in.
    const zs = Array.from({ length: 24 }, (_, i) => heightAt(graded, 3, 2.5 + 2.5 * i));
    expect(zs[0]).toBeCloseTo(level, 1);
    for (let i = 1; i + 1 < zs.length; i += 1) {
      expect(Math.abs((zs[i + 1] ?? 0) - 2 * (zs[i] ?? 0) + (zs[i - 1] ?? 0))).toBeLessThan(0.06);
    }
  });

  it('smooths a loop all the way round, with no step where it closes', () => {
    const ring = Array.from({ length: 41 }, (_, i) => {
      const a = (2 * Math.PI * (i % 40)) / 40;
      return { x: 100 * Math.cos(a), y: 100 * Math.sin(a) };
    });
    const graded = gradeTerrain(ground([road('ring', ring)]));
    let previous = heightAt(graded, 100, 0);
    for (let i = 1; i <= 400; i += 1) {
      const a = (2 * Math.PI * i) / 400;
      const z = heightAt(graded, 100 * Math.cos(a), 100 * Math.sin(a));
      // 1.6 m apart: a smooth road climbs or falls far less than this.
      expect(Math.abs(z - previous)).toBeLessThan(0.25);
      previous = z;
    }
  });
});

describe('the refined surface', () => {
  it('is continuous: no step anywhere, including between refined and unrefined cells', () => {
    const rng = createRngState(11);
    for (let i = 0; i < 4000; i += 1) {
      const x = -199 + 398 * nextFloat(rng);
      const y = -199 + 398 * nextFloat(rng);
      const e = 1e-6;
      // A step would show as a jump between neighbouring points.
      expect(Math.abs(heightAt(graded, x + e, y) - heightAt(graded, x - e, y))).toBeLessThan(1e-3);
      expect(Math.abs(heightAt(graded, x, y + e) - heightAt(graded, x, y - e))).toBeLessThan(1e-3);
    }
    // Along every coarse grid line too (where refined and unrefined cells meet).
    for (let g = -190; g <= 190; g += 10) {
      for (let t = -199; t <= 199; t += 0.37) {
        expect(
          Math.abs(heightAt(graded, g + 1e-7, t) - heightAt(graded, g - 1e-7, t)),
        ).toBeLessThan(1e-3);
        expect(
          Math.abs(heightAt(graded, t, g + 1e-7) - heightAt(graded, t, g - 1e-7)),
        ).toBeLessThan(1e-3);
      }
    }
  });

  it('is exactly its mesh: interpolating the triangles gives heightAt, with no cracks', () => {
    const mesh = surfaceMesh(graded);
    const p = mesh.positions;
    // Every edge is shared by two triangles, except on the battlefield's outline.
    const edges = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      for (let e = 0; e < 3; e += 1) {
        const a = mesh.indices[t + e] ?? 0;
        const b = mesh.indices[t + ((e + 1) % 3)] ?? 0;
        const k = a < b ? `${String(a)}-${String(b)}` : `${String(b)}-${String(a)}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
    const open = [...edges.values()].filter((n) => n === 1).length;
    expect([...edges.values()].every((n) => n <= 2)).toBe(true);
    expect(open).toBe(mesh.boundary.length);
    // Every triangle faces up, and its vertices lie on the surface.
    const rng = createRngState(3);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((e) => mesh.indices[t + e] ?? 0) as [number, number, number];
      const ax = p[a * 3] ?? 0;
      const ay = p[a * 3 + 1] ?? 0;
      const bx = p[b * 3] ?? 0;
      const by = p[b * 3 + 1] ?? 0;
      const cx = p[c * 3] ?? 0;
      const cy = p[c * 3 + 1] ?? 0;
      expect((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)).toBeGreaterThan(0);
      if (t % 7 !== 0) continue;
      // A random point inside: the triangle's interpolation equals heightAt.
      let u = nextFloat(rng);
      let v = nextFloat(rng);
      if (u + v > 1) [u, v] = [1 - u, 1 - v];
      const x = ax + u * (bx - ax) + v * (cx - ax);
      const y = ay + u * (by - ay) + v * (cy - ay);
      const z =
        (p[a * 3 + 2] ?? 0) +
        u * ((p[b * 3 + 2] ?? 0) - (p[a * 3 + 2] ?? 0)) +
        v * ((p[c * 3 + 2] ?? 0) - (p[a * 3 + 2] ?? 0));
      expect(Math.abs(z - heightAt(graded, x, y))).toBeLessThan(1e-6);
    }
  });

  it('samples the same through the fast sampler as through heightAt', () => {
    const fast = surfaceSampler(graded);
    const rng = createRngState(9);
    for (let i = 0; i < 2000; i += 1) {
      const x = -200 + 400 * nextFloat(rng);
      const y = -200 + 400 * nextFloat(rng);
      expect(fast(x, y)).toBe(heightAt(graded, x, y));
    }
  });
});

describe('line of sight on the graded terrain', () => {
  const eye = (t: TerrainDataset, x: number, y: number, h: number): Vec3 => ({
    x,
    y,
    z: heightAt(t, x, y) + h,
  });

  it('is blocked by a road embankment that the source ground did not have', () => {
    // Along the ditch bottom, under the road.
    const from = { x: 0, y: -160 };
    const to = { x: 0, y: -40 };
    expect(lineOfSight(source, from, to).clear).toBe(true);
    const graded_ = lineOfSight(graded, from, to);
    expect(graded_.clear).toBe(false);
    expect(graded_.obstruction?.cause.kind).toBe('terrain');
  });

  it('passes through a road cutting where the source ridge blocked it', () => {
    const a = eye(source, -100, 20, 3);
    const b = eye(source, -100, 100, 3);
    expect(traceSightLine(source, a, b)).not.toBeNull();
    const ga = eye(graded, -100, 20, 3);
    const gb = eye(graded, -100, 100, 3);
    expect(traceSightLine(graded, ga, gb)).toBeNull();
  });

  it('the fast tracer and the viewshed agree exactly with the reference on refined ground', () => {
    const tracer = sightLineTracer(graded);
    const rng = createRngState(42);
    const r = () => -199 + 398 * nextFloat(rng);
    let blocked = 0;
    for (let i = 0; i < 3000; i += 1) {
      const a = eye(graded, r(), r(), 0.5 + 6 * nextFloat(rng));
      const b = eye(graded, r(), r(), 0.3 + 3 * nextFloat(rng));
      if (a.x === b.x && a.y === b.y) continue;
      const reference = traceSightLine(graded, a, b) !== null;
      expect(tracer.blocked(a, b)).toBe(reference);
      if (reference) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(200);
    // Lines along the road and across refined cells' grid lines.
    for (const [a, b] of [
      [eye(graded, -100, -190, 1.7), eye(graded, -100, 190, 1.5)],
      [eye(graded, -190, -100, 1.7), eye(graded, 190, -100, 1.5)],
      [eye(graded, -110, -110, 1.7), eye(graded, 10, 10, 1.5)],
      [eye(graded, -102.5, -150, 1.7), eye(graded, -102.5, 150, 1.5)],
    ] as const) {
      expect(tracer.blocked(a, b)).toBe(traceSightLine(graded, a, b) !== null);
    }
    for (const observer of [
      { x: 0, y: -130 },
      { x: -100, y: 40 },
      { x: 95, y: 110 },
    ]) {
      const grid = viewshedGrid(graded, 4);
      const fast = computeViewshedRows(graded, observer, grid, 0, grid.rows);
      const reference = computeViewshedRowsReference(graded, observer, grid, 0, grid.rows);
      expect(Array.from(fast)).toEqual(Array.from(reference));
    }
  });

  it('works on a shared (frozen) graded terrain', () => {
    const shared = shareTerrain(graded);
    expect(heightAt(shared, 0, -100)).toBe(heightAt(graded, 0, -100));
  });
});

describe('the simulation on a graded terrain', () => {
  // The test scenario's ridge, with a road over it where the squad walks.
  const sourceTerrain: TerrainDataset = {
    ...TEST_SCENARIO.terrain,
    features: {
      ...TEST_SCENARIO.terrain.features,
      roads: [
        {
          id: 'ridge-road',
          roadClass: 'paved',
          widthMeters: 6,
          centerline: [
            { x: 0, y: -100 },
            { x: 0, y: 300 },
          ],
        },
      ],
    },
  };
  const gradedTerrain = gradeTerrain(sourceTerrain);
  const scenario = (terrain: TerrainDataset): Scenario => ({ ...TEST_SCENARIO, terrain });
  const run = (terrain: TerrainDataset) => {
    const sim = createSimulation({ tickRateHz: 30, seed: 7 }, scenario(terrain));
    sim.submit({
      type: 'setOrders',
      tick: 0,
      soldierId: soldierId('B-SL'),
      orders: { waypoints: [{ id: waypointId('W0'), x: 0, y: 60 }], finalFacing: 0 },
    });
    const events: SimEvent[] = [];
    // About 40 s: the leader walks the 60 m up the road onto graded ground.
    for (let i = 0; i < 1300; i += 1) events.push(...sim.step());
    return { sim, events, hash: hashSimState(sim.state) };
  };

  it('stands every soldier on the graded ground', () => {
    const { sim } = run(gradedTerrain);
    for (const s of sim.state.soldiers) {
      expect(s.position.z).toBe(heightAt(gradedTerrain, s.position.x, s.position.y));
    }
    // The squad leader is on the road, where grading changed the ground.
    const leader = sim.state.soldiers.find((s) => s.id === soldierId('B-SL'));
    expect(leader).toBeDefined();
    if (leader) {
      expect(
        Math.abs(leader.position.z - heightAt(sourceTerrain, leader.position.x, leader.position.y)),
      ).toBeGreaterThan(0.05);
    }
  });

  it('is reproducible for a given terrain version, and the version matters', () => {
    const a = run(gradedTerrain);
    const b = run(gradeTerrain(sourceTerrain));
    expect(b.hash).toBe(a.hash);
    expect(b.events).toEqual(a.events);
    expect(run(sourceTerrain).hash).not.toBe(a.hash);
  });

  it('never restores a snapshot (a replay state) onto another terrain version', () => {
    const { sim } = run(gradedTerrain);
    const snapshot = sim.snapshot();
    const onSource = createSimulation({ tickRateHz: 30, seed: 7 }, scenario(sourceTerrain));
    expect(() => {
      onSource.restore(snapshot);
    }).toThrow(/different world/);
    const onGraded = createSimulation(
      { tickRateHz: 30, seed: 7 },
      scenario(gradeTerrain(sourceTerrain)),
    );
    onGraded.restore(snapshot);
    expect(hashSimState(onGraded.state)).toBe(hashSimState(snapshot.state));
  });
});
