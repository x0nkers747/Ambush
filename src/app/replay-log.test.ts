import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO, type Exercise } from '#exercise';
import { createSession } from '#session';
import type { Vec2 } from '#sim';
import type { TacticalMap } from '#view2d';
import { createExerciseStage } from './exercise-stage';

// The After Action Review's event log (docs/adr/0026): at every moment of the
// replay it reads as the live log did then, from the trigger on.

const KILL_ZONE: Vec2[] = [
  { x: -40, y: -20 },
  { x: 40, y: -20 },
  { x: 40, y: 30 },
  { x: -40, y: 30 },
];
const lines = (html: string) => [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1] ?? '');

describe('the replay’s event log', () => {
  it('is empty before and at the trigger, then reads as the live log did, tick by tick', () => {
    const exercise = createExercise({
      config: { tickRateHz: 30, seed: 7 },
      scenario: DEMO_SCENARIO,
    });
    const map = {} as TacticalMap;
    const live = createExerciseStage({ exercise: () => exercise, session: createSession, map });
    for (const v of KILL_ZONE) exercise.addKillZoneVertex(v);
    exercise.execute();
    live.collect(exercise.advance(1 / 30));
    if (!exercise.startOpfor().ok) throw new Error('START OPFOR refused');
    for (let i = 0; i < 30 * 300 && (exercise.killZoneOccupancy()?.inside ?? 0) < 1; i += 1)
      live.collect(exercise.advance(1 / 30));
    live.collect([]);
    const before = lines(live.eventsHtml()).length;
    if (!exercise.triggerAmbush().ok) throw new Error('TRIGGER AMBUSH refused');
    // The live log after each tick from the trigger on: only what was added since.
    const logs: string[][] = [[]];
    while (exercise.phase !== 'engagementComplete') {
      live.collect(exercise.advance(1 / 30));
      const all = lines(live.eventsHtml());
      logs.push(all.slice(0, Math.max(0, all.length - before)).slice(0, 30));
    }
    let frame = 0;
    const replay = createExerciseStage({
      exercise: (): Exercise => exercise.replayAt(frame),
      session: createSession,
      map,
    });
    // The lead-in (the approach before the trigger) comes first.
    const lead = exercise.recording?.leadInFrames ?? 0;
    expect(lead).toBeGreaterThan(0);
    expect(exercise.recording?.frames).toHaveLength(lead + logs.length);
    for (frame = 0; frame <= lead; frame += 1) expect(lines(replay.replayEventsHtml())).toEqual([]);
    for (let k = 0; k < logs.length; k += 1) {
      frame = lead + k;
      expect(lines(replay.replayEventsHtml())).toEqual(logs[k]);
    }
    // Something was logged, and the trigger came first.
    expect(logs.at(-1)?.length).toBeGreaterThan(1);
    expect(logs.at(-1)?.at(-1)).toMatch(/AMBUSH|ambush/);
  });
});
