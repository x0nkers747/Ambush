import { describe, expect, it } from 'vitest';
import {
  impassableWater,
  NO_FEATURES,
  rectangle,
  type Building,
  type EnvironmentFeatures,
  type WaterArea,
} from './environment';
import type { Vec2 } from './geometry';
import { fingerprintWorld } from './hash';
import {
  NAV_CELL_M,
  navGrid,
  OBSTACLE_CLEARANCE_M,
  PATH_CACHE_SIZE,
  planPath,
  pointProblem,
} from './navigation';
import { clonePlainData } from './plain-data';
import { pointInPolygon } from './polygon';
import type { Scenario } from './scenario';
import { isSharedTerrain, shareTerrain } from './shared-terrain';
import { createSimulation } from './simulation';
import { createSyntheticTerrain, flatElevation } from './synthetic-terrain';
import type { TerrainDataset } from './terrain';

// The navigation grid is rasterized row by row instead of testing every cell
// against every polygon edge (5 km performance, phase 1). These tests compare
// it with that original cell-by-cell definition on awkward geometry, and check
// that per-terrain navigation data is reused but never shared across terrains.

/** A flat square terrain of `size` metres centred on the origin. */
function terrainWith(size: number, features: Partial<EnvironmentFeatures>): TerrainDataset {
  return createSyntheticTerrain(
    {
      originX: -size / 2,
      originY: -size / 2,
      cellSize: 10,
      columns: size / 10 + 1,
      rows: size / 10 + 1,
    },
    flatElevation(0),
    { ...NO_FEATURES, water: [], ...features },
  );
}

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A star-shaped (so simple) polygon round `centre`: `n` vertices at radius `r` ± `jitter`. */
function blob(centre: Vec2, r: number, jitter: number, n: number, seed: number): Vec2[] {
  const next = random(seed);
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const radius = r + (next() - 0.5) * 2 * jitter;
    return { x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) };
  });
}

const water = (id: string, boundary: Vec2[], holes?: Vec2[][]): WaterArea => ({
  id,
  kind: 'water',
  boundary,
  ...(holes ? { holes } : {}),
});
const building = (id: string, footprint: Vec2[]): Building => ({ id, footprint, heightMeters: 6 });

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0), 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceToPolygon(p: Vec2, polygon: readonly Vec2[]): number {
  let best = Number.POSITIVE_INFINITY;
  polygon.forEach((a, i) => {
    best = Math.min(best, distanceToSegment(p, a, polygon[(i + 1) % polygon.length] ?? a));
  });
  return best;
}

/**
 * The navigation grid as originally defined: every cell centre in the bounds
 * of an obstacle (grown by its margin) tested against the whole polygon.
 */
function referenceGrid(terrain: TerrainDataset): Uint8Array {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const cols = Math.floor(((columns - 1) * cellSize) / NAV_CELL_M);
  const rowCount = Math.floor(((rows - 1) * cellSize) / NAV_CELL_M);
  const blocked = new Uint8Array(cols * rowCount);
  const block = (polygon: readonly Vec2[], margin: number) => {
    const xs = polygon.map((p) => p.x);
    const ys = polygon.map((p) => p.y);
    const c0 = Math.max(0, Math.floor((Math.min(...xs) - margin - originX) / NAV_CELL_M));
    const c1 = Math.min(cols - 1, Math.ceil((Math.max(...xs) + margin - originX) / NAV_CELL_M));
    const r0 = Math.max(0, Math.floor((Math.min(...ys) - margin - originY) / NAV_CELL_M));
    const r1 = Math.min(rowCount - 1, Math.ceil((Math.max(...ys) + margin - originY) / NAV_CELL_M));
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const p = { x: originX + (c + 0.5) * NAV_CELL_M, y: originY + (r + 0.5) * NAV_CELL_M };
        if (pointInPolygon(p, polygon) || distanceToPolygon(p, polygon) < margin) {
          blocked[r * cols + c] = 1;
        }
      }
    }
  };
  for (const b of terrain.features.buildings) {
    block(b.footprint, OBSTACLE_CLEARANCE_M + (NAV_CELL_M * Math.SQRT2) / 2);
  }
  for (const w of impassableWater(terrain.features))
    block(w.boundary, (NAV_CELL_M * Math.SQRT2) / 2);
  return blocked;
}

function expectSameGrid(terrain: TerrainDataset): void {
  const grid = navGrid(terrain);
  const reference = referenceGrid(terrain);
  expect(grid.blocked.length).toBe(reference.length);
  const differences: number[] = [];
  reference.forEach((v, i) => {
    if (grid.blocked[i] !== v) differences.push(i);
  });
  expect(differences).toEqual([]);
  // The geometry must actually block something, or the comparison proves little.
  expect(reference.some((v) => v === 1)).toBe(true);
}

describe('navigation grid rasterization', () => {
  it('matches the cell-by-cell definition for a large irregular lake with an island', () => {
    const lake = blob({ x: 13.3, y: -7.1 }, 200, 50, 120, 1);
    const island = blob({ x: 20, y: 0 }, 40, 10, 24, 2);
    expectSameGrid(terrainWith(500, { water: [water('W-lake', lake, [island])] }));
  });

  it('matches it for water reaching the edges of the map', () => {
    // A river from the west edge to the east edge, and a bay in the north-east corner.
    const river: Vec2[] = [
      { x: -400, y: -60 },
      { x: 0, y: -20.5 },
      { x: 400, y: 10 },
      { x: 400, y: 45 },
      { x: 0, y: 12.25 },
      { x: -400, y: -20 },
    ];
    const bay: Vec2[] = [
      { x: 250, y: 400 },
      { x: 400, y: 250 },
      { x: 400, y: 400 },
    ];
    expectSameGrid(terrainWith(800, { water: [water('W-river', river), water('W-bay', bay)] }));
  });

  it('matches it for narrow obstacles', () => {
    expectSameGrid(
      terrainWith(400, {
        buildings: [
          building('B-thin', rectangle(-50, 30, 0.4, 60, 30)),
          building('B-sliver', rectangle(60, -40, 80, 0.3, 7)),
        ],
        water: [water('W-ditch', rectangle(0, -120, 1, 150, 75))],
      }),
    );
  });

  it('matches it where edges and vertices fall exactly on cell centres', () => {
    // Cell centres lie on odd metres here: these edges run through rows and columns of them.
    const square: Vec2[] = [
      { x: -41, y: -41 },
      { x: 41, y: -41 },
      { x: 41, y: 41 },
      { x: -41, y: 41 },
    ];
    const diamond: Vec2[] = [
      { x: 101, y: 51 },
      { x: 151, y: 101 },
      { x: 101, y: 151 },
      { x: 51, y: 101 },
    ];
    expectSameGrid(
      terrainWith(400, {
        buildings: [building('B-square', square)],
        water: [water('W-diamond', diamond)],
      }),
    );
  });

  it('matches it for a complex concave outline and many small buildings', () => {
    // A comb: teeth 3 m apart, narrower than the margins round them.
    const comb: Vec2[] = [{ x: -150, y: -150 }];
    for (let i = 0; i < 20; i += 1) {
      const x = -150 + i * 6;
      comb.push(
        { x: x + 3, y: -150 },
        { x: x + 3, y: -60 },
        { x: x + 6, y: -60 },
        { x: x + 6, y: -150 },
      );
    }
    comb.push({ x: -30, y: -170 }, { x: -150, y: -170 });
    const next = random(7);
    const houses = Array.from({ length: 150 }, (_, i) =>
      building(
        `B-${String(i)}`,
        rectangle(
          -180 + next() * 360,
          0 + next() * 180,
          4 + next() * 12,
          4 + next() * 12,
          next() * 360,
        ),
      ),
    ).filter(
      // Keep them apart so the features stay valid (and the comb clear).
      (b, i, all) =>
        all
          .slice(0, i)
          .every(
            (o) =>
              Math.hypot(
                (o.footprint[0]?.x ?? 0) - (b.footprint[0]?.x ?? 0),
                (o.footprint[0]?.y ?? 0) - (b.footprint[0]?.y ?? 0),
              ) > 25,
          ),
    );
    expectSameGrid(terrainWith(400, { water: [water('W-comb', comb)], buildings: houses }));
  });
});

describe('path planning on large water', () => {
  // A river across the whole map: its banks are not connected.
  const river: Vec2[] = [
    { x: -400, y: -30 },
    { x: 400, y: -10 },
    { x: 400, y: 30 },
    { x: -400, y: 10 },
  ];
  // A lake that the path must go round.
  const lake = blob({ x: 0, y: 200 }, 120, 30, 90, 3);
  const terrain = terrainWith(800, { water: [water('W-river', river), water('W-lake', lake)] });

  it('goes round a large lake, along the shore, never into the water', () => {
    const from = { x: 0, y: 60 };
    const to = { x: 0, y: 350 };
    const path = planPath(terrain, from, to);
    if (!path.ok) throw new Error(`no path: ${path.problem.kind}`);
    expect(path.turns.length).toBeGreaterThan(0);
    // Shoreline: the path may run close to the water, but every point is on land.
    for (const p of [from, ...path.turns, to]) expect(pointProblem(terrain, p)).toBeNull();
    expect(path.turns.some((p) => Math.abs(p.x) > 80)).toBe(true);
  });

  it('reports a destination across the river as unreachable', () => {
    expect(planPath(terrain, { x: -200, y: -200 }, { x: 200, y: 300 })).toEqual({
      ok: false,
      problem: { kind: 'unreachable' },
    });
    // And one in the water as in the water, before any search.
    expect(planPath(terrain, { x: -200, y: -200 }, { x: 0, y: 0 })).toEqual({
      ok: false,
      problem: { kind: 'inWater', waterId: 'W-river' },
    });
  });

  it('plans the same paths on an identical copy of the terrain (deterministic)', () => {
    const copy = clonePlainData(terrain);
    const legs: [Vec2, Vec2][] = [
      [
        { x: 0, y: 60 },
        { x: 0, y: 350 },
      ],
      [
        { x: -350, y: 300 },
        { x: 350, y: 120 },
      ],
      [
        { x: -200, y: -200 },
        { x: 200, y: 300 },
      ],
      [
        { x: -390, y: -390 },
        { x: 390, y: -100 },
      ],
    ];
    for (const [a, b] of legs) expect(planPath(copy, a, b)).toEqual(planPath(terrain, a, b));
  });
});

describe('navigation data reuse', () => {
  const lake = blob({ x: 0, y: 0 }, 80, 20, 60, 4);
  const make = () => terrainWith(400, { water: [water('W-lake', lake)] });
  const around: [Vec2, Vec2] = [
    { x: -150, y: 0 },
    { x: 150, y: 10 },
  ];

  it('builds the grid once per terrain, and never shares it between terrains', () => {
    const a = make();
    const b = make();
    expect(navGrid(a)).toBe(navGrid(a));
    expect(navGrid(b)).not.toBe(navGrid(a));
    // A different battlefield has its own grid, with its own obstacles.
    const open = terrainWith(400, {});
    expect(navGrid(open).blocked.some((v) => v === 1)).toBe(false);
    expect(planPath(open, ...around)).toEqual({ ok: true, turns: [] });
  });

  it('remembers grid paths per terrain, frozen, as computed', () => {
    const t = make();
    const first = planPath(t, ...around);
    expect(first.ok).toBe(true);
    expect(planPath(t, ...around)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.ok) expect(Object.isFrozen(first.turns[0])).toBe(true);
    // The same as on a terrain that has never planned anything.
    expect(planPath(make(), ...around)).toEqual(first);
  });

  it('keeps a bounded number of paths', () => {
    // Short detours round one small building, so each path is quick to plan.
    const t = terrainWith(100, { buildings: [building('B-1', rectangle(0, 0, 10, 10))] });
    const leg = (i: number): [Vec2, Vec2] => [
      { x: -12, y: (i % 16) * 0.25 - 2 },
      { x: 12, y: Math.floor(i / 16) * 0.25 - 2 },
    ];
    const first = planPath(t, ...leg(0));
    expect(first.ok && first.turns.length > 0).toBe(true);
    for (let i = 1; i <= PATH_CACHE_SIZE; i += 1) planPath(t, ...leg(i));
    // The first path was evicted: computed again, equal but a new object.
    const again = planPath(t, ...leg(0));
    expect(again).toEqual(first);
    expect(again).not.toBe(first);
  });

  it('shares one frozen terrain between simulations, so they share its navigation data', () => {
    const source = make();
    const scenario: Scenario = {
      id: 'shared',
      terrain: source,
      movement: { speed: 1.5, maxTurnRate: Math.PI },
      units: [{ id: 'U', echelon: 'team', parentId: null, leaderId: 'S-1' }],
      soldiers: [
        {
          id: 'S-1',
          side: 'BLUEFOR',
          unitId: 'U',
          position: { x: -150, y: 0 },
          azimuthDeg: 0,
          posture: 'standing',
        },
      ],
    };
    const first = createSimulation({ tickRateHz: 10, seed: 1 }, scenario);
    // A terrain that is not shared yet is copied and frozen, so the caller's object cannot reach the simulation.
    expect(first.world.terrain).not.toBe(source);
    expect(isSharedTerrain(first.world.terrain)).toBe(true);
    expect(Object.isFrozen(first.world.terrain.features.water?.[0]?.boundary[0])).toBe(true);
    // A shared terrain is used as it is.
    const shared = shareTerrain(source);
    expect(shareTerrain(shared)).toBe(shared);
    const second = createSimulation({ tickRateHz: 10, seed: 1 }, { ...scenario, terrain: shared });
    const third = createSimulation({ tickRateHz: 30, seed: 2 }, { ...scenario, terrain: shared });
    expect(second.world.terrain).toBe(shared);
    expect(third.world.terrain).toBe(shared);
    expect(navGrid(second.world.terrain)).toBe(navGrid(shared));
    // Sharing changes no fingerprint.
    expect(second.worldFingerprint).toBe(first.worldFingerprint);
    expect(fingerprintWorld({ terrain: clonePlainData(source), movement: scenario.movement })).toBe(
      second.worldFingerprint,
    );
    // Other movement parameters: another fingerprint, even on the same shared terrain.
    const faster = createSimulation(
      { tickRateHz: 10, seed: 1 },
      { ...scenario, terrain: shared, movement: { speed: 2, maxTurnRate: Math.PI } },
    );
    expect(faster.worldFingerprint).not.toBe(second.worldFingerprint);
  });
});
