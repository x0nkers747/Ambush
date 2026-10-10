import type { EngagementSummary, SoldierId } from '#sim';

// The After Action Review's score and recommendations (docs/adr/0027): four
// independent categories, 100 points in all, computed from the completed
// engagement's summary, never from a replay frame. Deterministic and
// rule-based: no analysis beyond the formulas and rules below.
//
// What the simulation records, and how it is read:
// - A "shot" is one firing opportunity (an aimed shot or a short burst), not
//   a round: rounds are not modelled. Efficiency counts shots, and says so.
// - The only casualty state is `incapacitated` (no wounded / killed split). It
//   counts as killed (the formula's ×2); wounded is always 0, not modelled.
// - Escape is the simulation's own `escaped` outcome (docs/adr/0019).
// - There are no participation assignments: every Marine with a weapon is
//   eligible (all are active when the engagement begins).

export type ScoreCategoryId = 'participation' | 'survival' | 'containment' | 'efficiency';

/** A raw measurement behind a score, for display. */
export interface ScoreMeasurement {
  readonly label: string;
  readonly value: number | string;
}

export interface CategoryScore {
  readonly id: ScoreCategoryId;
  readonly label: string;
  readonly maxPoints: number;
  /** Full precision; `null` when the category cannot be evaluated (see `unavailableReason`). */
  readonly points: number | null;
  readonly supported: boolean;
  readonly unavailableReason: string | null;
  readonly measurements: readonly ScoreMeasurement[];
  /** The soldiers behind the deductions (e.g. Marines who never fired, OPFOR who escaped). */
  readonly unitIds: readonly SoldierId[];
  /** Why points were deducted, in plain words; empty when none were. */
  readonly deductions: readonly string[];
}

export type RecommendationSeverity = 'high' | 'medium' | 'low' | 'info';

export type RecommendationId =
  | 'incomplete-participation'
  | 'friendly-casualties'
  | 'enemy-escape'
  | 'inefficient-fire'
  | 'no-enemy-casualties'
  | 'excellent-performance';

export interface Recommendation {
  readonly id: RecommendationId;
  readonly category: ScoreCategoryId | 'overall';
  readonly severity: RecommendationSeverity;
  readonly title: string;
  /** What was observed (facts from the record, no causes). */
  readonly observation: string;
  readonly recommendation: string;
  readonly measurements: readonly ScoreMeasurement[];
  readonly unitIds: readonly SoldierId[];
  /** Points lost in the related category, for ordering. */
  readonly impact: number;
}

export interface EngagementScore {
  /** Whether every category could be evaluated; only then is there a total. */
  readonly complete: boolean;
  /** Full precision, out of `maxTotal`; `null` for an incomplete assessment. */
  readonly total: number | null;
  readonly maxTotal: number;
  readonly categories: readonly CategoryScore[];
  /** Most severe first, then by points lost. */
  readonly recommendations: readonly Recommendation[];
}

export const MAX_POINTS: Readonly<Record<ScoreCategoryId, number>> = {
  participation: 20,
  survival: 30,
  containment: 30,
  efficiency: 20,
};

/** How an `incapacitated` soldier counts in survival: killed (weight 2), as decided for combat v1. */
export const INCAPACITATED_COUNTS_AS = 'killed' as const;
/** More shots than this per enemy incapacitated triggers the inefficient-fire recommendation. */
export const INEFFICIENT_SHOTS_PER_KILL = 10;
/** Efficiency points needed (with everything else perfect) for the excellent-performance note. */
export const EXCELLENT_EFFICIENCY_POINTS = 16;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

const unavailable = (
  id: ScoreCategoryId,
  label: string,
  reason: string,
  measurements: readonly ScoreMeasurement[] = [],
): CategoryScore => ({
  id,
  label,
  maxPoints: MAX_POINTS[id],
  points: null,
  supported: false,
  unavailableReason: reason,
  measurements,
  unitIds: [],
  deductions: [],
});

/**
 * The score of a completed engagement. `summary` is the engagement's summary
 * (`Exercise.engagementResult`) once it has ended; anything else (no
 * engagement, or one still running) gives an incomplete assessment with every
 * category unavailable.
 */
export function scoreEngagement(summary: EngagementSummary | null): EngagementScore {
  if (summary?.endSeconds == null) {
    const reason = summary
      ? 'The engagement has not ended yet.'
      : 'There was no engagement to assess.';
    const categories = (Object.keys(MAX_POINTS) as ScoreCategoryId[]).map((id) =>
      unavailable(id, CATEGORY_LABELS[id], reason),
    );
    return { complete: false, total: null, maxTotal: 100, categories, recommendations: [] };
  }

  const blufor = summary.soldiers.filter((s) => s.side === 'BLUEFOR');
  const opfor = summary.soldiers.filter((s) => s.side === 'OPFOR');

  // A. Fire participation: Marines with a weapon who fired at least once.
  const eligible = blufor.filter((s) => s.weaponProfileRef !== null);
  const silent = eligible.filter((s) => s.stats.shotsFired === 0);
  const participation: CategoryScore =
    eligible.length === 0
      ? unavailable(
          'participation',
          CATEGORY_LABELS.participation,
          'No Marine had a weapon to fire.',
        )
      : {
          id: 'participation',
          label: CATEGORY_LABELS.participation,
          maxPoints: MAX_POINTS.participation,
          points: MAX_POINTS.participation * ((eligible.length - silent.length) / eligible.length),
          supported: true,
          unavailableReason: null,
          measurements: [
            { label: 'Marines who fired', value: eligible.length - silent.length },
            { label: 'Marines eligible (armed)', value: eligible.length },
          ],
          unitIds: silent.map((s) => s.soldierId),
          deductions:
            silent.length === 0 ? [] : [`${plural(silent.length, 'eligible Marine')} never fired.`],
        };

  // B. BLUEFOR survival: incapacitated counts as killed (×2); wounded is not modelled.
  const fallen = blufor.filter((s) => s.outcome === 'incapacitated');
  const wounded = 0;
  const killed = fallen.length;
  const survival: CategoryScore =
    blufor.length === 0
      ? unavailable(
          'survival',
          CATEGORY_LABELS.survival,
          'There were no Marines in the engagement.',
        )
      : {
          id: 'survival',
          label: CATEGORY_LABELS.survival,
          maxPoints: MAX_POINTS.survival,
          points: MAX_POINTS.survival * Math.max(0, 1 - (wounded + 2 * killed) / blufor.length),
          supported: true,
          unavailableReason: null,
          measurements: [
            { label: 'Marines', value: blufor.length },
            { label: 'Incapacitated (counted as killed)', value: killed },
            { label: 'Wounded', value: 'not modelled' },
          ],
          unitIds: fallen.map((s) => s.soldierId),
          deductions:
            killed === 0
              ? []
              : [
                  `${plural(killed, 'Marine was', 'Marines were')} incapacitated (each counted as killed).`,
                ],
        };

  // C. OPFOR containment: the simulation's own escapes.
  const escaped = opfor.filter((s) => s.outcome === 'escaped');
  const containment: CategoryScore =
    opfor.length === 0
      ? unavailable(
          'containment',
          CATEGORY_LABELS.containment,
          'There was no OPFOR in the engagement.',
        )
      : {
          id: 'containment',
          label: CATEGORY_LABELS.containment,
          maxPoints: MAX_POINTS.containment,
          points: MAX_POINTS.containment * (1 - escaped.length / opfor.length),
          supported: true,
          unavailableReason: null,
          measurements: [
            { label: 'OPFOR', value: opfor.length },
            { label: 'Escaped', value: escaped.length },
          ],
          unitIds: escaped.map((s) => s.soldierId),
          deductions:
            escaped.length === 0
              ? []
              : [`${plural(escaped.length, 'enemy soldier', 'enemy soldiers')} escaped.`],
        };

  // D. Efficiency: shots (firing opportunities, not rounds) per enemy incapacitated.
  const shots = blufor.reduce((n, s) => n + s.stats.shotsFired, 0);
  const kills = opfor.filter((s) => s.outcome === 'incapacitated').length;
  const shotsPerKill = kills > 0 ? shots / kills : null;
  const efficiency: CategoryScore = {
    id: 'efficiency',
    label: CATEGORY_LABELS.efficiency,
    maxPoints: MAX_POINTS.efficiency,
    points: shotsPerKill === null ? 0 : MAX_POINTS.efficiency * clamp01((20 - shotsPerKill) / 19),
    supported: true,
    unavailableReason: null,
    measurements: [
      { label: 'Shots fired by Marines', value: shots },
      { label: 'Enemies incapacitated', value: kills },
      {
        label: 'Shots per enemy incapacitated',
        value: shotsPerKill === null ? '–' : Number(shotsPerKill.toFixed(1)),
      },
    ],
    unitIds: [],
    deductions:
      shotsPerKill === null
        ? ['No enemy was incapacitated, so no efficiency points.']
        : shotsPerKill > 1
          ? [
              `${shotsPerKill.toFixed(1)} shots per enemy incapacitated (1 earns full points, 20 or more none).`,
            ]
          : [],
  };

  const categories = [participation, survival, containment, efficiency];
  const complete = categories.every((c) => c.points !== null);
  const total = complete ? categories.reduce((n, c) => n + (c.points ?? 0), 0) : null;
  return {
    complete,
    total,
    maxTotal: 100,
    categories,
    recommendations: recommend({
      participation,
      survival,
      containment,
      efficiency,
      shots,
      kills,
      shotsPerKill,
    }),
  };
}

const CATEGORY_LABELS: Readonly<Record<ScoreCategoryId, string>> = {
  participation: 'Fire participation',
  survival: 'BLUEFOR survival',
  containment: 'OPFOR containment',
  efficiency: 'Fire efficiency',
};

const SEVERITY_RANK: Readonly<Record<RecommendationSeverity, number>> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};
const lost = (c: CategoryScore) => (c.points === null ? 0 : c.maxPoints - c.points);

/** The rule-based recommendations, each at most once, most severe first. */
function recommend(m: {
  readonly participation: CategoryScore;
  readonly survival: CategoryScore;
  readonly containment: CategoryScore;
  readonly efficiency: CategoryScore;
  readonly shots: number;
  readonly kills: number;
  readonly shotsPerKill: number | null;
}): Recommendation[] {
  const out: Recommendation[] = [];
  const { participation, survival, containment, efficiency } = m;

  // Rule 1: eligible Marines who never fired.
  if (participation.supported && participation.unitIds.length > 0) {
    out.push({
      id: 'incomplete-participation',
      category: 'participation',
      severity: 'medium',
      title: 'Not every Marine fired',
      observation: `${plural(participation.unitIds.length, 'eligible Marine')} never fired during the engagement.`,
      recommendation:
        'Not all assigned units participated in the engagement. Review unit visibility into the kill zone and check engagement orders.',
      measurements: participation.measurements,
      unitIds: participation.unitIds,
      impact: lost(participation),
    });
  }
  // Rule 2: friendly casualties.
  if (survival.supported && survival.unitIds.length > 0) {
    out.push({
      id: 'friendly-casualties',
      category: 'survival',
      severity: 'high',
      title: 'Friendly casualties',
      observation: `${plural(survival.unitIds.length, 'Marine was', 'Marines were')} incapacitated.`,
      recommendation:
        'Friendly forces sustained casualties. Review the exposure, cover, and positioning of affected units.',
      measurements: survival.measurements,
      unitIds: survival.unitIds,
      impact: lost(survival),
    });
  }
  // Rule 3: enemy escape.
  if (containment.supported && containment.unitIds.length > 0) {
    out.push({
      id: 'enemy-escape',
      category: 'containment',
      severity: 'high',
      title: 'Enemy escaped',
      observation: `${plural(containment.unitIds.length, 'enemy soldier', 'enemy soldiers')} escaped the engagement area.`,
      recommendation:
        'Enemy units escaped the engagement area. Review whether the selected position adequately covers likely exit routes.',
      measurements: containment.measurements,
      unitIds: containment.unitIds,
      impact: lost(containment),
    });
  }
  // Rule 5 before rule 4: with no enemy incapacitated, "inefficient" would say the same thing.
  if (m.kills === 0) {
    out.push({
      id: 'no-enemy-casualties',
      category: 'efficiency',
      severity: 'high',
      title: 'No enemy casualties',
      observation: `No enemy was incapacitated (${plural(m.shots, 'shot')} fired by Marines).`,
      recommendation:
        'No enemy casualties were recorded. Review whether friendly units were able to acquire and engage targets.',
      measurements: efficiency.measurements,
      unitIds: [],
      impact: lost(efficiency),
    });
  } else if (m.shotsPerKill !== null && m.shotsPerKill > INEFFICIENT_SHOTS_PER_KILL) {
    // Rule 4: more than 10 shots per enemy incapacitated.
    out.push({
      id: 'inefficient-fire',
      category: 'efficiency',
      severity: 'medium',
      title: 'High fire expenditure',
      observation: `${plural(m.shots, 'shot')} for ${plural(m.kills, 'enemy', 'enemies')} incapacitated: ${m.shotsPerKill.toFixed(1)} shots each.`,
      recommendation:
        'Ammunition expenditure was high relative to enemy losses. Review target acquisition, engagement distances, and fire control.',
      measurements: efficiency.measurements,
      unitIds: [],
      impact: lost(efficiency),
    });
  }
  // Rule 6: everything went well (only then; it never sits beside a problem).
  if (
    participation.supported &&
    survival.supported &&
    containment.supported &&
    participation.unitIds.length === 0 &&
    survival.unitIds.length === 0 &&
    containment.unitIds.length === 0 &&
    (efficiency.points ?? 0) >= EXCELLENT_EFFICIENCY_POINTS
  ) {
    out.push({
      id: 'excellent-performance',
      category: 'overall',
      severity: 'info',
      title: 'Strong overall performance',
      observation:
        'Every eligible Marine fired, no Marine was incapacitated, no enemy escaped, and fire was efficient.',
      recommendation:
        'Strong overall performance. All assigned units participated, friendly forces avoided casualties, enemy forces were contained, and ammunition use was efficient.',
      measurements: efficiency.measurements,
      unitIds: [],
      impact: 0,
    });
  }
  return out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.impact - a.impact ||
      a.id.localeCompare(b.id),
  );
}

/** Points as displayed: one decimal. */
export function displayPoints(points: number): string {
  return (Math.round(points * 10) / 10).toFixed(1);
}

/** The letter grade of a total as displayed (`displayPoints`), so the two always agree. */
export function gradeOf(total: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  const shown = Math.round(total * 10) / 10;
  return shown >= 90 ? 'A' : shown >= 80 ? 'B' : shown >= 70 ? 'C' : shown >= 60 ? 'D' : 'F';
}
