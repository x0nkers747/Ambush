import { describe, expect, it } from 'vitest';
import {
  FofConfigError,
  hashSimState,
  NO_FEATURES,
  rectangle,
  validateFofConfig,
  type ContactObservedEvent,
  type SimEvent,
} from '#sim';
import { labTerrain } from '../behavior-lab/run';
import defaultConfig from '../forces/fof-v2.json';
import { createFofRun, FOF_DEFAULT_CONFIG, type FofRun, type FofRunSpec } from './run';
import { headOn, SQUAD } from './test-specs';

// F1: detection and observation (docs/behavior-lab/force-on-force/02, 03).

function runFor(run: FofRun, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds * run.spec.tickRateHz && !run.done; i += 1)
    events.push(...run.step());
  return events;
}

const observed = (events: readonly SimEvent[]) =>
  events.filter((e): e is ContactObservedEvent => e.type === 'contactObserved');

describe('the experimental configuration', () => {
  it('validates, and refuses unknown parameters and broken hysteresis', () => {
    expect(validateFofConfig(defaultConfig)).toBe(defaultConfig);
    const bad = (patch: (c: Record<string, Record<string, unknown>>) => void) => {
      const c = JSON.parse(JSON.stringify(defaultConfig)) as unknown as Record<
        string,
        Record<string, unknown>
      >;
      patch(c);
      return () => validateFofConfig(c);
    };
    expect(
      bad((c) => {
        c['extra'] = {};
      }),
    ).toThrow(FofConfigError);
    expect(
      bad((c) => {
        if (c['detection']) c['detection']['lostConfidence'] = 0.9;
      }),
    ).toThrow(/hysteresis/);
    expect(
      bad((c) => {
        if (c['suppression']) c['suppression']['pinnedClearAt'] = 0.9;
      }),
    ).toThrow(FofConfigError);
  });
});

describe('detection in the open', () => {
  // A seed in which both sides identify the other within the run (they do in
  // most; in seed 1 BLUEFOR does not, by chance, before 700 s).
  const run = createFofRun(headOn('open', 2));
  const events = runFor(run, 700);
  const contacts = observed(events);

  it('both sides detect each other: possible, then confirmed, then identified, closer each time', () => {
    for (const side of ['BLUEFOR', 'OPFOR'] as const) {
      const mine = contacts.filter((e) => e.side === side);
      const first = (to: string) => mine.find((e) => e.to === to);
      const possible = first('possible');
      const detected = first('detected');
      const identified = first('identified');
      expect(possible).toBeDefined();
      expect(detected).toBeDefined();
      expect(identified).toBeDefined();
      if (!possible || !detected || !identified) return;
      expect(possible.atSeconds).toBeLessThanOrEqual(detected.atSeconds);
      expect(detected.atSeconds).toBeLessThan(identified.atSeconds);
      expect(identified.rangeM ?? Infinity).toBeLessThan(possible.rangeM ?? 0);
    }
  });

  it('every report changes a track from the level it had (no skipped or contradictory reports)', () => {
    const levels = new Map<string, string>();
    for (const e of contacts) {
      const key = `${e.side}:${e.targetId}`;
      expect(e.from).toBe(levels.get(key) ?? 'unaware');
      levels.set(key, e.to);
    }
    const fof = run.sim.state.fof;
    for (const t of fof?.tracks ?? []) {
      const side = fof?.forces[t.force]?.side ?? '';
      expect(levels.get(`${side}:${t.targetId}`)).toBe(t.level);
    }
  });

  it('a force never tracks its own soldiers; attempts and glimpses are counted', () => {
    const fof = run.sim.state.fof;
    for (const t of fof?.tracks ?? []) {
      const member = fof?.soldiers.find((s) => s.soldierId === t.targetId);
      expect(member?.force).not.toBe(t.force);
    }
    for (const f of fof?.forces ?? []) {
      expect(f.stats.detectionAttempts).toBeGreaterThan(f.stats.glimpses);
      expect(f.stats.glimpses).toBeGreaterThan(0);
    }
  });

  it('first glimpses name the observer and the range', () => {
    const glimpsed = contacts.filter((e) => e.to === 'possible' && e.from === 'unaware');
    expect(glimpsed.length).toBeGreaterThan(0);
    for (const e of glimpsed) {
      expect(e.observerId).not.toBeNull();
      expect(e.rangeM).toBeGreaterThan(0);
    }
  });
});

describe('sight lines', () => {
  const facing = (): FofRunSpec => ({
    blufor: { ...SQUAD, start: { x: 0, y: -150 }, destination: null, facingDeg: 0 },
    opfor: { ...SQUAD, start: { x: 0, y: 150 }, destination: null, facingDeg: 180 },
    terrain: 'open',
    seed: 2,
    tickRateHz: 30,
  });

  it('two squads facing each other 300 m apart in the open see each other', () => {
    const events = runFor(createFofRun(facing()), 60);
    expect(observed(events).some((e) => e.to === 'detected')).toBe(true);
  });

  it('a long, tall building between them: nobody is ever seen', () => {
    const wall = labTerrain({
      ...NO_FEATURES,
      buildings: [{ id: 'block', footprint: rectangle(0, 0, 400, 20), heightMeters: 12 }],
    });
    const run = createFofRun(facing(), wall);
    const events = runFor(run, 120);
    expect(observed(events)).toEqual([]);
    for (const f of run.sim.state.fof?.forces ?? []) {
      expect(f.stats.detectionAttempts).toBeGreaterThan(0);
      expect(f.stats.visibleAttempts).toBe(0);
    }
  }, 30_000);
});

describe('isolation', () => {
  it('only force-on-force worlds have its state', () => {
    const run = createFofRun(headOn('open', 3));
    runFor(run, 60);
    expect(run.sim.state.fof).toBeDefined();
    expect(run.sim.world.fof?.config).toEqual(FOF_DEFAULT_CONFIG);
  });
});

describe('determinism', () => {
  const at = (spec: FofRunSpec, seconds: number) => {
    const run = createFofRun(spec);
    runFor(run, seconds);
    return run;
  };

  it('repeats exactly, and differs with the seed', () => {
    const a = at(headOn('open', 4), 200);
    const b = at(headOn('open', 4), 200);
    const c = at(headOn('open', 5), 200);
    expect(hashSimState(a.sim.state)).toBe(hashSimState(b.sim.state));
    expect(hashSimState(c.sim.state)).not.toBe(hashSimState(a.sim.state));
  }, 60_000);

  it('is bit-identical at 10, 30, 60 and 120 Hz', () => {
    const exact = (rate: number) => {
      const run = at(headOn('open', 6, rate), 300);
      return JSON.stringify({ s: run.sim.state.soldiers, f: run.sim.state.fof });
    };
    const reference = exact(120);
    expect(reference).toContain('"confirmed":true');
    for (const rate of [10, 30, 60]) expect(exact(rate)).toBe(reference);
  }, 120_000);

  it('continues identically from a snapshot, during movement and after detection', () => {
    for (const split of [40, 160]) {
      const whole = at(headOn('open', 7), 240);
      const part = at(headOn('open', 7), split);
      const resumed = createFofRun(headOn('open', 7));
      resumed.sim.restore(part.sim.snapshot());
      for (let i = 0; i < (240 - split) * 30; i += 1) resumed.sim.step();
      expect(hashSimState(resumed.sim.state)).toBe(hashSimState(whole.sim.state));
    }
  }, 60_000);
});
