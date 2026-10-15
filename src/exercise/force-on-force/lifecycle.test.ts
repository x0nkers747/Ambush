import { describe, expect, it } from 'vitest';
import {
  validateFofConfig,
  type FofConfig,
  type FofFireEvent,
  type FofOutcome,
  type ForcePhaseChangedEvent,
  type SimEvent,
} from '#sim';
import { createFofRun, FOF_DEFAULT_CONFIG, type FofRun, type FofRunSpec } from './run';
import { headOn, SQUAD } from './test-specs';

// F3: the engagement lifecycle and bounded outcomes (docs/behavior-lab/force-on-force/03 §7).

const phasesOf = (events: readonly SimEvent[]) =>
  events.filter((e): e is ForcePhaseChangedEvent => e.type === 'forcePhaseChanged');
const firesOf = (events: readonly SimEvent[]) =>
  events.filter((e): e is FofFireEvent => e.type === 'fofFire');

function finish(run: FofRun, limitSeconds = 2000): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < limitSeconds * run.spec.tickRateHz && !run.done; i += 1) {
    events.push(...run.step());
  }
  return events;
}

type DeepMutable<T> = T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;

/** The default configuration with changes (validated). */
function config(patch: (c: DeepMutable<FofConfig>) => void): FofConfig {
  const c = JSON.parse(JSON.stringify(FOF_DEFAULT_CONFIG)) as DeepMutable<FofConfig>;
  patch(c);
  return validateFofConfig(c);
}

/** No round ever hits. */
function blind(c: DeepMutable<FofConfig>): void {
  for (const w of c.fire.weapons) for (const p of w.hitProbabilityByRange) p.probability = 0;
}

/** No force withdraws or is spent: they fight on to an adjudicated end. */
function stubborn(c: DeepMutable<FofConfig>): void {
  c.force.withdrawSuppression = 1;
  c.force.withdrawAmmunitionFraction = 0;
  c.force.withdrawEffectiveness = 0;
  c.force.ineffectiveEffectiveness = 0;
}

const DECISIVE = new Set([
  'blueforVictory',
  'opforVictory',
  'blueforWithdrawal',
  'opforWithdrawal',
  'mutualIneffective',
  'mutualDisengagement',
  'noContact',
]);

/** The checks every ended run must pass. */
function checkEnded(run: FofRun, events: readonly SimEvent[]): FofOutcome {
  const outcome = run.outcome;
  expect(outcome).not.toBeNull();
  if (!outcome) throw new Error('no outcome');
  const max = (run.spec.config ?? FOF_DEFAULT_CONFIG).termination.maxDurationSeconds;
  expect(outcome.atSeconds).toBeLessThanOrEqual(max + 1e-9);
  expect(outcome.reason.length).toBeGreaterThan(0);
  if (outcome.outcome === 'invalid') expect(outcome.basis).toBe('invalid');
  else expect(outcome.basis).toBe(DECISIVE.has(outcome.outcome) ? 'decisive' : 'adjudicated');
  if (outcome.basis !== 'adjudicated') expect(outcome.advantage).toBeNull();
  // The casualties are the real ones: no hit or casualty invented to end it.
  const down = { BLUEFOR: 0, OPFOR: 0 };
  for (const s of run.sim.state.soldiers) if (s.status !== 'active') down[s.side] += 1;
  expect(outcome.casualties).toEqual(down);
  const fallen = events.filter((e) => e.type === 'soldierIncapacitated').length;
  expect(fallen).toBe(down.BLUEFOR + down.OPFOR);
  // The model's own orders never fail visibly (a refused attempt is retried elsewhere or later).
  expect(events.filter((e) => e.type === 'commandRejected')).toEqual([]);
  const ended = events.filter((e) => e.type === 'fofEnded');
  expect(ended).toHaveLength(1);
  // Nothing fires after the end, even if the simulation is stepped on.
  for (let i = 0; i < 30 * 30; i += 1) {
    expect(run.step().some((e) => e.type === 'fofFire' || e.type === 'contactObserved')).toBe(
      false,
    );
  }
  return outcome;
}

describe('every engagement ends', () => {
  for (const terrain of ['open', 'wooded', 'urban'] as const) {
    it(`${terrain}: two seeds end by a stated rule, before the time limit, with the real casualties`, () => {
      for (const seed of [1, 2]) {
        const run = createFofRun(headOn(terrain, seed));
        checkEnded(run, finish(run));
      }
    }, 120_000);
  }
});

describe('combat ineffectiveness and withdrawal', () => {
  it('a force broken by losses withdraws or is combat ineffective, and then fires no more', () => {
    const run = createFofRun(headOn('open', 1));
    const events = finish(run);
    const outcome = checkEnded(run, events);
    expect(['blueforVictory', 'opforVictory']).toContain(outcome.outcome);
    const loser = outcome.outcome === 'blueforVictory' ? 'OPFOR' : 'BLUEFOR';
    const out = phasesOf(events).find((e) => e.side === loser && e.to === 'ineffective');
    expect(out).toBeDefined();
    expect(outcome.effectiveness[loser]).toBeLessThan(
      FOF_DEFAULT_CONFIG.force.ineffectiveEffectiveness,
    );
    const after = firesOf(events).filter(
      (e) => e.side === loser && e.atSeconds > (out?.atSeconds ?? 0),
    );
    expect(after).toEqual([]);
  }, 60_000);

  it('a withdrawing force moves away from the enemy through the movement engine, standing and on the move', () => {
    // The light-load approach: forces run low and withdraw.
    let withdrawals = 0;
    for (const seed of [1, 2, 3]) {
      const run = createFofRun({
        ...headOn('open', seed),
        config: config((c) => {
          for (const w of c.fire.weapons) w.basicLoadRounds = w.id === 'rifle' ? 40 : 120;
        }),
      });
      const centre = (side: string) => {
        const own = run.sim.state.soldiers.filter((x) => x.side === side && x.status === 'active');
        return {
          x: own.reduce((sum, x) => sum + x.position.x, 0) / Math.max(1, own.length),
          y: own.reduce((sum, x) => sum + x.position.y, 0) / Math.max(1, own.length),
        };
      };
      const gap = (side: string) => {
        const a = centre(side);
        const b = centre(side === 'BLUEFOR' ? 'OPFOR' : 'BLUEFOR');
        return Math.hypot(a.x - b.x, a.y - b.y);
      };
      const events: SimEvent[] = [];
      const starts = new Map<string, { gap: number; tick: number }>();
      const ends = new Map<string, number>();
      while (!run.done) {
        const step = run.step();
        events.push(...step);
        for (const e of phasesOf(step)) {
          if (e.to === 'withdrawing' && !starts.has(e.side)) {
            starts.set(e.side, { gap: gap(e.side), tick: e.tick });
          }
          if (e.to === 'withdrawn') ends.set(e.side, gap(e.side));
        }
        for (const x of run.sim.state.soldiers) {
          if (x.status !== 'active') continue;
          const member = run.sim.state.fof?.soldiers.find((m) => m.soldierId === x.id);
          const phase = run.sim.state.fof?.forces.find((f) => f.side === x.side)?.phase;
          if (phase === 'withdrawing' && member?.level === 'none')
            expect(x.posture).toBe('standing');
        }
      }
      checkEnded(run, events);
      for (const [side, end] of ends) {
        const start = starts.get(side);
        expect(start).toBeDefined();
        if (!start) continue;
        withdrawals += 1;
        const unit = run.forces.find((f) => f.side === side)?.unitId;
        expect(
          events.some((e) => e.type === 'unitOrdered' && e.unitId === unit && e.tick >= start.tick),
        ).toBe(true);
        expect(end).toBeGreaterThan(start.gap + 50);
      }
    }
    expect(withdrawals).toBeGreaterThan(0);
  }, 60_000);
});

describe('adjudicated ends', () => {
  it('stalemate: no hits and no change over the window (not merely no casualties)', () => {
    const run = createFofRun({
      ...headOn('open', 1),
      config: config((c) => {
        blind(c);
        stubborn(c);
      }),
    });
    const outcome = checkEnded(run, finish(run));
    expect(outcome.outcome).toBe('stalemate');
    expect(outcome.basis).toBe('adjudicated');
    expect(outcome.reason).toMatch(/no casualties/);
    expect(outcome.casualties).toEqual({ BLUEFOR: 0, OPFOR: 0 });
  }, 120_000);

  it('ammunition exhausted on both sides', () => {
    const run = createFofRun({
      ...headOn('open', 1),
      config: config((c) => {
        blind(c);
        stubborn(c);
        for (const w of c.fire.weapons) w.basicLoadRounds = 30;
        c.termination.stalemateWindowSeconds = 1000;
      }),
    });
    const outcome = checkEnded(run, finish(run));
    expect(outcome.outcome).toBe('stalemate');
    expect(outcome.reason).toBe('ammunition exhausted on both sides');
    for (const m of run.sim.state.fof?.soldiers ?? []) expect(m.rounds).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('the time limit: adjudicated, with the advantage by the stated margin', () => {
    const run = createFofRun({
      ...headOn('open', 1),
      config: config((c) => {
        c.termination.maxDurationSeconds = 520;
      }),
    });
    const outcome = checkEnded(run, finish(run));
    expect(outcome.outcome).toBe('timeLimit');
    expect(outcome.atSeconds).toBeCloseTo(520, 6);
    const lead = outcome.effectiveness.BLUEFOR - outcome.effectiveness.OPFOR;
    const margin = FOF_DEFAULT_CONFIG.termination.advantageMargin;
    expect(outcome.advantage).toBe(lead >= margin ? 'BLUEFOR' : -lead >= margin ? 'OPFOR' : null);
  }, 60_000);

  it('no contact before the time limit: noContact', () => {
    const spec: FofRunSpec = {
      blufor: { ...SQUAD, start: { x: -800, y: -800 }, destination: { x: -800, y: -400 } },
      opfor: { ...SQUAD, start: { x: 800, y: 800 }, destination: { x: 800, y: 400 } },
      terrain: 'urban',
      seed: 1,
      tickRateHz: 30,
      config: config((c) => {
        c.termination.maxDurationSeconds = 400;
      }),
    };
    const run = createFofRun(spec);
    const outcome = checkEnded(run, finish(run));
    expect(outcome.outcome).toBe('noContact');
  }, 60_000);
});

describe('mutual disengagement', () => {
  it('after contact, neither force in contact nor firing for the disengagement time', () => {
    // Blind fire, and withdrawal at the first suppression: both break contact.
    const run = createFofRun({
      ...headOn('open', 2),
      config: config((c) => {
        blind(c);
        c.force.withdrawSuppression = 0.05;
        c.force.withdrawSuppressedSeconds = 5;
        c.termination.stalemateWindowSeconds = 1000;
      }),
    });
    const outcome = checkEnded(run, finish(run));
    expect(['mutualDisengagement', 'blueforWithdrawal', 'opforWithdrawal']).toContain(
      outcome.outcome,
    );
    expect(outcome.basis).toBe('decisive');
  }, 60_000);
});

describe('invalid states', () => {
  it('an invariant broken in the state ends the run as invalid, naming it', () => {
    const run = createFofRun(headOn('open', 1));
    for (let i = 0; i < 30 * 30; i += 1) run.step();
    const snapshot = JSON.parse(JSON.stringify(run.sim.snapshot())) as {
      state: { fof: { soldiers: { rounds: number }[] } };
    };
    const first = snapshot.state.fof.soldiers[0];
    if (first) first.rounds = -5;
    run.sim.restore(snapshot as never);
    const events = finish(run, 5);
    expect(run.outcome?.outcome).toBe('invalid');
    expect(run.outcome?.reason).toMatch(/-5 rounds/);
    expect(events.filter((e) => e.type === 'fofEnded')).toHaveLength(1);
  });
});
