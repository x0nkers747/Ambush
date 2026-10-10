import { describe, expect, it, vi } from 'vitest';
import { clonePlainData, hashSimState, soldierId, type Vec2 } from '#sim';
import { DEMO_SCENARIO } from './demo-scenario';
import { createExercise, ExerciseError, type Exercise } from './exercise';
import { frameAt, frameSeconds, type ReplayRecording } from './replay';

// The After Action Review's recording and replay views (docs/adr/0026).

const KILL_ZONE: Vec2[] = [
  { x: -40, y: -20 },
  { x: 40, y: -20 },
  { x: 40, y: 30 },
  { x: -40, y: 30 },
];

/**
 * The demo, sprung once a patrol member is in the kill zone, then played out
 * one tick at a time. Returns the exercise and the live state at the trigger
 * and after every tick from then on, copied as it was.
 */
function playedDemo(seed: number) {
  const exercise = createExercise({ config: { tickRateHz: 30, seed }, scenario: DEMO_SCENARIO });
  for (const v of KILL_ZONE) exercise.addKillZoneVertex(v);
  exercise.execute();
  exercise.advance(1 / 30);
  if (!exercise.startOpfor().ok) throw new Error('START OPFOR refused');
  for (let i = 0; i < 30 * 300 && (exercise.killZoneOccupancy()?.inside ?? 0) < 1; i += 1)
    exercise.advance(1 / 30);
  const atTrigger = clonePlainData(exercise.simulation.state);
  if (!exercise.triggerAmbush().ok) throw new Error('TRIGGER AMBUSH refused');
  const live = [atTrigger];
  for (let i = 0; i < 30 * 120 && exercise.phase !== 'engagementComplete'; i += 1) {
    exercise.advance(1 / 30);
    live.push(clonePlainData(exercise.simulation.state));
  }
  if (exercise.phase !== 'engagementComplete') throw new Error('the engagement did not end');
  return { exercise, live, recording: recordingOf(exercise) };
}
const recordingOf = (exercise: Exercise): ReplayRecording => {
  const recording = exercise.recording;
  if (!recording) throw new Error('no recording');
  return recording;
};
/** Everything a frame's view shows, for comparing views. */
const shown = (view: Exercise) =>
  JSON.stringify({
    state: view.simulation.state,
    tick: view.simulation.tick,
    time: view.simulation.timeSeconds,
    phase: view.phase,
    combatLog: view.combatLog,
    timeline: view.timeline.map((e) => [e.type, e.tick]),
    result: view.engagementResult,
    statuses: view.simulation.state.soldiers.map((s) => view.deploymentStatus(s.id) ?? null),
    routes: view.simulation.state.soldiers.map((s) => view.displayedRoute(s.id) ?? null),
  });

const PLAYED = playedDemo(7);

describe('the recording', () => {
  it('starts at the trigger, with the state at that moment', () => {
    const { exercise, live, recording } = PLAYED;
    const trigger = exercise.trigger;
    expect(recording.triggerTick).toBe(trigger?.tick);
    expect(recording.triggerSeconds).toBe(trigger?.atSeconds);
    expect(recording.frames[0]?.tick).toBe(trigger?.tick);
    // Exactly the live state at the trigger: before the engagement begins.
    expect(recording.frames[0]).toEqual(live[0]);
    expect(recording.frames[0]?.engagement).toBeUndefined();
    const first = exercise.replayAt(0);
    expect(first.phase).toBe('opforApproach');
    expect(first.triggerState).toBe('queued');
    expect(first.combatLog).toEqual([]);
    expect(first.timeline.at(-1)?.type).toBe('ambushTriggered');
    expect(first.simulation.timeSeconds).toBe(trigger?.atSeconds);
  });

  it('holds the exact state of every tick to the end of the engagement', () => {
    const { exercise, live, recording } = PLAYED;
    expect(recording.complete).toBe(true);
    expect(recording.frames).toHaveLength(live.length);
    recording.frames.forEach((frame, k) => {
      expect(frame).toEqual(live[k]);
    });
    // The final frame is the final simulation state.
    expect(recording.frames.at(-1)).toEqual(clonePlainData(exercise.simulation.state));
    expect(recording.durationSeconds).toBeCloseTo((live.length - 1) / 30);
    const last = exercise.replayAt(recording.frames.length - 1);
    expect(last.phase).toBe('engagementComplete');
    expect(last.combatLog).toEqual(exercise.combatLog);
    expect(last.engagementResult).toEqual(exercise.engagementResult);
    // Same-tick events are not lost: everything of the trigger tick comes with frame 1.
    const triggerTick = recording.triggerTick;
    const sameTick = exercise.combatLog.filter((e) => e.tick === triggerTick);
    expect(exercise.replayAt(1).combatLog.filter((e) => e.tick === triggerTick)).toEqual(sameTick);
    expect(exercise.replayAt(1).timeline.some((e) => e.type === 'ambushTriggered')).toBe(true);
  });

  it('shows the combat events of each frame as they had happened by then', () => {
    const { exercise, recording } = PLAYED;
    const shots = exercise.combatLog.filter((e) => e.type === 'shotFired');
    expect(shots.length).toBeGreaterThan(0);
    for (let k = 0; k < recording.frames.length; k += 1) {
      const view = exercise.replayAt(k);
      const tick = view.simulation.tick;
      expect(view.combatLog).toEqual(exercise.combatLog.filter((e) => e.tick < tick));
    }
  });
});

describe('replay views', () => {
  it('give the same view of a frame however it is reached, backward or forward', () => {
    const { exercise, recording } = PLAYED;
    const last = recording.frames.length - 1;
    const reference = recording.frames.map((_, k) => shown(exercise.replayAt(k)));
    // Jumps forward, backward, to the ends and back.
    for (const k of [
      last,
      0,
      Math.floor(last / 2),
      3,
      last,
      1,
      last - 1,
      0,
      3,
      Math.floor(last / 2),
    ]) {
      expect(shown(exercise.replayAt(k))).toBe(reference[k]);
    }
    // Out of range is clamped.
    expect(shown(exercise.replayAt(-5))).toBe(reference[0]);
    expect(shown(exercise.replayAt(last + 50))).toBe(reference[last]);
  });

  it('show the frame for a replay time whatever the playback speed', () => {
    const { recording } = PLAYED;
    const last = recording.frames.length - 1;
    for (const speed of [0.25, 0.5, 1, 2, 4]) {
      let seconds = 0;
      let previous = 0;
      while (frameAt(recording, seconds) < last) {
        seconds += (1 / 60) * speed;
        const frame = frameAt(recording, seconds);
        expect(frame).toBeGreaterThanOrEqual(previous);
        expect(frameSeconds(recording, frame)).toBeLessThanOrEqual(seconds + 1e-9);
        previous = frame;
      }
      expect(frameAt(recording, seconds)).toBe(last);
    }
    // A time gives one frame, and a frame's own time gives that frame.
    for (let k = 0; k <= last; k += 1)
      expect(frameAt(recording, frameSeconds(recording, k))).toBe(k);
    expect(frameAt(recording, 1e9)).toBe(last);
    expect(frameAt(recording, -1)).toBe(0);
  });

  it('never simulate, draw random numbers or change the live exercise', () => {
    const { exercise, recording } = PLAYED;
    const step = vi.spyOn(exercise.simulation as unknown as { step: () => unknown }, 'step');
    const hash = hashSimState(exercise.simulation.state);
    const tick = exercise.simulation.tick;
    const log = exercise.combatLog.length;
    for (let k = 0; k < recording.frames.length; k += 1) shown(exercise.replayAt(k));
    expect(step).not.toHaveBeenCalled();
    expect(hashSimState(exercise.simulation.state)).toBe(hash);
    expect(exercise.simulation.tick).toBe(tick);
    expect(exercise.combatLog).toHaveLength(log);
    expect(exercise.phase).toBe('engagementComplete');
    step.mockRestore();
  });

  it('refuse every change, and leave the trainee’s plans as they are', () => {
    const { exercise, recording } = PLAYED;
    const plans = JSON.stringify(exercise.deploymentPlans());
    const zone = JSON.stringify(exercise.killZone);
    const view = exercise.replayAt(Math.floor(recording.frames.length / 2));
    const marine = soldierId('M02');
    expect(() => {
      view.setDestination(marine, { x: 0, y: 0 });
    }).toThrow(ExerciseError);
    expect(() => view.advance(1)).toThrow(ExerciseError);
    expect(() => view.triggerAmbush()).toThrow(ExerciseError);
    expect(() => {
      view.clearKillZone();
    }).toThrow(ExerciseError);
    expect(view.canEditPlans).toBe(false);
    expect(view.deploymentPlans()).toEqual(exercise.deploymentPlans());
    expect(JSON.stringify(exercise.deploymentPlans())).toBe(plans);
    expect(JSON.stringify(exercise.killZone)).toBe(zone);
  });

  it('are refused before there is a recording', () => {
    const exercise = createExercise({
      config: { tickRateHz: 30, seed: 1 },
      scenario: DEMO_SCENARIO,
    });
    expect(exercise.recording).toBeNull();
    expect(() => exercise.replayAt(0)).toThrow(ExerciseError);
  });
});
