import { describe, expect, it } from 'vitest';
import {
  createSimulation,
  createSyntheticTerrain,
  gradeTerrain,
  NO_FEATURES,
  planPath,
  soldierId,
  surfaceHeightAt,
  waypointId,
  type Road,
  type TerrainDataset,
  type WaterArea,
} from '#sim';
import { createExercise } from './exercise';
import { createStateRecorder } from './replay';
import {
  addRouteWaypoint,
  buildScenario,
  defaultScenarioDefinition,
  setOpforStart,
  setOrp,
  type EditResult,
} from './scenario-definition';

// OPFOR follows the roads (docs/adr/0043): the route the trainee is shown is
// the one walked, across bridges, and the recording replays it exactly.

/** An 800 m battlefield: a river at x ∈ [−20, 20], a lane across it on a bridge, banks at 20 m. */
function battlefield(): TerrainDataset {
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
  const lane: Road = {
    id: 'lane',
    roadClass: 'unpaved',
    widthMeters: 4,
    centerline: [
      { x: -300, y: 150 },
      { x: -100, y: 0 },
      { x: 100, y: 0 },
      { x: 300, y: -150 },
    ],
  };
  const valley = (x: number) =>
    Math.abs(x) < 20 ? 18 : 18 + Math.min(2, 0.2 * (Math.abs(x) - 20));
  return gradeTerrain(
    createSyntheticTerrain(
      { originX: -400, originY: -400, cellSize: 10, columns: 81, rows: 81 },
      valley,
      { ...NO_FEATURES, water: [river], roads: [lane] },
    ),
  );
}

const ok = (r: EditResult) => {
  if (!r.ok) throw new Error(r.problem);
  return r.definition;
};

describe('OPFOR on the roads', () => {
  const T = battlefield();
  let d = defaultScenarioDefinition(T, 'roads');
  d = ok(setOrp(T, d, { x: -250, y: -250 }));
  d = ok(setOpforStart(T, d, { x: 300, y: -150 }));
  d = ok(addRouteWaypoint(T, d, { x: -300, y: 150 }));
  const scenario = buildScenario(T, d);
  const exercise = createExercise({ config: { tickRateHz: 10, seed: 1 }, scenario });
  const [route] = scenario.opforRoutes;
  if (!route) throw new Error('no route');

  it('is shown as walked: along the lane and over the bridge', () => {
    const shown = exercise.opforRoutePaths.get(route.id);
    const leg = shown?.legs[0];
    const start = exercise.simulation.state.soldiers.find((s) => s.id === route.soldierId);
    if (!leg?.turns || !start) throw new Error('no leg');
    expect(leg.turns).toEqual(
      (() => {
        const p = planPath(T, start.position, leg.to, { followRoads: true });
        return p.ok ? p.turns : null;
      })(),
    );
    // The lane's bends, and the bridge's ends with the deck's height.
    expect(leg.turns).toEqual(
      expect.arrayContaining([
        { x: 100, y: 0 },
        { x: -100, y: 0 },
      ]),
    );
    expect(leg.turns.filter((p) => 'z' in p).length).toBeGreaterThanOrEqual(2);
  });

  it('walks it in the simulation, and the recording replays every step', () => {
    const sim = createSimulation({ tickRateHz: 10, seed: 1 }, scenario);
    sim.submit({
      type: 'setOrders',
      tick: 0,
      soldierId: soldierId(route.soldierId),
      orders: {
        waypoints: route.waypoints.map((w) => ({ id: waypointId(w.id), x: w.x, y: w.y })),
        finalFacing: 0,
        followRoads: true,
      },
    });
    sim.step();
    const soldier = () => sim.state.soldiers.find((s) => s.id === route.soldierId);
    expect(soldier()?.orders?.legPaths).toEqual([
      exercise.opforRoutePaths.get(route.id)?.legs[0]?.turns,
    ]);
    const record = createStateRecorder();
    const frames = [];
    const live = [];
    for (let i = 0; i < 6000 && soldier()?.orders?.behavior === 'moving'; i += 1) {
      sim.step();
      frames.push(record(sim.state));
      const s = soldier();
      if (s) live.push({ ...s.position });
    }
    expect(soldier()?.orders?.behavior).not.toBe('moving');
    const replayed = frames.map((f) => f.soldiers.find((s) => s.id === route.soldierId)?.position);
    expect(replayed).toEqual(live);
    // On the bridge, on its deck.
    const onBridge = live.filter((p) => Math.abs(p.x) < 20);
    expect(onBridge.length).toBeGreaterThan(10);
    for (const p of onBridge) expect(p.z).toBeCloseTo(surfaceHeightAt(T, p.x, p.y), 1);
  });
});
