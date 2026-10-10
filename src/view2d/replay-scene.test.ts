import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO, type Exercise } from '#exercise';
import { createSession } from '#session';
import type { Vec2 } from '#sim';
import { buildScene, SHOT_DISPLAY_SECONDS } from './scene';

// The tactical map draws a replay frame with its ordinary scene (docs/adr/0026):
// soldiers where the frame has them, shots at their recorded times.

const KILL_ZONE: Vec2[] = [
  { x: -40, y: -20 },
  { x: 40, y: -20 },
  { x: 40, y: 30 },
  { x: -40, y: 30 },
];
const viewport = { width: 1200, height: 900 };
const camera = { centerX: 0, centerY: 0, metersPerPixel: 0.75 };

function played(): Exercise {
  const exercise = createExercise({ config: { tickRateHz: 30, seed: 7 }, scenario: DEMO_SCENARIO });
  for (const v of KILL_ZONE) exercise.addKillZoneVertex(v);
  exercise.execute();
  exercise.advance(1 / 30);
  if (!exercise.startOpfor().ok) throw new Error('START OPFOR refused');
  for (let i = 0; i < 30 * 300 && (exercise.killZoneOccupancy()?.inside ?? 0) < 1; i += 1)
    exercise.advance(1 / 30);
  if (!exercise.triggerAmbush().ok) throw new Error('TRIGGER AMBUSH refused');
  for (let i = 0; i < 30 * 120 && exercise.phase !== 'engagementComplete'; i += 1)
    exercise.advance(1 / 30);
  return exercise;
}

describe('the scene of a replay frame', () => {
  const exercise = played();
  const frames = exercise.recording?.frames ?? [];

  it('draws the soldiers where the frame has them, and no combat at the trigger', () => {
    const first = buildScene(exercise.replayAt(0), createSession(), camera, viewport);
    expect(first.soldiers).toEqual(frames[0]?.soldiers);
    expect(first.combat).toBeNull();
    const last = buildScene(
      exercise.replayAt(frames.length - 1),
      createSession(),
      camera,
      viewport,
    );
    expect(last.soldiers).toEqual(frames.at(-1)?.soldiers);
    expect(last.combat?.ended).toBe(true);
  });

  it('shows each shot from its recorded time, for its display time only', () => {
    const shots = exercise.combatLog.filter((e) => e.type === 'shotFired');
    expect(shots.length).toBeGreaterThan(0);
    for (let k = 0; k < frames.length; k += 1) {
      const view = exercise.replayAt(k);
      const now = view.simulation.timeSeconds;
      const expected = shots.filter(
        (s) => s.tick < view.simulation.tick && now - s.atSeconds < SHOT_DISPLAY_SECONDS,
      );
      const scene = buildScene(view, createSession(), camera, viewport);
      expect(scene.combat?.shots.length ?? 0).toBe(expected.length);
      expect(scene.combat?.shots.map((s) => s.hit) ?? []).toEqual(expected.map((s) => s.hit));
    }
  });
});
