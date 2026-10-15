import { describe, expect, it } from 'vitest';
import { createFofRun, type FofRunSpec } from '#exercise/force-on-force';

// Force-on-Force scalability (docs/behavior-lab/force-on-force/04 §5):
//   AMBUSH_FOF_SCALE=38 npx vitest run tools/fof-scale.test.ts --silent=false
// Two forces of N rifle squads each (13 Marines a squad: 38 squads a side is
// 988 soldiers), in blocks 1 km apart, each ordered to the other's start,
// both attacking on contact (fire and movement: the most demanding
// behaviour). Reports CPU per simulated second as the run goes, until the
// outcome or AMBUSH_FOF_SCALE_SECONDS (default 900) simulated seconds.
// Opt-in: at full size this takes a long time.

const squads = Number(process.env['AMBUSH_FOF_SCALE'] ?? 0);
const limit = Number(process.env['AMBUSH_FOF_SCALE_SECONDS'] ?? 900);
const terrain = (process.env['AMBUSH_FOF_SCALE_TERRAIN'] ?? 'open') as FofRunSpec['terrain'];
/** The movement engine's integration rate (Hz): 30, as experiment 14 runs it. */
const substepHz = Number(process.env['AMBUSH_FOF_SCALE_SUBSTEP'] ?? 30);

function spec(n: number): FofRunSpec {
  const force = {
    organization: 'squad' as const,
    formation: 'usmc.squad.wedge',
    pace: 1.4,
    interval: 10,
    elementSpacing: 20,
    count: n,
    groupSpacingM: 60,
    actionsOn: 'attack' as const,
  };
  return {
    blufor: { ...force, start: { x: 0, y: -500 }, destination: { x: 0, y: 500 } },
    opfor: { ...force, start: { x: 0, y: 500 }, destination: { x: 0, y: -500 } },
    terrain,
    seed: 1,
    tickRateHz: 30,
    substepHz,
  };
}

describe.skipIf(!(squads > 0))('Force-on-Force scalability', () => {
  it(
    `${String(squads)} squads a side (${String(squads * 13 * 2)} soldiers), both attacking`,
    () => {
      const t0 = performance.now();
      const run = createFofRun(spec(squads));
      const buildMs = performance.now() - t0;
      const rate = run.spec.tickRateHz;
      const lines: string[] = [];
      let windowMs = 0;
      let windowBursts = 0;
      const first: { contactAt: number | null } = { contactAt: null };
      let rejected = 0;
      const cpu = { before: 0, beforeS: 0, after: 0, afterS: 0 };
      let worstTick = 0;
      let bounds = 0;
      let lastBound: (string | null)[] = [null, null];
      while (!run.done && run.sim.timeSeconds < limit) {
        const a = performance.now();
        const events = run.step();
        const ms = performance.now() - a;
        worstTick = Math.max(worstTick, ms);
        windowMs += ms;
        for (const e of events) {
          if (e.type === 'fofFire') windowBursts += 1;
          if (e.type === 'commandRejected') rejected += 1;
          if (e.type === 'forcePhaseChanged' && e.to === 'contact') first.contactAt ??= e.atSeconds;
        }
        const forces = run.sim.state.fof?.forces ?? [];
        forces.forEach((f, i) => {
          if (f.boundUnit && f.boundUnit !== lastBound[i]) bounds += 1;
        });
        lastBound = forces.map((f) => f.boundUnit);
        if (first.contactAt === null) {
          cpu.before += ms;
          cpu.beforeS += 1 / rate;
        } else {
          cpu.after += ms;
          cpu.afterS += 1 / rate;
        }
        if (run.sim.tick % (30 * rate) === 0) {
          const fof = run.sim.state.fof;
          const up = (side: string) =>
            run.sim.state.soldiers.filter((s) => s.side === side && s.status === 'active').length;
          const line = `t=${run.sim.timeSeconds.toFixed(0)}s ${(windowMs / 30).toFixed(0)} ms/sim-s | ${forces.map((f) => `${f.side} ${f.phase}${f.boundUnit ? ` (${f.boundUnit} bounding)` : ''}`).join(', ')} | up B${String(up('BLUEFOR'))} O${String(up('OPFOR'))} | tracks ${String(fof?.tracks.length ?? 0)} | bursts ${String(windowBursts)}`;
          lines.push(line);
          console.log(line);
          windowMs = 0;
          windowBursts = 0;
        }
      }
      const total = cpu.before + cpu.after;
      const summary = [
        `soldiers ${String(run.sim.state.soldiers.length)}; build ${buildMs.toFixed(0)} ms; simulated ${run.sim.timeSeconds.toFixed(0)} s in ${(total / 1000).toFixed(1)} s CPU`,
        `before contact: ${(cpu.before / Math.max(1e-9, cpu.beforeS)).toFixed(1)} ms per simulated second (${cpu.beforeS.toFixed(0)} s)`,
        `after contact (${first.contactAt === null ? 'none' : `${first.contactAt.toFixed(0)} s`}): ${(cpu.after / Math.max(1e-9, cpu.afterS)).toFixed(1)} ms per simulated second (${cpu.afterS.toFixed(0)} s)`,
        `worst tick ${worstTick.toFixed(0)} ms; bounds ${String(bounds)}; rejected commands ${String(rejected)}; outcome ${run.outcome ? `${run.outcome.outcome} at ${run.outcome.atSeconds.toFixed(0)} s` : 'none (limit)'}`,
        `heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`,
      ];
      console.log(summary.join('\n'));
      expect(rejected).toBe(0);
      expect(run.outcome?.basis ?? 'none').not.toBe('invalid');
    },
    24 * 3600_000,
  );
});
