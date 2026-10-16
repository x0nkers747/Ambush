import { describe, expect, it } from 'vitest';
import { emptyMotionSample } from '#exercise';
import { labTerrain } from '#exercise/behavior-lab';
import {
  addOrder,
  addSquad,
  newBattleScenario,
  type BattleEdit,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import { createBattleHost, type HostBatch } from './battle-host';
import { createCombat, type Combat } from './combat';
import { createReview } from './review';
import { createWorkerDriver, type BattleChannel } from './worker-combat';

// The battle worker (docs/constructive-simulation/04): the host (the
// worker's side) wired to the page's driver through a queue, every message
// cloned as `postMessage` clones it. A battle fought through it must be the
// battle fought on the page, tick for tick; and the review must replay and
// verify through it.

const terrain = labTerrain();
const done = (edit: BattleEdit): BattleScenarioDefinition => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};

function scenario(): BattleScenarioDefinition {
  let d = newBattleScenario(terrain, 'bf');
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 0, y: -300 }));
  d = done(addSquad(terrain, d, 'BLUEFOR', 'fireTeam', { x: 200, y: -300 }));
  d = done(addSquad(terrain, d, 'OPFOR', 'squad', { x: 0, y: 300 }));
  d = done(addOrder(terrain, d, 'O1', 'attack', { x: 0, y: -300 }));
  return d;
}

/** A host on this thread behind a channel; `flush` lets it (and its posts) run to quiet. */
function hostChannel(): { channel: BattleChannel; flush: () => void } {
  const queue: (() => void)[] = [];
  const listeners = new Set<(batch: HostBatch) => void>();
  const host = createBattleHost(
    (batch) => {
      const copy = structuredClone(batch);
      queue.push(() => {
        for (const l of listeners) l(copy);
      });
    },
    (run) => queue.push(run),
  );
  return {
    channel: {
      post: (message) => {
        const copy = structuredClone(message);
        queue.push(() => {
          host.receive(copy);
        });
      },
      listen(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        listeners.clear();
      },
    },
    flush() {
      for (let n = 0; queue.length > 0 && n < 1_000_000; n += 1) queue.shift()?.();
    },
  };
}

/** Fights the battle with orders at fixed times; `settle` runs between frames (the worker's turn). */
function fight(c: Combat, settle: () => void): void {
  c.setSpeed(32);
  c.play();
  const until = (s: number) => {
    while (c.session.seconds < s) {
      c.frame(0.25);
      settle();
    }
  };
  until(30);
  c.order('B1', 'move', { x: -100, y: -200 }, 'replace');
  c.pause();
  c.order('B2', 'attack', { x: 0, y: 250 }, 'replace');
  c.order('B2', 'withdraw', { x: 200, y: -400 }, 'append');
  c.play();
  until(120);
  c.hold('O1');
  until(300);
  c.end();
}

describe('the battle worker', { timeout: 60_000 }, () => {
  it('fights the battle the page would: the same commands, ticks and state hashes', async () => {
    const local = createCombat({
      terrain,
      definition: scenario(),
      notify: () => undefined,
      stepBudgetMs: Infinity,
    });
    fight(local, () => undefined);
    const { channel, flush } = hostChannel();
    const remote = createCombat({
      terrain,
      definition: scenario(),
      notify: () => undefined,
      driver: createWorkerDriver(channel, terrain),
    });
    flush();
    fight(remote, flush);
    const expected = await local.recording();
    const pending = remote.recording();
    flush();
    const got = await pending;
    expect(got.commands).toEqual(expected.commands);
    expect(got.origins).toEqual(expected.origins);
    expect(got.endTick).toBe(expected.endTick);
    expect(got.hashes).toEqual(expected.hashes);
    // What the page shows of it: the squads, the events, every soldier's motion.
    expect(remote.squads()).toEqual(local.squads());
    expect(remote.session.events).toEqual(local.session.events);
    expect(remote.session.hashes).toEqual(local.session.hashes);
    const a = emptyMotionSample();
    const b = emptyMotionSample();
    for (const tick of [0, 1, 450, 3000, expected.endTick]) {
      local.session.motion.soldierIds.forEach((id, i) => {
        local.session.motion.read(i, tick, a);
        remote.session.motion.read(remote.session.motion.indexOf(id), tick, b);
        expect([b.x, b.y, b.z, b.azimuth, b.posture, b.status]).toEqual([
          a.x,
          a.y,
          a.z,
          a.azimuth,
          a.posture,
          a.status,
        ]);
      });
    }
  });

  it('shows the squads where they start before the worker has sent anything, then goes on from there', () => {
    const { channel, flush } = hostChannel();
    const c = createCombat({
      terrain,
      definition: scenario(),
      notify: () => undefined,
      driver: createWorkerDriver(channel, terrain),
    });
    // Nothing from the worker yet: the squads and their soldiers are there, as they start.
    const log = c.session.motion;
    expect(c.squads().map((s) => s.id)).toEqual(['B1', 'B2', 'O1']);
    expect(log.lastTick).toBe(0);
    const sample = emptyMotionSample();
    log.read(log.indexOf('B1-01'), 0, sample);
    const atStart = { x: sample.x, y: sample.y };
    expect(Math.hypot(atStart.x, atStart.y + 300)).toBeLessThan(40);
    // The worker's frames follow on, its tick 0 the same.
    flush();
    c.play();
    c.frame(0.5);
    flush();
    c.frame(0.1);
    expect(log.lastTick).toBeGreaterThan(0);
    log.read(log.indexOf('B1-01'), 0, sample);
    expect({ x: sample.x, y: sample.y }).toEqual(atStart);
  });

  it('shows orders queued until the worker has applied them', () => {
    const { channel, flush } = hostChannel();
    const c = createCombat({
      terrain,
      definition: scenario(),
      notify: () => undefined,
      driver: createWorkerDriver(channel, terrain),
    });
    flush();
    c.order('B1', 'move', { x: -100, y: -200 }, 'replace');
    c.frame(0);
    expect(c.squad('B1')?.queued).toHaveLength(1);
    flush();
    c.play();
    c.frame(0.1);
    flush();
    c.frame(0.1);
    expect(c.squad('B1')?.queued).toHaveLength(0);
    expect(c.squad('B1')?.active?.kind).toBe('move');
  });

  it('replays and verifies the battle for the review, and the playhead seeks through its keyframes', async () => {
    const local = createCombat({
      terrain,
      definition: scenario(),
      notify: () => undefined,
      stepBudgetMs: Infinity,
    });
    fight(local, () => undefined);
    const recording = await local.recording();
    const { channel, flush } = hostChannel();
    const review = createReview({
      terrain,
      recording,
      driver: createWorkerDriver(channel, terrain),
    });
    flush();
    review.frame(0);
    expect(review.verification).toEqual({
      checked: 301,
      mismatches: 0,
      firstMismatch: null,
      complete: true,
    });
    expect(review.replay.keyframes.size).toBe(61);
    review.seek(200);
    expect(review.view.sim.tick).toBe(6000);
    expect(review.summary()).toEqual(local.summary());
    expect(review.markers().filter((m) => m.kind === 'order')).toHaveLength(4);
  });
});
