import { describe, expect, it } from 'vitest';
import { bridgeSurfaces, surfaceHeightAt, type PathPoint } from './bridge-navigation';
import type { Building, EnvironmentFeatures, Road, WaterArea } from './environment';
import type { Vec2 } from './geometry';
import { gradeTerrain } from './ground';
import {
  bridgeCrossings,
  isSegmentWalkable,
  pathLength,
  planPath,
  pointProblem,
} from './navigation';
import { pointInPolygon } from './polygon';
import type { Scenario } from './scenario';
import { createSimulation } from './simulation';
import { soldierId, waypointId } from './state';
import { createSyntheticTerrain } from './synthetic-terrain';
import { heightAt, type TerrainDataset } from './terrain';
import { waterLevelAt } from './water-grading';

// Crossing bridges (docs/adr/0043): the bridges the 3D view draws join the
// land on either side of water, soldiers walk along their decks, and nothing
// else crosses impassable water.

const GRID = { originX: -300, originY: -300, cellSize: 10, columns: 61, rows: 61 };
/** A river valley along y: banks at 20 m, the river 40 m wide at x ∈ [−20, 20], across the whole map. */
const valley = (x: number) => (Math.abs(x) < 20 ? 18 : 18 + Math.min(2, 0.2 * (Math.abs(x) - 20)));
const river: WaterArea = {
  id: 'river-area',
  kind: 'water',
  waterClass: 'river',
  boundary: [
    { x: -20, y: -300 },
    { x: 20, y: -300 },
    { x: 20, y: 300 },
    { x: -20, y: 300 },
  ],
};
const road = (id: string, pts: [number, number][], extra: Partial<Road> = {}): Road => ({
  id,
  roadClass: 'paved',
  widthMeters: 6,
  centerline: pts.map(([x, y]) => ({ x, y })),
  ...extra,
});
/** The road across the river at y = 0, mapped as a bridge over it. */
const approaches = [
  road('west', [
    [-150, 0],
    [-30, 0],
  ]),
  road('east', [
    [30, 0],
    [150, 0],
  ]),
];
const across = [
  ...approaches,
  road(
    'across',
    [
      [-30, 0],
      [30, 0],
    ],
    { bridge: true, crossing: { kind: 'bridge' } },
  ),
];
const world = (f: Partial<EnvironmentFeatures> = {}): TerrainDataset =>
  gradeTerrain(
    createSyntheticTerrain(GRID, valley, {
      roads: [],
      buildings: [],
      vegetation: [],
      water: [river],
      waterways: [],
      landUse: [],
      ...f,
    }),
  );
const WITH_BRIDGE = world({ roads: across });
const NO_BRIDGE = world();

const inRiver = (p: Vec2) => pointInPolygon(p, river.boundary);

/** Walks a soldier from `start` through `waypoints`; every position, and the events. */
function walk(terrain: TerrainDataset, start: Vec2, waypoints: Vec2[], ticks = 4000) {
  const scenario: Scenario = {
    id: 'bridge',
    terrain,
    movement: { speed: 2, maxTurnRate: Math.PI / 2 },
    units: [{ id: 'U', echelon: 'fireTeam', parentId: null, leaderId: null }],
    soldiers: [
      {
        id: 'A',
        side: 'OPFOR',
        unitId: 'U',
        position: start,
        azimuthDeg: 0,
        posture: 'standing',
      },
    ],
  };
  const sim = createSimulation({ tickRateHz: 10, seed: 0 }, scenario);
  sim.submit({
    type: 'setOrders',
    tick: 0,
    soldierId: soldierId('A'),
    orders: {
      waypoints: waypoints.map((w, i) => ({ id: waypointId(`A.${String(i + 1)}`), ...w })),
      finalFacing: 0,
    },
  });
  const events = [];
  const visited: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < ticks; i += 1) {
    events.push(...sim.step());
    const s = sim.state.soldiers[0];
    if (s) visited.push({ ...s.position });
    if (s?.orders?.behavior === 'inPosition') break;
  }
  return { sim, events, visited, terrain: sim.world.terrain };
}

describe('bridges soldiers can cross', () => {
  it('are the bridges drawn over water, with a centreline, deck heights and a width', () => {
    const { crossable, rejected } = bridgeCrossings(WITH_BRIDGE);
    expect(rejected).toEqual([]);
    expect(crossable.map((b) => b.roadIds)).toEqual([['across']]);
    const [b] = crossable;
    if (!b) throw new Error('no bridge');
    // From bank to bank and onto the land beyond, along the road.
    const first = b.points[0];
    const last = b.points[b.points.length - 1];
    expect(Math.min(first?.x ?? 0, last?.x ?? 0)).toBeLessThan(-20);
    expect(Math.max(first?.x ?? 0, last?.x ?? 0)).toBeGreaterThan(20);
    for (const p of b.points) expect(Math.abs(p.y)).toBeLessThan(1e-6);
    expect(b.length).toBeGreaterThan(40);
    expect(b.halfWidth).toBeGreaterThan(3);
    // The ends stand on land; the deck stands above the water between them.
    expect(first && pointProblem(WITH_BRIDGE, first)).toBeNull();
    expect(last && pointProblem(WITH_BRIDGE, last)).toBeNull();
    const level = waterLevelAt(WITH_BRIDGE, 0, 0) ?? 0;
    expect(surfaceHeightAt(WITH_BRIDGE, 0, 0)).toBeGreaterThan(level + 0.5);
    expect(surfaceHeightAt(WITH_BRIDGE, 0, 0)).toBeGreaterThan(heightAt(WITH_BRIDGE, 0, 0));
    // Beside the deck, the river is still water.
    expect(pointProblem(WITH_BRIDGE, { x: 0, y: 10 })?.kind).toBe('inWater');
    expect(pointProblem(WITH_BRIDGE, { x: 0, y: 1 })).toBeNull();
  });

  it('carries a soldier across the river', () => {
    const { events, visited, terrain } = walk(WITH_BRIDGE, { x: -100, y: -20 }, [
      { x: 100, y: -20 },
    ]);
    expect(events.filter((e) => e.type === 'waypointReached')).toHaveLength(1);
    expect(visited.at(-1)).toMatchObject({ x: 100, y: -20 });
    // Over the river only on the deck.
    const wet = visited.filter(inRiver);
    expect(wet.length).toBeGreaterThan(0);
    for (const p of wet) expect(bridgeSurfaces(terrain).deckAt(p.x, p.y)).not.toBeNull();
  });

  it('detours to a bridge far from the straight line', () => {
    const from = { x: -100, y: -250 };
    const to = { x: 100, y: -250 };
    expect(isSegmentWalkable(WITH_BRIDGE, from, to)).toBe(false);
    const path = planPath(WITH_BRIDGE, from, to);
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    // Up to the bridge at y = 0 and back: well over twice 250 m.
    expect(pathLength(from, path.turns, to)).toBeGreaterThan(2 * 240);
    // Across on the deck: its ends (with the deck's height) on either bank.
    const deck = path.turns.filter((p) => p.z !== undefined && Math.abs(p.y) < 1e-6);
    expect(deck.some((p) => p.x < -20)).toBe(true);
    expect(deck.some((p) => p.x > 20)).toBe(true);
    const { visited } = walk(WITH_BRIDGE, from, [to], 6000);
    expect(visited.at(-1)).toMatchObject(to);
  });

  it('never crosses a river with no bridge', () => {
    const from = { x: -100, y: -20 };
    const to = { x: 100, y: -20 };
    expect(planPath(NO_BRIDGE, from, to)).toEqual({ ok: false, problem: { kind: 'unreachable' } });
    const { events, visited } = walk(NO_BRIDGE, from, [to], 10);
    expect(events[0]).toMatchObject({ type: 'commandRejected', reason: 'waypointUnreachable' });
    expect(visited.every((p) => p.x === from.x && p.y === from.y)).toBe(true);
  });

  it('crosses either way, on the same deck', () => {
    const east = walk(WITH_BRIDGE, { x: -100, y: 30 }, [{ x: 100, y: 30 }]);
    const west = walk(WITH_BRIDGE, { x: 100, y: 30 }, [{ x: -100, y: 30 }]);
    expect(east.visited.at(-1)).toMatchObject({ x: 100, y: 30 });
    expect(west.visited.at(-1)).toMatchObject({ x: -100, y: 30 });
    const deckPoints = (v: { x: number; y: number }[]) =>
      v.filter(inRiver).map((p) => Math.round(p.x));
    expect(deckPoints(east.visited).length).toBeGreaterThan(10);
    expect(deckPoints(west.visited).length).toBeGreaterThan(10);
    // The same line over the water.
    for (const p of [...east.visited, ...west.visited].filter(inRiver))
      expect(Math.abs(p.y)).toBeLessThan(0.01);
  });

  it('keeps a soldier on the deck, rising and falling smoothly', () => {
    const { visited, terrain } = walk(WITH_BRIDGE, { x: -100, y: 0 }, [{ x: 100, y: 0 }]);
    const level = waterLevelAt(terrain, 0, 0) ?? 0;
    const onBridge = visited.filter(inRiver);
    expect(onBridge.length).toBeGreaterThan(10);
    for (const p of onBridge) {
      // On the surface: the deck, above the water and the riverbed.
      expect(p.z).toBeCloseTo(surfaceHeightAt(terrain, p.x, p.y), 1);
      expect(p.z).toBeGreaterThan(level + 0.2);
      expect(p.z).toBeGreaterThan(heightAt(terrain, p.x, p.y) + 0.5);
    }
    // No jumps anywhere: at 2 m/s and 10 Hz, 0.2 m a tick, no more than a steep step.
    for (let i = 1; i < visited.length; i += 1) {
      const a = visited[i - 1];
      const b = visited[i];
      if (a && b) expect(Math.abs(b.z - a.z)).toBeLessThan(0.2);
    }
  });

  it('is not crossed when an end is not on open ground', () => {
    // A pier: mapped as a bridge, from the west bank to the middle of the river.
    const pier = road('pier', [
      [-150, 0],
      [0, 0],
    ]);
    const piered = world({ roads: [{ ...pier, crossing: { kind: 'bridge' }, bridge: true }] });
    expect(bridgeCrossings(piered).crossable).toEqual([]);
    expect(bridgeCrossings(piered).rejected).toEqual([
      { id: expect.stringContaining('pier') as string, reason: 'an end is inWater' },
    ]);
    expect(planPath(piered, { x: -100, y: -20 }, { x: 100, y: -20 }).ok).toBe(false);
    // A bridge whose east end is inside a building.
    const shed: Building = {
      id: 'shed',
      footprint: [
        { x: 15, y: -20 },
        { x: 80, y: -20 },
        { x: 80, y: 20 },
        { x: 15, y: 20 },
      ],
      heightMeters: 4,
    };
    const blocked = world({ roads: across, buildings: [shed] });
    expect(bridgeCrossings(blocked).crossable).toEqual([]);
    expect(bridgeCrossings(blocked).rejected[0]?.reason).toMatch(/Building/);
    expect(planPath(blocked, { x: -100, y: -40 }, { x: 100, y: -40 }).ok).toBe(false);
  });

  it('is the same bridge for the 3D view: one plan, from the simulation', () => {
    const [b] = bridgeCrossings(WITH_BRIDGE).crossable;
    expect(b?.bridge).toBe(bridgeSurfaces(WITH_BRIDGE).bridges[0]?.bridge);
  });

  it('plans from and to a point on the deck', () => {
    const mid = { x: 0, y: 0.5 };
    expect(pointProblem(WITH_BRIDGE, mid)).toBeNull();
    const there = planPath(WITH_BRIDGE, { x: -100, y: -40 }, mid);
    const back = planPath(WITH_BRIDGE, mid, { x: 100, y: 40 });
    expect(there.ok && back.ok).toBe(true);
    const deck = (turns: readonly PathPoint[]) => turns.filter((p) => p.z !== undefined);
    if (there.ok) expect(deck(there.turns).length).toBeGreaterThan(0);
    if (back.ok) expect(deck(back.turns).length).toBeGreaterThan(0);
  });

  it('plans and walks the same, run after run', () => {
    const run = () => walk(WITH_BRIDGE, { x: -100, y: -60 }, [{ x: 100, y: 60 }]);
    const a = run();
    const b = run();
    expect(b.visited).toEqual(a.visited);
    const state = (s: unknown) => JSON.stringify(s);
    expect(state(b.sim.state)).toEqual(state(a.sim.state));
  });
});
