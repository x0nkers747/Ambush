import type { Posture, Side } from './state';

// Combat configuration (docs/adr/0019): every balance parameter of the
// engagement model, as versioned, validated plain data. The simulation reads
// these values and nothing else: no combat number is written into the
// algorithms in `combat.ts`. The defaults live in a JSON file of the exercise
// layer (src/exercise/combat/combat-v1.json); docs/combat-configuration.md
// documents every parameter, its unit, valid range and default.
//
// The defaults are illustrative gameplay placeholders, not validated
// empirical combat data. Replacing a curve or probability means editing the
// JSON (and its `version`), not code.

export const COMBAT_CONFIG_SCHEMA = 'ambush.combat-config';
export const COMBAT_CONFIG_SCHEMA_VERSION = 1;

/** One control point of a hit-probability curve. */
export interface RangeProbability {
  /** Horizontal distance from shooter to target, in metres. */
  readonly rangeM: number;
  /** Probability in [0, 1] that one shot at a standing target at this range hits. */
  readonly probability: number;
}

/**
 * The combat performance of one weapon, keyed by the weapon profile reference
 * the organization templates use (docs/adr/0012).
 *
 * Hit probability by range: the first point is at 0 m; ranges strictly
 * increase. Between two points the probability is interpolated linearly in
 * range. From the last point out to `maxEngagementRangeM` it stays at the
 * last point's value. Beyond `maxEngagementRangeM` the weapon is not fired at
 * all: a target there is not a valid target.
 */
export interface WeaponCombatProfile {
  readonly weaponProfileRef: string;
  readonly hitProbabilityByRange: readonly RangeProbability[];
  /** Metres; at least the last curve point's range. */
  readonly maxEngagementRangeM: number;
  /** Probability in [0, 1] that a hit incapacitates the target. */
  readonly incapacitationProbabilityOnHit: number;
  /** Seconds between two firing opportunities of one soldier (> 0). */
  readonly secondsBetweenShots: number;
}

/** A uniformly distributed duration, in seconds: min ≤ value < max (or exactly min when equal). */
export interface UniformSeconds {
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

/**
 * How a shooter chooses among valid targets (active enemies within the
 * weapon's maximum engagement range with a clear line of sight):
 *
 * - `nearest`: the closest by horizontal distance; on a tie, the one first in
 *   scenario soldier order.
 */
export type TargetSelectionPolicy = 'nearest';
export const TARGET_SELECTION_POLICIES: readonly TargetSelectionPolicy[] = ['nearest'];

export interface OpforBehaviorConfig {
  /**
   * Probabilities of each OPFOR soldier's reaction when it is under fire (a
   * shot has been fired at it) as it reacts, drawn independently per soldier.
   * Must sum to 1. A soldier not under fire flees (docs/adr/0028).
   */
  readonly reactionProbabilities: { readonly prone: number; readonly flee: number };
  /** Time from the start of the engagement until a soldier reacts. */
  readonly reactionDelay: UniformSeconds;
  /** After dropping prone, seconds until the first return shot. */
  readonly returnFireDelaySeconds: number;
  /** Fleeing ground speed, in metres per second. */
  readonly fleeSpeedMps: number;
  /** How far away from the threat a fleeing soldier heads, in metres. */
  readonly fleeDistanceM: number;
  /**
   * A fleeing soldier escapes once at least this far (horizontally) from
   * where it started running, or on reaching its flee destination.
   */
  readonly escapeDistanceM: number;
}

export interface EngagementConfig {
  /** The engagement ends at the latest this many simulated seconds after it starts. */
  readonly maxDurationSeconds: number;
  /** Time from the start of the engagement until each BLUEFOR soldier's first firing opportunity. */
  readonly bluforFirstShotDelay: UniformSeconds;
  /** Seconds until a soldier with no valid target looks for one again. */
  readonly targetRecheckSeconds: number;
  /** Target-selection policy of each side. */
  readonly targetSelection: Readonly<Record<Side, TargetSelectionPolicy>>;
}

export interface CombatConfig {
  readonly schema: typeof COMBAT_CONFIG_SCHEMA;
  readonly schemaVersion: typeof COMBAT_CONFIG_SCHEMA_VERSION;
  /** Identifies the configuration; with `version`, recorded with every engagement. */
  readonly id: string;
  /** Semantic version of this configuration's content. */
  readonly version: string;
  readonly name: string;
  /** Free-text notes, e.g. the status of the numbers. */
  readonly notes: readonly string[];
  readonly weapons: readonly WeaponCombatProfile[];
  /** Multiplier on the hit probability of a shot at a target in each posture. */
  readonly postureHitMultipliers: Readonly<Record<Posture, number>>;
  readonly opfor: OpforBehaviorConfig;
  readonly engagement: EngagementConfig;
}

/** Thrown by `validateCombatConfig`; the message names the offending path. */
export class CombatConfigError extends Error {
  override name = 'CombatConfigError';
}

const ID = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const POSTURES: readonly Posture[] = ['standing', 'kneeling', 'prone'];

/**
 * Checks that `data` is a complete, valid combat configuration of the current
 * schema version and returns it typed. Unknown fields are refused, so a
 * misspelt parameter cannot silently fall back to a default. Throws a
 * `CombatConfigError` naming the first problem.
 */
export function validateCombatConfig(data: unknown): CombatConfig {
  const fail = (path: string, message: string): never => {
    throw new CombatConfigError(`combat configuration ${path}: ${message}`);
  };
  const object = (
    value: unknown,
    path: string,
    keys: readonly string[],
  ): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(path, 'must be an object');
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) fail(`${path}.${key}`, 'is not a known field');
    }
    for (const key of keys) if (!(key in record)) fail(`${path}.${key}`, 'is missing');
    return record;
  };
  const text = (value: unknown, path: string, pattern?: RegExp): string => {
    if (typeof value !== 'string' || value === '') return fail(path, 'must be a non-empty string');
    if (pattern && !pattern.test(value)) fail(path, `"${value}" is not in the expected format`);
    return value;
  };
  const number = (value: unknown, path: string, min: number, max: number, open = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(path, 'must be a finite number');
    }
    if (value < min || value > max || (open && value === min)) {
      fail(path, `${String(value)} is outside ${open ? '(' : '['}${String(min)}, ${String(max)}]`);
    }
    return value;
  };
  const probability = (value: unknown, path: string) => number(value, path, 0, 1);
  const seconds = (value: unknown, path: string, open = false) =>
    number(value, path, 0, 3600, open);
  const uniform = (value: unknown, path: string) => {
    const u = object(value, path, ['minSeconds', 'maxSeconds']);
    const min = seconds(u['minSeconds'], `${path}.minSeconds`);
    const max = seconds(u['maxSeconds'], `${path}.maxSeconds`);
    if (max < min) fail(`${path}.maxSeconds`, 'must be at least minSeconds');
  };
  const list = (value: unknown, path: string): unknown[] => {
    if (!Array.isArray(value)) return fail(path, 'must be an array');
    return value as unknown[];
  };

  const root = object(data, '$', [
    'schema',
    'schemaVersion',
    'id',
    'version',
    'name',
    'notes',
    'weapons',
    'postureHitMultipliers',
    'opfor',
    'engagement',
  ]);
  if (root['schema'] !== COMBAT_CONFIG_SCHEMA)
    fail('$.schema', `must be "${COMBAT_CONFIG_SCHEMA}"`);
  if (root['schemaVersion'] !== COMBAT_CONFIG_SCHEMA_VERSION) {
    fail(
      '$.schemaVersion',
      `${JSON.stringify(root['schemaVersion'])} is not supported (expected ${String(COMBAT_CONFIG_SCHEMA_VERSION)})`,
    );
  }
  text(root['id'], '$.id', ID);
  text(root['version'], '$.version', SEMVER);
  text(root['name'], '$.name');
  list(root['notes'], '$.notes').forEach((n, i) => text(n, `$.notes[${String(i)}]`));

  const refs = new Set<string>();
  list(root['weapons'], '$.weapons').forEach((w, i) => {
    const path = `$.weapons[${String(i)}]`;
    const weapon = object(w, path, [
      'weaponProfileRef',
      'hitProbabilityByRange',
      'maxEngagementRangeM',
      'incapacitationProbabilityOnHit',
      'secondsBetweenShots',
    ]);
    const ref = text(weapon['weaponProfileRef'], `${path}.weaponProfileRef`, ID);
    if (refs.has(ref)) fail(`${path}.weaponProfileRef`, `repeats "${ref}"`);
    refs.add(ref);
    const curve = list(weapon['hitProbabilityByRange'], `${path}.hitProbabilityByRange`);
    if (curve.length === 0) fail(`${path}.hitProbabilityByRange`, 'must not be empty');
    let previous = -1;
    curve.forEach((p, k) => {
      const pointPath = `${path}.hitProbabilityByRange[${String(k)}]`;
      const point = object(p, pointPath, ['rangeM', 'probability']);
      const range = number(point['rangeM'], `${pointPath}.rangeM`, 0, 100_000);
      if (k === 0 && range !== 0) fail(`${pointPath}.rangeM`, 'the first point must be at 0 m');
      if (k > 0 && range <= previous) {
        fail(`${pointPath}.rangeM`, 'ranges must strictly increase');
      }
      previous = range;
      probability(point['probability'], `${pointPath}.probability`);
    });
    const max = number(
      weapon['maxEngagementRangeM'],
      `${path}.maxEngagementRangeM`,
      0,
      100_000,
      true,
    );
    if (max < previous) {
      fail(`${path}.maxEngagementRangeM`, 'must be at least the last curve point’s range');
    }
    probability(weapon['incapacitationProbabilityOnHit'], `${path}.incapacitationProbabilityOnHit`);
    seconds(weapon['secondsBetweenShots'], `${path}.secondsBetweenShots`, true);
  });

  const posture = object(root['postureHitMultipliers'], '$.postureHitMultipliers', POSTURES);
  for (const p of POSTURES) probability(posture[p], `$.postureHitMultipliers.${p}`);

  const opfor = object(root['opfor'], '$.opfor', [
    'reactionProbabilities',
    'reactionDelay',
    'returnFireDelaySeconds',
    'fleeSpeedMps',
    'fleeDistanceM',
    'escapeDistanceM',
  ]);
  const reaction = object(opfor['reactionProbabilities'], '$.opfor.reactionProbabilities', [
    'prone',
    'flee',
  ]);
  const prone = probability(reaction['prone'], '$.opfor.reactionProbabilities.prone');
  const flee = probability(reaction['flee'], '$.opfor.reactionProbabilities.flee');
  if (Math.abs(prone + flee - 1) > 1e-9) {
    fail('$.opfor.reactionProbabilities', `must sum to 1, got ${String(prone + flee)}`);
  }
  uniform(opfor['reactionDelay'], '$.opfor.reactionDelay');
  seconds(opfor['returnFireDelaySeconds'], '$.opfor.returnFireDelaySeconds');
  number(opfor['fleeSpeedMps'], '$.opfor.fleeSpeedMps', 0, 15, true);
  number(opfor['fleeDistanceM'], '$.opfor.fleeDistanceM', 0, 10_000, true);
  number(opfor['escapeDistanceM'], '$.opfor.escapeDistanceM', 0, 10_000, true);

  const engagement = object(root['engagement'], '$.engagement', [
    'maxDurationSeconds',
    'bluforFirstShotDelay',
    'targetRecheckSeconds',
    'targetSelection',
  ]);
  seconds(engagement['maxDurationSeconds'], '$.engagement.maxDurationSeconds', true);
  uniform(engagement['bluforFirstShotDelay'], '$.engagement.bluforFirstShotDelay');
  seconds(engagement['targetRecheckSeconds'], '$.engagement.targetRecheckSeconds', true);
  const selection = object(engagement['targetSelection'], '$.engagement.targetSelection', [
    'BLUEFOR',
    'OPFOR',
  ]);
  for (const side of ['BLUEFOR', 'OPFOR'] as const) {
    const policy = selection[side];
    if (!TARGET_SELECTION_POLICIES.includes(policy as TargetSelectionPolicy)) {
      fail(
        `$.engagement.targetSelection.${side}`,
        `must be one of ${TARGET_SELECTION_POLICIES.join(', ')}`,
      );
    }
  }
  return data as CombatConfig;
}

/** The combat profile of a weapon, or `undefined` when the configuration has none. */
export function weaponCombatProfile(
  config: CombatConfig,
  weaponProfileRef: string,
): WeaponCombatProfile | undefined {
  return config.weapons.find((w) => w.weaponProfileRef === weaponProfileRef);
}

/**
 * Probability that one shot from `weapon` at a standing target `rangeM`
 * metres away hits: linear interpolation between the curve's control points,
 * the last point's value from there out to the maximum engagement range, and
 * 0 beyond it (where the weapon is never fired).
 */
export function hitProbabilityAt(
  weapon: Pick<WeaponCombatProfile, 'hitProbabilityByRange' | 'maxEngagementRangeM'>,
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
