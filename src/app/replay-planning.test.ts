import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO, type Exercise } from '#exercise';
import { clonePlainData, soldierId, type Vec2 } from '#sim';
import { carryPlans } from './carry-plans';

// Back to planning from the After Action Review (docs/adr/0026): the trainee's
// plans go into a fresh exercise, the old recording stays as it was, and a
// changed plan runs as a new, independent simulation with its own recording.

const KILL_ZONE: Vec2[] = [
  { x: -40, y: -20 },
  { x: 40, y: -20 },
  { x: 40, y: 30 },
  { x: -40, y: 30 },
];
const fresh = () =>
  createExercise({ config: { tickRateHz: 30, seed: 7 }, scenario: DEMO_SCENARIO });

/** Execute (moving into position), start OPFOR, spring the ambush and play it out. */
function runAmbush(exercise: Exercise): void {
  exercise.execute();
  for (let i = 0; i < 30 * 600 && !exercise.bluforMovementComplete; i += 1)
    exercise.advance(1 / 30);
  if (!exercise.startOpfor().ok) throw new Error('START OPFOR refused');
  for (let i = 0; i < 30 * 300 && (exercise.killZoneOccupancy()?.inside ?? 0) < 1; i += 1)
    exercise.advance(1 / 30);
  if (!exercise.triggerAmbush().ok) throw new Error('TRIGGER AMBUSH refused');
  for (let i = 0; i < 30 * 120 && exercise.phase !== 'engagementComplete'; i += 1)
    exercise.advance(1 / 30);
  if (exercise.phase !== 'engagementComplete') throw new Error('the engagement did not end');
}

describe('returning to planning', () => {
  it('restores the plan as executed in a fresh exercise, without the combat', () => {
    const first = fresh();
    for (const v of KILL_ZONE) first.addKillZoneVertex(v);
    first.setDestination(soldierId('M02'), { x: -20, y: -60 });
    first.placeFormation('FT2', { x: 10, y: -70 });
    const planned = clonePlainData(first.deploymentPlans());
    runAmbush(first);
    const frames = first.recording?.frames;
    const framesBefore = JSON.stringify(frames);

    const next = fresh();
    const carried = carryPlans(first, next);
    expect(carried.problems).toEqual([]);
    // The plan as it was executed, editable again.
    expect(next.phase).toBe('bluforPlanning');
    expect(next.canEditPlans).toBe(true);
    expect(next.deploymentPlans()).toEqual(planned);
    expect(next.killZone?.vertices).toEqual(KILL_ZONE);
    expect(next.formation('FT2')?.linked).toHaveLength(4);
    // Nobody hurt, nobody moved: every soldier active where the scenario starts them.
    for (const s of next.simulation.state.soldiers) {
      expect(s.status).toBe('active');
      expect({ x: s.position.x, y: s.position.y }).toEqual(next.scenarioStart(s.id));
    }
    expect(next.simulation.state.engagement).toBeUndefined();
    expect(next.recording).toBeNull();
    // The previous run's recording is untouched.
    expect(first.recording?.frames).toBe(frames);
    expect(JSON.stringify(first.recording?.frames)).toBe(framesBefore);
  });

  it('runs a changed plan as a new simulation with its own recording', () => {
    const first = fresh();
    for (const v of KILL_ZONE) first.addKillZoneVertex(v);
    runAmbush(first);
    const firstFrames = JSON.stringify(first.recording?.frames);

    const second = fresh();
    carryPlans(first, second);
    // A changed plan: the 1st fire team in a line south-west of the road.
    second.placeFormation('FT1', { x: -30, y: -50 });
    runAmbush(second);
    const recording = second.recording;
    expect(recording?.complete).toBe(true);
    expect(recording).not.toBe(first.recording);
    expect(JSON.stringify(recording?.frames)).not.toBe(firstFrames);
    // Its own frames lead up to its own trigger; the first run's are unchanged.
    expect(recording?.frames[recording.leadInFrames]?.tick).toBe(second.trigger?.tick);
    expect(JSON.stringify(first.recording?.frames)).toBe(firstFrames);
  });
});
