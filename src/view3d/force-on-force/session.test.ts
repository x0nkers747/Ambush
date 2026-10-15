import { describe, expect, it } from 'vitest';
import { headOn } from '#exercise/force-on-force';
import { hashSimState, orgUnitId } from '#sim';
import { createFofSession, fofRecordingFromJson, fofRecordingToJson } from './session';

// The Force-on-Force Lab session (docs/behavior-lab/force-on-force/05):
// recording, save and load, replay with per-second hash checks through an
// engagement, scrubbing back, and the characters' combat log.

describe('force-on-force lab session', () => {
  // Into the firefight (contact at about 451 s for this seed).
  const session = createFofSession(headOn('open', 1));
  // A user order before contact (a new OPFOR destination), recorded with the run.
  for (let i = 0; i < 30 * 520; i += 1) {
    if (i === 30 * 60) {
      session.submit({
        type: 'orderUnit',
        tick: 0,
        unitId: orgUnitId(session.head.forces[1].unitId),
        order: {
          kind: 'moveInFormation',
          destination: { x: 20, y: -700 },
          formation: session.head.forces[1].formation,
          pace: 1.4,
        },
      });
    }
    session.step();
  }

  it('records an engagement, and replays it saved and loaded to the same hash every second', () => {
    expect(session.head.sim.state.fof?.forces.some((f) => f.stats.bursts > 0)).toBe(true);
    const recording = fofRecordingFromJson(fofRecordingToJson(session.recording()));
    expect(recording.origins).toContain('user');
    const replay = createFofSession(recording.spec, recording);
    while (replay.headTick < recording.endTick) replay.step();
    expect(replay.verification).toEqual({
      checked: recording.hashes.length,
      mismatches: 0,
      firstMismatch: null,
    });
    expect(hashSimState(replay.head.sim.state)).toBe(hashSimState(session.head.sim.state));
  }, 120_000);

  it('the characters get every burst as a shot and every casualty, up to the tick shown', () => {
    const fired = session.events.filter((e) => e.event.type === 'fofFire').length;
    const down = session.events.filter((e) => e.event.type === 'soldierIncapacitated').length;
    expect(session.combatLog.filter((e) => e.type === 'shotFired')).toHaveLength(fired);
    expect(session.combatLog.filter((e) => e.type === 'soldierIncapacitated')).toHaveLength(down);
  });

  it('scrubbing back shows the state at that tick, then returns to the head unchanged', () => {
    const head = hashSimState(session.head.sim.state);
    const back = 30 * 470;
    session.seek(back);
    expect(session.scrubbed).toBe(true);
    expect(session.viewTick).toBe(back);
    expect(session.combatLog.every((e) => e.tick < back)).toBe(true);
    const reference = createFofSession(headOn('open', 1), session.recording());
    while (reference.headTick < back) reference.step();
    expect(hashSimState(session.view.sim.state)).toBe(hashSimState(reference.head.sim.state));
    session.seek(session.headTick);
    expect(session.scrubbed).toBe(false);
    expect(hashSimState(session.head.sim.state)).toBe(head);
  }, 120_000);

  it('a recording that is not one is refused', () => {
    expect(() => fofRecordingFromJson('{"schema":"other"}')).toThrow(/Force-on-Force/);
  });
});
