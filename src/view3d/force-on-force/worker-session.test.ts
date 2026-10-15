import { describe, expect, it } from 'vitest';
import { emptyMotionSample } from '#exercise';
import { headOn } from '#exercise/force-on-force';
import { hashSimState, orgUnitId } from '#sim';
import { createFofSession, type FofSession } from './session';
import { createFofSessionHost, type HostBatch, type HostIn } from './session-host';
import { createFofWorkerSession, type FofHostChannel } from './worker-session';

// The lab's session with the simulation in a worker
// (docs/behavior-lab/force-on-force/05): the page side and the host joined by
// an in-memory channel that copies every message as a worker's does
// (structured clone, buffers transferred). Everything the page shows must be
// what the in-page session shows.

function memoryChannel(): FofHostChannel {
  let receive: ((batch: HostBatch) => void) | null = null;
  let closed = false;
  const host = createFofSessionHost((batch, transfer) => {
    const copy = structuredClone(batch, { transfer });
    setTimeout(() => {
      if (!closed) receive?.(copy);
    }, 0);
  });
  return {
    post: (message: HostIn) => {
      const copy = structuredClone(message);
      setTimeout(() => {
        if (!closed) host.receive(copy);
      }, 0);
    },
    listen: (r) => {
      receive = r;
    },
    close: () => {
      closed = true;
    },
  };
}

/** Waits until the session's head has reached `tick` (the worker steps on its own). */
async function reach(session: FofSession, tick: number): Promise<void> {
  session.advance(tick);
  for (let i = 0; i < 1_000_000 && session.headTick < tick && !session.head.settled; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('force-on-force lab session in a worker', () => {
  const ticks = 30 * 500;

  it('shows the same run as the in-page session: hashes, motion, events, metrics, outcome', async () => {
    const inPage = createFofSession(headOn('open', 1));
    while (inPage.headTick < ticks) inPage.step();
    const worker = createFofWorkerSession(headOn('open', 1), undefined, memoryChannel());
    await reach(worker, ticks);
    expect(worker.headTick).toBe(ticks);
    expect(worker.recording().hashes).toEqual(inPage.recording().hashes);
    expect(worker.events.length).toBe(inPage.events.length);
    expect(worker.combatLog.length).toBe(inPage.combatLog.length);
    expect(worker.samples).toEqual(inPage.samples);
    // Every soldier where the in-page run has him, at every tick of the last seconds.
    for (let tick = ticks - 90; tick <= ticks; tick += 1) {
      for (const id of ['B01', 'B07', 'O03', 'O13']) {
        const at = (s: FofSession) =>
          s.motion.read(s.motion.indexOf(id), tick, emptyMotionSample());
        expect(at(worker)).toEqual(at(inPage));
      }
    }
    // The state the page reads (the per-pair thresholds aside).
    await reach(worker, ticks); // the last batch carries the state
    const { fof: a, ...restA } = worker.head.sim.state;
    const { fof: b, ...restB } = inPage.head.sim.state;
    expect(restA).toEqual(restB);
    expect({ ...a, thresholds: [] }).toEqual({ ...b, thresholds: [] });
    expect(worker.metrics()).toEqual(inPage.metrics());
    worker.dispose();
  }, 300_000);

  it('records user orders, replays the recording with every hash checked, and scrubs back', async () => {
    const worker = createFofWorkerSession(headOn('open', 2), undefined, memoryChannel());
    await reach(worker, 30 * 60);
    worker.submit({
      type: 'orderUnit',
      tick: 0,
      unitId: orgUnitId(worker.head.forces[1].unitId),
      order: {
        kind: 'moveInFormation',
        destination: { x: 20, y: -700 },
        formation: worker.head.forces[1].formation,
        pace: 1.4,
      },
    });
    await reach(worker, 30 * 480);
    const recording = worker.recording();
    expect(recording.origins).toContain('user');
    // Replayed in the page: the same hash every second.
    const replay = createFofSession(recording.spec, recording);
    while (replay.headTick < recording.endTick) replay.step();
    expect(replay.verification).toEqual({
      checked: recording.hashes.length,
      mismatches: 0,
      firstMismatch: null,
    });
    // Replayed in the worker too.
    const again = createFofWorkerSession(recording.spec, recording, memoryChannel());
    await reach(again, recording.endTick);
    expect(again.verification?.mismatches).toBe(0);
    expect(again.verification?.checked).toBe(recording.hashes.length);
    again.dispose();
    // Scrubbing back: the state at that tick, from the keyframes.
    const back = 30 * 300;
    worker.seek(back);
    expect(worker.scrubbed).toBe(true);
    expect(worker.viewTick).toBe(back);
    expect(hashSimState(worker.view.sim.state)).toBe(recording.hashes[back / 30]);
    worker.seek(worker.headTick);
    expect(worker.scrubbed).toBe(false);
    // A step while scrubbed back branches there, and the worker re-simulates it.
    worker.seek(back);
    worker.step();
    // While the worker re-simulates up to the branch, the page goes on showing that tick.
    expect(worker.viewTick).toBe(back);
    expect(worker.headTick).toBe(0);
    await reach(worker, back + 1);
    expect(worker.headTick).toBe(back + 1);
    expect(worker.recording().hashes).toEqual(recording.hashes.slice(0, back / 30 + 1));
    worker.dispose();
  }, 300_000);
});
