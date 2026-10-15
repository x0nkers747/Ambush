import { beforeAll, describe, expect, it } from 'vitest';
import { labTerrain } from '#exercise/behavior-lab';
import {
  addOrder,
  addSquad,
  newBattleScenario,
  type BattleEdit,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import { hashSimState } from '#sim';
import { createCombat, type Combat } from './combat';
import { createReview, type Review } from './review';
import type { BattleRecording } from './session';

// The After-Action Review (docs/constructive-simulation/05): the battle
// replayed from tick 0 by re-simulation from its recording, each second's
// state hash checked; the playhead anywhere in it, at the state the battle
// had then; the timeline's markers.

const terrain = labTerrain();
const done = (edit: BattleEdit): BattleScenarioDefinition => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};

/** A squad each side, 600 m apart, OPFOR attacking north to south. */
function scenario(): BattleScenarioDefinition {
  let d = newBattleScenario(terrain, 'bf');
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 0, y: -300 }));
  d = done(addSquad(terrain, d, 'OPFOR', 'squad', { x: 0, y: 300 }));
  d = done(addOrder(terrain, d, 'O1', 'attack', { x: 0, y: -300 }));
  return d;
}

/** A battle fought with orders given live (some while paused), ended at `seconds`. */
function fought(seconds: number): Combat {
  const c = createCombat({
    terrain,
    definition: scenario(),
    notify: () => undefined,
    stepBudgetMs: Infinity,
  });
  c.setSpeed(32);
  c.play();
  const until = (s: number) => {
    while (c.session.seconds < s) c.frame(0.25);
  };
  until(20);
  c.order('B1', 'move', { x: -100, y: -250 }, 'replace');
  until(40);
  c.pause();
  c.order('B1', 'attack', { x: 0, y: 200 }, 'replace');
  c.order('B1', 'withdraw', { x: 0, y: -500 }, 'append');
  c.play();
  until(seconds);
  c.end();
  return c;
}

describe('the replay', { timeout: 60_000 }, () => {
  const battle = fought(240);
  let recording: BattleRecording;
  beforeAll(async () => {
    recording = await battle.recording();
  });

  it('re-simulates the whole battle from tick 0, and every second matches the recording', () => {
    const review = createReview({ terrain, recording, budgetMs: Infinity });
    expect(review.verification).toEqual({
      checked: 241,
      mismatches: 0,
      firstMismatch: null,
      complete: true,
    });
    expect(review.endSeconds).toBe(battle.session.seconds);
    expect(review.replay.tick).toBe(recording.endTick);
    expect(review.replay.hashes.at(-1)).toBe(battle.session.hashes.at(-1));
    expect(review.summary()).toEqual(battle.summary());
  });

  it('notices a recording whose battle it does not reproduce', () => {
    const tampered = {
      ...recording,
      hashes: recording.hashes.map((h, i) => (i === 100 ? 'x' : h)),
    };
    const review = createReview({ terrain, recording: tampered, budgetMs: Infinity });
    expect(review.verification).toMatchObject({ mismatches: 1, firstMismatch: 100 });
  });

  it('replays a little at a time when given a budget, verifying as it goes', () => {
    const review = createReview({ terrain, recording, budgetMs: 0 });
    // One tick per frame at least: it is under way, not done.
    expect(review.verification.complete).toBe(false);
    for (let k = 0; k < 20; k += 1) review.frame(0);
    expect(review.replayedSeconds).toBeGreaterThan(0);
    expect(review.verification.mismatches).toBe(0);
    // The playhead never passes the replay.
    review.seek(200);
    expect(review.seconds).toBeLessThanOrEqual(review.replayedSeconds);
  });
});

describe('the playhead', { timeout: 60_000 }, () => {
  const battle = fought(180);
  let recording: BattleRecording;
  let review: Review;
  beforeAll(async () => {
    recording = await battle.recording();
    review = createReview({ terrain, recording, budgetMs: Infinity });
  });

  it('shows the battle as it was at any second, forward or back', () => {
    for (const s of [150, 30, 31, 90, 0, 179, 45]) {
      review.seek(s);
      expect(review.view.sim.tick).toBe(s * 30);
      expect(hashSimState(review.view.sim.state)).toBe(recording.hashes[s]);
    }
  });

  it('plays at the speed chosen, and stops at the end', () => {
    review.seek(170);
    review.setSpeed(4);
    review.play();
    review.frame(0.25);
    expect(review.seconds).toBeCloseTo(171, 5);
    for (let k = 0; k < 40; k += 1) review.frame(0.25);
    expect(review.seconds).toBe(review.endSeconds);
    expect(review.playing).toBe(false);
  });

  it('gives the squads as they were then: orders, phases and strength', () => {
    review.seek(30);
    expect(review.squad('B1')?.active?.kind).toBe('move');
    review.seek(45);
    const b1 = review.squad('B1');
    expect(b1?.orders.map((x) => x.kind)).toEqual(['move', 'attack', 'withdraw']);
    expect(b1?.orders.map((x) => x.status)).toContain('superseded');
    expect(review.phases('O1').length).toBeGreaterThan(0);
  });
});

describe('the timeline', { timeout: 60_000 }, () => {
  it('marks the user’s orders, contact and casualties, in time order', async () => {
    const battle = fought(600);
    const review = createReview({
      terrain,
      recording: await battle.recording(),
      budgetMs: Infinity,
    });
    const markers = review.markers();
    expect(markers.filter((m) => m.kind === 'order').map((m) => [m.seconds, m.text])).toEqual([
      [20, '1st Squad: ordered move'],
      [40, '1st Squad: ordered attack'],
      [40, '1st Squad: appended withdraw'],
    ]);
    expect(markers.some((m) => m.kind === 'contact')).toBe(true);
    expect(markers.some((m) => m.kind === 'casualty')).toBe(true);
    const times = markers.map((m) => m.seconds);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
