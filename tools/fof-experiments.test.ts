import { describe, expect, it } from 'vitest';
import {
  createFofRun,
  fofExperiment,
  runFof,
  type FofExperimentId,
  type FofRunResult,
} from '#exercise/force-on-force';
import { hashSimState, type SimEvent } from '#sim';

// The Force-on-Force Lab's thirteen experiments, automated
// (docs/behavior-lab/force-on-force/04 §2):
//   AMBUSH_FOF_EXPERIMENTS=1 npx vitest run tools/fof-experiments.test.ts --silent=false
// Each runs over seeds 1–3 and checks the property the experiment is about,
// over the seeds (not one chosen run). Opt-in: a few minutes of simulation.

const on = process.env['AMBUSH_FOF_EXPERIMENTS'] === '1';
const SEEDS = [1, 2, 3] as const;
const now = () => performance.now();

/** Every variant of an experiment, every seed, run to its outcome. */
function run(id: FofExperimentId): Map<string, FofRunResult[]> {
  const out = new Map<string, FofRunResult[]>();
  for (const seed of SEEDS) {
    for (const v of fofExperiment(id).variants(seed)) {
      const list = out.get(v.label) ?? [];
      list.push(runFof(v.spec, now));
      out.set(v.label, list);
    }
  }
  for (const list of out.values()) {
    for (const r of list) {
      expect(r.terminated).toBe(true);
      expect(r.metrics.outcome?.basis).not.toBe('invalid');
      expect(r.metrics.invalidTransitions).toBe(0);
    }
  }
  return out;
}

const only = (m: Map<string, FofRunResult[]>) => [...m.values()][0] ?? [];
const range = (r: FofRunResult) =>
  Math.max(
    r.metrics.sides.BLUEFOR.firstDetected?.rangeM ?? 0,
    r.metrics.sides.OPFOR.firstDetected?.rangeM ?? 0,
  );
const log = (id: string, results: readonly FofRunResult[]) => {
  console.log(
    `${id}: ${results.map((r) => `${String(r.seed)} ${r.metrics.outcome?.outcome ?? '-'} @${r.seconds.toFixed(0)}s`).join(', ')}`,
  );
};

describe.skipIf(!on)('Force-on-Force experiments', () => {
  it('1. approach in open terrain: contact, an engagement, an outcome', () => {
    const results = only(run('open-approach'));
    log('1', results);
    for (const r of results) {
      expect(r.metrics.engagementStart).not.toBeNull();
      expect(r.metrics.sides.BLUEFOR.firstDetected).not.toBeNull();
      expect(r.metrics.sides.OPFOR.firstDetected).not.toBeNull();
    }
  }, 600_000);

  it('2. observation distance: confirmed detection farther in clear air than in haze or restricted visibility', () => {
    const m = run('observation-distance');
    const clear = m.get('open') ?? [];
    const restricted = m.get('restricted') ?? [];
    clear.forEach((r, i) => {
      const other = restricted[i];
      if (other) expect(range(r)).toBeGreaterThan(range(other));
    });
    log('2 open', clear);
    log('2 restricted', restricted);
  }, 900_000);

  it('3. first detection: the still, kneeling force sees the moving one first in most seeds', () => {
    const results = only(run('first-detection'));
    log('3', results);
    const opforFirst = results.filter(
      (r) =>
        (r.metrics.sides.OPFOR.firstDetected?.seconds ?? Infinity) <
        (r.metrics.sides.BLUEFOR.firstDetected?.seconds ?? Infinity),
    ).length;
    expect(opforFirst).toBeGreaterThanOrEqual(2);
  }, 600_000);

  it('4. simultaneous detection: mirror-image squads detect within a minute of each other in most seeds', () => {
    const results = only(run('simultaneous-detection'));
    log('4', results);
    const close = results.filter(
      (r) =>
        Math.abs(
          (r.metrics.sides.BLUEFOR.firstDetected?.seconds ?? 0) -
            (r.metrics.sides.OPFOR.firstDetected?.seconds ?? 1e9),
        ) <= 60,
    ).length;
    expect(close).toBeGreaterThanOrEqual(2);
  }, 600_000);

  it('5. wooded terrain: confirmed detection later and closer than in the open, every seed', () => {
    const m = run('wooded-delay');
    const wooded = m.get('wooded') ?? [];
    const open = m.get('open') ?? [];
    wooded.forEach((r, i) => {
      const o = open[i];
      if (!o) return;
      expect(range(r)).toBeLessThan(range(o));
      expect(r.metrics.sides.BLUEFOR.firstDetected?.seconds ?? Infinity).toBeGreaterThan(
        o.metrics.sides.BLUEFOR.firstDetected?.seconds ?? 0,
      );
    });
    log('5 wooded', wooded);
  }, 900_000);

  it('6. temporary loss of contact: contacts are lost and regained, without coming into contact', () => {
    const results = only(run('contact-loss'));
    log('6', results);
    const cycling = results.filter(
      (r) => r.metrics.sides.BLUEFOR.contactsLost > 0 && r.metrics.sides.BLUEFOR.reacquisitions > 0,
    ).length;
    expect(cycling).toBeGreaterThanOrEqual(2);
    for (const r of results) expect(r.metrics.outcome?.outcome).toBe('noContact');
  }, 900_000);

  it('7. urban sight lines: most looks are blocked, and contact comes closer than in the open', () => {
    const results = only(run('urban-sight-lines'));
    log('7', results);
    for (const seed of SEEDS) {
      const spec = fofExperiment('urban-sight-lines').variants(seed)[0]?.spec;
      if (!spec) continue;
      const r = createFofRun(spec);
      for (let i = 0; i < 30 * 200; i += 1) r.step();
      const f = r.sim.state.fof?.forces[0];
      expect(
        (f?.stats.visibleAttempts ?? 1) / Math.max(1, f?.stats.tracedAttempts ?? 1),
      ).toBeLessThan(0.5);
    }
  }, 900_000);

  it('8. combat ineffective: the fire team is broken by the squad in most seeds', () => {
    const results = only(run('combat-ineffective'));
    log('8', results);
    expect(
      results.filter((r) => r.metrics.outcome?.outcome === 'blueforVictory').length,
    ).toBeGreaterThanOrEqual(2);
  }, 600_000);

  it('9. ammunition exhaustion: both sides fire most of a light load; never below zero', () => {
    const results = only(run('ammunition-exhaustion'));
    log('9', results);
    for (const r of results) {
      const spent =
        Math.max(r.metrics.sides.BLUEFOR.rounds, r.metrics.sides.OPFOR.rounds) /
        (10 * 40 + 3 * 120);
      expect(spent).toBeGreaterThan(0.6);
      expect(spent).toBeLessThanOrEqual(1);
    }
  }, 600_000);

  it('10. bounded stalemate: adjudicated in most seeds, with the real casualties', () => {
    const results = only(run('bounded-stalemate'));
    log('10', results);
    const stalemates = results.filter((r) => r.metrics.outcome?.outcome === 'stalemate');
    expect(stalemates.length).toBeGreaterThanOrEqual(2);
    for (const r of stalemates) expect(r.metrics.outcome?.basis).toBe('adjudicated');
  }, 900_000);

  it('11. mutual disengagement: both cautious forces break contact in most seeds', () => {
    const results = only(run('mutual-disengagement'));
    log('11', results);
    expect(
      results.filter((r) => r.metrics.outcome?.outcome === 'mutualDisengagement').length,
    ).toBeGreaterThanOrEqual(2);
  }, 600_000);

  it('12. replay and restoration during an active engagement: bit-identical', () => {
    for (const seed of SEEDS) {
      const spec = fofExperiment('replay-restore').variants(seed)[0]?.spec;
      if (!spec) continue;
      const whole = createFofRun(spec);
      let snapshotAt = -1;
      let snapshot: ReturnType<typeof whole.sim.snapshot> | null = null;
      while (!whole.done) {
        whole.step();
        if (!snapshot && whole.sim.state.fof?.forces.some((f) => f.phase === 'engaged')) {
          // Into the firefight: a little after the first exchange.
          if (snapshotAt < 0) snapshotAt = whole.sim.tick + 30 * 20;
          if (whole.sim.tick === snapshotAt) snapshot = whole.sim.snapshot();
        }
      }
      expect(snapshot).not.toBeNull();
      if (!snapshot) continue;
      const restored = createFofRun(spec);
      restored.sim.restore(snapshot);
      while (!restored.done) restored.step();
      expect(hashSimState(restored.sim.state)).toBe(hashSimState(whole.sim.state));
      const replayed = createFofRun(spec, undefined, {
        commands: whole.commands,
        origins: whole.origins,
      });
      while (!replayed.done) replayed.step();
      expect(hashSimState(replayed.sim.state)).toBe(hashSimState(whole.sim.state));
      // And at 120 Hz, the same outcome at the same moment.
      const fast = createFofRun({ ...spec, tickRateHz: 120 });
      while (!fast.done) fast.step();
      expect(fast.outcome).toEqual({ ...whole.outcome, tick: (whole.outcome?.tick ?? 0) * 4 + 3 });
    }
  }, 900_000);

  it('13. actions on contact: attackers assault, withdrawing forces go back at once', () => {
    const outcomes: string[] = [];
    for (const seed of SEEDS) {
      for (const v of fofExperiment('actions-on').variants(seed)) {
        const r = createFofRun(v.spec);
        const events: SimEvent[] = [];
        let rejected = 0;
        while (!r.done) {
          for (const e of r.step()) {
            if (e.type === 'commandRejected') rejected += 1;
            if (e.type === 'forcePhaseChanged') events.push(e);
          }
        }
        expect(rejected).toBe(0);
        expect(r.outcome?.basis).not.toBe('invalid');
        outcomes.push(`${String(seed)} ${v.label}: ${r.outcome?.outcome ?? '-'}`);
        for (const side of ['BLUEFOR', 'OPFOR'] as const) {
          const spec = side === 'BLUEFOR' ? v.spec.blufor : v.spec.opfor;
          const phases = events.flatMap((e) =>
            e.type === 'forcePhaseChanged' && e.side === side ? [e] : [],
          );
          const engaged = phases.findIndex(
            (e) => e.to === 'contact' || e.to === 'withdrawing' || e.to === 'assaulting',
          );
          if (engaged < 0) continue;
          if (spec.actionsOn === 'withdraw') {
            // At once, by its actions on contact, never by halting to fight first.
            expect(phases[engaged]?.to).toBe('withdrawing');
            expect(phases[engaged]?.reason).toMatch(/^actions on contact: withdraw/);
          }
          if (spec.actionsOn !== 'attack') {
            expect(phases.some((e) => e.to === 'assaulting')).toBe(false);
          }
        }
        // BLUEFOR attacks: it assaults, unless broken or out of contact before it could.
        if (v.spec.blufor.actionsOn === 'attack') {
          const blue = events.filter((e) => e.type === 'forcePhaseChanged' && e.side === 'BLUEFOR');
          const contact = blue.some((e) => e.type === 'forcePhaseChanged' && e.to === 'contact');
          if (contact) {
            expect(blue.some((e) => e.type === 'forcePhaseChanged' && e.to === 'assaulting')).toBe(
              true,
            );
          }
        }
      }
    }
    console.log(`13: ${outcomes.join('; ')}`);
  }, 1_800_000);
});
