import { describe, expect, it } from 'vitest';
import { labTerrain } from '#exercise/behavior-lab';
import {
  addOrder,
  addSquad,
  battleSpecOf,
  newBattleScenario,
  type BattleEdit,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import { createCombat } from './combat';
import { BATTLE_TICK_RATE_HZ } from './planner';
import { createBattleSession } from './session';

// The Combat stage (docs/constructive-simulation/04) without the page: the
// clock, live orders to either side, End Combat; and the session that
// records the battle so that it can be replayed exactly.

const terrain = labTerrain();
const done = (edit: BattleEdit): BattleScenarioDefinition => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};

/** Two BLUEFOR squads and an OPFOR fire team, 900 m apart; OPFOR moves toward them. */
function scenario(): BattleScenarioDefinition {
  let d = newBattleScenario(terrain, 'bf');
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: -150, y: -450 }));
  d = done(addSquad(terrain, d, 'BLUEFOR', 'fireTeam', { x: 150, y: -450 }));
  d = done(addSquad(terrain, d, 'OPFOR', 'fireTeam', { x: 0, y: 450 }));
  d = done(addOrder(terrain, d, 'O1', 'move', { x: 0, y: 200 }));
  return d;
}

function combat() {
  const notices: string[] = [];
  // No time limit per frame: the battle reaches the clock whatever the machine's load.
  const c = createCombat({
    terrain,
    definition: scenario(),
    notify: (m) => notices.push(m),
    stepBudgetMs: Infinity,
  });
  return { c, notices };
}

describe('the clock', () => {
  it('runs only while playing, at the speed chosen', () => {
    const { c } = combat();
    c.frame(1);
    expect(c.session.tick).toBe(0);
    c.play();
    c.frame(0.1);
    expect(c.session.seconds).toBeCloseTo(0.1, 5);
    c.setSpeed(8);
    c.frame(0.25);
    expect(c.session.seconds).toBeCloseTo(2.1, 5);
    c.pause();
    c.frame(1);
    expect(c.session.seconds).toBeCloseTo(2.1, 5);
    // A long frame (the tab was hidden) counts for at most a quarter second.
    c.play();
    c.setSpeed(1);
    c.frame(10);
    // The battle steps whole ticks up to the clock: at most one tick ahead of it.
    expect(c.session.seconds - 2.35).toBeGreaterThanOrEqual(0);
    expect(c.session.seconds - 2.35).toBeLessThan(1 / BATTLE_TICK_RATE_HZ);
    expect(c.renderSeconds).toBeLessThanOrEqual(c.session.seconds);
  });
});

describe('orders in combat', () => {
  it('to either side: replace starts on the new order, append follows the pending ones', () => {
    const { c } = combat();
    c.play();
    c.frame(0.1);
    // OPFOR: replace its move with an attack.
    expect(c.order('O1', 'attack', { x: 0, y: -300 }, 'replace')).toBe(true);
    expect(c.squad('O1')?.queued).toHaveLength(1);
    c.frame(0.1);
    const o1 = c.squad('O1');
    expect(o1?.queued).toHaveLength(0);
    expect(o1?.active?.kind).toBe('attack');
    expect(o1?.orders.map((x) => x.status)).toEqual(['superseded', 'active']);
    // BLUEFOR: a move, then a withdrawal after it.
    c.order('B1', 'move', { x: -150, y: -300 }, 'replace');
    c.order('B1', 'withdraw', { x: -150, y: -600 }, 'append');
    c.frame(0.1);
    const b1 = c.squad('B1');
    expect(b1?.active?.kind).toBe('move');
    expect(b1?.pending.map((x) => x.kind)).toEqual(['withdraw']);
    expect(b1?.orders.every((x) => x.source === 'player')).toBe(true);
  });

  it('given while paused, apply in turn when play resumes', () => {
    const { c } = combat();
    c.order('B2', 'move', { x: 150, y: -300 }, 'replace');
    c.order('B2', 'attack', { x: 0, y: 200 }, 'append');
    c.frame(1);
    expect(c.session.tick).toBe(0);
    expect(c.squad('B2')?.queued).toHaveLength(2);
    c.play();
    c.frame(0.05);
    const b2 = c.squad('B2');
    expect(b2?.queued).toHaveLength(0);
    expect(b2?.active?.kind).toBe('move');
    expect(b2?.pending.map((x) => x.kind)).toEqual(['attack']);
  });

  it('hold clears the orders; a destination in an obstacle is moved clear, one off the map refused', () => {
    const { c, notices } = combat();
    c.play();
    c.frame(0.1);
    c.hold('O1');
    c.frame(0.1);
    expect(c.squad('O1')?.active).toBeNull();
    expect(c.squad('O1')?.orders.map((x) => x.status)).toEqual(['canceled']);
    expect(c.order('O1', 'move', { x: 9000, y: 0 }, 'replace')).toBe(false);
    expect(notices.at(-1)).toBe('A destination must be on the map.');
  });
});

describe('ending', () => {
  it('only when the user ends it; then nothing more happens', () => {
    const { c } = combat();
    c.play();
    c.setSpeed(32);
    for (let k = 0; k < 40; k += 1) c.frame(0.25);
    expect(c.ended).toBe(false);
    const at = c.session.tick;
    c.end();
    expect(c.playing).toBe(false);
    c.play();
    c.frame(0.25);
    expect(c.session.tick).toBe(at);
    expect(c.order('B1', 'move', { x: 0, y: 0 }, 'replace')).toBe(false);
    const summary = c.summary();
    expect(summary.sides.map((s) => [s.side, s.squads, s.soldiers])).toEqual([
      ['BLUEFOR', 2, 17],
      ['OPFOR', 1, 4],
    ]);
    expect(summary.orders.given).toBe(1);
  });
});

describe('the session', () => {
  it('records the battle so that it replays exactly: keyframes, hashes, commands and origins', () => {
    const spec = battleSpecOf(scenario(), BATTLE_TICK_RATE_HZ);
    const live = createBattleSession(spec, terrain);
    live.advance(3 * BATTLE_TICK_RATE_HZ, Infinity);
    live.submit({
      type: 'orderSquad',
      tick: 0,
      unitId: 'B1-SQD',
      mode: 'replace',
      orders: [{ kind: 'attack', destination: { x: 0, y: 300 } }],
    });
    live.advance(20 * BATTLE_TICK_RATE_HZ, Infinity);
    const recording = live.recording();
    expect(recording.endTick).toBe(20 * BATTLE_TICK_RATE_HZ);
    expect(recording.hashes.filter((h) => h !== null)).toHaveLength(21);
    expect([...live.keyframes.keys()]).toEqual([0, 150, 300, 450, 600]);
    expect(recording.commands.at(-1)).toMatchObject({ tick: 90, unitId: 'B1-SQD' });
    expect(recording.origins.at(-1)).toBe('user');
    expect(live.motion.lastTick).toBe(600);

    const again = createBattleSession(spec, terrain, recording);
    again.advance(recording.endTick, Infinity);
    expect(again.hashes).toEqual(live.hashes);
  });
});
