import { ttpf } from './detection';
import type { FofContext } from './system';
import type { FofState } from './types';

// Which looks can be left out because they cannot detect
// (docs/behavior-lab/force-on-force/04 §5.1). A pair (observer, target) can
// detect only while the target's P∞ exceeds the pair's threshold (drawn at
// the start), and P∞ at its best — the target standing, moving and firing,
// wholly in view, nothing in the way — falls with range. So each pair has a
// reach: beyond it, nothing it could see would be detected; no look there
// ever draws a random number or changes anything but the look counts.
//
// When a pair is found farther apart than its reach (or than the
// observation range), the gap is its budget: the pair is not looked at again
// until the two soldiers have between them travelled that far (each
// soldier's odometer is the sum of his straight-line moves between
// decisions, at least his displacement), since until then they cannot be
// within reach. No speed is assumed. Leaving these looks out changes
// nothing in the run but the look counts.
//
// Not simulation state: kept beside it, per force-on-force state object, and
// rebuilt after a restore (when every pair is simply looked at again).

export interface Schedule {
  readonly n: number;
  /** Per member: metres travelled, summed over decisions. */
  readonly odometer: Float64Array;
  /** Per pair (observer-major): the odometers' sum it may still grow by unseen (0: look). */
  readonly budget: Float64Array;
  readonly sumAt: Float64Array;
  /**
   * Per pair: the target's last burst when it was left out on its reach
   * without the firing cue (−1: none), or NaN (no condition): a burst since
   * ends the deferral.
   */
  readonly firedAt: Float64Array;
  /** Per pair: its reach (m) with every cue, and without the firing cue; NaN until needed. */
  readonly reach: Float64Array;
  readonly reachQuiet: Float64Array;
  /** Per pair: `cyclesNeeded`, NaN until needed. */
  readonly need: Float64Array;
}

const schedules = new WeakMap<FofState, Schedule>();

/** The schedule of a force-on-force state (made on first use). */
export function scheduleFor(fof: FofState): Schedule {
  let s = schedules.get(fof);
  if (s?.n !== fof.soldiers.length) {
    const n = fof.soldiers.length;
    s = {
      n,
      odometer: new Float64Array(n),
      budget: new Float64Array(n * n),
      sumAt: new Float64Array(n * n),
      firedAt: new Float64Array(n * n).fill(Number.NaN),
      reach: new Float64Array(n * n).fill(Number.NaN),
      reachQuiet: new Float64Array(n * n).fill(Number.NaN),
      need: new Float64Array(n * n).fill(Number.NaN),
    };
    schedules.set(fof, s);
  }
  return s;
}

/** Member `i` moved `metres` (straight-line) since the previous decision. */
export function travelled(context: FofContext, i: number, metres: number): void {
  const s = scheduleFor(context.fof);
  s.odometer[i] = (s.odometer[i] ?? 0) + metres;
}

/**
 * The pair is `rangeM` apart and (at best) cannot detect: it is left out
 * until the soldiers may have closed to its reach, or, given `limitM` (the
 * observation range, which it is beyond), to that. Given `quiet` (the target
 * shows no firing cue now), the reach without the firing cue, until the
 * target fires again.
 */
export function deferLook(
  context: FofContext,
  i: number,
  j: number,
  rangeM: number,
  limitM = Infinity,
  quiet: { readonly lastFiredAt: number | null } | null = null,
): void {
  const s = scheduleFor(context.fof);
  const k = i * s.n + j;
  // Beyond the observation range, that range is the edge (no reach needed).
  let edge = limitM;
  let firedAt = Number.NaN;
  if (!Number.isFinite(edge)) {
    const table = quiet ? s.reachQuiet : s.reach;
    edge = table[k] ?? Number.NaN;
    if (Number.isNaN(edge)) {
      edge = reachOf(context, context.fof.thresholds[k] ?? 1, quiet === null);
      table[k] = edge;
    }
    if (quiet) firedAt = quiet.lastFiredAt ?? -1;
  }
  const gap = rangeM - edge;
  if (!(gap > 0)) return;
  s.budget[k] = gap;
  s.sumAt[k] = (s.odometer[i] ?? 0) + (s.odometer[j] ?? 0);
  s.firedAt[k] = firedAt;
}

/** Relative margin on the cycles a detection needs, far above any rounding. */
const CYCLES_MARGIN = 1e-6;
/** Metres added to a reach, far above any rounding. */
const REACH_MARGIN_M = 0.01;
const ARCMIN_RAD = Math.PI / (180 * 60);

/**
 * The range beyond which no target is detectable to a pair with threshold
 * `u`: where the cycles of the best case (the largest critical dimension,
 * every cue, or every cue but firing, wholly in view, clear air but for the haze) fall below what P∞
 * needs to exceed `u`. Both by bisection, with margins.
 */
/**
 * The cycles below which P∞ cannot exceed `u` (with a margin far above
 * rounding): fewer cycles than this, and no look of the pair draws.
 */
export function cyclesNeeded(context: FofContext, k: number): number {
  const s = scheduleFor(context.fof);
  let need = s.need[k] ?? Number.NaN;
  if (Number.isNaN(need)) {
    need = needFor(context, context.fof.thresholds[k] ?? 1);
    s.need[k] = need;
  }
  return need;
}

function needFor(context: FofContext, u: number): number {
  const n50 = context.setup.config.detection.detectionCycles50;
  if (!(u < 1)) return Infinity;
  // ttpf increases with cycles: the largest cycles at which P∞ is still at most u.
  let lo = 0;
  let hi = n50;
  while (ttpf(hi, n50) <= u && hi < 1e9) hi *= 2;
  for (let k = 0; k < 200 && hi - lo > hi * 1e-12; k += 1) {
    const mid = (lo + hi) / 2;
    if (ttpf(mid, n50) <= u) lo = mid;
    else hi = mid;
  }
  return lo * (1 - CYCLES_MARGIN);
}

function reachOf(context: FofContext, u: number, firing: boolean): number {
  const { detection, visibility } = context.setup.config;
  const conditions = visibility[context.setup.visibility];
  if (!(u < 1)) return 0;
  const need = needFor(context, u);
  const dimension = Math.max(...Object.values(detection.criticalDimensionM));
  const cue =
    Math.max(1, detection.movingTargetFactor) *
    (firing ? Math.max(1, detection.firingSignatureFactor) : 1);
  const best = (r: number) =>
    (dimension / (r * detection.cycleArcmin * ARCMIN_RAD)) *
    conditions.backgroundContrast *
    Math.exp((-3.912 * r) / conditions.meteorologicalVisibilityM) *
    cue;
  // Falls with range: the last range where it still reaches `need`.
  const far = conditions.maxObservationRangeM * 4;
  if (best(far) >= need) return Infinity;
  let a = 1e-3;
  let b = far;
  for (let k = 0; k < 200 && b - a > 1e-6; k += 1) {
    const mid = (a + b) / 2;
    if (best(mid) >= need) a = mid;
    else b = mid;
  }
  return b + REACH_MARGIN_M;
}
