import { hashSimState, type FofOutcomeKind } from '#sim';
import { createFofMetrics, type FofMetrics } from './metrics';
import { createFofRun, type FofRunSpec } from './run';

// Running force-on-force experiments headless and summarizing a seed sweep
// (docs/behavior-lab/force-on-force/04): distributions, not the best run.
// Measured simulation outcomes of an experimental model, not claims about
// real-world combat.

export interface FofRunResult {
  readonly seed: number;
  readonly metrics: FofMetrics;
  /** Simulated seconds, ticks, and CPU time spent stepping (ms). */
  readonly seconds: number;
  readonly ticks: number;
  readonly cpuMs: number;
  readonly finalHash: string;
  /** Whether the run ended by an outcome (not by the safety cap). */
  readonly terminated: boolean;
  /** Commands the kernel refused (none are given but the setup's orders: always 0). */
  readonly rejected: number;
}

/** Runs a spec to its outcome (or `capSeconds`). `now` is a clock in ms for the CPU figure. */
export function runFof(spec: FofRunSpec, now: () => number, capSeconds = 4000): FofRunResult {
  const run = createFofRun(spec);
  const metrics = createFofMetrics(run.sim);
  let cpu = 0;
  let rejected = 0;
  const cap = capSeconds * spec.tickRateHz;
  while (!run.done && run.sim.tick < cap) {
    const t = now();
    const events = run.step();
    cpu += now() - t;
    metrics.sample(events);
    for (const e of events) if (e.type === 'commandRejected') rejected += 1;
  }
  return {
    seed: spec.seed,
    metrics: metrics.result(),
    seconds: run.sim.timeSeconds,
    ticks: run.sim.tick,
    cpuMs: cpu,
    finalHash: hashSimState(run.sim.state),
    terminated: run.done,
    rejected,
  };
}

const quantile = (xs: readonly number[], q: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))] ?? NaN;
};

/** p10 / p50 / p90 of a sample, as text (n/a without data). */
export function spread(xs: readonly number[], digits = 0): string {
  if (xs.length === 0) return 'n/a';
  return [0.1, 0.5, 0.9].map((q) => quantile(xs, q).toFixed(digits)).join(' / ');
}

export interface FofSweepSummary {
  readonly runs: number;
  readonly terminated: number;
  readonly rejected: number;
  readonly outcomes: Readonly<Partial<Record<FofOutcomeKind, number>>>;
  readonly lines: readonly string[];
}

/** A Markdown summary of a sweep's results. */
export function summarize(label: string, results: readonly FofRunResult[]): FofSweepSummary {
  const outcomes: Partial<Record<FofOutcomeKind, number>> = {};
  for (const r of results) {
    const k = r.metrics.outcome?.outcome;
    if (k) outcomes[k] = (outcomes[k] ?? 0) + 1;
  }
  const both = (pick: (r: FofRunResult, side: 'BLUEFOR' | 'OPFOR') => number | null) =>
    results.flatMap((r) =>
      (['BLUEFOR', 'OPFOR'] as const).flatMap((side) => {
        const v = pick(r, side);
        return v === null || !Number.isFinite(v) ? [] : [v];
      }),
    );
  const firstDetected = both((r, s) => r.metrics.sides[s].firstDetected?.seconds ?? null);
  const detectedRange = both((r, s) => r.metrics.sides[s].firstDetected?.rangeM ?? null);
  const possibleRange = both((r, s) => r.metrics.sides[s].firstPossible?.rangeM ?? null);
  const identifiedRange = both((r, s) => r.metrics.sides[s].firstIdentified?.rangeM ?? null);
  const engaged = results.filter((r) => r.metrics.engagementStart !== null);
  const duration = engaged.map((r) => r.metrics.engagementSeconds);
  const casualties = both((r, s) => r.metrics.sides[s].casualties);
  const total = results.map(
    (r) => r.metrics.sides.BLUEFOR.casualties + r.metrics.sides.OPFOR.casualties,
  );
  const rounds = both((r, s) => r.metrics.sides[s].rounds);
  const lost = both((r, s) => r.metrics.sides[s].contactsLost);
  const ends = results.map((r) => r.seconds);
  const msPerSimSecond = results.map((r) => r.cpuMs / Math.max(1e-9, r.seconds));
  const ticksPerSecond = results.map((r) => (r.ticks / Math.max(1e-9, r.cpuMs)) * 1000);
  const stalemates = (outcomes.stalemate ?? 0) + (outcomes.timeLimit ?? 0);
  const decisive = results.filter((r) => r.metrics.outcome?.basis === 'decisive').length;
  const invalid = results.reduce((s, r) => s + r.metrics.invalidTransitions, 0);
  const lines = [
    `### ${label} (${String(results.length)} seeds)`,
    '',
    `- Terminated: ${String(results.filter((r) => r.terminated).length)}/${String(results.length)}; decisive ${String(decisive)}, adjudicated ${String(results.length - decisive - (outcomes.invalid ?? 0))}, invalid ${String(outcomes.invalid ?? 0)}; invariant failures ${String(invalid)}; rejected commands ${String(results.reduce((s, r) => s + r.rejected, 0))}`,
    `- Outcomes: ${Object.entries(outcomes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(', ')}`,
    `- Stalemate or time limit: ${String(stalemates)} (${((100 * stalemates) / Math.max(1, results.length)).toFixed(0)} %)`,
    '',
    '| Measure (both sides pooled where per side) | p10 / p50 / p90 |',
    '| --- | ---: |',
    `| First possible contact range (m) | ${spread(possibleRange)} |`,
    `| First confirmed detection time (s) | ${spread(firstDetected)} |`,
    `| First confirmed detection range (m) | ${spread(detectedRange)} |`,
    `| First identification range (m) | ${spread(identifiedRange)} |`,
    `| Contacts lost per side | ${spread(lost)} |`,
    `| Engagement duration (s), ${String(engaged.length)} engagements | ${spread(duration)} |`,
    `| Rounds per side | ${spread(rounds)} |`,
    `| Casualties per side | ${spread(casualties)} |`,
    `| Casualties per run (both sides) | ${spread(total)} |`,
    `| Experiment end (s) | ${spread(ends)} |`,
    `| Simulation CPU per simulated second (ms) | ${spread(msPerSimSecond, 1)} |`,
    `| Ticks per CPU second (30 Hz) | ${spread(ticksPerSecond)} |`,
  ];
  return {
    runs: results.length,
    terminated: results.filter((r) => r.terminated).length,
    rejected: results.reduce((s, r) => s + r.rejected, 0),
    outcomes,
    lines,
  };
}
