import type { LabMetrics } from './metrics';
import type { LabRunSpec } from './run';
import type { LabScenarioId } from './scenarios';

// The first milestone's acceptance thresholds (docs/behavior-lab/05 §2), as
// one function the seed sweep and the lab page use. All are experimental
// calibration targets, not doctrine; the scenario tests state the same
// thresholds one by one.

/** The thresholds `metrics` of scenario `id` run as `spec` fails (empty: accepted). */
export function acceptanceFailures(
  id: LabScenarioId,
  spec: LabRunSpec,
  metrics: LabMetrics,
): string[] {
  const d = spec.interval;
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  check(metrics.outcome === 'arrived', `outcome ${String(metrics.outcome)}`);
  check(metrics.collisions === 0, `${String(metrics.collisions)} collisions`);
  check(metrics.maxSpeedRatio <= 1.3 + 1e-9, `speed ${metrics.maxSpeedRatio.toFixed(2)} × pace`);
  const formation = () => {
    check(
      metrics.steadyMeanError <= 0.15 * d,
      `mean error ${metrics.steadyMeanError.toFixed(2)} m`,
    );
    check(metrics.steadyMaxError <= 0.4 * d, `max error ${metrics.steadyMaxError.toFixed(2)} m`);
  };
  switch (id) {
    case 's1-straight':
    case 's2-speeds':
      formation();
      check(
        (metrics.completionSeconds ?? Infinity) <= (300 / spec.pace) * 1.15 + 20,
        `completion ${String(metrics.completionSeconds)} s`,
      );
      check(
        metrics.worstReversalsPerMinute <= 1,
        `${metrics.worstReversalsPerMinute.toFixed(2)} speed reversals/min`,
      );
      break;
    case 's3-straggler':
      check(
        (metrics.recoverySeconds ?? Infinity) <= 40,
        `recovery ${String(metrics.recoverySeconds)} s`,
      );
      check(metrics.longestStop === 0, `stopped ${metrics.longestStop.toFixed(1)} s`);
      check(
        metrics.othersMaxError <= 0.5 * d,
        `others' error ${metrics.othersMaxError.toFixed(2)} m`,
      );
      break;
    case 's4-turn':
      check(metrics.maxError <= 0.5 * d, `max error ${metrics.maxError.toFixed(2)} m`);
      check(metrics.maxSlip <= 0.4, `sideways ${metrics.maxSlip.toFixed(2)} m/s`);
      break;
    case 's5-waypoints':
      formation();
      check(metrics.longestStop <= 2, `stopped ${metrics.longestStop.toFixed(1)} s`);
      break;
  }
  return failures;
}
