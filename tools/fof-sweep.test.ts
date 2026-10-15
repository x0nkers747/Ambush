import { describe, expect, it } from 'vitest';
import { fofExperiment, runFof, summarize, type FofExperimentId } from '#exercise/force-on-force';

// Opt-in seed sweep of the Force-on-Force Lab (docs/behavior-lab/force-on-force/04 §3):
//   AMBUSH_FOF_SWEEP=50 AMBUSH_FOF_TERRAIN=open npx vitest run tools/fof-sweep.test.ts --silent=false
// (AMBUSH_FOF_TERRAIN: open | wooded | urban; one process per terrain runs
// them in parallel.) Runs the default approach on that terrain at seeds 1..N
// and prints distributions of outcomes, detection, engagement, casualties
// and performance, and re-runs five seeds to check they repeat exactly.

const seeds = Number(process.env['AMBUSH_FOF_SWEEP'] ?? 0);
const terrain = (process.env['AMBUSH_FOF_TERRAIN'] ?? 'open') as 'open' | 'wooded' | 'urban';
const EXPERIMENT: Record<typeof terrain, FofExperimentId> = {
  open: 'open-approach',
  wooded: 'wooded-delay',
  urban: 'urban-sight-lines',
};

describe.skipIf(seeds <= 0)('Force-on-Force seed sweep', () => {
  it(`runs the ${terrain} approach over the seeds`, () => {
    const experiment = fofExperiment(EXPERIMENT[terrain]);
    const now = () => performance.now();
    const results = [];
    for (let seed = 1; seed <= seeds; seed += 1) {
      const variant = experiment.variants(seed)[0];
      if (!variant) continue;
      results.push(runFof(variant.spec, now));
    }
    const heap = process.memoryUsage().heapUsed / 1e6;
    const summary = summarize(`${terrain} (${experiment.name})`, results);
    // Determinism: five seeds again, the same final state to the bit.
    const repeats = results.slice(0, 5).map((r) => {
      const variant = experiment.variants(r.seed)[0];
      return variant ? runFof(variant.spec, now).finalHash === r.finalHash : false;
    });
    console.log(
      [
        ...summary.lines,
        '',
        `- Determinism (${String(repeats.length)} seeds re-run): ${String(repeats.filter(Boolean).length)}/${String(repeats.length)} identical`,
        `- Agents: 26; engagements per run: 1; heap after the sweep: ${heap.toFixed(0)} MB`,
      ].join('\n'),
    );
    expect(summary.terminated).toBe(summary.runs);
    expect(summary.outcomes.invalid ?? 0).toBe(0);
    expect(summary.rejected).toBe(0);
    expect(repeats.every(Boolean)).toBe(true);
  }, 3_600_000);
});
