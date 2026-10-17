import { describe, expect, it } from 'vitest';
import type { ActionsOn, ForcePhaseChangedEvent, SimEvent } from '#sim';
import { labTerrain } from '../behavior-lab/run';
import { woodsFeatures } from '../force-on-force/woods';
import { assaultFormationId } from '../forces/forces';
import { createBattle, orderSquad, type BattleSpec } from './battle';
import {
  actionsOnOf,
  addOrder,
  addSquad,
  defaultActionsOn,
  newBattleScenario,
  parseBattleScenario,
  setOrderActionsOn,
  setOrderKind,
  type BattleEdit,
  type BattleScenarioDefinition,
} from './scenario';

// Actions on contact (docs/behavior-lab/force-on-force/07): each order says
// what the squad does on contact (continue, attack, hold, avoid), and
// squads in contact take postures they can see from, press on through
// contact they cannot engage, and never flip between withdrawing and
// holding. Two squads 600 m apart walk at each other through woods, as in
// a scenario where contact comes from glimpses through the trees.

const START = { blue: { x: 0, y: -300 }, red: { x: 30, y: 300 } };

function ground(seed: number) {
  return labTerrain(
    woodsFeatures({
      seed,
      half: 600,
      keepClear: [START.blue, START.red, { x: 0, y: 250 }, { x: 30, y: -250 }],
      clearRadius: 35,
    }),
  );
}

function spec(seed: number, blue: ActionsOn, red: ActionsOn = 'continue'): BattleSpec {
  return {
    seed,
    tickRateHz: 30,
    squads: [
      {
        id: 'B1',
        name: 'Blue',
        side: 'BLUEFOR',
        organization: 'squad',
        position: START.blue,
        facingDeg: 0,
        plan: [{ kind: 'move', destination: { x: 0, y: 250 }, actionsOn: blue }],
      },
      {
        id: 'O1',
        name: 'Red',
        side: 'OPFOR',
        organization: 'squad',
        position: START.red,
        facingDeg: 180,
        plan: [{ kind: 'move', destination: { x: 30, y: -250 }, actionsOn: red }],
      },
    ],
  };
}

interface Fought {
  readonly events: SimEvent[];
  readonly phases: ForcePhaseChangedEvent[];
  readonly battle: ReturnType<typeof createBattle>;
}

const fights = new Map<string, Fought>();
/** A battle fought for `seconds` (cached: several tests read the same one). */
function fight(seed: number, blue: ActionsOn, seconds = 900, red: ActionsOn = 'continue'): Fought {
  const key = `${String(seed)}/${blue}/${red}/${String(seconds)}`;
  const known = fights.get(key);
  if (known) return known;
  const battle = createBattle(spec(seed, blue, red), ground(seed));
  const events: SimEvent[] = [];
  for (let tick = 1; tick <= seconds * 30; tick += 1) events.push(...battle.step());
  const phases = events.filter((e): e is ForcePhaseChangedEvent => e.type === 'forcePhaseChanged');
  const fought = { events, phases, battle };
  fights.set(key, fought);
  return fought;
}

const blue = (f: Fought) => f.phases.filter((e) => e.side === 'BLUEFOR');
const SEEDS = [1, 2, 3];

describe('actions on contact', { timeout: 300_000 }, () => {
  it('hold: halts on contact and never moves on until ordered', () => {
    let contacts = 0;
    for (const seed of SEEDS) {
      const phases = blue(fight(seed, 'hold'));
      const first = phases.findIndex((e) => e.to === 'contact');
      if (first < 0) continue;
      contacts += 1;
      const after = phases.slice(first);
      // It fights from where it halted (or, spent, breaks contact): never moves on or assaults.
      expect(after.some((e) => e.to === 'moving' || e.to === 'assaulting')).toBe(false);
      // Its move order is still active: it waits for new orders.
      const order = fight(seed, 'hold').battle.sim.state.fof?.forces[0]?.orders[0];
      if (after.every((e) => e.to !== 'withdrawing')) expect(order?.status).toBe('active');
    }
    expect(contacts).toBeGreaterThan(0);
  });

  it('avoid (withdraw): falls back as soon as it sees the enemy, holds its fire until fired upon, then holds', () => {
    let avoided = 0;
    for (const seed of SEEDS) {
      const f = fight(seed, 'withdraw');
      const phases = blue(f);
      const first = phases.find(
        (e) => e.to !== 'moving' && e.to !== 'possibleContact' && e.to !== 'atObjective',
      );
      if (!first) continue;
      avoided += 1;
      // Its first reaction to contact is to fall back, not to fight.
      expect(first.to).toBe('withdrawing');
      expect(first.reason).toMatch(/actions on contact: withdraw/);
      // It fires only once it has been fired upon.
      const fire = f.events.filter((e) => e.type === 'fofFire');
      const firstRed = fire.find((e) => e.side === 'OPFOR');
      const firstBlue = fire.find((e) => e.side === 'BLUEFOR');
      if (firstBlue) expect(firstRed && firstRed.atSeconds <= firstBlue.atSeconds).toBe(true);
      // Having fallen back, it never resumes its move toward the enemy.
      expect(phases.some((e) => e.to === 'moving' && e.atSeconds > first.atSeconds)).toBe(false);
    }
    expect(avoided).toBeGreaterThan(0);
  });

  it('attack: assaults the enemy in an extended line', () => {
    let assaults = 0;
    for (const seed of SEEDS) {
      const f = fight(seed, 'attack');
      if (blue(f).some((e) => e.to === 'assaulting' && e.reason.includes('attack'))) assaults += 1;
      // Its assault formation is the squad's line.
      const setup = f.battle.sim.world.fof?.forces.find((x) => x.side === 'BLUEFOR');
      expect(setup?.assaultFormation).toBeDefined();
    }
    expect(assaults).toBeGreaterThanOrEqual(2);
    expect(assaultFormationId('squad')).toBe('usmc.squad.line');
    expect(assaultFormationId('fireTeam')).toBe('usmc.fireTeam.skirmishers');
  });

  it('continue: presses on through contact it cannot engage, without halting at once; under fire, crawling', () => {
    let pressed = 0;
    // Six fights: whether one comes to have nothing to engage depends on how it went before.
    for (const seed of [...SEEDS, 4, 5, 6]) {
      const f = fight(seed, 'continue');
      for (const side of ['BLUEFOR', 'OPFOR'] as const) {
        const phases = f.phases.filter((e) => e.side === side);
        for (const e of phases.filter((x) => x.reason.startsWith('nothing to engage: '))) {
          pressed += 1;
          // It does not halt for contact again while pressing on.
          const halt = phases.find((x) => x.atSeconds > e.atSeconds && x.to === 'contact');
          if (halt) expect(halt.atSeconds - e.atSeconds).toBeGreaterThanOrEqual(45 - 0.2);
          // Fired upon (by the other squad, the only one) within 15 s, it crawls on.
          const fired = f.events.some(
            (x) =>
              x.type === 'fofFire' &&
              x.side !== side &&
              x.atSeconds <= e.atSeconds &&
              x.atSeconds > e.atSeconds - 15 + 0.2,
          );
          expect(e.reason).toBe(
            fired ? 'nothing to engage: crawling on under fire' : 'nothing to engage: pressing on',
          );
        }
      }
    }
    expect(pressed).toBeGreaterThan(0);
  });

  it('no squad flips between phases (withdrawing and holding) every decision', () => {
    for (const seed of SEEDS) {
      for (const actions of ['continue', 'attack', 'hold', 'withdraw'] as const) {
        const phases = fight(seed, actions).phases;
        for (const side of ['BLUEFOR', 'OPFOR'] as const) {
          const own = phases.filter((e) => e.side === side);
          for (let i = 0; i + 4 < own.length; i += 1) {
            const a = own[i];
            const b = own[i + 4];
            // Five changes within two seconds would be a flip-flop.
            if (a && b) expect(b.atSeconds - a.atSeconds).toBeGreaterThan(2);
          }
        }
      }
    }
  });
});

describe('an order’s actions on contact in a scenario', () => {
  const terrain = labTerrain();
  const done = (e: BattleEdit): BattleScenarioDefinition => {
    if (!e.ok) throw new Error(e.problem);
    return e.definition;
  };
  const withOrder = () => {
    let d = newBattleScenario(terrain, 'bf');
    d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 0, y: 0 }));
    return done(addOrder(terrain, d, 'B1', 'move', { x: 0, y: 200 }));
  };

  it('defaults by the order’s kind, and can be chosen apart from it', () => {
    expect(defaultActionsOn('move')).toBe('continue');
    expect(defaultActionsOn('attack')).toBe('attack');
    expect(defaultActionsOn('withdraw')).toBe('withdraw');
    let d = withOrder();
    expect(d.squads[0]?.plan[0]?.actionsOn).toBe('continue');
    // Changing the kind changes a default actions on contact…
    d = done(setOrderKind(d, 'B1', 0, 'attack'));
    expect(d.squads[0]?.plan[0]?.actionsOn).toBe('attack');
    // …but not one chosen apart from it.
    d = done(setOrderActionsOn(d, 'B1', 0, 'hold'));
    d = done(setOrderKind(d, 'B1', 0, 'move'));
    expect(d.squads[0]?.plan[0]?.actionsOn).toBe('hold');
    expect(setOrderActionsOn(d, 'B1', 3, 'hold').ok).toBe(false);
  });

  it('is saved and read back; an older scenario without it reads its kind’s; an unknown one is refused', () => {
    const d = done(setOrderActionsOn(withOrder(), 'B1', 0, 'withdraw'));
    const read = parseBattleScenario(JSON.parse(JSON.stringify(d)));
    expect(read.squads[0]?.plan[0]?.actionsOn).toBe('withdraw');
    const old = JSON.parse(JSON.stringify(d)) as { squads: { plan: { actionsOn?: string }[] }[] };
    delete old.squads[0]?.plan[0]?.actionsOn;
    const order = parseBattleScenario(old).squads[0]?.plan[0];
    expect(order && actionsOnOf(order)).toBe('continue');
    const bad = JSON.parse(JSON.stringify(d)) as { squads: { plan: { actionsOn?: string }[] }[] };
    const first = bad.squads[0]?.plan[0];
    if (first) first.actionsOn = 'panic';
    expect(() => parseBattleScenario(bad)).toThrow(/actions on contact are unknown/);
  });
});

describe('a broken squad', { timeout: 300_000 }, () => {
  it('falls back 500 m and holds, spent; ordered on, it goes at once', () => {
    let found = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const battle = createBattle(spec(seed, 'continue'), ground(seed));
      const blue = () => battle.sim.state.fof?.forces[0];
      const events: SimEvent[] = [];
      let brokeAt: { x: number; y: number } | null = null;
      const centre = () => {
        const up = battle.sim.state.soldiers.filter(
          (s) => s.unitId.startsWith('B1-') && s.status === 'active',
        );
        return {
          x: up.reduce((a, s) => a + s.position.x, 0) / up.length,
          y: up.reduce((a, s) => a + s.position.y, 0) / up.length,
        };
      };
      while (battle.sim.timeSeconds < 900) {
        events.push(...battle.step());
        const force = blue();
        if (force?.phase === 'withdrawing' && force.brokenWithdrawal) brokeAt ??= centre();
        if (brokeAt && force?.phase === 'holding') break;
      }
      const force = blue();
      if (!brokeAt || force?.phase !== 'holding') continue;
      found += 1;
      // All the way back (500 m from the threat, less what the ground allows), not just clear.
      const back = centre();
      expect(Math.hypot(back.x - brokeAt.x, back.y - brokeAt.y)).toBeGreaterThan(350);
      expect(events.at(-1)).toMatchObject({ reason: 'reached its withdrawal point' });
      // Holding (spent or recovering), the player's order takes it on at once.
      const to = { x: back.x, y: back.y - 80 };
      battle.submit(orderSquad(battle, 'B1', 'replace', [{ kind: 'move', destination: to }]));
      const later: SimEvent[] = [];
      for (let tick = 0; tick < 30; tick += 1) later.push(...battle.step());
      expect(later).toContainEqual(
        expect.objectContaining({ type: 'forcePhaseChanged', from: 'holding', to: 'moving' }),
      );
    }
    expect(found).toBeGreaterThan(0);
  });
});
