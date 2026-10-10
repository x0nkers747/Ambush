import { describe, expect, it } from 'vitest';
import {
  addRouteWaypoint,
  buildScenario,
  createExercise,
  defaultScenarioDefinition,
  setOpforStart,
  setOrp,
  type EditResult,
  type Exercise,
  type ScenarioDefinition,
} from '#exercise';
import {
  azimuthFromDegrees,
  createSyntheticTerrain,
  flatElevation,
  rectangle,
  type TerrainDataset,
} from '#sim';
import { carryPlans } from './carry-plans';

// Carrying plans into a rebuilt exercise (docs/adr/0025).

/** A 1 km flat battlefield, with buildings centred on the given points (20 × 20 m). */
function terrain(buildings: readonly [number, number][]): TerrainDataset {
  const base = createSyntheticTerrain(
    { originX: -500, originY: -500, cellSize: 10, columns: 101, rows: 101 },
    flatElevation(50),
  );
  return {
    ...base,
    formatVersion: 3,
    features: {
      roads: [],
      buildings: buildings.map(([x, y], i) => ({
        id: `B${String(i + 1)}`,
        footprint: rectangle(x, y, 20, 20, 0),
        heightMeters: 6,
      })),
      vegetation: [],
      water: [],
      waterways: [],
      landUse: [],
    },
  };
}
const ok = (r: EditResult): ScenarioDefinition => {
  if (!r.ok) throw new Error(r.problem);
  return r.definition;
};
function exercise(t: TerrainDataset, orp: { x: number; y: number }): Exercise {
  let d = defaultScenarioDefinition(t, 'carry-test');
  d = ok(setOrp(t, d, orp));
  d = ok(setOpforStart(t, d, { x: 0, y: 400 }));
  d = ok(addRouteWaypoint(t, d, { x: 0, y: 100 }));
  return createExercise({ config: { tickRateHz: 10, seed: 1 }, scenario: buildScenario(t, d) });
}
const plans = (e: Exercise) => e.deploymentPlans().plans;
const ZONE = [
  { x: -40, y: 80 },
  { x: 40, y: 80 },
  { x: 40, y: 140 },
  { x: -40, y: 140 },
];

/** A planned exercise: a kill zone, a fire-team formation with one detached Marine, one single Marine. */
function planned(t: TerrainDataset): Exercise {
  const e = exercise(t, { x: 0, y: -300 });
  for (const v of ZONE) e.addKillZoneVertex(v);
  const team = e.fireTeams[0];
  const other = e.fireTeams[1];
  if (!team || !other) throw new Error('no fire teams');
  e.placeFormation(team.unitId, { x: 0, y: -100 }, azimuthFromDegrees(0));
  const detached = team.memberIds[0];
  const single = other.memberIds[0];
  if (!detached || !single) throw new Error('no Marines');
  e.setDestination(detached, { x: -100, y: -120 });
  e.setDestination(single, { x: 60, y: -60 });
  e.setFacing(single, azimuthFromDegrees(45));
  return e;
}

describe('carrying plans into a new exercise', () => {
  it('keeps every plan, the formation (with its detached Marine) and the kill zone', () => {
    const T = terrain([[150, 0]]);
    const from = planned(T);
    // The same scenario after an explicit restart: a fresh exercise.
    const to = exercise(T, { x: 0, y: -300 });
    const result = carryPlans(from, to);
    expect(result.problems).toEqual([]);
    expect(result.kept).toBe(13);
    expect(plans(to)).toEqual(plans(from));
    expect(to.killZone?.vertices).toEqual(ZONE);
    const team = from.fireTeams[0];
    if (!team) throw new Error('no fire team');
    expect(to.formation(team.unitId)).toEqual(from.formation(team.unitId));
  });

  it('carries plans across a scenario change (the ORP moved), which changes the fingerprint', () => {
    const T = terrain([[150, 0]]);
    const from = planned(T);
    const to = exercise(T, { x: 0, y: -250 });
    expect(to.scenarioFingerprint).not.toBe(from.scenarioFingerprint);
    const result = carryPlans(from, to);
    expect(result.problems).toEqual([]);
    expect(plans(to)).toEqual(plans(from));
  });

  it('carries the plans being shown after execution, and reports what the new exercise refuses', () => {
    const from = planned(terrain([[150, 0]]));
    from.execute();
    from.advance(1);
    // On this terrain a building stands on the single Marine's destination.
    const to = exercise(
      terrain([
        [150, 0],
        [60, -60],
      ]),
      { x: 0, y: -300 },
    );
    const result = carryPlans(from, to);
    expect(result.kept).toBe(12);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/^2-FTL: Destination not set: .*building/);
    const single = from.fireTeams[1]?.memberIds[0];
    if (!single) throw new Error('no Marine');
    expect(to.displayedPlan(single)).toEqual({
      soldierId: single,
      destination: null,
      facingDegrees: null,
    });
  });
});
