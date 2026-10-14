import { describe, expect, it } from 'vitest';
import { clonePlainData, hashSimState, type SimState, type Vec2 } from '#sim';
import { DEMO_SCENARIO } from './demo-scenario';
import { createExercise, type Exercise } from './exercise';
import { createMotionRecorder, emptyMotionSample } from './motion-log';

// The soldiers' motion log, the 3D characters' input (docs/character-animation.md).

const KILL_ZONE: Vec2[] = [
  { x: -40, y: -20 },
  { x: 40, y: -20 },
  { x: 40, y: 30 },
  { x: -40, y: 30 },
];

/** The demo from the start, sprung once a patrol member is in the kill zone, to its end. */
function playedDemo(seed: number, onTick: (exercise: Exercise) => void = () => undefined) {
  const exercise = createExercise({ config: { tickRateHz: 30, seed }, scenario: DEMO_SCENARIO });
  for (const v of KILL_ZONE) exercise.addKillZoneVertex(v);
  exercise.execute();
  const tick = () => {
    exercise.advance(1 / 30);
    onTick(exercise);
  };
  tick();
  if (!exercise.startOpfor().ok) throw new Error('START OPFOR refused');
  for (let i = 0; i < 30 * 300 && (exercise.killZoneOccupancy()?.inside ?? 0) < 1; i += 1) tick();
  if (!exercise.triggerAmbush().ok) throw new Error('TRIGGER AMBUSH refused');
  for (let i = 0; i < 30 * 120 && exercise.phase !== 'engagementComplete'; i += 1) tick();
  if (exercise.phase !== 'engagementComplete') throw new Error('the engagement did not end');
  return exercise;
}

const state = (tick: number, xs: number[], ids = xs.map((_, i) => `S${String(i)}`)) =>
  ({
    tick,
    soldiers: xs.map((x, i) => ({
      id: ids[i],
      position: { x, y: -x, z: 1 },
      azimuth: 0.5,
      posture: 'kneeling',
      status: 'active',
    })),
  }) as unknown as SimState;

describe('the motion recorder', () => {
  it('appends ticks and reads them back exactly, clamped to the recorded ticks', () => {
    const log = createMotionRecorder(30);
    log.record(state(5, [1.25, 2]));
    log.record(state(6, [1.5, 3]));
    log.record(state(7, [1.75, 4]));
    expect(log.firstTick).toBe(5);
    expect(log.lastTick).toBe(7);
    const s = emptyMotionSample();
    expect(log.read(1, 6, s)).toMatchObject({ x: 3, y: -3, z: 1, azimuth: 0.5 });
    expect(s.posture).toBe('kneeling');
    expect(s.behavior).toBeNull();
    expect(log.read(0, 2, s).x).toBe(1.25);
    expect(log.read(0, 99, s).x).toBe(1.75);
    expect(log.indexOf('S1')).toBe(1);
    expect(log.indexOf('nobody')).toBe(-1);
  });

  it('keeps the latest tick as the state is now (edits between ticks)', () => {
    const log = createMotionRecorder(30);
    log.record(state(0, [1]));
    const epoch = log.epoch;
    log.record(state(0, [4]));
    expect(log.read(0, 0, emptyMotionSample()).x).toBe(4);
    expect(log.epoch).toBe(epoch);
  });

  it('starts again when time does not follow on or the soldiers change', () => {
    const log = createMotionRecorder(30);
    log.record(state(0, [1]));
    log.record(state(1, [2]));
    const epoch = log.epoch;
    log.record(state(9, [3]));
    expect(log.firstTick).toBe(9);
    expect(log.epoch).toBe(epoch + 1);
    log.record(state(10, [3, 4]));
    expect(log.soldierIds).toEqual(['S0', 'S1']);
    expect(log.firstTick).toBe(10);
  });

  it('holds thousands of ticks across chunks', () => {
    const log = createMotionRecorder(30);
    for (let t = 0; t < 5000; t += 1) log.record(state(t, [t / 8]));
    const s = emptyMotionSample();
    for (const t of [0, 1023, 1024, 2047, 4999]) expect(log.read(0, t, s).x).toBe(t / 8);
  });
});

describe('the exercise motion log', () => {
  const exercise = playedDemo(7);
  const log = exercise.motionLog;

  it('covers every tick from the start of the exercise', () => {
    expect(log.firstTick).toBe(0);
    expect(log.lastTick).toBe(exercise.simulation.tick);
    expect(log.soldierIds).toEqual(exercise.simulation.state.soldiers.map((s) => s.id));
  });

  it('matches the review recording exactly at every recorded tick', () => {
    const recording = exercise.recording;
    if (!recording) throw new Error('no recording');
    const s = emptyMotionSample();
    for (const frame of recording.frames) {
      const behaviors = new Map(
        (frame.engagement?.combatants ?? []).map((c) => [c.soldierId, c.behavior]),
      );
      frame.soldiers.forEach((soldier, i) => {
        log.read(i, frame.tick, s);
        expect(s.x).toBe(soldier.position.x);
        expect(s.y).toBe(soldier.position.y);
        expect(s.z).toBe(soldier.position.z);
        expect(s.azimuth).toBe(soldier.azimuth);
        expect(s.posture).toBe(soldier.posture);
        expect(s.status).toBe(soldier.status);
        expect(s.behavior).toBe(behaviors.get(soldier.id) ?? null);
      });
    }
  });

  it('never changes the simulation', () => {
    const states: string[] = [];
    const reading = playedDemo(11, (e) => {
      // Read the log (and so record the latest tick) every tick.
      expect(e.motionLog.lastTick).toBe(e.simulation.tick);
      states.push(hashSimState(clonePlainData(e.simulation.state)));
    });
    const other: string[] = [];
    playedDemo(11, (e) => other.push(hashSimState(clonePlainData(e.simulation.state))));
    expect(states).toEqual(other);
    expect(reading.motionLog.lastTick).toBe(reading.simulation.tick);
    // Two whole exercises, hashed at every tick.
  }, 60000);
});

describe('render time', () => {
  it('is one tick behind the simulation while it runs, plus the accumulated part of a tick', () => {
    const exercise = createExercise({
      config: { tickRateHz: 30, seed: 3 },
      scenario: DEMO_SCENARIO,
    });
    expect(exercise.renderSeconds).toBe(0);
    for (const v of KILL_ZONE) exercise.addKillZoneVertex(v);
    exercise.execute();
    exercise.advance(1 / 30);
    if (!exercise.startOpfor().ok) throw new Error('START OPFOR refused');
    const start = exercise.simulation.tick;
    for (let i = 0; i < 10; i += 1) exercise.advance(1 / 30);
    exercise.advance(0.5 / 30);
    const tick = exercise.simulation.tick;
    expect(tick).toBe(start + 10);
    expect(exercise.renderSeconds).toBeCloseTo((tick - 1 + 0.5) / 30, 9);
    exercise.pause();
    expect(exercise.renderSeconds).toBe(tick / 30);
  });
});
