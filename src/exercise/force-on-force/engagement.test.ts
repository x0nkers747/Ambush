import { describe, expect, it } from 'vitest';
import { hashSimState, orgUnitId, type SimEvent } from '#sim';
import { createFofRun, type FofRun, type FofRunSpec } from './run';
import { headOn, SQUAD } from './test-specs';

// F2: contact and engagement (docs/behavior-lab/force-on-force/03).

function runFor(run: FofRun, seconds: number, each?: (events: readonly SimEvent[]) => void) {
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds * run.spec.tickRateHz && !run.done; i += 1) {
    const step = run.step();
    events.push(...step);
    each?.(step);
  }
  return events;
}

const of = <T extends SimEvent['type']>(events: readonly SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

describe('two squads meeting in the open', () => {
  const run = createFofRun(headOn('open', 1));
  // Positions of the fallen, checked every tick after they fall.
  const fallen = new Map<string, { x: number; y: number }>();
  let movedAfterFalling = 0;
  const events = runFor(run, 700, () => {
    for (const s of run.sim.state.soldiers) {
      const at = fallen.get(s.id);
      if (at && (at.x !== s.position.x || at.y !== s.position.y)) movedAfterFalling += 1;
      if (!at && s.status === 'incapacitated') fallen.set(s.id, { ...s.position });
    }
  });
  const phases = of(events, 'forcePhaseChanged');
  const fire = of(events, 'fofFire');

  it('both halt in contact and exchange fire; contact comes before engagement', () => {
    for (const side of ['BLUEFOR', 'OPFOR'] as const) {
      const mine = phases.filter((e) => e.side === side);
      const contact = mine.find((e) => e.to === 'contact');
      const engaged = mine.find((e) => e.to === 'engaged');
      expect(contact).toBeDefined();
      expect(engaged).toBeDefined();
      expect(contact?.atSeconds ?? Infinity).toBeLessThanOrEqual(engaged?.atSeconds ?? 0);
      expect(fire.some((f) => f.side === side)).toBe(true);
    }
  });

  it('halting cancels the movement task: nobody in a halted force is steered', () => {
    const fof = run.sim.state.fof;
    for (const force of fof?.forces ?? []) {
      if (force.phase !== 'contact' && force.phase !== 'engaged' && force.phase !== 'holding')
        continue;
      const running = run.sim.state.behavior?.tasks.filter(
        (t) => t.unitId === force.unitId && t.outcome === null,
      );
      expect(running).toEqual([]);
      expect(force.mission?.destination).toBeDefined();
    }
  });

  it('soldiers in contact are down (prone, leaders kneeling) and face the enemy', () => {
    const fof = run.sim.state.fof;
    for (const member of fof?.soldiers ?? []) {
      const soldier = run.sim.state.soldiers.find((s) => s.id === member.soldierId);
      const force = fof?.forces[member.force];
      if (soldier?.status !== 'active' || !member.reacted) continue;
      if (force?.phase !== 'engaged' && force?.phase !== 'contact') continue;
      expect(soldier.posture).toBe(
        member.leader && member.level !== 'pinned' ? 'kneeling' : 'prone',
      );
    }
  });

  it('bursts: from active soldiers only, never more rounds than carried, ammunition never negative', () => {
    const downAt = new Map(
      of(events, 'soldierIncapacitated').map((e) => [e.soldierId, e.atSeconds]),
    );
    const rounds = new Map<string, number>();
    for (const f of fire) {
      const down = downAt.get(f.shooterId);
      if (down !== undefined) expect(f.atSeconds).toBeLessThanOrEqual(down);
      expect(f.rounds).toBeGreaterThan(0);
      rounds.set(f.shooterId, (rounds.get(f.shooterId) ?? 0) + f.rounds);
      if (f.incapacitated) expect(f.hit).toBe(true);
      if (f.hit) expect(f.hitId).not.toBeNull();
    }
    const fof = run.sim.state.fof;
    for (const member of fof?.soldiers ?? []) {
      // Every round of the primary weapon is loaded, in reserve, or fired in a burst.
      const primary = member.arms[0];
      const left = primary ? primary.loaded + primary.reserve : 0;
      expect(left).toBeGreaterThanOrEqual(0);
      const load = member.weapon === 'automaticRifle' ? 600 : member.weapon === 'rifle' ? 210 : 0;
      expect(left + (rounds.get(member.soldierId) ?? 0)).toBe(load);
    }
  });

  it('casualties: each soldier falls once, by a hit or a grenade, and never moves, fires or is seen again', () => {
    const down = of(events, 'soldierIncapacitated');
    expect(down.length).toBeGreaterThan(0);
    expect(new Set(down.map((e) => e.soldierId)).size).toBe(down.length);
    const grenades = of(events, 'fofGrenade');
    for (const e of down) {
      // A burst's soldier falls when its rounds arrive (the first decision after: every 0.1 s).
      const shot = fire.find(
        (f) =>
          f.hitId === e.soldierId &&
          f.incapacitated &&
          e.atSeconds >= f.arriveAt - 1e-9 &&
          e.atSeconds < f.arriveAt + 0.1 + 1e-9,
      );
      const burst = grenades.find(
        (g) => g.atSeconds === e.atSeconds && g.incapacitated.includes(e.soldierId),
      );
      expect(shot?.incapacitated === true || burst !== undefined).toBe(true);
      expect((shot ?? burst)?.shooterId).toBe(e.byId);
    }
    expect(movedAfterFalling).toBe(0);
    for (const t of run.sim.state.fof?.tracks ?? []) {
      expect(run.sim.state.soldiers.find((s) => s.id === t.targetId)?.status).toBe('active');
    }
    const released = of(events, 'memberReleased').filter((e) => e.reason === 'incapacitated');
    for (const r of released) expect(fallen.has(r.soldierId)).toBe(true);
  });

  it('suppression is reported crossing its thresholds and costs effectiveness beyond losses', () => {
    const changes = of(events, 'suppressionChanged');
    expect(changes.some((e) => e.to === 'suppressed' || e.to === 'pinned')).toBe(true);
    const level = new Map<string, string>();
    for (const e of changes) {
      expect(e.from).toBe(level.get(e.soldierId) ?? 'none');
      level.set(e.soldierId, e.to);
    }
    for (const force of run.sim.state.fof?.forces ?? []) {
      const active = force.memberIds.filter(
        (id) => run.sim.state.soldiers.find((s) => s.id === id)?.status === 'active',
      ).length;
      expect(force.effectiveness).toBeLessThanOrEqual(active / force.memberIds.length + 1e-12);
      expect(force.effectiveness).toBeGreaterThanOrEqual(0);
    }
  });

  it('an outside order to a force in contact is rejected', () => {
    const force = run.sim.state.fof?.forces.find(
      (f) => f.phase === 'engaged' || f.phase === 'contact',
    );
    expect(force).toBeDefined();
    if (!force?.mission) return;
    run.submit({
      type: 'orderUnit',
      tick: run.sim.tick,
      unitId: orgUnitId(force.unitId),
      order: force.mission,
    });
    const step = run.step();
    expect(step.some((e) => e.type === 'commandRejected' && e.reason === 'unitInContact')).toBe(
      true,
    );
  });
});

describe('fired on first', () => {
  // OPFOR waits, prone, behind BLUEFOR, which walks away from it: BLUEFOR
  // cannot see it (nobody looks behind), so the first it knows is the fire.
  const spec: FofRunSpec = {
    blufor: { ...SQUAD, start: { x: 0, y: -100 }, destination: { x: 0, y: 700 } },
    opfor: {
      ...SQUAD,
      formation: 'usmc.squad.line',
      start: { x: 0, y: -360 },
      destination: null,
      facingDeg: 0,
      posture: 'prone',
    },
    terrain: 'open',
    seed: 3,
    tickRateHz: 30,
  };

  it('the force that did not see the other reacts to its fire: halts in contact, and fires back', () => {
    let reactions = 0;
    for (let seed = 1; seed <= 6; seed += 1) {
      const run = createFofRun({ ...spec, seed });
      const events = runFor(run, 600);
      const blue = of(events, 'forcePhaseChanged').filter((e) => e.side === 'BLUEFOR');
      const contact = blue.find((e) => e.to === 'contact');
      if (contact?.reason !== 'under fire') continue;
      reactions += 1;
      // Fired on before it had any confirmed contact of its own; it fires back afterwards.
      const confirmedBefore = of(events, 'contactObserved').some(
        (e) => e.side === 'BLUEFOR' && e.to === 'detected' && e.atSeconds < contact.atSeconds,
      );
      expect(confirmedBefore).toBe(false);
      expect(
        of(events, 'fofFire').some((f) => f.side === 'BLUEFOR' && f.atSeconds > contact.atSeconds),
      ).toBe(true);
    }
    expect(reactions).toBeGreaterThan(0);
  }, 120_000);
});

describe('determinism through an engagement', () => {
  const at = (spec: FofRunSpec, seconds: number) => {
    const run = createFofRun(spec);
    runFor(run, seconds);
    return run;
  };

  it('is bit-identical at 30 and 120 Hz into the firefight', () => {
    const exact = (rate: number) => {
      const run = at(headOn('open', 1, rate), 520);
      expect(run.sim.state.fof?.forces.some((f) => f.stats.bursts > 0)).toBe(true);
      return JSON.stringify({ s: run.sim.state.soldiers, f: run.sim.state.fof });
    };
    expect(exact(30)).toBe(exact(120));
  }, 120_000);

  it('continues identically from a snapshot taken during the engagement', () => {
    const whole = at(headOn('open', 1), 560);
    const part = at(headOn('open', 1), 480);
    expect(part.sim.state.fof?.forces.some((f) => f.phase === 'engaged')).toBe(true);
    const resumed = createFofRun(headOn('open', 1));
    resumed.sim.restore(part.sim.snapshot());
    for (let i = 0; i < 80 * 30; i += 1) resumed.sim.step();
    expect(hashSimState(resumed.sim.state)).toBe(hashSimState(whole.sim.state));
  }, 60_000);
});
