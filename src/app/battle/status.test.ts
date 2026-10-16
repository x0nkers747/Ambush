import { describe, expect, it } from 'vitest';
import { labTerrain } from '#exercise/behavior-lab';
import {
  addOrder,
  addSquad,
  battleSpecOf,
  FOF_DEFAULT_CONFIG,
  newBattleScenario,
  type BattleEdit,
} from '#exercise/battle';
import { recovered, spent, type DeepReadonly, type FofForce } from '#sim';
import { BATTLE_TICK_RATE_HZ } from './planner';
import { createBattleSession } from './session';
import { activityOf, squadStatuses } from './status';

// What a squad is doing, in a word, and why; and when a squad has recovered
// from a fight (docs/behavior-lab/force-on-force/03 §4).

const terrain = labTerrain();
const done = (edit: BattleEdit) => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};

/** A BLUEFOR squad on a Move order, a second ago. */
function movingForce(): DeepReadonly<FofForce> {
  let d = newBattleScenario(terrain, 'bf');
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: -150, y: -450 }));
  d = done(addSquad(terrain, d, 'OPFOR', 'fireTeam', { x: 0, y: 450 }));
  d = done(addOrder(terrain, d, 'B1', 'move', { x: -150, y: -200 }));
  const session = createBattleSession(battleSpecOf(d, BATTLE_TICK_RATE_HZ), terrain);
  session.advance(BATTLE_TICK_RATE_HZ, Infinity);
  const status = squadStatuses(session.battle, session.battle.sim.state);
  expect(status[0]?.activity).toEqual({ word: 'Moving', why: 'on its Move order' });
  const force = session.battle.sim.state.fof?.forces[0];
  if (!force) throw new Error('no force');
  return force;
}

describe('recovered from a fight', () => {
  const config = FOF_DEFAULT_CONFIG;
  it('once its suppression has worn off, however many casualties it has, unless spent', () => {
    // Scenario 2's OPFOR: 8 of 13 up, 2 of 4 leaders: at best 0.538. It used to hold forever (0.6 needed).
    const hurt = { lastingEffectiveness: 0.538, meanSuppression: 0 };
    expect(spent(hurt, config)).toBe(false);
    expect(recovered(hurt, config)).toBe(true);
    expect(recovered({ ...hurt, meanSuppression: 0.4 }, config)).toBe(false);
    expect(recovered({ ...hurt, meanSuppression: config.force.resumeSuppression }, config)).toBe(
      true,
    );
    // Below the withdrawal threshold for good: spent, never recovered.
    const weak = { lastingEffectiveness: 0.404, meanSuppression: 0 };
    expect(spent(weak, config)).toBe(true);
    expect(recovered(weak, config)).toBe(false);
  });
});

describe('the activity word', () => {
  const force = movingForce();
  const as = (change: Partial<DeepReadonly<FofForce>>) => activityOf({ ...force, ...change });
  it('says what it is doing and why', () => {
    expect(as({ pressOnUntil: 100 }).word).toBe('Pressing on');
    expect(as({ phase: 'possibleContact' }).word).toBe('Observing');
    expect(as({ phase: 'engaged' }).word).toBe('Engaging');
    expect(as({ phase: 'assaulting' }).word).toBe('Attacking');
    expect(as({ phase: 'withdrawing' }).word).toBe('Withdrawing');
    expect(as({ phase: 'inAmbush', concealed: true }).word).toBe('Waiting');
    expect(as({ phase: 'ineffective' }).word).toBe('Ineffective');
    expect(as({ phase: 'withdrawing', brokenWithdrawal: true }).why).toMatch(/broken/);
    const ordered = as({ phase: 'moving', combatIneffective: true });
    expect(ordered.word).toBe('Moving');
    expect(ordered.why).toMatch(/\(combat ineffective\)$/);
  });

  it('holding: regrouping, recovering, or spent', () => {
    const holding = { phase: 'holding', lastingEffectiveness: 0.538 } as const;
    expect(as({ ...holding, meanSuppression: 0 }).word).toBe('Regrouping');
    const suppressed = as({ ...holding, meanSuppression: 0.4 });
    expect(suppressed.word).toBe('Recovering');
    expect(suppressed.why).toMatch(/suppressed \(40 %\)/);
    expect(as({ ...holding, holdUntilRecovered: true, meanSuppression: 0.4 }).word).toBe(
      'Recovering',
    );
    const weak = as({ phase: 'holding', lastingEffectiveness: 0.404, holdUntilRecovered: true });
    expect(weak.word).toBe('Spent');
    expect(weak.why).toMatch(/at best 40 %, under 50 %/);
    expect(as({ ...holding, actionsOn: 'hold' }).word).toBe('Holding');
  });
});
