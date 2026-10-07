import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  flatElevation,
  pointInPolygon,
  rectangle,
  soldierId,
  type SimEvent,
  type Vec2,
} from '#sim';
import type { AmbushScenario } from './ambush-scenario';
import { createExercise, ExerciseError, type Exercise } from './exercise';
import { killZoneSamplePoints } from './kill-zone';

// Planning against the environment (docs/adr/0011): routes around buildings,
// refused waypoints, and line of sight from planned positions.

const A = soldierId('A');
/** A 40 m × 20 m building between A (south) and the area north of it. */
const BARN = { id: 'B-1', footprint: rectangle(0, 0, 40, 20), heightMeters: 8 };
/** Four buildings enclosing a courtyard at (100, 100). */
const COURTYARD = [
  { id: 'C-N', footprint: rectangle(100, 125, 60, 10), heightMeters: 5 },
  { id: 'C-S', footprint: rectangle(100, 75, 60, 10), heightMeters: 5 },
  { id: 'C-E', footprint: rectangle(125, 100, 10, 40), heightMeters: 5 },
  { id: 'C-W', footprint: rectangle(75, 100, 10, 40), heightMeters: 5 },
];

const SCENARIO: AmbushScenario = {
  id: 'environment-planning',
  terrain: createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
    flatElevation(100),
    { roads: [], buildings: [BARN, ...COURTYARD], vegetation: [] },
  ),
  movement: { speed: 2, maxTurnRate: Math.PI / 2 },
  units: [
    { id: 'TM', echelon: 'fireTeam', parentId: null, leaderId: null },
    { id: 'EN', echelon: 'fireTeam', parentId: null, leaderId: null },
  ],
  soldiers: [
    {
      id: 'A',
      side: 'BLUEFOR',
      unitId: 'TM',
      position: { x: 0, y: -40 },
      azimuthDeg: 0,
      posture: 'standing',
    },
    {
      id: 'E',
      side: 'OPFOR',
      unitId: 'EN',
      position: { x: -150, y: 150 },
      azimuthDeg: 180,
      posture: 'standing',
    },
  ],
  opforRoutes: [
    {
      id: 'E-route',
      soldierId: 'E',
      waypoints: [{ id: 'E-route.1', x: -150, y: -150 }],
      finalFacingDeg: 180,
      shownToTrainee: true,
    },
  ],
};

function setup(): Exercise {
  return createExercise({ config: { tickRateHz: 10, seed: 0 }, scenario: SCENARIO });
}

function run(exercise: Exercise, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds * 10; i += 1) events.push(...exercise.advance(0.1));
  return events;
}

describe('waypoint placement', () => {
  it('refuses a waypoint inside a building, saying which, and leaves the plan unchanged', () => {
    const exercise = setup();
    expect(() => exercise.addWaypoint(A, { x: 5, y: 2 })).toThrow(ExerciseError);
    expect(() => exercise.addWaypoint(A, { x: 5, y: 2 })).toThrow(
      'Waypoint not placed: inside building B-1; soldiers cannot enter buildings.',
    );
    expect(exercise.draft(A)?.waypoints).toEqual([]);
  });

  it('refuses a waypoint against a building wall', () => {
    const exercise = setup();
    expect(() => exercise.addWaypoint(A, { x: 0, y: -10.4 })).toThrow(
      /against the wall of building B-1/,
    );
  });

  it('refuses a waypoint that cannot be reached', () => {
    const exercise = setup();
    expect(() => exercise.addWaypoint(A, { x: 100, y: 100 })).toThrow(/cannot be reached/);
  });

  it('refuses moving a waypoint into a building, keeping it where it was', () => {
    const exercise = setup();
    const id = exercise.addWaypoint(A, { x: 0, y: 40 });
    expect(() => {
      exercise.moveWaypoint(A, id, { x: 0, y: 0 });
    }).toThrow(/inside building B-1/);
    expect(exercise.draft(A)?.waypoints).toEqual([{ id, x: 0, y: 40 }]);
  });

  it('still allows tactically poor but possible plans', () => {
    const exercise = setup();
    // Hard against the far side of the barn, facing into its wall: allowed.
    exercise.addWaypoint(A, { x: 0, y: 11 });
    exercise.setFinalFacing(A, Math.PI);
    expect(exercise.draft(A)?.waypoints).toHaveLength(1);
    // A long detour is allowed too.
    exercise.addWaypoint(A, { x: -180, y: 180 });
    exercise.addWaypoint(A, { x: 0, y: 30 });
    expect(exercise.execute().ok).toBe(true);
  });
});

describe('routes around buildings', () => {
  it('shows the generated path around a building, separate from the trainee waypoints', () => {
    const exercise = setup();
    const id = exercise.addWaypoint(A, { x: 0, y: 40 });
    const route = exercise.displayedRoute(A);
    expect(route?.ok).toBe(true);
    expect(route?.legs).toHaveLength(1);
    expect(route?.legs[0]?.waypointId).toBe(id);
    expect(route?.legs[0]?.turns?.length).toBeGreaterThan(0);
    // The trainee's plan holds only the trainee's waypoint.
    expect(exercise.draft(A)?.waypoints).toEqual([{ id, x: 0, y: 40 }]);
  });

  it('walks exactly the path that was shown, never through the building', () => {
    const exercise = setup();
    exercise.addWaypoint(A, { x: 0, y: 40 });
    const shown = exercise.displayedRoute(A)?.legs[0]?.turns;
    exercise.execute();
    const positions: Vec2[] = [];
    for (let i = 0; i < 700; i += 1) {
      exercise.advance(0.1);
      const s = exercise.simulation.state.soldiers[0];
      if (s) positions.push({ x: s.position.x, y: s.position.y });
    }
    expect(exercise.simulation.state.soldiers[0]?.orders?.legPaths).toEqual([shown]);
    for (const p of positions) expect(pointInPolygon(p, BARN.footprint)).toBe(false);
    expect(positions.at(-1)).toEqual({ x: 0, y: 40 });
    expect(exercise.phase).toBe('bluforReady');
  });

  it('reports only trainee waypoints as reached, not generated turns', () => {
    const exercise = setup();
    const id = exercise.addWaypoint(A, { x: 0, y: 40 });
    exercise.execute();
    const reached = run(exercise, 70).filter((e) => e.type === 'waypointReached');
    expect(reached.map((e) => e.waypointId)).toEqual([id]);
  });

  it('plans identically every time', () => {
    const routes = Array.from({ length: 3 }, () => {
      const exercise = setup();
      exercise.addWaypoint(A, { x: 0, y: 40 });
      exercise.addWaypoint(A, { x: 150, y: 100 });
      return exercise.displayedRoute(A);
    });
    expect(routes[1]).toEqual(routes[0]);
    expect(routes[2]).toEqual(routes[0]);
  });

  it('keeps showing the path being walked after a pause', () => {
    const exercise = setup();
    exercise.addWaypoint(A, { x: 0, y: 40 });
    exercise.execute();
    run(exercise, 10);
    exercise.pause();
    const route = exercise.displayedRoute(A);
    const active = exercise.simulation.state.soldiers[0]?.orders;
    expect(route?.legs[0]?.turns).toEqual(active?.legPaths[0]?.slice(active.nextTurnIndex));
  });
});

describe('line of sight from planned positions', () => {
  it('looks from the planned final position, not where the soldier stands', () => {
    const exercise = setup();
    // From the start (0, −40) the barn blocks the view north; from (60, 0) it does not.
    const target = { x: 0, y: 60 };
    expect(exercise.observer(A)).toEqual({ point: { x: 0, y: -40 }, planned: false });
    expect(exercise.lineOfSightFrom(A, target)?.obstruction?.cause).toEqual({
      kind: 'building',
      featureId: 'B-1',
    });
    exercise.addWaypoint(A, { x: 60, y: 0 });
    expect(exercise.observer(A)).toEqual({ point: { x: 60, y: 0 }, planned: true });
    expect(exercise.lineOfSightFrom(A, target)?.clear).toBe(true);
    // Before anything has been executed: the soldier itself has not moved.
    expect(exercise.simulation.state.soldiers[0]?.position.y).toBe(-40);
  });

  it('assesses the kill zone deterministically from the planned position', () => {
    const exercise = setup();
    for (const v of [
      { x: -30, y: 40 },
      { x: 30, y: 40 },
      { x: 30, y: 70 },
      { x: -30, y: 70 },
    ]) {
      exercise.addKillZoneVertex(v);
    }
    const fromStart = exercise.killZoneVisibility(A);
    expect(fromStart?.samples).toHaveLength(9);
    expect(fromStart?.planned).toBe(false);
    exercise.addWaypoint(A, { x: 60, y: -10 });
    const fromPlan = exercise.killZoneVisibility(A);
    expect(fromPlan?.planned).toBe(true);
    expect(fromPlan?.observer).toEqual({ x: 60, y: -10 });
    expect(fromPlan?.clearCount).toBeGreaterThan(fromStart?.clearCount ?? 0);
    expect(exercise.killZoneVisibility(A)).toEqual(fromPlan);
  });

  it('needs a complete kill zone', () => {
    const exercise = setup();
    expect(exercise.killZoneVisibility(A)).toBeUndefined();
    exercise.addKillZoneVertex({ x: -30, y: 40 });
    exercise.addKillZoneVertex({ x: 30, y: 40 });
    expect(exercise.killZoneVisibility(A)).toBeUndefined();
  });

  it('is not offered for OPFOR', () => {
    expect(setup().lineOfSightFrom(soldierId('E'), { x: 0, y: 0 })).toBeUndefined();
  });
});

describe('killZoneSamplePoints', () => {
  it('samples corners, side midpoints and the centroid, in corner order', () => {
    const zone = {
      id: 'KZ' as never,
      vertices: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ],
    };
    expect(killZoneSamplePoints(zone)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 5 },
      { x: 20, y: 10 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 5 },
      { x: 10, y: 5 },
    ]);
  });

  it('leaves out the centroid when it falls outside a concave zone', () => {
    const vee = {
      id: 'KZ' as never,
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 30 },
        { x: 0, y: 4 },
        { x: -10, y: 30 },
      ],
    };
    expect(killZoneSamplePoints(vee)).toHaveLength(8);
  });
});
