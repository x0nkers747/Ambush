import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  flatElevation,
  hashSimState,
  soldierId,
  waypointId,
  type Scenario,
  type SimEvent,
} from '#sim';
import { createExercise, ExerciseError, type Exercise } from './exercise';

const TICK_RATE = 10;
const A = soldierId('A');
const B = soldierId('B');
const ENEMY = soldierId('E');

/** Two BLUEFOR soldiers and one OPFOR soldier on flat 400 m × 400 m terrain; 2 m/s, 90°/s. */
const SCENARIO: Scenario = {
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
    {
      id: 'A',
      side: 'BLUEFOR',
      unitId: 'TM',
      position: { x: 0, y: 0 },
      azimuthDeg: 0,
      posture: 'standing',
    },
    {
      id: 'B',
      side: 'BLUEFOR',
      unitId: 'TM',
      position: { x: 10, y: 0 },
      azimuthDeg: 90,
      posture: 'standing',
    },
    {
      id: 'E',
      side: 'OPFOR',
      unitId: 'EN',
      position: { x: 0, y: 150 },
      azimuthDeg: 180,
      posture: 'standing',
    },
  ],
};

function setup(): Exercise {
  return createExercise({ config: { tickRateHz: TICK_RATE, seed: 3 }, scenario: SCENARIO });
}

const soldier = (exercise: Exercise, id: string) => {
  const s = exercise.simulation.state.soldiers.find((x) => x.id === id);
  if (!s) throw new Error(`no soldier ${id}`);
  return s;
};

/**
 * Advances `seconds` of simulation time at 1×, one tick per call like successive
 * frames (a single `advance` is capped at 10 ticks to protect the frame rate).
 */
function run(exercise: Exercise, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * TICK_RATE); i += 1) {
    events.push(...exercise.advance(1 / TICK_RATE));
  }
  return events;
}

/** Gives A a three-leg route north: (0, 20), (0, 40), (0, 60), finally facing east. */
function planA(exercise: Exercise) {
  const ids = [20, 40, 60].map((y) => exercise.addWaypoint(A, { x: 0, y }));
  exercise.setFinalFacing(A, Math.PI / 2);
  return ids;
}

describe('phases', () => {
  it('starts in Planning with the simulation frozen', () => {
    const exercise = setup();
    expect(exercise.phase).toBe('planning');
    expect(exercise.canEditPlans).toBe(true);
    expect(exercise.advance(10)).toEqual([]);
    expect(exercise.simulation.tick).toBe(0);
  });

  it('goes Planning → Executing → Paused → Executing', () => {
    const exercise = setup();
    expect(exercise.execute().ok).toBe(true);
    expect(exercise.phase).toBe('executing');
    expect(exercise.canEditPlans).toBe(false);
    exercise.pause();
    expect(exercise.phase).toBe('paused');
    expect(exercise.canEditPlans).toBe(true);
    expect(exercise.resume().ok).toBe(true);
    expect(exercise.phase).toBe('executing');
  });

  it('rejects transitions the current phase does not allow', () => {
    const exercise = setup();
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

  it('advances only while Executing, in whole ticks scaled by the time scale', () => {
    const exercise = setup();
    exercise.execute();
    run(exercise, 1);
    expect(exercise.simulation.tick).toBe(10);
    exercise.advance(0.2, 4); // 0.8 s of simulation time
    expect(exercise.simulation.tick).toBe(18);
    exercise.advance(5, 4); // a long frame is capped at 10 ticks
    expect(exercise.simulation.tick).toBe(28);
    exercise.pause();
    const tick = exercise.simulation.tick;
    expect(exercise.advance(5, 4)).toEqual([]);
    expect(exercise.simulation.tick).toBe(tick);
    expect(exercise.simulation.timeSeconds).toBe(tick / TICK_RATE);
  });

  it('pauses on a tick boundary and does not carry partial ticks into the resume', () => {
    const exercise = setup();
    exercise.execute();
    exercise.advance(0.25); // 2.5 ticks: 2 stepped, half a tick pending
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
      [w3, 0, 60],
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

  it('are read-only while Executing', () => {
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
    const added = exercise.addWaypoint(A, { x: 20, y: 70 });
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
    if (!result.ok) throw new Error('commit failed');
    expect(result.revision).toMatchObject({
      revision: 1,
      trigger: 'execute',
      tick: 0,
      timeSeconds: 0,
      changedSoldierIds: [A],
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

  it('keeps committed revisions immutable', () => {
    const exercise = setup();
    planA(exercise);
    exercise.execute();
    const [revision] = exercise.revisions;
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision?.plans[0]?.waypoints[0])).toBe(true);
    exercise.pause();
    exercise.clearRoute(A);
    expect(revision?.plans[0]?.waypoints).toHaveLength(3);
  });

  it('never exposes a partially edited draft to the simulation', () => {
    const exercise = setup();
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

describe('pause, replan, resume', () => {
  it('offers the remaining route from the soldier’s position when paused partway', () => {
    const exercise = setup();
    const [w1, w2, w3] = planA(exercise);
    exercise.execute();
    run(exercise, 15); // 30 m along: past w1 (20 m), heading for w2 (40 m)
    exercise.pause();
    expect(soldier(exercise, 'A').position.y).toBeCloseTo(30, 9);
    expect(exercise.draft(A)).toEqual({
      soldierId: A,
      waypoints: [
        { id: w2, x: 0, y: 40 },
        { id: w3, x: 0, y: 60 },
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
    if (!result.ok) throw new Error('commit failed');
    expect(result.revision.changedSoldierIds).toEqual([A, B]);

    const events = run(exercise, 20); // 30 m east to the moved waypoint (15 s), then toward (0, 60)
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
    // 5 s × 2 m/s = 10 m along the diagonal leg toward (0, 60).
    expect(a.position.x).toBeCloseTo(30 - 10 / Math.SQRT2, 9);
    expect(a.position.y).toBeCloseTo(30 + 10 / Math.SQRT2, 9);
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
    expect(result.ok && result.revision.changedSoldierIds).toEqual([]);
    run(exercise, 30);
    expect(soldier(exercise, 'A').position.y).toBeCloseTo(60, 9);
  });

  it('shows the remaining active orders while Executing', () => {
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

  it('treats a soldier in position with an untouched plan as unchanged', () => {
    const exercise = setup();
    planA(exercise);
    exercise.execute();
    run(exercise, 60);
    expect(soldier(exercise, 'A').orders?.behavior).toBe('inPosition');
    exercise.pause();
    expect(exercise.draft(A)).toEqual({ soldierId: A, waypoints: [], finalFacing: Math.PI / 2 });
    const result = exercise.resume();
    expect(result.ok && result.revision.changedSoldierIds).toEqual([]);
  });
});
