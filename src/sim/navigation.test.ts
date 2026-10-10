import { describe, expect, it } from 'vitest';
import { NO_FEATURES, rectangle, validateFeatures, type EnvironmentFeatures } from './environment';
import type { Vec2 } from './geometry';
import {
  isSegmentWalkable,
  nearestPointClearOfBuildings,
  OBSTACLE_CLEARANCE_M,
  planPath,
  pointProblem,
  stringPull,
} from './navigation';
import { pointInPolygon } from './polygon';
import type { Scenario } from './scenario';
import { createSimulation } from './simulation';
import { soldierId, waypointId } from './state';
import { createSyntheticTerrain, flatElevation } from './synthetic-terrain';
import { isOnTerrain, validateTerrain, type TerrainDataset } from './terrain';

/** A 40 m × 20 m wall-like building across the middle of a flat 200 m square. */
const WALL = { id: 'B-1', footprint: rectangle(0, 0, 40, 20), heightMeters: 6 };

function terrainWith(features: Partial<EnvironmentFeatures> = {}): TerrainDataset {
  return createSyntheticTerrain(
    { originX: -100, originY: -100, cellSize: 10, columns: 21, rows: 21 },
    flatElevation(0),
    { ...NO_FEATURES, ...features },
  );
}

const length = (points: readonly Vec2[]) =>
  points
    .slice(1)
    .reduce(
      (sum, p, i) => sum + Math.hypot(p.x - (points[i]?.x ?? 0), p.y - (points[i]?.y ?? 0)),
      0,
    );

/** Every straight piece of the full path keeps clear of the buildings. */
function expectWalkable(terrain: TerrainDataset, from: Vec2, turns: readonly Vec2[], to: Vec2) {
  const points = [from, ...turns, to];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) throw new Error('missing point');
    expect(isSegmentWalkable(terrain, a, b)).toBe(true);
  }
  for (const p of points) expect(isOnTerrain(terrain, p.x, p.y)).toBe(true);
}

describe('environment features', () => {
  const onMap = (p: Vec2) => Math.abs(p.x) <= 100 && Math.abs(p.y) <= 100;
  const road = {
    id: 'R-1',
    roadClass: 'unpaved' as const,
    centerline: [
      { x: -90, y: 0 },
      { x: 90, y: 5 },
    ],
    widthMeters: 4,
  };
  const wood = {
    id: 'V-1',
    kind: 'woodland' as const,
    boundary: rectangle(50, 50, 30, 30),
    canopyHeightMeters: 12,
    seeThroughMeters: 20,
  };

  it('accepts valid roads, buildings and vegetation', () => {
    expect(() => {
      validateFeatures({ roads: [road], buildings: [WALL], vegetation: [wood] }, onMap);
    }).not.toThrow();
    expect(() => {
      validateTerrain(terrainWith({ roads: [road], buildings: [WALL], vegetation: [wood] }));
    }).not.toThrow();
  });

  it.each<[string, Partial<EnvironmentFeatures>, RegExp]>([
    ['duplicate ids', { buildings: [WALL, { ...WALL }] }, /duplicate feature id "B-1"/],
    [
      'an id shared across kinds',
      { buildings: [WALL], vegetation: [{ ...wood, id: 'B-1' }] },
      /duplicate/,
    ],
    ['a one-point road', { roads: [{ ...road, centerline: [{ x: 0, y: 0 }] }] }, /two points/],
    ['a zero-width road', { roads: [{ ...road, widthMeters: 0 }] }, /width/],
    [
      'a road off the map',
      {
        roads: [
          {
            ...road,
            centerline: [
              { x: 0, y: 0 },
              { x: 150, y: 0 },
            ],
          },
        ],
      },
      /off the terrain/,
    ],
    [
      'a self-crossing footprint',
      {
        buildings: [
          {
            ...WALL,
            footprint: [
              { x: 0, y: 0 },
              { x: 10, y: 10 },
              { x: 10, y: 0 },
              { x: 0, y: 10 },
            ],
          },
        ],
      },
      /simple polygon/,
    ],
    ['a building without height', { buildings: [{ ...WALL, heightMeters: 0 }] }, /height/],
    ['vegetation without canopy', { vegetation: [{ ...wood, canopyHeightMeters: -1 }] }, /canopy/],
    [
      'vegetation with no see-through depth',
      { vegetation: [{ ...wood, seeThroughMeters: 0 }] },
      /see-through/,
    ],
  ])('rejects %s', (_label, features, message) => {
    expect(() => {
      validateFeatures({ ...NO_FEATURES, ...features }, onMap);
    }).toThrow(message);
  });

  it('builds rotated rectangular footprints', () => {
    const square = rectangle(10, 20, 4, 2);
    expect(square).toEqual([
      { x: 8, y: 19 },
      { x: 12, y: 19 },
      { x: 12, y: 21 },
      { x: 8, y: 21 },
    ]);
    const turned = rectangle(0, 0, 4, 2, 90); // width now runs north–south
    expect(turned[1]?.x).toBeCloseTo(-1, 12);
    expect(turned[1]?.y).toBeCloseTo(-2, 12);
  });
});

describe('pointProblem', () => {
  const terrain = terrainWith({ buildings: [WALL] });

  it('allows open ground and the area just outside the clearance', () => {
    expect(pointProblem(terrain, { x: 50, y: 50 })).toBeNull();
    expect(pointProblem(terrain, { x: 0, y: 10 + OBSTACLE_CLEARANCE_M })).toBeNull();
  });

  it('rejects points inside a building, too close to one, or off the map', () => {
    expect(pointProblem(terrain, { x: 0, y: 0 })).toEqual({
      kind: 'insideBuilding',
      buildingId: 'B-1',
    });
    expect(pointProblem(terrain, { x: 20, y: 10 })).toEqual({
      kind: 'insideBuilding',
      buildingId: 'B-1',
    }); // a corner
    expect(pointProblem(terrain, { x: 0, y: 10.5 })).toEqual({
      kind: 'tooCloseToBuilding',
      buildingId: 'B-1',
    });
    expect(pointProblem(terrain, { x: 0, y: 101 })).toEqual({ kind: 'offTerrain' });
  });
});

describe('planPath', () => {
  const terrain = terrainWith({ buildings: [WALL] });

  it('goes straight when nothing is in the way', () => {
    expect(planPath(terrain, { x: -50, y: 50 }, { x: 50, y: 60 })).toEqual({ ok: true, turns: [] });
    expect(planPath(terrainWith(), { x: -50, y: -50 }, { x: 50, y: 50 })).toEqual({
      ok: true,
      turns: [],
    });
  });

  it('goes around a building, keeping clear of it and on the terrain', () => {
    const from = { x: 0, y: -40 };
    const to = { x: 0, y: 40 };
    expect(isSegmentWalkable(terrain, from, to)).toBe(false);
    const path = planPath(terrain, from, to);
    if (!path.ok) throw new Error('no path');
    expect(path.turns.length).toBeGreaterThan(0);
    expectWalkable(terrain, from, path.turns, to);
    for (const p of path.turns) expect(pointInPolygon(p, WALL.footprint)).toBe(false);
  });

  it('produces short, simplified paths without zig-zags', () => {
    const from = { x: 0, y: -40 };
    const to = { x: 0, y: 40 };
    const path = planPath(terrain, from, to);
    if (!path.ok) throw new Error('no path');
    // Around one end of the 40 × 20 wall: two turns, close to the ideal path that hugs
    // the clearance around two corners (−20.75, −10.75) and (−20.75, 10.75).
    expect(path.turns).toHaveLength(2);
    const c = OBSTACLE_CLEARANCE_M;
    const ideal = 2 * Math.hypot(20 + c, 30 - c) + (20 + 2 * c);
    expect(length([from, ...path.turns, to])).toBeLessThan(ideal * 1.05);
  });

  it('is deterministic, including the choice between equally good sides', () => {
    const from = { x: 0, y: -40 };
    const to = { x: 0, y: 40 };
    const first = planPath(terrain, from, to);
    for (let i = 0; i < 5; i += 1) expect(planPath(terrain, from, to)).toEqual(first);
    // A fresh copy of the same terrain plans the same path.
    expect(planPath(terrainWith({ buildings: [WALL] }), from, to)).toEqual(first);
  });

  it('rejects destinations inside or against a building, or off the map', () => {
    expect(planPath(terrain, { x: 0, y: -40 }, { x: 5, y: 2 })).toEqual({
      ok: false,
      problem: { kind: 'insideBuilding', buildingId: 'B-1' },
    });
    expect(planPath(terrain, { x: 0, y: -40 }, { x: 0, y: -10.3 })).toEqual({
      ok: false,
      problem: { kind: 'tooCloseToBuilding', buildingId: 'B-1' },
    });
    expect(planPath(terrain, { x: 0, y: -40 }, { x: 0, y: -120 })).toEqual({
      ok: false,
      problem: { kind: 'offTerrain' },
    });
  });

  it('rejects a destination that cannot be reached', () => {
    // A courtyard enclosed on all sides by four buildings.
    const ring = terrainWith({
      buildings: [
        { id: 'N', footprint: rectangle(0, 25, 60, 10), heightMeters: 5 },
        { id: 'S', footprint: rectangle(0, -25, 60, 10), heightMeters: 5 },
        { id: 'E', footprint: rectangle(25, 0, 10, 40), heightMeters: 5 },
        { id: 'W', footprint: rectangle(-25, 0, 10, 40), heightMeters: 5 },
      ],
    });
    expect(pointProblem(ring, { x: 0, y: 0 })).toBeNull();
    expect(planPath(ring, { x: 0, y: -60 }, { x: 0, y: 0 })).toEqual({
      ok: false,
      problem: { kind: 'unreachable' },
    });
  });
});

describe('stringPull', () => {
  it('removes nodes a straight walkable line can skip, keeping the endpoints', () => {
    const terrain = terrainWith();
    const zigzag = [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 4, y: 2 },
      { x: 6, y: 4 },
      { x: 8, y: 4 },
    ];
    expect(stringPull(terrain, zigzag)).toEqual([
      { x: 0, y: 0 },
      { x: 8, y: 4 },
    ]);
  });

  it('keeps the nodes needed to stay clear of a building', () => {
    const terrain = terrainWith({ buildings: [WALL] });
    const around = [
      { x: 0, y: -40 },
      { x: -30, y: -20 },
      { x: -30, y: 0 },
      { x: -30, y: 20 },
      { x: 0, y: 40 },
    ];
    // (0, −40) → (−30, 0) and (−30, 0) → (0, 40) both pass the wall's west end with room to spare.
    expect(stringPull(terrain, around)).toEqual([
      { x: 0, y: -40 },
      { x: -30, y: 0 },
      { x: 0, y: 40 },
    ]);
  });
});

describe('movement around buildings', () => {
  const A = soldierId('A');
  const scenario: Scenario = {
    id: 'nav',
    terrain: terrainWith({ buildings: [WALL] }),
    movement: { speed: 2, maxTurnRate: Math.PI / 2 },
    units: [{ id: 'U', echelon: 'fireTeam', parentId: null, leaderId: null }],
    soldiers: [
      {
        id: 'A',
        side: 'BLUEFOR',
        unitId: 'U',
        position: { x: 0, y: -40 },
        azimuthDeg: 0,
        posture: 'standing',
      },
    ],
  };

  it('follows the planned path, reporting only the trainee waypoint', () => {
    const sim = createSimulation({ tickRateHz: 10, seed: 0 }, scenario);
    sim.submit({
      type: 'setOrders',
      tick: 0,
      soldierId: A,
      orders: { waypoints: [{ id: waypointId('A.1'), x: 0, y: 40 }], finalFacing: 0 },
    });
    const planned = planPath(scenario.terrain, { x: 0, y: -40 }, { x: 0, y: 40 });
    if (!planned.ok) throw new Error('no path');
    const events = [];
    const visited: Vec2[] = [];
    for (let i = 0; i < 1200; i += 1) {
      events.push(...sim.step());
      const s = sim.state.soldiers[0];
      if (s) visited.push({ x: s.position.x, y: s.position.y });
    }
    expect(sim.state.soldiers[0]?.orders?.legPaths).toEqual([planned.turns]);
    expect(events.filter((e) => e.type === 'waypointReached').map((e) => e.waypointId)).toEqual([
      'A.1',
    ]);
    expect(visited.at(-1)).toEqual({ x: 0, y: 40 });
    for (const p of visited) expect(pointInPolygon(p, WALL.footprint)).toBe(false);
  });

  it('rejects orders to a waypoint inside a building', () => {
    const sim = createSimulation({ tickRateHz: 10, seed: 0 }, scenario);
    const command = {
      type: 'setOrders' as const,
      tick: 0,
      soldierId: A,
      orders: { waypoints: [{ id: waypointId('A.1'), x: 0, y: 0 }], finalFacing: 0 },
    };
    sim.submit(command);
    expect(sim.step()).toEqual([
      { type: 'commandRejected', tick: 0, command, reason: 'waypointBlocked' },
    ]);
    expect(sim.state.soldiers[0]?.orders).toBeNull();
  });
});

describe('the nearest point clear of buildings', () => {
  // WALL spans x −20..20, y −10..10.
  const reach = OBSTACLE_CLEARANCE_M + 0.5;

  it('is just outside the nearest wall, for a point inside or too close', () => {
    const t = terrainWith({ buildings: [WALL] });
    expect(nearestPointClearOfBuildings(t, { x: 0, y: 8 })).toEqual({ x: 0, y: 10 + reach });
    expect(nearestPointClearOfBuildings(t, { x: 15, y: 0 })).toEqual({ x: 20 + reach, y: 0 });
    const close = nearestPointClearOfBuildings(t, { x: 0, y: 10.3 });
    expect(close?.x).toBeCloseTo(0);
    expect(close?.y).toBeCloseTo(10 + reach);
  });

  it('searches round the point when that spot is blocked or refused', () => {
    // A second building just north of the wall: its gap is too narrow to stand in.
    const north = { id: 'B-2', footprint: rectangle(0, 13, 40, 2), heightMeters: 6 };
    const t = terrainWith({ buildings: [WALL, north] });
    const p = { x: 0, y: 8 };
    const q = nearestPointClearOfBuildings(t, p);
    expect(q).not.toBeNull();
    expect(q && pointProblem(t, q)).toBeNull();
    expect(q && Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(25);
    // A refusing `accept` is honoured too.
    const notNorth = nearestPointClearOfBuildings(
      terrainWith({ buildings: [WALL] }),
      p,
      (c) => c.y < 0,
    );
    expect(notNorth && notNorth.y < 0 && pointProblem(t, notNorth) === null).toBe(true);
  });

  it('leaves a good point as it is, and does nothing for problems other than buildings', () => {
    const t = terrainWith({ buildings: [WALL] });
    expect(nearestPointClearOfBuildings(t, { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
    expect(nearestPointClearOfBuildings(t, { x: 500, y: 0 })).toBeNull();
  });
});
