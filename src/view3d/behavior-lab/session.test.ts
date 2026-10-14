import { describe, expect, it } from 'vitest';
import { scenarioSpec } from '#exercise/behavior-lab';
import { hashSimState, orgUnitId, soldierId } from '#sim';
import { createLabSession, recordingFromJson, recordingToJson } from './session';

// The Behavior Lab session (docs/behavior-lab/04 §4): recording, replay with
// per-second hash checks, save and load, scrubbing back, and branching.

const free = { ...scenarioSpec('s1-straight', { organization: 'squad' }), waypoints: [] };

function freeRun(ticks: number) {
  const session = createLabSession(free);
  session.submit({
    type: 'orderUnit',
    tick: 0,
    unitId: orgUnitId('SQD'),
    // −0 as a click straight below the camera can give: kept through save and load.
    order: {
      kind: 'moveInFormation',
      destination: { x: -0, y: 150 },
      formation: session.head.formation,
      pace: 1.4,
    },
  });
  for (let i = 0; i < ticks; i += 1) {
    session.step();
    if (i === 300) {
      session.submit({
        type: 'disturbAgent',
        tick: 0,
        soldierId: soldierId('M07'),
        disturbance: { kind: 'goTo', x: 30, y: 40 },
      });
    }
  }
  return session;
}

describe('behavior lab session', () => {
  it('replays a saved and loaded run to the same state hash every second', () => {
    const original = freeRun(30 * 40);
    const text = recordingToJson(original.recording());
    const loaded = recordingFromJson(text);
    expect(loaded.hashes).toHaveLength(41);
    const replay = createLabSession(loaded.spec, loaded);
    for (let i = 0; i < 30 * 40; i += 1) replay.step();
    expect(replay.verification).toEqual({ checked: 41, mismatches: 0, firstMismatch: null });
    expect(hashSimState(replay.head.sim.state)).toBe(hashSimState(original.head.sim.state));
  }, 60_000);

  it('shows an earlier tick exactly as it was, then returns to the head', () => {
    const session = freeRun(30 * 30);
    const recording = session.recording();
    session.seek(30 * 12);
    expect(session.scrubbed).toBe(true);
    expect(hashSimState(session.view.sim.state)).toBe(recording.hashes[12]);
    session.seek(session.headTick);
    expect(session.scrubbed).toBe(false);
    expect(session.viewTick).toBe(30 * 30);
  }, 60_000);

  it('branches from a scrubbed tick: later commands are dropped, the run goes on from there', () => {
    const session = freeRun(30 * 20);
    expect(session.head.commands).toHaveLength(2);
    session.seek(30 * 5);
    session.step();
    // The displacement (given at T+10 s) is gone; the order (T+0) stays.
    expect(session.head.commands).toHaveLength(1);
    expect(session.headTick).toBe(30 * 5 + 1);
    expect(session.scrubbed).toBe(false);
    expect(session.verification).toBeNull();
  }, 60_000);
});
