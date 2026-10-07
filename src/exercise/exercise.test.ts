import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  flatElevation,
  hashSimState,
  soldierId,
  waypointId,
  type SimEvent,
  type Vec2,
} from '#sim';
import type { AmbushScenario } from './ambush-scenario';
import { createExercise, ExerciseError, type Exercise } from './exercise';

const TICK_RATE = 10;
const A = soldierId('A');
const B = soldierId('B');
const ENEMY = soldierId('E');
const ENEMY2 = soldierId('E2');

/**
 * Two BLUEFOR soldiers in the south and two OPFOR soldiers in the north on flat
 * 400 m × 400 m terrain; 2 m/s, 90°/s. The OPFOR routes run due south.
 */
function scenario(overrides: Partial<AmbushScenario> = {}): AmbushScenario {
  const soldier = (
    id: string,
    side: 'BLUEFOR' | 'OPFOR',
    x: number,
    y: number,
    azimuthDeg: number,
  ) => ({
    id,
    side,
    unitId: side === 'BLUEFOR' ? 'TM' : 'EN',
    position: { x, y },
    azimuthDeg,
    posture: 'standing' as const,
  });
  const route = (id: string, x: number) => ({
    id: `${id}-route`,
    soldierId: id,
    waypoints: [{ id: `${id}-route.1`, x, y: -150 }],
    finalFacingDeg: 180,
    shownToTrainee: true,
  });
  return {
    id: 'exercise-test',
    terrain: createSyntheticTerrain(
      { originX: -200, originY: -200, cellSize: 20, columns: 21, rows: 21 },
      flatElevation(0),
    ),
    movement: { speed: 2, maxTurnRate: Math.PI / 2 },
    units: [
      { id: 'TM', echelon: 'fireTeam', parentId: null, leaderId: 'A' },
      { id: 'EN', echelon: 'fireTeam', parentId: null, leaderId: null },
    ],
    soldiers: [
      soldier('A', 'BLUEFOR', 0, 0, 0),
      soldier('B', 'BLUEFOR', 10, 0, 90),
      soldier('E', 'OPFOR', 0, 150, 180),
      soldier('E2', 'OPFOR', 10, 160, 180),
    ],
    // E reaches the kill zone's north edge (y = 100) 25 s after starting; E2 after 30 s.
    opforRoutes: [route('E', 0), route('E2', 10)],
    ...overrides,
  };
}

/** Kill zone x ∈ [−20, 20], y ∈ [60, 100]. */
const KILL_ZONE: Vec2[] = [
  { x: -20, y: 60 },
  { x: 20, y: 60 },
  { x: 20, y: 100 },
  { x: -20, y: 100 },
];

function setup(overrides: Partial<AmbushScenario> = {}, tickRateHz = TICK_RATE): Exercise {
  return createExercise({ config: { tickRateHz, seed: 3 }, scenario: scenario(overrides) });
}

const soldier = (exercise: Exercise, id: string) => {
  const s = exercise.simulation.state.soldiers.find((x) => x.id === id);
  if (!s) throw new Error(`no soldier ${id}`);
  return s;
};

/**
 * Advances `seconds` of simulation time at 1×, one tick per call like successive
 * frames (one `advance` steps at most 100 ms of real time's worth of ticks).
 */
function run(exercise: Exercise, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  const rate = exercise.simulation.config.tickRateHz;
  for (let i = 0; i < Math.round(seconds * rate); i += 1)
    events.push(...exercise.advance(1 / rate));
  return events;
}

/** Gives A a three-leg route north: (0, 20), (0, 40), (0, 50), finally facing east. */
function planA(exercise: Exercise) {
  const ids = [20, 40, 50].map((y) => exercise.addWaypoint(A, { x: 0, y }));
  exercise.setFinalFacing(A, Math.PI / 2);
  return ids;
}

function drawKillZone(exercise: Exercise, vertices: Vec2[] = KILL_ZONE) {
  for (const v of vertices) exercise.addKillZoneVertex(v);
}

/** Planned, executed and in position, with a kill zone: ready for START OPFOR. */
function readyExercise(tickRateHz = TICK_RATE): Exercise {
  const exercise = setup({}, tickRateHz);
  planA(exercise);
  drawKillZone(exercise);
  exercise.execute();
  run(exercise, 40);
  expect(exercise.phase).toBe('bluforReady');
  return exercise;
}

describe('phases', () => {
  it('starts in BLUEFOR Planning with the simulation frozen', () => {
    const exercise = setup();
    expect(exercise.phase).toBe('bluforPlanning');
    expect(exercise.paused).toBe(false);
    expect(exercise.canEditPlans).toBe(true);
    expect(exercise.advance(10)).toEqual([]);
    expect(exercise.simulation.tick).toBe(0);
  });

  it('runs Planning → Occupation → Ready → Approach → Triggered', () => {
    const exercise = setup();
    planA(exercise);
    drawKillZone(exercise);
    expect(exercise.execute().ok).toBe(true);
    expect(exercise.phase).toBe('bluforOccupation');
    expect(exercise.canEditPlans).toBe(false);
    run(exercise, 40);
    expect(exercise.phase).toBe('bluforReady');
    expect(exercise.canEditPlans).toBe(true);
    expect(exercise.startOpfor().ok).toBe(true);
    expect(exercise.phase).toBe('opforApproach');
    expect(exercise.canEditPlans).toBe(false);
    run(exercise, 30);
    expect(exercise.phase).toBe('ambushTriggered');
    expect(exercise.timeline.map((e) => e.type)).toEqual([
      'planCommitted',
      'bluforInPosition',
      'opforStarted',
      'ambushTriggered',
    ]);
  });

  it('rejects transitions the current phase does not allow', () => {
    const exercise = setup();
    exercise.addWaypoint(A, { x: 0, y: 150 });
    expect(() => {
      exercise.pause();
    }).toThrow(ExerciseError);
    expect(() => exercise.resume()).toThrow(ExerciseError);
    exercise.execute();
    expect(() => exercise.execute()).toThrow(ExerciseError);
    expect(() => exercise.resume()).toThrow(ExerciseError);
    exercise.pause();
    expect(() => exercise.execute()).toThrow(ExerciseError);
    expect(() => {
      exercise.pause();
    }).toThrow(ExerciseError);
  });

  it('advances only while running, in whole ticks scaled by the time scale', () => {
    const exercise = setup();
    exercise.addWaypoint(A, { x: 0, y: 150 });
    exercise.execute();
    run(exercise, 1);
    expect(exercise.simulation.tick).toBe(10);
    exercise.advance(0.1, 4); // two frames of 0.4 s of simulation time each
    exercise.advance(0.1, 4);
    expect(exercise.simulation.tick).toBe(18);
    expect(exercise.droppedSeconds).toBe(0);
    exercise.advance(5, 4); // a 5 s stall: only 100 ms of real time at 4× (4 ticks) is simulated
    expect(exercise.simulation.tick).toBe(22);
    expect(exercise.droppedSeconds).toBeCloseTo((200 - 4) / TICK_RATE, 9);
    exercise.pause();
    const tick = exercise.simulation.tick;
    expect(exercise.advance(5, 4)).toEqual([]);
    expect(exercise.simulation.tick).toBe(tick);
    expect(exercise.simulation.timeSeconds).toBe(tick / TICK_RATE);
  });

  it('pauses on a tick boundary and does not carry partial ticks into the resume', () => {
    const exercise = setup();
    exercise.addWaypoint(A, { x: 0, y: 150 });
    exercise.execute();
    exercise.advance(0.1);
    exercise.advance(0.15); // 2.5 ticks in all: 2 stepped, half a tick pending
    expect(exercise.simulation.tick).toBe(2);
    exercise.pause();
    exercise.resume();
    exercise.advance(0.06); // 0.6 of a tick: would step if the old half tick carried over
    expect(exercise.simulation.tick).toBe(2);
  });
});

describe('draft plans', () => {
  it('exist only for the trainee side, starting from each soldier’s current facing', () => {
    const exercise = setup();
    expect(exercise.isPlannable(A)).toBe(true);
    expect(exercise.isPlannable(ENEMY)).toBe(false);
    expect(exercise.draft(A)).toEqual({ soldierId: A, waypoints: [], finalFacing: 0 });
    expect(exercise.draft(B)).toEqual({ soldierId: B, waypoints: [], finalFacing: Math.PI / 2 });
    expect(exercise.draft(ENEMY)).toBeUndefined();
    expect(exercise.displayedPlan(ENEMY)).toBeUndefined();
  });

  it('cannot be edited for OPFOR', () => {
    const exercise = setup();
    expect(() => exercise.addWaypoint(ENEMY, { x: 0, y: 0 })).toThrow(ExerciseError);
    expect(() => {
      exercise.setFinalFacing(ENEMY, 1);
    }).toThrow(ExerciseError);
  });

  it('adds, inserts, moves and deletes waypoints and clears the route', () => {
    const exercise = setup();
    const [w1, w2, w3] = planA(exercise);
    const w4 = exercise.addWaypoint(A, { x: 5, y: 30 }, 2);
    const xs = () => exercise.draft(A)?.waypoints.map((w) => [w.id, w.x, w.y]);
    expect(xs()).toEqual([
      [w1, 0, 20],
      [w2, 0, 40],
      [w4, 5, 30],
      [w3, 0, 50],
    ]);
    if (!w2 || !w3) throw new Error('missing ids');
    exercise.moveWaypoint(A, w2, { x: -10, y: 45 });
    exercise.deleteWaypoint(A, w3);
    expect(xs()).toEqual([
      [w1, 0, 20],
      [w2, -10, 45],
      [w4, 5, 30],
    ]);
    exercise.clearRoute(A);
    expect(exercise.draft(A)?.waypoints).toEqual([]);
    expect(exercise.draft(A)?.finalFacing).toBe(Math.PI / 2);
  });

  it('rejects points off the map, bad indices and unknown waypoints', () => {
    const exercise = setup();
    expect(() => exercise.addWaypoint(A, { x: 0, y: 200.5 })).toThrow(ExerciseError);
    expect(() => exercise.addWaypoint(A, { x: 0, y: 0 }, 1)).toThrow(ExerciseError);
    expect(() => {
      exercise.moveWaypoint(A, waypointId('nope'), { x: 0, y: 0 });
    }).toThrow(ExerciseError);
    expect(() => {
      exercise.deleteWaypoint(A, waypointId('nope'));
    }).toThrow(ExerciseError);
  });

  it('normalizes the final facing to an azimuth', () => {
    const exercise = setup();
    exercise.setFinalFacing(A, -Math.PI / 2);
    expect(exercise.draft(A)?.finalFacing).toBeCloseTo((3 * Math.PI) / 2, 12);
    exercise.setFinalFacing(A, 2 * Math.PI);
    expect(exercise.draft(A)?.finalFacing).toBe(0);
  });

  it('are read-only while BLUEFOR is moving', () => {
    const exercise = setup();
    const [w1] = planA(exercise);
    exercise.execute();
    expect(exercise.draft(A)).toBeUndefined();
    expect(() => exercise.addWaypoint(A, { x: 1, y: 1 })).toThrow(ExerciseError);
    expect(() => {
      if (w1) exercise.moveWaypoint(A, w1, { x: 1, y: 1 });
    }).toThrow(ExerciseError);
    expect(() => {
      exercise.clearRoute(A);
    }).toThrow(ExerciseError);
    expect(() => {
      exercise.setFinalFacing(A, 1);
    }).toThrow(ExerciseError);
  });
});

describe('stable waypoint ids', () => {
  it('are generated per soldier, never reused, and kept when a waypoint moves', () => {
    const exercise = setup();
    const a1 = exercise.addWaypoint(A, { x: 0, y: 10 });
    const b1 = exercise.addWaypoint(B, { x: 10, y: 10 });
    const a2 = exercise.addWaypoint(A, { x: 0, y: 20 });
    expect([a1, b1, a2]).toEqual(['A.1', 'B.1', 'A.2']);
    exercise.deleteWaypoint(A, a2);
    expect(exercise.addWaypoint(A, { x: 0, y: 30 })).toBe('A.3');
    exercise.moveWaypoint(A, a1, { x: 3, y: 12 });
    expect(exercise.draft(A)?.waypoints[0]).toEqual({ id: 'A.1', x: 3, y: 12 });
  });

  it('carry through pause and resume into the next revision', () => {
    const exercise = setup();
    const ids = planA(exercise);
    exercise.execute();
    run(exercise, 15); // past (0, 20), on the way to (0, 40)
    exercise.pause();
    const added = exercise.addWaypoint(A, { x: 20, y: 30 });
    exercise.resume();
    const [, second] = exercise.revisions;
    expect(second?.plans.find((p) => p.soldierId === A)?.waypoints.map((w) => w.id)).toEqual([
      ids[1],
      ids[2],
      added,
    ]);
    expect(added).toBe('A.4');
  });
});

describe('committing plans', () => {
  it('Execute records revision 1 and orders only the soldiers whose plans changed', () => {
    const exercise = setup();
    planA(exercise);
    const result = exercise.execute();
    if (!result.ok || !result.revision) throw new Error('commit failed');
    expect(result.revision).toMatchObject({
      revision: 1,
      trigger: 'execute',
      tick: 0,
      timeSeconds: 0,
      changedSoldierIds: [A],
      killZone: null,
    });
    expect(result.revision.plans.map((p) => p.soldierId)).toEqual([A, B]);
    expect(exercise.revisions).toEqual([result.revision]);

    const events = exercise.advance(0.1);
    expect(events.filter((e) => e.type === 'ordersChanged')).toEqual([
      {
        type: 'ordersChanged',
        tick: 0,
        soldierId: A,
        orders: { waypoints: exercise.revisions[0]?.plans[0]?.waypoints, finalFacing: Math.PI / 2 },
      },
    ]);
    expect(soldier(exercise, 'B').orders).toBeNull();
  });

  it('orders a facing-only change as a turn in place', () => {
    const exercise = setup();
    exercise.setFinalFacing(B, Math.PI);
    exercise.execute();
    run(exercise, 2);
    expect(soldier(exercise, 'B').azimuth).toBe(Math.PI);
    expect(soldier(exercise, 'B').orders?.behavior).toBe('inPosition');
  });

  it('keeps committed revisions immutable, including the kill zone as drawn', () => {
    const exercise = setup();
    planA(exercise);
    drawKillZone(exercise, KILL_ZONE.slice(0, 2));
    exercise.execute();
    const [revision] = exercise.revisions;
    expect(revision?.killZone?.vertices).toEqual(KILL_ZONE.slice(0, 2));
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision?.plans[0]?.waypoints[0])).toBe(true);
    exercise.pause();
    exercise.clearRoute(A);
    exercise.clearKillZone();
    expect(revision?.plans[0]?.waypoints).toHaveLength(3);
    expect(revision?.killZone?.vertices).toHaveLength(2);
  });

  it('never exposes a partially edited draft to the simulation', () => {
    const exercise = setup();
    exercise.addWaypoint(B, { x: 10, y: 100 });
    exercise.execute();
    run(exercise, 1);
    exercise.pause();
    exercise.addWaypoint(A, { x: 0, y: 50 });
    exercise.addWaypoint(A, { x: 50, y: 50 });
    // Edits while paused reach the simulation only at Resume.
    expect(soldier(exercise, 'A').orders).toBeNull();
    exercise.resume();
    run(exercise, 0.1);
    expect(soldier(exercise, 'A').orders?.orders.waypoints).toHaveLength(2);
  });
});

describe('pause, replan, resume during occupation', () => {
  it('offers the remaining route from the soldier’s position when paused partway', () => {
    const exercise = setup();
    const [w1, w2, w3] = planA(exercise);
    exercise.execute();
    run(exercise, 15); // 30 m along: past w1 (20 m), heading for w2 (40 m)
    exercise.pause();
    expect(exercise.paused).toBe(true);
    expect(exercise.phase).toBe('bluforOccupation');
    expect(soldier(exercise, 'A').position.y).toBeCloseTo(30, 9);
    expect(exercise.draft(A)).toEqual({
      soldierId: A,
      waypoints: [
        { id: w2, x: 0, y: 40 },
        { id: w3, x: 0, y: 50 },
      ],
      finalFacing: Math.PI / 2,
    });
    expect(w1).toBe('A.1');
  });

  it('does not re-order soldiers whose remaining plans are unchanged, and does not perturb them', () => {
    const reference = setup();
    planA(reference);
    reference.execute();
    run(reference, 40);

    const exercise = setup();
    planA(exercise);
    exercise.execute();
    run(exercise, 15);
    exercise.pause();
    const result = exercise.resume();
    if (!result.ok) throw new Error('commit failed');
    expect(result.revision).toMatchObject({
      revision: 2,
      trigger: 'resume',
      tick: 150,
      changedSoldierIds: [],
    });
    const events = run(exercise, 25);
    expect(events.some((e) => e.type === 'ordersChanged')).toBe(false);
    expect(hashSimState(exercise.simulation.state)).toBe(hashSimState(reference.simulation.state));
  });

  it('re-orders a soldier whose remaining plan changed, from where the soldier is', () => {
    const exercise = setup();
    const [, w2] = planA(exercise);
    exercise.execute();
    run(exercise, 15); // at (0, 30)
    exercise.pause();
    if (!w2) throw new Error('missing id');
    exercise.moveWaypoint(A, w2, { x: 30, y: 30 }); // turn east instead
    exercise.setFinalFacing(B, Math.PI); // B also changes
    const result = exercise.resume();
    if (!result.ok || !result.revision) throw new Error('commit failed');
    expect(result.revision.changedSoldierIds).toEqual([A, B]);

    const events = run(exercise, 20); // 30 m east to the moved waypoint (15 s), then toward (0, 50)
    expect(
      events.filter((e) => e.type === 'ordersChanged').map((e) => [e.tick, e.soldierId]),
    ).toEqual([
      [150, A],
      [150, B],
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'waypointReached',
        soldierId: A,
        waypointId: w2,
        atSeconds: expect.closeTo(30, 6) as number,
      }),
    );
    const a = soldier(exercise, 'A');
    expect(a.orders?.nextWaypointIndex).toBe(1);
    // 5 s × 2 m/s = 10 m along the leg toward (0, 50).
    const leg = Math.hypot(30, 20);
    expect(a.position.x).toBeCloseTo(30 - (10 * 30) / leg, 9);
    expect(a.position.y).toBeCloseTo(30 + (10 * 20) / leg, 9);
  });

  it('shows committed plans immediately, before the first tick applies them', () => {
    const exercise = setup();
    const ids = planA(exercise);
    exercise.execute();
    expect(exercise.displayedPlan(A)?.waypoints.map((w) => w.id)).toEqual(ids);
    // Pausing again before any tick keeps the committed plan, not the old orders.
    exercise.pause();
    expect(exercise.draft(A)?.waypoints.map((w) => w.id)).toEqual(ids);
    const result = exercise.resume();
    expect(result.ok && result.revision?.changedSoldierIds).toEqual([]);
    run(exercise, 30);
    expect(soldier(exercise, 'A').position.y).toBeCloseTo(50, 9);
  });

  it('shows the remaining active orders while moving', () => {
    const exercise = setup();
    const [, w2, w3] = planA(exercise);
    exercise.execute();
    run(exercise, 15);
    expect(exercise.displayedPlan(A)?.waypoints.map((w) => w.id)).toEqual([w2, w3]);
    expect(exercise.displayedPlan(B)).toEqual({
      soldierId: B,
      waypoints: [],
      finalFacing: Math.PI / 2,
    });
  });
});

describe('BLUEFOR readiness', () => {
  it('is reached when every BLUEFOR soldier has completed its orders, not before', () => {
    const exercise = setup();
    planA(exercise); // 50 m = 25 s, then a 90° turn = 1 s
    exercise.setFinalFacing(B, Math.PI); // B only turns: 1 s
    exercise.execute();
    expect(exercise.bluforMovementComplete).toBe(false); // orders not yet applied
    run(exercise, 25.5);
    expect(soldier(exercise, 'B').orders?.behavior).toBe('inPosition');
    expect(soldier(exercise, 'A').orders?.behavior).toBe('facing');
    expect(exercise.bluforMovementComplete).toBe(false);
    expect(exercise.phase).toBe('bluforOccupation');
    run(exercise, 1);
    expect(exercise.phase).toBe('bluforReady');
    expect(exercise.bluforMovementComplete).toBe(true);
    // A completes its turn at exactly 26 s, the end of tick 259.
    expect(exercise.timeline.at(-1)).toEqual({
      type: 'bluforInPosition',
      tick: 260,
      timeSeconds: 26,
    });
  });

  it('counts soldiers without orders as in position', () => {
    const exercise = setup();
    exercise.execute(); // nobody was given a plan
    run(exercise, 0.1);
    expect(exercise.phase).toBe('bluforReady');
  });

  it('does not start OPFOR or advance the simulation by itself', () => {
    const exercise = readyExercise();
    const tick = exercise.simulation.tick;
    run(exercise, 60);
    expect(exercise.phase).toBe('bluforReady');
    expect(exercise.simulation.tick).toBe(tick);
    expect(soldier(exercise, 'E').orders).toBeNull();
    expect(exercise.opforStart).toBeNull();
  });

  it('allows re-planning from Ready, returning to occupation on Resume', () => {
    const exercise = readyExercise();
    exercise.addWaypoint(A, { x: 0, y: 30 });
    expect(exercise.hasUncommittedChanges).toBe(true);
    const result = exercise.resume();
    expect(result.ok).toBe(true);
    expect(exercise.phase).toBe('bluforOccupation');
    run(exercise, 20);
    expect(exercise.phase).toBe('bluforReady');
    expect(soldier(exercise, 'A').position.y).toBeCloseTo(30, 9);
  });
});

describe('OPFOR before the approach', () => {
  it('stays where the scenario put it through planning, occupation and ready', () => {
    const exercise = setup();
    const start = { ...soldier(exercise, 'E').position };
    planA(exercise);
    drawKillZone(exercise);
    exercise.execute();
    run(exercise, 10);
    expect(soldier(exercise, 'E').position).toEqual(start);
    run(exercise, 30);
    expect(exercise.phase).toBe('bluforReady');
    expect(soldier(exercise, 'E').position).toEqual(start);
    expect(soldier(exercise, 'E').orders).toBeNull();
  });
});

describe('START OPFOR validation', () => {
  it('requires BLUEFOR to have executed its plan and reached its positions', () => {
    const exercise = setup();
    drawKillZone(exercise);
    expect(exercise.startOpforProblems()).toEqual([
      'BLUEFOR has not occupied its positions: Execute the plan first.',
    ]);
    planA(exercise);
    exercise.execute();
    run(exercise, 1);
    expect(exercise.startOpforProblems()).toEqual([
      'BLUEFOR is still moving into position (1 soldier).',
    ]);
    exercise.pause();
    expect(exercise.startOpforProblems()).toEqual([
      'Occupation is paused: Resume until BLUEFOR is in position.',
    ]);
    const result = exercise.startOpfor();
    expect(result.ok).toBe(false);
    expect(exercise.phase).toBe('bluforOccupation');
  });

  it('requires a valid kill zone', () => {
    const exercise = setup();
    exercise.execute();
    run(exercise, 0.1);
    expect(exercise.phase).toBe('bluforReady');
    expect(exercise.startOpforProblems()).toEqual(['No kill zone: draw one on the map.']);
    drawKillZone(exercise, KILL_ZONE.slice(0, 2));
    expect(exercise.startOpforProblems()).toEqual([
      'The kill zone needs at least 3 corners (it has 2).',
    ]);
    exercise.clearKillZone();
    drawKillZone(exercise, [
      { x: 0, y: 60 },
      { x: 4, y: 60 },
      { x: 0, y: 64 },
    ]);
    expect(exercise.startOpforProblems()).toEqual(['The kill zone is smaller than 25 m².']);
    expect(exercise.startOpfor().ok).toBe(false);
    expect(exercise.phase).toBe('bluforReady');
  });

  it('refuses a kill zone that already contains OPFOR', () => {
    const exercise = setup();
    drawKillZone(exercise, [
      { x: -20, y: 140 },
      { x: 20, y: 140 },
      { x: 20, y: 155 },
      { x: -20, y: 155 },
    ]);
    exercise.execute();
    run(exercise, 0.1);
    expect(exercise.startOpforProblems()).toEqual([
      'OPFOR already inside the kill zone: E. It must be entered, not start inside.',
    ]);
  });

  it('refuses route changes that have not been executed', () => {
    const exercise = readyExercise();
    exercise.addWaypoint(B, { x: 10, y: 10 });
    expect(exercise.startOpforProblems()).toEqual([
      'Route changes have not been executed: press Resume to execute them.',
    ]);
  });

  it('requires the scenario to define OPFOR routes', () => {
    const exercise = setup({ opforRoutes: [] });
    drawKillZone(exercise);
    exercise.execute();
    run(exercise, 0.1);
    expect(exercise.startOpforProblems()).toEqual(['The scenario defines no OPFOR route.']);
  });
});

describe('OPFOR approach', () => {
  it('records the trainee’s declaration and sends OPFOR along the scenario routes', () => {
    const exercise = readyExercise();
    const tick = exercise.simulation.tick;
    const result = exercise.startOpfor();
    if (!result.ok) throw new Error(result.problems.join('; '));
    expect(result.start).toEqual({
      tick,
      timeSeconds: tick / TICK_RATE,
      killZone: { id: 'KZ-1', vertices: KILL_ZONE },
      planRevision: 1,
      routeIds: ['E-route', 'E2-route'],
    });
    expect(exercise.opforStart).toBe(result.start);
    run(exercise, 5);
    expect(soldier(exercise, 'E').orders?.orders).toEqual({
      waypoints: [{ id: 'E-route.1', x: 0, y: -150 }],
      finalFacing: Math.PI,
    });
    expect(soldier(exercise, 'E').position.y).toBeCloseTo(140, 9);
    expect(soldier(exercise, 'E2').position.y).toBeCloseTo(150, 9);
    expect(exercise.simulation.state.engagementAreas).toEqual([
      { id: 'KZ-1', vertices: KILL_ZONE, monitoredSide: 'OPFOR' },
    ]);
  });

  it('keeps BLUEFOR where it is and its plans read-only', () => {
    const exercise = readyExercise();
    const bluforPoses = () =>
      exercise.simulation.state.soldiers
        .filter((s) => s.side === 'BLUEFOR')
        .map((s) => ({ ...s.position, azimuth: s.azimuth }));
    const before = bluforPoses();
    exercise.startOpfor();
    run(exercise, 20);
    expect(bluforPoses()).toEqual(before);
    expect(exercise.canEditPlans).toBe(false);
    expect(() => exercise.addWaypoint(A, { x: 0, y: 0 })).toThrow(ExerciseError);
    expect(() => {
      exercise.addKillZoneVertex({ x: 50, y: 50 });
    }).toThrow(ExerciseError);
    expect(exercise.startOpfor().ok).toBe(false);
  });

  it('can be paused and resumed without re-planning', () => {
    const exercise = readyExercise();
    exercise.startOpfor();
    run(exercise, 5);
    exercise.pause();
    expect(exercise.paused).toBe(true);
    expect(exercise.canEditPlans).toBe(false);
    const tick = exercise.simulation.tick;
    run(exercise, 5);
    expect(exercise.simulation.tick).toBe(tick);
    expect(exercise.resume()).toEqual({ ok: true, revision: null });
    expect(exercise.revisions).toHaveLength(1);
    run(exercise, 5);
    expect(exercise.simulation.tick).toBe(tick + 50);
  });
});

describe('ambush trigger', () => {
  it('fires when the first OPFOR soldier enters the kill zone, recording who, when and where', () => {
    const exercise = readyExercise();
    const start = exercise.startOpfor();
    if (!start.ok) throw new Error('start failed');
    run(exercise, 40);
    expect(exercise.phase).toBe('ambushTriggered');
    // E walks 50 m from y = 150 to the north edge at y = 100: 25 s.
    // The entry falls on a tick boundary, so it may be reported by the tick ending or
    // the tick starting there; its exact time is what matters.
    expect(exercise.trigger).toEqual({
      tick: expect.any(Number) as number,
      atSeconds: expect.closeTo(start.start.timeSeconds + 25, 9) as number,
      soldierId: ENEMY,
      killZoneId: 'KZ-1',
      point: { x: 0, y: expect.closeTo(100, 9) as number },
    });
    expect(exercise.timeline.filter((e) => e.type === 'ambushTriggered')).toHaveLength(1);
    const tick = exercise.trigger?.tick ?? Number.NaN;
    expect([start.start.tick + 249, start.start.tick + 250]).toContain(tick);
  });

  it('stops the simulation at the end of the trigger tick', () => {
    const exercise = readyExercise();
    exercise.startOpfor();
    run(exercise, 40);
    const tick = exercise.simulation.tick;
    expect(tick).toBe((exercise.trigger?.tick ?? Number.NaN) + 1);
    expect(run(exercise, 30)).toEqual([]);
    expect(exercise.simulation.tick).toBe(tick);
    expect(() => {
      exercise.pause();
    }).toThrow(ExerciseError);
    expect(() => exercise.resume()).toThrow(ExerciseError);
    expect(soldier(exercise, 'E2').position.y).toBeGreaterThan(100); // E2 never reached the zone
  });

  it('is sprung by whichever soldier enters first, not by soldier order', () => {
    // E2 now starts closer to the zone than E.
    const base = scenario();
    const exercise = setup({
      soldiers: base.soldiers.map((s) =>
        s.id === 'E2' ? { ...s, position: { x: 10, y: 120 } } : s,
      ),
    });
    planA(exercise);
    drawKillZone(exercise);
    exercise.execute();
    run(exercise, 40);
    exercise.startOpfor();
    run(exercise, 40);
    expect(exercise.trigger?.soldierId).toBe(ENEMY2);
  });

  it.each([10, 20, 30, 60, 120])('happens at the same simulation time at %i Hz', (rate) => {
    const exercise = readyExercise(rate);
    const start = exercise.startOpfor();
    if (!start.ok) throw new Error('start failed');
    run(exercise, 40);
    const trigger = exercise.trigger;
    if (!trigger) throw new Error('no trigger');
    // OPFOR starts at a tick boundary that depends on when readiness was detected,
    // so compare the time from START OPFOR to the trigger.
    expect(Math.abs(trigger.atSeconds - start.start.timeSeconds - 25)).toBeLessThanOrEqual(1e-6);
    expect(trigger.soldierId).toBe(ENEMY);
    expect(Math.abs(trigger.point.y - 100)).toBeLessThanOrEqual(1e-6);
    expect(trigger.atSeconds).toBeGreaterThanOrEqual(trigger.tick / rate - 1e-9);
    expect(trigger.atSeconds).toBeLessThanOrEqual((trigger.tick + 1) / rate + 1e-9);
  });

  it('is deterministic', () => {
    const runOnce = () => {
      const exercise = readyExercise(30);
      exercise.startOpfor();
      run(exercise, 40);
      return { trigger: exercise.trigger, hash: hashSimState(exercise.simulation.state) };
    };
    expect(runOnce()).toEqual(runOnce());
  });
});

describe('kill zone editing', () => {
  it('creates a zone with a stable id and edits its corners', () => {
    const exercise = setup();
    expect(exercise.killZone).toBeNull();
    drawKillZone(exercise);
    expect(exercise.killZone).toEqual({ id: 'KZ-1', vertices: KILL_ZONE });
    exercise.addKillZoneVertex({ x: 0, y: 110 }, 3); // into the north side
    exercise.moveKillZoneVertex(0, { x: -25, y: 55 });
    exercise.deleteKillZoneVertex(1);
    expect(exercise.killZone).toEqual({
      id: 'KZ-1',
      vertices: [
        { x: -25, y: 55 },
        { x: 20, y: 100 },
        { x: 0, y: 110 },
        { x: -20, y: 100 },
      ],
    });
  });

  it('gives a new id after the zone is cleared and drawn again', () => {
    const exercise = setup();
    drawKillZone(exercise);
    exercise.clearKillZone();
    expect(exercise.killZone).toBeNull();
    drawKillZone(exercise);
    expect(exercise.killZone?.id).toBe('KZ-2');
  });

  it('refuses edits that would make the zone cross itself, crowd a corner or leave the map', () => {
    const exercise = setup();
    drawKillZone(exercise);
    const before = exercise.killZone;
    expect(() => {
      exercise.moveKillZoneVertex(0, { x: 30, y: 80 }); // its edge to (−20, 100) would cross x = 20
    }).toThrow(/cross itself/);
    expect(() => {
      exercise.addKillZoneVertex({ x: 20.5, y: 100 });
    }).toThrow(/1 m apart/);
    expect(() => {
      exercise.addKillZoneVertex({ x: 0, y: 250 });
    }).toThrow(/on the map/);
    expect(exercise.killZone).toEqual(before);
  });

  it('refuses a deletion that would make the zone cross itself', () => {
    const exercise = setup();
    // A U shape with a notch from the north between x = 10 and x = 30.
    drawKillZone(exercise, [
      { x: 0, y: 60 },
      { x: 40, y: 60 },
      { x: 40, y: 100 },
      { x: 30, y: 100 },
      { x: 30, y: 70 },
      { x: 10, y: 70 },
      { x: 10, y: 100 },
      { x: 0, y: 100 },
    ]);
    // Deleting the corner (0, 60) would join (0, 100) to (40, 60) across the notch.
    expect(() => {
      exercise.deleteKillZoneVertex(0);
    }).toThrow(ExerciseError);
    expect(exercise.killZone?.vertices).toHaveLength(8);
  });

  it('is editable in Planning, when occupation is paused and in Ready, and read-only otherwise', () => {
    const exercise = setup();
    exercise.addKillZoneVertex({ x: -20, y: 60 });
    planA(exercise);
    exercise.execute();
    expect(() => {
      exercise.addKillZoneVertex({ x: 20, y: 60 });
    }).toThrow(ExerciseError);
    exercise.pause();
    exercise.addKillZoneVertex({ x: 20, y: 60 });
    exercise.resume();
    run(exercise, 40);
    expect(exercise.phase).toBe('bluforReady');
    exercise.addKillZoneVertex({ x: 0, y: 100 });
    expect(exercise.killZone?.vertices).toHaveLength(3);
  });
});

describe('scenario OPFOR routes', () => {
  it('are exposed read-only and unchanged', () => {
    const exercise = setup();
    expect(exercise.opforRoutes).toEqual(scenario().opforRoutes);
    expect(Object.isFrozen(exercise.opforRoutes)).toBe(true);
    expect(Object.isFrozen(exercise.opforRoutes[0]?.waypoints[0])).toBe(true);
  });

  it.each([
    ['for an unknown soldier', { soldierId: 'X' }, /unknown soldier/],
    ['for a trainee soldier', { soldierId: 'A' }, /trainee soldier/],
    ['with a waypoint off the map', { waypoints: [{ id: 'w', x: 0, y: 999 }] }, /off the terrain/],
    ['with no waypoints', { waypoints: [] }, /no waypoints/],
  ])('are rejected %s', (_label, change, message) => {
    const [first, ...rest] = scenario().opforRoutes;
    if (!first) throw new Error('no route');
    expect(() => setup({ opforRoutes: [{ ...first, ...change }, ...rest] })).toThrow(message);
  });
});
