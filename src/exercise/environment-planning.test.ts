import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  flatElevation,
  pointInPolygon,
  rectangle,
  computeViewshed,
  soldierId,
  viewshedGrid,
  type SimEvent,
  type Vec2,
} from '#sim';
import type { AmbushScenario } from './ambush-scenario';
import { createExercise, ExerciseError, type Exercise } from './exercise';
import { TEST_PAIR_TEMPLATE } from './test-organization';

// Planning against the environment (docs/adr/0011, docs/adr/0012): paths
// around buildings, refused destinations, and line of sight from destinations.

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
  orp: {
    id: 'ORP-E',
    name: 'ORP',
    centre: { east: 0, north: -40 },
    shape: { kind: 'circle', radiusM: 5 },
  },
  organization: {
    // One soldier: the test pair's leader slot only.
    template: {
      ...TEST_PAIR_TEMPLATE,
      roles: TEST_PAIR_TEMPLATE.roles.slice(0, 1),
      slots: TEST_PAIR_TEMPLATE.slots.slice(0, 1),
    },
    unitIdPrefix: '',
    members: [{ soldierId: 'A', slotId: 'lead' }],
  },
};

function setup(): Exercise {
  return createExercise({ config: { tickRateHz: 10, seed: 0 }, scenario: SCENARIO });
}

function run(exercise: Exercise, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds * 10; i += 1) events.push(...exercise.advance(0.1));
  return events;
}

describe('destination placement', () => {
  const destinationOf = (exercise: Exercise) => exercise.draft(A)?.destination;

  it('refuses a destination inside a building, saying which, and leaves the plan unchanged', () => {
    const exercise = setup();
    expect(() => {
      exercise.setDestination(A, { x: 5, y: 2 });
    }).toThrow(ExerciseError);
    expect(() => {
      exercise.setDestination(A, { x: 5, y: 2 });
    }).toThrow('Destination not set: inside building B-1; soldiers cannot enter buildings.');
    expect(destinationOf(exercise)).toBeNull();
  });

  it('refuses a destination against a building wall', () => {
    const exercise = setup();
    expect(() => {
      exercise.setDestination(A, { x: 0, y: -10.4 });
    }).toThrow(/against the wall of building B-1/);
  });

  it('refuses a destination that cannot be reached', () => {
    const exercise = setup();
    expect(() => {
      exercise.setDestination(A, { x: 100, y: 100 });
    }).toThrow(
      /cannot be reached from the soldier’s position|cannot be reached from the soldier's position/,
    );
  });

  it('refuses moving the destination into a building, keeping it where it was', () => {
    const exercise = setup();
    exercise.setDestination(A, { x: 0, y: 40 });
    expect(() => {
      exercise.setDestination(A, { x: 0, y: 0 });
    }).toThrow(/inside building B-1/);
    expect(destinationOf(exercise)).toEqual({ east: 0, north: 40 });
  });

  it('still allows tactically poor but possible plans', () => {
    const exercise = setup();
    // Hard against the far side of the barn, facing into its wall: allowed.
    exercise.setDestination(A, { x: 0, y: 11 });
    exercise.setFacing(A, Math.PI);
    expect(destinationOf(exercise)).toEqual({ east: 0, north: 11 });
    // A long detour is allowed too.
    exercise.setDestination(A, { x: -180, y: 180 });
    expect(exercise.execute().ok).toBe(true);
  });
});

describe('routes around buildings', () => {
  it('shows the generated path around a building, separate from the trainee’s destination', () => {
    const exercise = setup();
    exercise.setDestination(A, { x: 0, y: 40 });
    const route = exercise.displayedRoute(A);
    expect(route?.ok).toBe(true);
    expect(route?.legs).toHaveLength(1);
    expect(route?.legs[0]?.to).toEqual({ x: 0, y: 40 });
    expect(route?.legs[0]?.turns?.length).toBeGreaterThan(0);
    // The trainee's plan holds only the destination and facing, never the turns.
    expect(exercise.draft(A)).toEqual({
      soldierId: A,
      destination: { east: 0, north: 40 },
      facingDegrees: null,
    });
  });

  it('walks exactly the path that was shown, never through the building', () => {
    const exercise = setup();
    exercise.setDestination(A, { x: 0, y: 40 });
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

  it('reports only the destination as reached, not generated turns', () => {
    const exercise = setup();
    exercise.setDestination(A, { x: 0, y: 40 });
    exercise.execute();
    const reached = run(exercise, 70).filter((e) => e.type === 'waypointReached');
    expect(reached.map((e) => e.waypointId)).toEqual(['A.dest.1']);
  });

  it('plans identically every time', () => {
    const routes = Array.from({ length: 3 }, () => {
      const exercise = setup();
      exercise.setDestination(A, { x: 150, y: 100 });
      return exercise.displayedRoute(A);
    });
    expect(routes[1]).toEqual(routes[0]);
    expect(routes[2]).toEqual(routes[0]);
  });

  it('keeps showing the path being walked after a pause', () => {
    const exercise = setup();
    exercise.setDestination(A, { x: 0, y: 40 });
    exercise.execute();
    run(exercise, 10);
    exercise.pause();
    const route = exercise.displayedRoute(A);
    const active = exercise.simulation.state.soldiers[0]?.orders;
    expect(route?.legs[0]?.turns).toEqual(active?.legPaths[0]?.slice(active.nextTurnIndex));
  });
});

describe('line of sight from planned positions', () => {
  it('looks from the destination, not where the soldier stands', () => {
    const exercise = setup();
    // From the start (0, −40) the barn blocks the view north; from (60, 0) it does not.
    const target = { x: 0, y: 60 };
    expect(exercise.observer(A)).toEqual({ point: { x: 0, y: -40 }, planned: false });
    expect(exercise.lineOfSightFrom(A, target)?.obstruction?.cause).toEqual({
      kind: 'building',
      featureId: 'B-1',
    });
    exercise.setDestination(A, { x: 60, y: 0 });
    expect(exercise.observer(A)).toEqual({ point: { x: 60, y: 0 }, planned: true });
    expect(exercise.lineOfSightFrom(A, target)?.clear).toBe(true);
    // Before anything has been executed: the soldier itself has not moved.
    expect(exercise.simulation.state.soldiers[0]?.position.y).toBe(-40);
  });

  it('needs a complete kill zone for kill-zone coverage', () => {
    const exercise = setup();
    const terrain = exercise.simulation.world.terrain;
    const viewshed = computeViewshed(terrain, { x: 0, y: -40 }, viewshedGrid(terrain, 4));
    expect(exercise.killZoneCoverage(viewshed)).toBeUndefined();
    exercise.addKillZoneVertex({ x: -30, y: 40 });
    exercise.addKillZoneVertex({ x: 30, y: 40 });
    expect(exercise.killZoneCoverage(viewshed)).toBeUndefined();
  });

  it('is not offered for OPFOR', () => {
    expect(setup().lineOfSightFrom(soldierId('E'), { x: 0, y: 0 })).toBeUndefined();
  });
});

describe('visibility from planned positions', () => {
  /** The viewshed from where the soldier would observe, as the planning display computes it. */
  const viewshedOf = (exercise: Exercise, id = A) => {
    const observer = exercise.observer(id);
    if (!observer) throw new Error('no observer');
    const terrain = exercise.simulation.world.terrain;
    return computeViewshed(terrain, observer.point, viewshedGrid(terrain, 4));
  };
  const zone = (exercise: Exercise, corners: Vec2[]) => {
    for (const c of corners) exercise.addKillZoneVertex(c);
  };
  // North of the barn: hidden from A's start, open from east of the barn.
  const NORTH = [
    { x: -15, y: 30 },
    { x: 15, y: 30 },
    { x: 15, y: 60 },
    { x: -15, y: 60 },
  ];

  it('is computed from the destination, not where the soldier stands', () => {
    const exercise = setup();
    zone(exercise, NORTH);
    const fromStart = exercise.killZoneCoverage(viewshedOf(exercise));
    expect(fromStart?.percent).toBe(0); // the barn hides it completely
    exercise.setDestination(A, { x: 60, y: -10 });
    expect(exercise.observer(A)).toEqual({ point: { x: 60, y: -10 }, planned: true });
    const fromPlan = exercise.killZoneCoverage(viewshedOf(exercise));
    expect(fromPlan?.percent).toBe(100);
    expect(fromPlan?.cells).toBe(fromStart?.cells);
    expect(exercise.simulation.state.soldiers[0]?.position.y).toBe(-40); // nobody moved
  });

  it('changes as the destination moves', () => {
    const exercise = setup();
    zone(exercise, NORTH);
    exercise.setDestination(A, { x: 60, y: -10 });
    const open = viewshedOf(exercise);
    exercise.setDestination(A, { x: 0, y: -15 }); // right behind the barn
    const hidden = viewshedOf(exercise);
    expect(hidden).not.toEqual(open);
    expect(exercise.killZoneCoverage(hidden)?.percent).toBe(0);
  });

  it('follows the selected soldier', () => {
    const exercise = setup();
    const opfor = soldierId('E');
    expect(exercise.observer(opfor)).toBeUndefined();
    const viewA = viewshedOf(exercise, A);
    exercise.setDestination(A, { x: 60, y: -10 });
    expect(viewshedOf(exercise, A)).not.toEqual(viewA);
  });

  it('gives a deterministic, partial kill-zone percentage', () => {
    const exercise = setup();
    // Straddling the barn's shadow as seen from the start.
    zone(exercise, [
      { x: -100, y: 30 },
      { x: 100, y: 30 },
      { x: 100, y: 60 },
      { x: -100, y: 60 },
    ]);
    const coverage = exercise.killZoneCoverage(viewshedOf(exercise));
    expect(coverage?.cells).toBe(400); // 50 × 8 cells of 4 m
    expect(coverage?.percent).toBeGreaterThan(0);
    expect(coverage?.percent).toBeLessThan(100);
    expect(coverage?.percent).toBe((100 * (coverage?.visibleCells ?? 0)) / 400);
    expect(exercise.killZoneCoverage(viewshedOf(exercise))).toEqual(coverage);
  });

  it('returns to the current position when the destination is cleared', () => {
    const exercise = setup();
    exercise.setDestination(A, { x: 60, y: -10 });
    exercise.clearDestination(A);
    expect(exercise.observer(A)).toEqual({ point: { x: 0, y: -40 }, planned: false });
  });
});
