import { beforeAll, describe, expect, it } from 'vitest';
import { labTerrain } from '#exercise/behavior-lab';
import {
  addOrder,
  addSquad,
  newBattleScenario,
  type BattleEdit,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import { createCombat, type Combat } from './combat';
import { createReview } from './review';
import type { BattleRecording, TimedEvent } from './session';

// Weapons in a battle (docs/behavior-lab/force-on-force/06 §5): the bursts,
// reloads, grenades and exhausted weapons of a battle fought are kept in its
// log, the After-Action Review shows exactly the same ones (it re-simulates,
// verified every second, and draws nothing anew), and the battle is the
// same at any playback speed.

const terrain = labTerrain();
const done = (edit: BattleEdit): BattleScenarioDefinition => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};

/** Two squads a side, 500 m apart, attacking each other. */
function scenario(): BattleScenarioDefinition {
  let d = newBattleScenario(terrain, 'bf');
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: -60, y: -250 }));
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 60, y: -250 }));
  d = done(addSquad(terrain, d, 'OPFOR', 'squad', { x: -60, y: 250 }));
  d = done(addSquad(terrain, d, 'OPFOR', 'squad', { x: 60, y: 250 }));
  for (const id of ['B1', 'B2']) d = done(addOrder(terrain, d, id, 'attack', { x: 0, y: 250 }));
  for (const id of ['O1', 'O2']) d = done(addOrder(terrain, d, id, 'attack', { x: 0, y: -250 }));
  return d;
}

/** Fought to `seconds` at `speed`, the frames `frameSeconds` of wall time long. */
function fought(seconds: number, speed: 1 | 32, frameSeconds: number): Combat {
  const c = createCombat({
    terrain,
    definition: scenario(),
    notify: () => undefined,
    stepBudgetMs: Infinity,
  });
  c.setSpeed(speed);
  c.play();
  while (c.session.seconds < seconds) c.frame(frameSeconds);
  return c;
}

const WEAPON_EVENTS = new Set([
  'fofFire',
  'fofGrenade',
  'fofReload',
  'ammunitionExhausted',
  'soldierIncapacitated',
]);
const weaponEvents = (events: readonly TimedEvent[], until: number) =>
  JSON.stringify(events.filter((e) => WEAPON_EVENTS.has(e.event.type) && e.event.tick < until));

describe('weapons in a battle and its review', { timeout: 120_000 }, () => {
  const battle = fought(300, 32, 0.25);
  let recording: BattleRecording;
  beforeAll(async () => {
    battle.end();
    recording = await battle.recording();
  });

  it('the battle log keeps the bursts, reloads and grenades', () => {
    const types = new Set(battle.session.events.map((e) => e.event.type));
    for (const t of ['fofFire', 'fofReload', 'fofGrenade'])
      expect(types.has(t as never)).toBe(true);
    const squads = battle.squads();
    // The selected squad's panel: its rounds by weapon.
    // (Counted over its soldiers still up.)
    const b1 = squads.find((s) => s.up >= 5);
    expect(b1?.ammunition.map((a) => a.weapon).sort()).toEqual([
      'automaticRifle',
      'grenadeLauncher',
      'rifle',
    ]);
    expect(b1?.ammunition.every((a) => a.loaded + a.reserve >= 0)).toBe(true);
  });

  it('the review re-simulates exactly the same weapon events, verified every second', () => {
    const review = createReview({ terrain, recording, budgetMs: Infinity });
    expect(review.verification).toMatchObject({ mismatches: 0, complete: true });
    const end = recording.endTick;
    expect(weaponEvents(review.replay.events, end)).toBe(weaponEvents(battle.session.events, end));
    // The squads' ammunition at the end is the battle's.
    review.seek(review.endSeconds);
    expect(review.squads().map((s) => s.ammunition)).toEqual(
      battle.squads().map((s) => s.ammunition),
    );
  });

  it('is the same battle at 1× in small frames as at 32×', () => {
    const slow = fought(120, 1, 1 / 60);
    const until = Math.min(slow.session.tick, battle.session.tick, 120 * 30);
    expect(weaponEvents(slow.session.events, until)).toBe(
      weaponEvents(battle.session.events, until),
    );
    expect(slow.session.hashes.slice(0, 120)).toEqual(battle.session.hashes.slice(0, 120));
  });
});
