// A weapon's hit probability by range: a curve of control points
// (`FofWeapon.hitProbabilityByRange`), out to its maximum engagement range.

/** One control point of a hit-probability curve. */
export interface RangeProbability {
  /** Horizontal distance from shooter to target, in metres. */
  readonly rangeM: number;
  /** Probability in [0, 1] that one shot at a standing target at this range hits. */
  readonly probability: number;
}

/**
 * Probability that one shot from `weapon` at a standing target `rangeM`
 * metres away hits: linear interpolation between the curve's control points,
 * the last point's value from there out to the maximum engagement range, and
 * 0 beyond it (where the weapon is never fired).
 */
export function hitProbabilityAt(
  weapon: {
    readonly hitProbabilityByRange: readonly RangeProbability[];
    readonly maxEngagementRangeM: number;
  },
  rangeM: number,
): number {
  if (!(rangeM >= 0) || rangeM > weapon.maxEngagementRangeM) return 0;
  const curve = weapon.hitProbabilityByRange;
  for (let i = 1; i < curve.length; i += 1) {
    const b = curve[i];
    const a = curve[i - 1];
    if (a === undefined || b === undefined) break;
    if (rangeM === b.rangeM) return b.probability;
    if (rangeM < b.rangeM) {
      const t = (rangeM - a.rangeM) / (b.rangeM - a.rangeM);
      return a.probability + t * (b.probability - a.probability);
    }
  }
  return curve[curve.length - 1]?.probability ?? 0;
}
