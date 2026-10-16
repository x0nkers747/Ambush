import { describe, expect, it } from 'vitest';
import { labTerrain } from '#exercise/behavior-lab';
import {
  addOrder,
  addSquad,
  addVehicle,
  addVehicleWaypoint,
  clearPlan,
  moveOrder,
  setOrderKind,
  BATTLE_SUBSTEP_HZ,
  battleSpecOf,
  newBattleScenario,
  type BattleEdit,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import { createCombat } from './combat';
import { BATTLE_TICK_RATE_HZ } from './planner';
import { createBattleSession, HASH_EVERY_SECOND_MAX_SOLDIERS, KEYFRAME_SECONDS } from './session';

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

  it('an ambush takes its kill zone: 50 m square around the second point, facing the first', () => {
    const { c, notices } = combat();
    // Without a kill zone it is refused.
    expect(c.order('B1', 'ambush', { x: -150, y: -350 }, 'replace')).toBe(false);
    expect(notices.at(-1)).toMatch(/kill zone/);
    expect(
      c.order('B1', 'ambush', { x: -150, y: -350 }, 'replace', null, { x: -150, y: -280 }),
    ).toBe(true);
    c.play();
    c.frame(0.1);
    const active = c.squad('B1')?.active;
    expect(active?.kind).toBe('ambush');
    expect(active?.killZone).toEqual({
      centre: { x: -150, y: -280 },
      widthM: 50,
      depthM: 50,
      facing: 0,
    });
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

describe('a large battle', () => {
  it('moves at 30 Hz; hashes its state at each keyframe only, and still replays exactly', () => {
    // Eight squads: 104 soldiers, over HASH_EVERY_SECOND_MAX_SOLDIERS.
    let d = newBattleScenario(terrain, 'bf');
    for (let k = 0; k < 4; k += 1) {
      d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: -300 + k * 150, y: -450 }));
      d = done(addSquad(terrain, d, 'OPFOR', 'squad', { x: -300 + k * 150, y: 450 }));
    }
    const spec = battleSpecOf(d, BATTLE_TICK_RATE_HZ);
    expect(spec.substepHz).toBe(BATTLE_SUBSTEP_HZ);
    expect(BATTLE_SUBSTEP_HZ).toBe(30);
    const live = createBattleSession(spec, terrain);
    expect(live.battle.sim.state.soldiers.length).toBeGreaterThan(HASH_EVERY_SECOND_MAX_SOLDIERS);
    live.advance(11 * BATTLE_TICK_RATE_HZ, Infinity);
    const recording = live.recording();
    expect(recording.hashes.map((h) => h !== null)).toEqual(
      Array.from({ length: 12 }, (_, s) => s % KEYFRAME_SECONDS === 0),
    );
    const again = createBattleSession(spec, terrain, recording);
    again.advance(recording.endTick, Infinity);
    expect(again.hashes).toEqual(live.hashes);
  });
});

describe('plans edited in combat, as in planning (Ambush Feedback 4)', () => {
  /** Plays on `seconds` of simulation. */
  const run = (c: ReturnType<typeof combat>['c'], seconds: number) => {
    c.play();
    c.setSpeed(32);
    for (let t = 0; t < seconds; t += 8) c.frame(0.25);
    c.pause();
  };
  const destinations = (c: ReturnType<typeof combat>['c'], id: string) =>
    c.plan(id).map((o) => `${o.kind} ${String(o.destination.east)},${String(o.destination.north)}`);

  it('adds an order after the selected one: the active order goes on, not restarted', () => {
    const { c } = combat();
    run(c, 10);
    expect(destinations(c, 'O1')).toEqual(['move 0,200']);
    const started = c.squad('O1')?.active?.activatedAt;
    // After the active order: appended.
    expect(
      c.editPlan('O1', (d) => addOrder(terrain, d, 'O1', 'withdraw', { x: 0, y: 500 }, 1)),
    ).toBe(true);
    expect(destinations(c, 'O1')).toEqual(['move 0,200', 'withdraw 0,500']);
    expect(c.squad('O1')?.queued.map((q) => q.mode)).toEqual(['append']);
    run(c, 2);
    // Then an order between them: the pending ones replaced, the active one kept.
    expect(c.editPlan('O1', (d) => addOrder(terrain, d, 'O1', 'move', { x: 100, y: 300 }, 1))).toBe(
      true,
    );
    expect(c.squad('O1')?.queued.map((q) => q.mode)).toEqual(['pending']);
    run(c, 2);
    expect(destinations(c, 'O1')).toEqual(['move 0,200', 'move 100,300', 'withdraw 0,500']);
    expect(c.squad('O1')?.active?.activatedAt).toBe(started);
  });

  it('changing the active order gives the plan in its place; clearing it stops the squad', () => {
    const { c } = combat();
    run(c, 10);
    expect(c.editPlan('O1', (d) => moveOrder(terrain, d, 'O1', 0, { x: -100, y: 200 }))).toBe(true);
    expect(c.squad('O1')?.queued.map((q) => q.mode)).toEqual(['replace']);
    expect(destinations(c, 'O1')).toEqual(['move -100,200']);
    run(c, 2);
    expect(c.squad('O1')?.active?.destination).toEqual({ x: -100, y: 200 });
    // A drag shows where it would go, and gives nothing.
    const preview = c.previewPlan('O1', (d) => moveOrder(terrain, d, 'O1', 0, { x: 50, y: 50 }));
    expect(preview?.[0]?.destination).toEqual({ east: 50, north: 50 });
    expect(c.squad('O1')?.queued).toEqual([]);
    expect(c.editPlan('O1', (d) => clearPlan(d, 'O1'))).toBe(true);
    run(c, 2);
    expect(c.plan('O1')).toEqual([]);
    expect(c.squad('O1')?.phase).not.toBe('moving');
  });

  it('refuses an ambush without its kill zone, saying why', () => {
    const { c, notices } = combat();
    run(c, 2);
    expect(c.editPlan('O1', (d) => setOrderKind(d, 'O1', 0, 'ambush'))).toBe(false);
    expect(notices.at(-1)).toMatch(/Order refused: .*kill zone/);
    expect(c.squad('O1')?.queued).toEqual([]);
  });

  it('edits a vehicle route in place of its own', () => {
    let d = scenario();
    d = done(addVehicle(terrain, d, 'BLUEFOR', { x: 0, y: -300 }));
    d = done(addVehicleWaypoint(terrain, d, 'V1', { x: 0, y: -100 }));
    const c = createCombat({
      terrain,
      definition: d,
      notify: () => undefined,
      stepBudgetMs: Infinity,
    });
    expect(c.vehicleRoute('V1')).toEqual([{ x: 0, y: -100 }]);
    expect(
      c.setVehicleRoute('V1', [
        { x: 50, y: -200 },
        { x: 0, y: -100 },
      ]),
    ).toBe(true);
    expect(c.vehicleRoute('V1')).toEqual([
      { x: 50, y: -200 },
      { x: 0, y: -100 },
    ]);
    run(c, 2);
    expect(c.vehicle('V1')?.route).toEqual([
      { x: 50, y: -200 },
      { x: 0, y: -100 },
    ]);
  });
});
