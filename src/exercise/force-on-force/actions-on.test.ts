import { describe, expect, it } from 'vitest';
import {
  hashSimState,
  lineOfSight,
  validateFofSetup,
  type ActionsOn,
  type FofFireEvent,
  type ForcePhaseChangedEvent,
  type SimEvent,
} from '#sim';
import { withConfig } from './experiments';
import { createFofRun, FOF_DEFAULT_CONFIG, type FofRun, type FofRunSpec } from './run';
import { headOn } from './test-specs';

// Actions on contact (docs/behavior-lab/force-on-force/03 §4.1): what each
// force does when it comes into contact — attack, withdraw or continue.

const phasesOf = (events: readonly SimEvent[]) =>
  events.filter((e): e is ForcePhaseChangedEvent => e.type === 'forcePhaseChanged');

function spec(terrain: FofRunSpec['terrain'], seed: number, blue: ActionsOn, red: ActionsOn) {
  const base = headOn(terrain, seed);
  return {
    ...base,
    blufor: { ...base.blufor, actionsOn: blue },
    opfor: { ...base.opfor, actionsOn: red },
  };
}

/** Steps to the outcome, calling `each` after every tick; returns every event. */
function finish(run: FofRun, each?: (events: readonly SimEvent[]) => void): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < 3000 * run.spec.tickRateHz && !run.done; i += 1) {
    const stepped = run.step();
    events.push(...stepped);
    each?.(stepped);
  }
  return events;
}

function centre(run: FofRun, side: string) {
  const own = run.sim.state.soldiers.filter((s) => s.side === side && s.status === 'active');
  return {
    x: own.reduce((sum, s) => sum + s.position.x, 0) / Math.max(1, own.length),
    y: own.reduce((sum, s) => sum + s.position.y, 0) / Math.max(1, own.length),
  };
}

const gap = (run: FofRun) => {
  const b = centre(run, 'BLUEFOR');
  const o = centre(run, 'OPFOR');
  return Math.hypot(b.x - o.x, b.y - o.y);
};

describe('actions on contact: attack', () => {
  for (const terrain of ['open', 'urban'] as const) {
    it(`${terrain}: returns fire, then assaults the enemy's believed position, closing under its own covering fire`, () => {
      const run = createFofRun(spec(terrain, 1, 'attack', 'continue'));
      const at: { assault: number | null } = { assault: null };
      let closest = Infinity;
      let assaultFire = 0;
      let rejected = 0;
      const events = finish(run, (stepped) => {
        const blue = run.sim.state.fof?.forces[0];
        for (const e of stepped) {
          if (e.type === 'commandRejected') rejected += 1;
          if (e.type === 'forcePhaseChanged' && e.side === 'BLUEFOR' && e.to === 'assaulting') {
            at.assault ??= gap(run);
          }
          if (e.type === 'fofFire' && e.side === 'BLUEFOR' && blue?.phase === 'assaulting') {
            assaultFire += 1;
          }
        }
        if (blue?.phase === 'assaulting') {
          closest = Math.min(closest, gap(run));
          // It assaults where it believes the enemy is.
          expect(blue.objective).not.toBeNull();
        }
      });
      const blue = phasesOf(events).filter((e) => e.side === 'BLUEFOR');
      const contact = blue.find((e) => e.to === 'contact');
      const assault = blue.find((e) => e.to === 'assaulting');
      expect(contact).toBeDefined();
      expect(assault).toBeDefined();
      // It returns fire and locates the enemy first.
      expect((assault?.atSeconds ?? 0) - (contact?.atSeconds ?? 0)).toBeGreaterThanOrEqual(
        FOF_DEFAULT_CONFIG.force.assaultAfterSeconds - 1e-9,
      );
      expect(events.some((e) => e.type === 'fofFire' && e.side === 'BLUEFOR')).toBe(true);
      // Moving forward into contact.
      expect(at.assault).not.toBeNull();
      expect(closest).toBeLessThan((at.assault ?? 0) - 25);
      expect(assaultFire).toBeGreaterThan(0);
      expect(rejected).toBe(0);
      expect(run.outcome?.basis).not.toBe('invalid');
      // The other force is not attacking.
      expect(phasesOf(events).some((e) => e.side === 'OPFOR' && e.to === 'assaulting')).toBe(false);
    }, 120_000);
  }

  it('once the enemy is broken, the winner returns to its original movement order', () => {
    // Both attack; whichever wins (not itself breaking contact) heads back to its first order.
    let checked = 0;
    for (const seed of [1, 2, 3]) {
      const s = spec('open', seed, 'attack', 'attack');
      const run = createFofRun(s);
      finish(run);
      const outcome = run.outcome?.outcome;
      if (outcome !== 'blueforVictory' && outcome !== 'opforVictory') continue;
      const index = outcome === 'blueforVictory' ? 0 : 1;
      const winner = run.sim.state.fof?.forces[index];
      if (!winner || winner.phase === 'withdrawing' || winner.phase === 'withdrawn') continue;
      const task = run.sim.state.behavior?.tasks.find(
        (t) => t.unitId === winner.unitId && t.outcome === null,
      );
      const destination = (index === 0 ? s.blufor : s.opfor).destination;
      expect(winner.phase).toBe('moving');
      expect(task?.order.kind).toBe('moveInFormation');
      if (task?.order.kind === 'moveInFormation')
        expect(task.order.destination).toEqual(destination);
      // ... and it gets there (the experiment is over: nobody fires).
      const before = run.sim.timeSeconds;
      while (!run.settled) {
        const stepped = run.step();
        expect(stepped.some((e) => e.type === 'fofFire')).toBe(false);
      }
      expect(run.sim.timeSeconds).toBeGreaterThan(before);
      const at = centre(run, winner.side);
      expect(Math.hypot(at.x - (destination?.x ?? 0), at.y - (destination?.y ?? 0))).toBeLessThan(
        40,
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  }, 300_000);
});

describe('actions on contact: attack by fire and movement', () => {
  for (const terrain of ['open', 'urban'] as const) {
    it(`${terrain}: one element (a fire team, or the squad leader) rushes at a time, not firing, while the others fire from the ground`, () => {
      const run = createFofRun(spec(terrain, 1, 'attack', 'continue'));
      const teams = new Map<string, number>();
      let order: string[] = [];
      let lastUnit: string | null = null;
      let coverFire = 0;
      let boundTicks = 0;
      let fastest = 0;
      const before = new Map<string, { x: number; y: number }>();
      finish(run, (stepped) => {
        const blue = run.sim.state.fof?.forces[0];
        if (blue?.phase !== 'assaulting') return;
        const bounding = new Set<string>(blue.bounding);
        for (const e of stepped) {
          if (e.type !== 'fofFire' || e.side !== 'BLUEFOR') continue;
          // Bounding soldiers do not fire; the base of fire does.
          expect(bounding.has(e.shooterId)).toBe(false);
          if (bounding.size > 0) coverFire += 1;
        }
        if (bounding.size === 0) {
          lastUnit = null;
          return;
        }
        boundTicks += 1;
        // One element at a time: a fire team, or the squad leader.
        expect(bounding.size).toBeLessThanOrEqual(5);
        const units = new Set(
          run.sim.state.soldiers.filter((s) => bounding.has(s.id)).map((s) => s.unitId),
        );
        expect([...units].filter((u) => u.includes('-FT')).length).toBeLessThanOrEqual(1);
        if (blue.boundUnit !== lastUnit && blue.boundUnit) {
          order = [...order, blue.boundUnit];
          teams.set(blue.boundUnit, (teams.get(blue.boundUnit) ?? 0) + 1);
        }
        lastUnit = blue.boundUnit;
        // Rushing: faster than a walk.
        for (const s of run.sim.state.soldiers) {
          if (!bounding.has(s.id) || s.status !== 'active') continue;
          const was = before.get(s.id);
          if (was) {
            fastest = Math.max(
              fastest,
              Math.hypot(s.position.x - was.x, s.position.y - was.y) * run.spec.tickRateHz,
            );
          }
          before.set(s.id, { x: s.position.x, y: s.position.y });
        }
      });
      // Several bounds, by different teams in turn.
      expect(order.length).toBeGreaterThanOrEqual(2);
      expect(teams.size).toBeGreaterThanOrEqual(2);
      for (let k = 1; k < order.length; k += 1) expect(order[k]).not.toBe(order[k - 1]);
      expect(boundTicks).toBeGreaterThan(0);
      expect(coverFire).toBeGreaterThan(0);
      expect(fastest).toBeGreaterThan(2);
    }, 120_000);
  }

  it('a fire team (no subordinate units) bounds in two halves', () => {
    const base = spec('open', 1, 'attack', 'continue');
    const run = createFofRun({
      ...base,
      blufor: { ...base.blufor, organization: 'fireTeam', formation: 'usmc.fireTeam.wedge' },
    });
    const sizes = new Set<number>();
    finish(run, () => {
      const blue = run.sim.state.fof?.forces[0];
      if (blue?.phase === 'assaulting' && blue.bounding.length > 0) sizes.add(blue.bounding.length);
    });
    expect(sizes.size).toBeGreaterThan(0);
    expect([...sizes].every((n) => n <= 2)).toBe(true);
  }, 120_000);
});

describe('actions on contact: attack, firing positions', () => {
  /** The share of looks (each second, while assaulting) in which a soldier of the base of fire, prone, sees an enemy. */
  function baseOfFireSight(searchDegrees: number, seeds: readonly number[]) {
    let looks = 0;
    let seeing = 0;
    for (const seed of seeds) {
      const run = createFofRun({
        ...spec('urban', seed, 'attack', 'continue'),
        config: withConfig((c) => {
          c.force.boundSearchDegrees = searchDegrees;
        }),
      });
      const terrain = run.sim.world.terrain;
      finish(run, () => {
        const fof = run.sim.state.fof;
        const blue = fof?.forces[0];
        if (blue?.phase !== 'assaulting' || run.sim.tick % run.spec.tickRateHz !== 0) return;
        const enemies = run.sim.state.soldiers.filter(
          (s) => s.side === 'OPFOR' && s.status === 'active',
        );
        for (const m of fof?.soldiers ?? []) {
          if (m.force !== 0 || !m.reacted || blue.bounding.includes(m.soldierId)) continue;
          const s = run.sim.state.soldiers.find((x) => x.id === m.soldierId);
          if (s?.status !== 'active') continue;
          looks += 1;
          if (
            enemies.some(
              (e) =>
                lineOfSight(terrain, s.position, e.position, {
                  observerHeightMeters: 0.3,
                  targetHeightMeters: 0.5,
                }).clear,
            )
          ) {
            seeing += 1;
          }
        }
      });
    }
    return seeing / Math.max(1, looks);
  }

  it('in town, bounding to firing positions gives the base of fire more sight of the enemy than bounding straight', () => {
    const seeds = [1, 2, 3, 4];
    const straight = baseOfFireSight(0, seeds);
    const searched = baseOfFireSight(FOF_DEFAULT_CONFIG.force.boundSearchDegrees, seeds);
    expect(FOF_DEFAULT_CONFIG.force.boundSearchDegrees).toBeGreaterThan(0);
    expect(searched).toBeGreaterThan(straight + 0.05);
  }, 300_000);
});

describe('actions on contact: withdraw', () => {
  it('disengages at once and moves back to where it started, firing on the move', () => {
    const s = spec('urban', 1, 'withdraw', 'continue');
    const run = createFofRun(s);
    const seen: {
      destination: { x: number; y: number } | null;
      atWithdrawal: { x: number; y: number } | null;
    } = { destination: null, atWithdrawal: null };
    const events = finish(run, (stepped) => {
      for (const e of stepped) {
        if (e.type === 'forcePhaseChanged' && e.side === 'BLUEFOR' && e.to === 'withdrawing') {
          seen.atWithdrawal ??= centre(run, 'BLUEFOR');
          const task = run.sim.state.behavior?.tasks.find(
            (t) => t.unitId === 'B-SQD' && t.outcome === null,
          );
          if (task?.order.kind === 'moveInFormation') seen.destination ??= task.order.destination;
        }
      }
    });
    const blue = phasesOf(events).filter((e) => e.side === 'BLUEFOR');
    const withdrawal = blue.find((e) => e.to === 'withdrawing');
    expect(withdrawal?.reason).toMatch(/^actions on contact: withdraw/);
    // At once: it never halts to fight first.
    const firstContact = blue.findIndex((e) => e.to === 'contact' || e.to === 'withdrawing');
    expect(blue[firstContact]?.to).toBe('withdrawing');
    // Back to its start.
    const { destination, atWithdrawal } = seen;
    expect(destination).not.toBeNull();
    expect(
      Math.hypot(
        (destination?.x ?? 0) - s.blufor.start.x,
        (destination?.y ?? 0) - s.blufor.start.y,
      ),
    ).toBeLessThan(15);
    expect(run.outcome?.outcome).toMatch(/blueforWithdrawal|mutualDisengagement|opforVictory/);
    while (!run.settled) run.step();
    const home = centre(run, 'BLUEFOR');
    const from = atWithdrawal ?? home;
    expect(Math.hypot(home.x - s.blufor.start.x, home.y - s.blufor.start.y)).toBeLessThan(
      Math.hypot(from.x - s.blufor.start.x, from.y - s.blufor.start.y),
    );
    expect(phasesOf(events).some((e) => e.side === 'BLUEFOR' && e.to === 'assaulting')).toBe(false);
  }, 120_000);
});

describe('actions on contact: continue', () => {
  it('is the default, and never assaults', () => {
    const a = createFofRun(headOn('open', 2));
    const b = createFofRun(spec('open', 2, 'continue', 'continue'));
    const events = finish(a);
    finish(b);
    expect(hashSimState(a.sim.state)).toBe(hashSimState(b.sim.state));
    expect(phasesOf(events).some((e) => e.to === 'assaulting')).toBe(false);
    expect(phasesOf(events).some((e) => e.reason.startsWith('actions on contact: withdraw'))).toBe(
      false,
    );
  }, 120_000);
});

describe('actions on contact: determinism and validation', () => {
  it('an attack is bit-identical when repeated, and reaches the same outcome at 30 and 120 Hz', () => {
    const run = (rate: number) => {
      const r = createFofRun({ ...spec('open', 3, 'attack', 'withdraw'), tickRateHz: rate });
      const fires = finish(r).filter((e): e is FofFireEvent => e.type === 'fofFire').length;
      return { hash: hashSimState(r.sim.state), outcome: r.outcome, fires };
    };
    const first = run(30);
    expect(run(30)).toEqual(first);
    const fast = run(120);
    expect(fast.outcome?.outcome).toBe(first.outcome?.outcome);
    expect(fast.outcome?.atSeconds).toBe(first.outcome?.atSeconds);
    expect(fast.fires).toBe(first.fires);
  }, 300_000);

  it('rejects an unknown action', () => {
    const r = createFofRun(headOn('open', 1));
    const setup = r.sim.world.fof;
    if (!setup) throw new Error('no setup');
    const units = r.sim.state.units.map((u) => ({ ...u }));
    const soldiers = r.sim.state.soldiers.map((s) => ({ ...s }));
    const bad = {
      ...setup,
      forces: setup.forces.map((f, i) =>
        i === 0 ? { ...f, actionsOn: 'charge' as ActionsOn } : f,
      ),
    };
    expect(() => {
      validateFofSetup(bad, units, soldiers as never);
    }).toThrow(/unknown actions on contact "charge"/);
  });
});
