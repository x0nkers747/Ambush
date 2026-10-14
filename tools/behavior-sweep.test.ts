import { describe, expect, it } from 'vitest';
import {
  acceptanceFailures,
  runScenario,
  scenarioSpec,
  type LabMetrics,
  type LabOrganization,
  type LabScenarioId,
  type ScenarioOptions,
} from '#exercise/behavior-lab';

// Opt-in seed sweep of the Behavior Lab's scenarios 1–5 (docs/behavior-lab/05 §6):
//   AMBUSH_BEHAVIOR_SWEEP=50 npx vitest run tools/behavior-sweep.test.ts --silent=false
// Runs each scenario for the squad and the 3-Marine element at seeds 1..N
// (the seed moves the start positions and the Marines' personal drift) and
// prints, per scenario, the pass count and the median, 95th percentile and
// worst of the main metrics, as a Markdown table.

const seeds = Number(process.env['AMBUSH_BEHAVIOR_SWEEP'] ?? 0);

const CASES: readonly { id: LabScenarioId; label: string; options?: Partial<ScenarioOptions> }[] = [
  { id: 's1-straight', label: '1 straight' },
  { id: 's2-speeds', label: '2 pace 1.0, d 5', options: { pace: 1.0, interval: 5 } },
  { id: 's2-speeds', label: '2 pace 1.8, d 15', options: { pace: 1.8, interval: 15 } },
  { id: 's3-straggler', label: '3 straggler' },
  { id: 's4-turn', label: '4 turn' },
  { id: 's5-waypoints', label: '5 waypoints' },
];

const stat = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] ?? NaN;

describe.skipIf(seeds <= 0)('Behavior Lab seed sweep', () => {
  it('runs scenarios 1–5 over the seeds', () => {
    const rows = [
      '| Organization | Scenario | Accepted | Mean error p50 / p95 (m) | Max error p95 / worst (m) | Completion p50 (s) | Reversals/min worst | Recovery worst (s) | Collisions | Stuck |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ];
    const failures: string[] = [];
    for (const organization of ['squad', 'element3'] as LabOrganization[]) {
      for (const c of CASES) {
        const results: LabMetrics[] = [];
        let accepted = 0;
        for (let seed = 1; seed <= seeds; seed += 1) {
          const spec = scenarioSpec(c.id, { organization, seed, ...c.options });
          const { metrics } = runScenario(spec);
          results.push(metrics);
          const failed = acceptanceFailures(c.id, spec, metrics);
          if (failed.length === 0) accepted += 1;
          else
            failures.push(`${organization} ${c.label} seed ${String(seed)}: ${failed.join(', ')}`);
        }
        const of = (f: (m: LabMetrics) => number) => results.map(f);
        rows.push(
          `| ${organization} | ${c.label} | ${String(accepted)}/${String(seeds)} | ${stat(
            of((m) => m.steadyMeanError),
            0.5,
          ).toFixed(2)} / ${stat(
            of((m) => m.steadyMeanError),
            0.95,
          ).toFixed(2)} | ${stat(
            of((m) => m.steadyMaxError),
            0.95,
          ).toFixed(2)} / ${Math.max(...of((m) => m.steadyMaxError)).toFixed(2)} | ${stat(
            of((m) => m.completionSeconds ?? NaN),
            0.5,
          ).toFixed(
            0,
          )} | ${Math.max(...of((m) => m.worstReversalsPerMinute)).toFixed(2)} | ${Math.max(...of((m) => m.recoverySeconds ?? 0)).toFixed(1)} | ${String(Math.max(...of((m) => m.collisions)))} | ${String(Math.max(...of((m) => m.stuck)))} |`,
        );
      }
    }
    console.log(rows.join('\n'));
    if (failures.length > 0) console.log(`Not accepted:\n${failures.join('\n')}`);
    expect(rows.length).toBeGreaterThan(2);
  }, 3_600_000);
});
