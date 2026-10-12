import { describe, expect, it } from 'vitest';
import { surfaceHeightAt, type PathPoint } from './bridge-navigation';
import { NO_FEATURES, type EnvironmentFeatures, type Road, type WaterArea } from './environment';
import type { Vec2 } from './geometry';
import { gradeTerrain } from './grading';
import { pathLength, planOffRoad, planPath } from './navigation';
import { roadNetwork, roadPointAt } from './road-network';
import type { Scenario } from './scenario';
import { createSimulation } from './simulation';
import { soldierId, waypointId } from './state';
import { createSyntheticTerrain, flatElevation } from './synthetic-terrain';
import type { TerrainDataset } from './terrain';

// OPFOR road following (docs/adr/0043): to a destination on a road, along the
// roads; elsewhere, off road as before.

const GRID = { originX: -400, originY: -400, cellSize: 10, columns: 81, rows: 81 };
const road = (id: string, pts: [number, number][], extra: Partial<Road> = {}): Road => ({
  id,
  roadClass: 'unpaved',
  widthMeters: 4,
  centerline: pts.map(([x, y]) => ({ x, y })),
  ...extra,
});
const flat = (f: Partial<EnvironmentFeatures>): TerrainDataset =>
  createSyntheticTerrain(GRID, flatElevation(10), { ...NO_FEATURES, ...f });

/** A road winding east in a zigzag between y = −100 and y = 100. */
const WINDING = road('winding', [
  [-300, 0],
  [-200, 100],
  [-100, -100],
  [0, 100],
  [100, -100],
  [200, 100],
  [300, 0],
]);

/** The distance from `p` to a polyline. */
function distanceTo(p: Vec2, line: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

/** Sends an OPFOR soldier from `start` through `waypoints` along the roads; every position and the events. */
function patrol(terrain: TerrainDataset, start: Vec2, waypoints: Vec2[], followRoads = true) {
  const scenario: Scenario = {
    id: 'roads',
    terrain,
    movement: { speed: 2, maxTurnRate: Math.PI / 2 },
    units: [{ id: 'P', echelon: 'fireTeam', parentId: null, leaderId: null }],
    soldiers: [
      { id: 'E', side: 'OPFOR', unitId: 'P', position: start, azimuthDeg: 0, posture: 'standing' },
    ],
  };
  const sim = createSimulation({ tickRateHz: 10, seed: 0 }, scenario);
  sim.submit({
    type: 'setOrders',
    tick: 0,
    soldierId: soldierId('E'),
    orders: {
      waypoints: waypoints.map((w, i) => ({ id: waypointId(`E.${String(i + 1)}`), ...w })),
      finalFacing: 0,
      followRoads,
    },
  });
  const events = [];
  const visited: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 20_000; i += 1) {
    events.push(...sim.step());
    const s = sim.state.soldiers[0];
    if (s) visited.push({ ...s.position });
    if (s?.orders?.behavior === 'inPosition' || s?.orders === null) break;
  }
  return { sim, events, visited };
}

describe('road following', () => {
  it('follows a winding road rather than the straight line', () => {
    const t = flat({ roads: [WINDING] });
    const from = { x: -300, y: 0 };
    const to = { x: 300, y: 0 };
    const path = planPath(t, from, to, { followRoads: true });
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    // Every bend, in order, and nothing off the road.
    expect(path.turns).toEqual(WINDING.centerline.slice(1, -1));
    expect(pathLength(from, path.turns, to)).toBeGreaterThan(1000);
    // Without roads: straight across the open ground.
    expect(planPath(t, from, to)).toEqual({ ok: true, turns: [] });
    const { visited, events } = patrol(t, from, [to]);
    expect(events.filter((e) => e.type === 'waypointReached')).toHaveLength(1);
    expect(visited.at(-1)).toMatchObject(to);
    for (const p of visited) expect(distanceTo(p, WINDING.centerline)).toBeLessThan(1e-6);
  });

  it('goes through junctions, taking the shortest way', () => {
    // A junction at (0, 0) and a long way round to the north and east.
    const t = flat({
      roads: [
        road('west', [
          [-300, 0],
          [0, 0],
        ]),
        road('east', [
          [0, 0],
          [300, 0],
        ]),
        road('south', [
          [0, 0],
          [0, -300],
        ]),
        road('loop', [
          [-300, 0],
          [-300, 300],
          [300, 300],
          [300, 0],
        ]),
      ],
    });
    const from = { x: -250, y: 0 };
    const to = { x: 0, y: -250 };
    const path = planPath(t, from, to, { followRoads: true });
    expect(path.ok && path.turns).toEqual([{ x: 0, y: 0 }]);
    const { visited } = patrol(t, from, [to]);
    expect(visited.at(-1)).toMatchObject(to);
  });

  it('crosses a bridge on the road, on its deck', () => {
    const river: WaterArea = {
      id: 'river',
      kind: 'water',
      waterClass: 'river',
      boundary: [
        { x: -20, y: -400 },
        { x: 20, y: -400 },
        { x: 20, y: 400 },
        { x: -20, y: 400 },
      ],
    };
    const valley = (x: number) =>
      Math.abs(x) < 20 ? 18 : 18 + Math.min(2, 0.2 * (Math.abs(x) - 20));
    const t = gradeTerrain(
      createSyntheticTerrain(GRID, valley, {
        ...NO_FEATURES,
        water: [river],
        roads: [
          road('lane', [
            [-300, 150],
            [-100, 0],
            [100, 0],
            [300, -150],
          ]),
        ],
      }),
    );
    const from = { x: -300, y: 150 };
    const to = { x: 300, y: -150 };
    const path = planPath(t, from, to, { followRoads: true });
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    // Along the road, the bridge's two ends carrying the deck's height.
    const deck = path.turns.filter((p: PathPoint) => p.z !== undefined);
    expect(deck.some((p) => p.x < -20)).toBe(true);
    expect(deck.some((p) => p.x > 20)).toBe(true);
    const { visited, sim } = patrol(t, from, [to]);
    expect(visited.at(-1)).toMatchObject(to);
    const terrain = sim.world.terrain;
    for (const p of visited.filter((q) => Math.abs(q.x) < 20)) {
      expect(Math.abs(p.y)).toBeLessThan(1e-6);
      expect(p.z).toBeCloseTo(surfaceHeightAt(terrain, p.x, p.y), 1);
    }
  });

  it('joins the road from off it, then follows it', () => {
    const t = flat({ roads: [WINDING] });
    const from = { x: -250, y: -150 };
    const to = { x: 250, y: 50 };
    const path = planPath(t, from, to, { followRoads: true });
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    const [join, ...rest] = path.turns;
    // Joins at the nearest good point of the road, then every bend after it.
    expect(join && distanceTo(join, WINDING.centerline)).toBeLessThan(1e-6);
    expect(rest).toEqual(
      expect.arrayContaining(
        WINDING.centerline.filter((p) => p.x >= -100 && p.x <= 200).map((p) => ({ ...p })),
      ),
    );
    const { visited } = patrol(t, from, [to]);
    expect(visited.at(-1)).toMatchObject(to);
  });

  it('plans a destination off the roads as before', () => {
    const t = flat({ roads: [WINDING] });
    const from = { x: -300, y: 0 };
    const to = { x: 200, y: -300 };
    expect(roadPointAt(t, to)).toBeNull();
    expect(planPath(t, from, to, { followRoads: true })).toEqual(planPath(t, from, to));
    expect(planPath(t, from, to, { followRoads: true })).toEqual({ ok: true, turns: [] });
  });

  it('does not join roads that are not joined, nor cross water with no bridge', () => {
    // Two roads ending either side of a river with no bridge.
    const river: WaterArea = {
      id: 'river',
      kind: 'water',
      boundary: [
        { x: -20, y: -400 },
        { x: 20, y: -400 },
        { x: 20, y: 400 },
        { x: -20, y: 400 },
      ],
    };
    const t = flat({
      water: [river],
      roads: [
        // A road mapped across the river as a ford: no bridge, and its edge over the water is left out.
        road(
          'west',
          [
            [-300, 0],
            [-30, 0],
            [30, 0],
            [300, 0],
          ],
          { crossing: { kind: 'ford' } },
        ),
      ],
    });
    const net = roadNetwork(t);
    expect(net.blockedEdges).toBe(1);
    const parts = new Set(net.component);
    expect(parts.size).toBe(2);
    expect(planPath(t, { x: -200, y: 0 }, { x: 200, y: 0 }, { followRoads: true })).toEqual({
      ok: false,
      problem: { kind: 'unreachable' },
    });
    // Two roads with a gap: no road edge across it; the walk across the gap is off road.
    const gap = flat({
      roads: [
        road('a', [
          [-300, 0],
          [-50, 0],
        ]),
        road('b', [
          [50, 0],
          [300, 0],
        ]),
      ],
    });
    const net2 = roadNetwork(gap);
    expect(net2.component[0]).not.toBe(net2.component[net2.nodes.length - 1]);
    const p = planPath(gap, { x: -250, y: 0 }, { x: 250, y: 0 }, { followRoads: true });
    expect(p.ok && p.turns).toEqual([{ x: 50, y: 0 }]);
  });

  it('keeps roads that cross without a junction apart', () => {
    const over = road(
      'over',
      [
        [0, -300],
        [0, 0],
        [0, 300],
      ],
      { crossing: { kind: 'bridge', layer: 1 }, bridge: true },
    );
    const under = road('under', [
      [-300, 0],
      [0, 0],
      [300, 0],
    ]);
    const net = roadNetwork(flat({ roads: [over, under] }));
    const at = (x: number, y: number) =>
      net.nodes.flatMap((n, i) => (n.x === x && n.y === y ? [i] : []));
    // The shared point is two nodes, on two levels, and the roads are not joined.
    expect(at(0, 0)).toHaveLength(2);
    const [a, b] = at(0, 0);
    expect(net.component[a ?? 0]).not.toBe(net.component[b ?? 0]);
    // Crossing with no shared point at all: apart too.
    const plain = roadNetwork(
      flat({
        roads: [
          road('ns', [
            [0, -300],
            [0, 300],
          ]),
          road('ew', [
            [-300, 0],
            [300, 0],
          ]),
        ],
      }),
    );
    expect(new Set(plain.component).size).toBe(2);
    // On one level with a shared point: a junction.
    const junction = roadNetwork(
      flat({
        roads: [
          road('ns', [
            [0, -300],
            [0, 0],
            [0, 300],
          ]),
          road('ew', [
            [-300, 0],
            [0, 0],
            [300, 0],
          ]),
        ],
      }),
    );
    expect(new Set(junction.component).size).toBe(1);
    // A bridge meets its approach at its end, whatever the levels.
    const approach = roadNetwork(
      flat({
        roads: [
          road(
            'deck',
            [
              [0, 0],
              [0, 100],
            ],
            { crossing: { kind: 'bridge', layer: 1 } },
          ),
          road('ramp', [
            [0, -100],
            [0, 0],
          ]),
        ],
      }),
    );
    expect(new Set(approach.component).size).toBe(1);
  });

  it('visits several waypoints in order, along the roads', () => {
    const t = flat({ roads: [WINDING] });
    const waypoints = [
      { x: 0, y: 100 },
      { x: -200, y: 100 },
      { x: 300, y: 0 },
    ];
    const { events, visited } = patrol(t, { x: -300, y: 0 }, waypoints);
    expect(events.flatMap((e) => (e.type === 'waypointReached' ? [e.waypointId] : []))).toEqual([
      'E.1',
      'E.2',
      'E.3',
    ]);
    expect(visited.at(-1)).toMatchObject({ x: 300, y: 0 });
    for (const p of visited) expect(distanceTo(p, WINDING.centerline)).toBeLessThan(1e-6);
  });

  it('is the same as off road for orders that do not follow roads', () => {
    const t = flat({ roads: [WINDING] });
    const { visited } = patrol(t, { x: -300, y: 0 }, [{ x: 300, y: 0 }], false);
    for (const p of visited) expect(Math.abs(p.y)).toBeLessThan(1e-9);
    expect(planOffRoad(t, { x: -300, y: 0 }, { x: 300, y: 0 })).toEqual({ ok: true, turns: [] });
  });
});
