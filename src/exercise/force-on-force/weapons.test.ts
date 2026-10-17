import { describe, expect, it } from 'vitest';
import {
  areaIncapacitation,
  hashSimState,
  roundsLeft,
  type FofConfig,
  type FofFireEvent,
  type FofGrenadeEvent,
  type FofReloadEvent,
  type SimEvent,
} from '#sim';
import { FOF_DEFAULT_CONFIG } from '../forces/forces';
import { createFofRun, type FofRun, type FofRunSpec } from './run';
import { SQUAD } from './test-specs';

// Weapons and ammunition (docs/behavior-lab/force-on-force/06): every armed
// soldier's weapons and rounds, fire modes and bursts, reloads, exhaustion
// and conservation, the fire team leader's grenade launcher and its area
// effect, and determinism, snapshot and tick-rate equivalence with them.

type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> };

/** Two squads 500 m apart closing on each other: they meet within a minute or so. */
function close(seed = 1, tickRateHz = 30, config?: FofConfig): FofRunSpec {
  return {
    blufor: { ...SQUAD, start: { x: 0, y: -250 }, destination: { x: 0, y: 700 } },
    opfor: { ...SQUAD, start: { x: 40, y: 250 }, destination: { x: 40, y: -700 } },
    terrain: 'open',
    seed,
    tickRateHz,
    ...(config ? { config } : {}),
  };
}

const configWith = (edit: (c: DeepMutable<FofConfig>) => void): FofConfig => {
  const c = JSON.parse(JSON.stringify(FOF_DEFAULT_CONFIG)) as DeepMutable<FofConfig>;
  edit(c);
  return c;
};

/** Steps `seconds` (or to the end), calling `each` after every tick with its events. */
function play(run: FofRun, seconds: number, each?: (events: readonly SimEvent[]) => void) {
  const events: SimEvent[] = [];
  const end = run.sim.tick + Math.round(seconds * run.spec.tickRateHz);
  while (run.sim.tick < end && !run.done) {
    const stepped = run.step();
    events.push(...stepped);
    each?.(stepped);
  }
  return events;
}

const of = <T extends SimEvent['type']>(events: readonly SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

const weapon = (id: string) => {
  const w = FOF_DEFAULT_CONFIG.fire.weapons.find((x) => x.id === id);
  if (!w) throw new Error(`no weapon ${id}`);
  return w;
};

/** One engagement, played once and shared by the tests that only read it. */
const shared = (() => {
  let cache: { run: FofRun; events: SimEvent[]; conserved: boolean } | null = null;
  return () => {
    if (cache) return cache;
    const run = createFofRun(close(3));
    let conserved = true;
    const events = play(run, 600, () => {
      for (const m of run.sim.state.fof?.soldiers ?? []) {
        for (const a of m.arms) {
          const w = weapon(a.id);
          if (a.loaded + a.reserve + a.fired !== w.basicLoadRounds || a.loaded > w.capacity)
            conserved = false;
        }
      }
    });
    cache = { run, events, conserved };
    return cache;
  };
})();

describe('the weapons and their ammunition at the start', () => {
  it('each soldier carries his role’s weapons, one feed loaded and the rest in reserve, on both sides alike', () => {
    const run = createFofRun(close());
    run.step();
    const fof = run.sim.state.fof;
    if (!fof) throw new Error('no fof');
    const bySide = (side: string) =>
      fof.soldiers
        .filter((m) => fof.forces[m.force]?.side === side)
        .map((m) =>
          m.arms.map((a) => `${a.id}:${String(a.loaded)}+${String(a.reserve)}`).join(','),
        );
    const blue = bySide('BLUEFOR');
    expect(bySide('OPFOR')).toEqual(blue);
    // A USMC squad: the squad leader and riflemen with rifles, three automatic
    // riflemen, three fire team leaders with rifle and grenade launcher.
    const count = (s: string) => blue.filter((x) => x === s).length;
    expect(count('rifle:30+180')).toBe(7);
    expect(count('automaticRifle:200+400')).toBe(3);
    expect(count('rifle:30+180,grenadeLauncher:1+17')).toBe(3);
    for (const m of fof.soldiers) {
      expect(m.reloadUntil).toBeNull();
      expect(m.arms.every((a) => a.fired === 0 && !a.exhausted)).toBe(true);
    }
  });

  it('the configuration describes every weapon, from the reference data', () => {
    const rifle = weapon('rifle');
    const saw = weapon('automaticRifle');
    const m203 = weapon('grenadeLauncher');
    expect([rifle.feed, rifle.capacity, rifle.basicLoadRounds]).toEqual(['magazine', 30, 210]);
    expect([saw.feed, saw.capacity, saw.category]).toEqual(['belt', 200, 'lightMachineGun']);
    expect([m203.feed, m203.capacity, m203.category]).toEqual(['single', 1, 'grenadeLauncher']);
    // Doctrinal rates: rifle sustained 12–15 rounds/min, M249 sustained ~50 and rapid ~100, M203 5–7.
    const rate = (w: typeof rifle, mode: 'sustained' | 'rapid') => {
      const m = w[mode];
      const rounds = (m.roundsPerBurst.min + m.roundsPerBurst.max) / 2;
      return (
        (rounds / ((m.secondsBetweenBursts.minSeconds + m.secondsBetweenBursts.maxSeconds) / 2)) *
        60
      );
    };
    expect(rate(rifle, 'sustained')).toBeGreaterThanOrEqual(11);
    expect(rate(rifle, 'sustained')).toBeLessThanOrEqual(15);
    expect(rate(rifle, 'rapid')).toBeGreaterThanOrEqual(40);
    expect(rate(rifle, 'rapid')).toBeLessThanOrEqual(50);
    expect(rate(saw, 'sustained')).toBeGreaterThanOrEqual(45);
    expect(rate(saw, 'sustained')).toBeLessThanOrEqual(55);
    expect(rate(saw, 'rapid')).toBeGreaterThanOrEqual(90);
    expect(rate(saw, 'rapid')).toBeLessThanOrEqual(110);
    expect(rate(m203, 'sustained')).toBeGreaterThanOrEqual(5);
    expect(rate(m203, 'sustained')).toBeLessThanOrEqual(7);
  });
});

describe('firing', () => {
  it('rifles fire short aimed bursts, automatic rifles 6–9-round bursts; the burst that empties the feed is cut short', () => {
    const { events } = shared();
    const fire = of(events, 'fofFire');
    const rifle = fire.filter((f) => f.weapon === 'rifle');
    const saw = fire.filter((f) => f.weapon === 'automaticRifle');
    expect(rifle.length).toBeGreaterThan(20);
    expect(saw.length).toBeGreaterThan(5);
    expect(rifle.every((f) => f.rounds >= 1 && f.rounds <= 3)).toBe(true);
    expect(saw.every((f) => f.rounds >= 1 && f.rounds <= 9)).toBe(true);
    // Most automatic-rifle bursts are full: 6–9 rounds.
    expect(saw.filter((f) => f.rounds >= 6).length / saw.length).toBeGreaterThan(0.9);
  });

  it('bursts follow each other no faster than the fire mode allows', () => {
    const { events } = shared();
    const last = new Map<string, FofFireEvent>();
    let checked = 0;
    for (const f of of(events, 'fofFire')) {
      const before = last.get(f.shooterId);
      last.set(f.shooterId, f);
      if (!before) continue;
      const w = weapon(f.weapon);
      const gap = f.atSeconds - before.atSeconds;
      // The interval was drawn for the burst before, in its mode (factors only lengthen it).
      expect(gap).toBeGreaterThanOrEqual(w[before.mode].secondsBetweenBursts.minSeconds - 0.11);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('rapid fire when opening fire and close in; sustained fire later at range', () => {
    const { events } = shared();
    const fire = of(events, 'fofFire');
    const firstFire = Math.min(...fire.map((f) => f.atSeconds));
    const opening = fire.filter((f) => f.atSeconds - firstFire < 40);
    expect(opening.every((f) => f.mode === 'rapid')).toBe(true);
    const later = fire.filter((f) => f.atSeconds - firstFire > 60 && f.rangeM > 120);
    if (later.length > 0) expect(later.some((f) => f.mode === 'sustained')).toBe(true);
    for (const f of fire)
      if (f.rangeM <= FOF_DEFAULT_CONFIG.fire.rapidFire.withinRangeM) expect(f.mode).toBe('rapid');
  });

  it('different weapons fire at observably different rates', () => {
    const { events, run } = shared();
    const fire = of(events, 'fofFire');
    const fof = run.sim.state.fof;
    const perSoldier = (w: string) => {
      const shooters = new Set(fof?.soldiers.filter((m) => m.weapon === w).map((m) => m.soldierId));
      const rounds = fire.filter((f) => f.weapon === w).reduce((s, f) => s + f.rounds, 0);
      return rounds / Math.max(1, shooters.size);
    };
    expect(perSoldier('automaticRifle')).toBeGreaterThan(2 * perSoldier('rifle'));
  });
});

describe('reloads', () => {
  it('an emptied feed is reloaded from the reserve; no fire while reloading; fire resumes after', () => {
    const { events } = shared();
    const reloads = of(events, 'fofReload');
    expect(reloads.some((r) => r.phase === 'started')).toBe(true);
    const open = new Map<string, FofReloadEvent>();
    const resumed = new Set<string>();
    for (const e of events) {
      if (e.type === 'fofReload') {
        if (e.phase === 'started') {
          expect(open.has(e.soldierId)).toBe(false);
          open.set(e.soldierId, e);
        } else {
          const started = open.get(e.soldierId);
          expect(started?.weapon).toBe(e.weapon);
          const w = weapon(e.weapon);
          const r = w.reloadSeconds;
          const took = e.atSeconds - (started?.atSeconds ?? 0);
          expect(took).toBeGreaterThanOrEqual(r.minSeconds - 1e-6);
          expect(took).toBeLessThanOrEqual(r.maxSeconds + 0.11);
          // Loaded from the pool: a full feed, or what is left.
          expect(e.loaded).toBe(
            Math.min(w.capacity, (started?.loaded ?? 0) + (started?.reserve ?? 0)),
          );
          expect(e.loaded + e.reserve).toBe((started?.loaded ?? 0) + (started?.reserve ?? 0));
          open.delete(e.soldierId);
        }
      }
      if ((e.type === 'fofFire' || e.type === 'fofGrenade') && open.has(e.shooterId))
        throw new Error(`${e.shooterId} fired while reloading`);
      if (e.type === 'fofFire' && !open.has(e.shooterId)) resumed.add(e.shooterId);
    }
    const reloaded = new Set(
      reloads.filter((r) => r.phase === 'completed').map((r) => r.soldierId),
    );
    expect([...reloaded].some((id) => resumed.has(id))).toBe(true);
  });

  it('a magazine runs dry after its 30 rounds, and empty reloads start at 0 rounds loaded', () => {
    const { events } = shared();
    const fired = new Map<string, number>();
    for (const e of events) {
      if (e.type === 'fofFire' && e.weapon === 'rifle')
        fired.set(e.shooterId, (fired.get(e.shooterId) ?? 0) + e.rounds);
      if (e.type === 'fofReload' && e.phase === 'started' && e.weapon === 'rifle') {
        // Empty (0 loaded), or a tactical change of a magazine below a third.
        expect(e.loaded === 0 || e.loaded < 30 * weapon('rifle').tacticalReloadBelow).toBe(true);
      }
    }
    expect(Math.max(...fired.values())).toBeGreaterThan(30);
  });

  it('a partial last magazine is loaded as it is; then the weapon is exhausted and falls silent', () => {
    const run = createFofRun(
      close(
        2,
        30,
        configWith((c) => {
          for (const w of c.fire.weapons)
            if (w.id === 'rifle' || w.id === 'automaticRifle') w.basicLoadRounds = 45;
          c.force.withdrawAmmunitionFraction = 0;
          c.force.withdrawEffectiveness = 0;
          c.force.ineffectiveEffectiveness = 0;
          c.force.withdrawSuppression = 1;
        }),
      ),
    );
    const events = play(run, 900);
    const fof = run.sim.state.fof;
    // The rifles: 30 loaded, 15 in reserve; the reload loads the 15.
    const partial = of(events, 'fofReload').filter(
      (r) => r.phase === 'completed' && r.weapon === 'rifle',
    );
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.every((r) => r.loaded + r.reserve <= 45)).toBe(true);
    expect(partial.some((r) => r.loaded === 15 && r.reserve === 0)).toBe(true);
    const out = of(events, 'ammunitionExhausted');
    expect(out.length).toBeGreaterThan(0);
    for (const e of out) {
      // Once per weapon, and nothing fired with it after.
      expect(out.filter((x) => x.soldierId === e.soldierId && x.weapon === e.weapon)).toHaveLength(
        1,
      );
      expect(
        of(events, 'fofFire').some(
          (f) => f.shooterId === e.soldierId && f.weapon === e.weapon && f.atSeconds > e.atSeconds,
        ),
      ).toBe(false);
      const member = fof?.soldiers.find((m) => m.soldierId === e.soldierId);
      const arm = member?.arms.find((a) => a.id === e.weapon);
      expect([arm?.loaded, arm?.reserve, arm?.fired]).toEqual([
        0,
        0,
        run.spec.config?.fire.weapons.find((w) => w.id === e.weapon)?.basicLoadRounds,
      ]);
    }
  });

  it('a soldier keeps moving while he reloads (bounding in an assault)', () => {
    const run = createFofRun({
      ...close(2),
      blufor: { ...close(2).blufor, actionsOn: 'attack' },
      opfor: { ...close(2).opfor, actionsOn: 'continue' },
    });
    let movingReloads = 0;
    play(run, 600, () => {
      for (const m of run.sim.state.fof?.soldiers ?? []) {
        if (m.reloadUntil !== null && m.speed > 0.5) movingReloads += 1;
      }
    });
    expect(movingReloads).toBeGreaterThan(0);
  });
});

describe('conservation of ammunition', () => {
  it('loaded + reserve + fired is always the basic load, and loaded never exceeds the feed (every tick)', () => {
    expect(shared().conserved).toBe(true);
  });

  it('over random seeds and tick rates, and the rounds fired match the bursts', () => {
    for (const [seed, rate] of [
      [11, 20],
      [12, 30],
      [13, 60],
    ] as const) {
      const run = createFofRun(close(seed, rate));
      const events = play(run, 240);
      const fired = new Map<string, number>();
      for (const f of of(events, 'fofFire'))
        fired.set(
          `${f.shooterId}/${f.weapon}`,
          (fired.get(`${f.shooterId}/${f.weapon}`) ?? 0) + f.rounds,
        );
      for (const g of of(events, 'fofGrenade'))
        fired.set(`${g.shooterId}/${g.weapon}`, (fired.get(`${g.shooterId}/${g.weapon}`) ?? 0) + 1);
      for (const m of run.sim.state.fof?.soldiers ?? []) {
        for (const a of m.arms) {
          expect(a.loaded + a.reserve + a.fired).toBe(weapon(a.id).basicLoadRounds);
          expect(a.fired).toBe(fired.get(`${m.soldierId}/${a.id}`) ?? 0);
        }
        expect(roundsLeft(m)).toBeGreaterThanOrEqual(0);
      }
    }
  }, 120_000);
});

describe('the grenade launcher', () => {
  /** Engagements with grenades, and the state at each grenade's tick. */
  const grenadeRuns = (() => {
    let cache: {
      grenades: {
        e: FofGrenadeEvent;
        seed: number;
        positions: Map<string, { x: number; y: number; side: string; status: string }>;
      }[];
      events: SimEvent[];
    } | null = null;
    return () => {
      if (cache) return cache;
      const grenades: {
        e: FofGrenadeEvent;
        seed: number;
        positions: Map<string, { x: number; y: number; side: string; status: string }>;
      }[] = [];
      const events: SimEvent[] = [];
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const run = createFofRun(close(seed));
        // Positions before the decision that fired (start of the tick).
        let before = new Map<string, { x: number; y: number; side: string; status: string }>();
        const snap = () =>
          new Map(
            run.sim.state.soldiers.map((s) => [
              s.id as string,
              { x: s.position.x, y: s.position.y, side: s.side, status: s.status },
            ]),
          );
        before = snap();
        events.push(
          ...play(run, 500, (stepped) => {
            for (const e of stepped)
              if (e.type === 'fofGrenade') grenades.push({ e, seed, positions: before });
            before = snap();
          }),
        );
      }
      cache = { grenades, events };
      return cache;
    };
  })();

  it('only fire team leaders fire grenades, one at a time, within 31–350 m', () => {
    const { grenades, events } = grenadeRuns();
    expect(grenades.length).toBeGreaterThan(3);
    const area = weapon('grenadeLauncher').area;
    const probe = createFofRun(close(1));
    probe.step();
    const grenadiers = new Set(
      (probe.sim.state.fof?.soldiers ?? [])
        .filter((m) => m.arms[1]?.id === 'grenadeLauncher')
        .map((m) => m.soldierId as string),
    );
    expect(grenadiers.size).toBe(6);
    for (const g of of(events, 'fofGrenade')) expect(grenadiers.has(g.shooterId)).toBe(true);
    for (const { e } of grenades) {
      expect(e.rangeM).toBeGreaterThanOrEqual(area?.minRangeM ?? 0);
      expect(e.rangeM).toBeLessThanOrEqual(350);
    }
    // Never two from one launcher within the least interval.
    // (Each run's own: the same launcher in another seed's run is another.)
    const lastAt = new Map<string, number>();
    for (const { e, seed } of grenades) {
      const key = `${String(seed)}:${e.shooterId}`;
      const before = lastAt.get(key);
      if (before !== undefined && before < e.atSeconds)
        expect(e.atSeconds - before).toBeGreaterThanOrEqual(
          (area?.minSecondsBetweenShots ?? 0) - 1e-6,
        );
      lastAt.set(key, e.atSeconds);
    }
  }, 180_000);

  it('never aimed with a friend near the aim point', () => {
    const { grenades } = grenadeRuns();
    const clearance = weapon('grenadeLauncher').area?.friendlyClearanceM ?? 0;
    for (const { e, positions } of grenades) {
      for (const [id, p] of positions) {
        if (id === e.shooterId || p.side !== e.side || p.status !== 'active') continue;
        expect(Math.hypot(p.x - e.aimPoint.x, p.y - e.aimPoint.y)).toBeGreaterThanOrEqual(
          clearance - 1e-6,
        );
      }
    }
  });

  it('lands near its aim point; strikes down only soldiers within its effect, not all of them', () => {
    const { grenades } = grenadeRuns();
    const area = weapon('grenadeLauncher').area;
    if (!area) throw new Error('no area');
    let exposed = 0;
    let struck = 0;
    for (const { e, positions } of grenades) {
      const spread = area.dispersionM.atZeroM + (e.rangeM / 100) * area.dispersionM.per100M;
      expect(Math.hypot(e.impact.x - e.aimPoint.x, e.impact.y - e.aimPoint.y)).toBeLessThanOrEqual(
        spread + 1e-9,
      );
      for (const id of e.incapacitated) {
        const p = positions.get(id);
        expect(p && Math.hypot(p.x - e.impact.x, p.y - e.impact.y)).toBeLessThan(
          area.maxEffectRadiusM,
        );
      }
      exposed += e.exposed;
      struck += e.incapacitated.length;
    }
    expect(struck).toBeLessThanOrEqual(exposed);
    if (exposed >= 5) expect(struck).toBeLessThan(exposed);
  });

  it('consumes its rounds and reloads after each', () => {
    const { events } = grenadeRuns();
    const reloads = of(events, 'fofReload').filter(
      (r) => r.weapon === 'grenadeLauncher' && r.phase === 'completed',
    );
    expect(reloads.length).toBeGreaterThan(0);
    expect(reloads.every((r) => r.loaded === 1)).toBe(true);
  });

  it('the area effect falls from the burst to nothing at its edge, prone soldiers less', () => {
    const area = weapon('grenadeLauncher').area;
    if (!area) throw new Error('no area');
    expect(areaIncapacitation(area, 0)).toBeCloseTo(0.75, 9);
    expect(areaIncapacitation(area, 5)).toBeCloseTo(0.5, 9);
    expect(areaIncapacitation(area, 7.5)).toBeCloseTo(0.25, 9);
    expect(areaIncapacitation(area, 10)).toBe(0);
    for (let d = 0; d < 10; d += 0.5)
      expect(areaIncapacitation(area, d + 0.5)).toBeLessThanOrEqual(areaIncapacitation(area, d));
  });

  it('is not employed when its chance is zero (a decision, not automatic in range)', () => {
    const run = createFofRun(
      close(
        4,
        30,
        configWith((c) => {
          const g = c.fire.weapons.find((w) => w.id === 'grenadeLauncher');
          if (g?.area) {
            g.area.employProbability.aimed = 0;
            g.area.employProbability.area = 0;
          }
        }),
      ),
    );
    const events = play(run, 400);
    expect(of(events, 'fofFire').length).toBeGreaterThan(0);
    expect(of(events, 'fofGrenade')).toHaveLength(0);
  });
});

describe('determinism', () => {
  const trace = (spec: FofRunSpec, seconds: number) => {
    const run = createFofRun(spec);
    const events = play(run, seconds);
    return { hash: hashSimState(run.sim.state), events: JSON.stringify(events) };
  };

  it('the same seed gives the same bursts, reloads, grenades and casualties; another seed differs', () => {
    const a = trace(close(5), 300);
    const b = trace(close(5), 300);
    expect(b).toEqual(a);
    const c = trace(close(6), 300);
    expect(c.hash).not.toBe(a.hash);
    expect(c.events).not.toBe(a.events);
  }, 120_000);

  it('restoring a snapshot taken mid-engagement (reloads pending) continues identically', () => {
    const whole = createFofRun(close(5));
    const held: { snapshot: ReturnType<typeof whole.sim.snapshot> | null } = { snapshot: null };
    const head = play(whole, 400, () => {
      if (held.snapshot) return;
      const fof = whole.sim.state.fof;
      if (
        fof?.soldiers.some((m) => m.reloadUntil !== null) &&
        fof.soldiers.some((m) => m.arms[1] && m.arms[1].fired > 0)
      )
        held.snapshot = whole.sim.snapshot();
    });
    const snapshot = held.snapshot;
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    const taken = snapshot.state.tick;
    const rest = play(whole, 200);
    const resumed = createFofRun(close(5));
    resumed.sim.restore(JSON.parse(JSON.stringify(snapshot)) as typeof snapshot);
    const after = play(resumed, (whole.sim.tick - taken) / 30);
    const tail = [...head.filter((e) => e.tick >= taken), ...rest];
    expect(JSON.stringify(after)).toBe(JSON.stringify(tail));
    expect(hashSimState(resumed.sim.state)).toBe(hashSimState(whole.sim.state));
  }, 120_000);

  it('the weapons behave alike at every tick rate (decisions are on simulation time)', () => {
    const rate = (tickRateHz: number) => {
      const run = createFofRun(close(7, tickRateHz));
      const events = play(run, 300);
      const fire = of(events, 'fofFire');
      const minutes = 300 / 60;
      return fire.reduce((s, f) => s + f.rounds, 0) / minutes;
    };
    const at30 = rate(30);
    for (const hz of [20, 60]) {
      const r = rate(hz);
      expect(r).toBeGreaterThan(at30 * 0.5);
      expect(r).toBeLessThan(at30 * 2);
    }
  }, 180_000);
});
