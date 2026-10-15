import type { RangeProbability, UniformSeconds } from '../combat-config';
import type { Posture } from '../state';

// Force-on-force configuration (docs/behavior-lab/force-on-force): every
// parameter of the experimental detection, fire, suppression, organizational
// and termination models, as versioned, validated plain data. The kernel
// reads these values and nothing else. The defaults live in the exercise
// layer (src/exercise/force-on-force/fof-v1.json); the research note
// (docs/behavior-lab/force-on-force/02-detection-research.md) says which are
// taken from the literature and which are experimental.
//
// Separate from the game's combat configuration (combat-v1): the game's
// ambush engagement never reads it, and this model never reads that one.

export const FOF_CONFIG_SCHEMA = 'ambush.fof-config';
export const FOF_CONFIG_SCHEMA_VERSION = 1;

/** Broad observation conditions (experimental classes, not calibrated predictions). */
export type VisibilityClass = 'open' | 'wooded' | 'urban' | 'restricted';
export const VISIBILITY_CLASSES: readonly VisibilityClass[] = [
  'open',
  'wooded',
  'urban',
  'restricted',
];

export interface VisibilityConditions {
  readonly label: string;
  /**
   * Target-to-background contrast and clutter, as a multiplier on the
   * resolvable cycles (1: a clear silhouette on a plain background).
   */
  readonly backgroundContrast: number;
  /** Meteorological visibility (m): apparent contrast falls as exp(−3.912 r / V) (Koschmieder). */
  readonly meteorologicalVisibilityM: number;
  /** Nobody is looked for beyond this (m). */
  readonly maxObservationRangeM: number;
}

export interface DetectionConfig {
  /** Each observer looks at every enemy in his field of regard this often (s). */
  readonly scanIntervalSeconds: number;
  /** The smallest cycle (line pair) the eye resolves in field search (arc minutes). */
  readonly cycleArcmin: number;
  /** Cycles across the target for 50 % detection and for 50 % identification (Johnson-style criteria). */
  readonly detectionCycles50: number;
  readonly identificationCycles50: number;
  /** Mean search time scale (s): a target detectable with P∞ is found at rate P∞ / this. */
  readonly searchSeconds: number;
  /** Attention: the search rate multiplier of an unalerted and an alerted observer. */
  readonly unalertedSearchFactor: number;
  readonly alertedSearchFactor: number;
  /** Half-angle of central vision (deg), and of the field of regard (deg); beyond, nothing is seen. */
  readonly centralHalfAngleDeg: number;
  readonly regardHalfAngleDeg: number;
  /** Search rate multiplier outside central vision. */
  readonly peripheralFactor: number;
  /** Critical dimension of a person in each posture (m): √(height × width). */
  readonly criticalDimensionM: Readonly<Record<Posture, number>>;
  /** Eye height of an observer and the heights looked at on a target, by posture (m). */
  readonly eyeHeightM: Readonly<Record<Posture, number>>;
  readonly targetSampleHeightsM: Readonly<Record<Posture, readonly number[]>>;
  /** Cycle multiplier for a moving target, and for one that fired within `firingSignatureSeconds`. */
  readonly movingTargetFactor: number;
  readonly firingSignatureFactor: number;
  readonly firingSignatureSeconds: number;
  /** A target moving faster than this (m/s) is moving. */
  readonly movingSpeedMps: number;
  /** Confidence added by a successful glimpse; thresholds (hysteresis: confirm high, lose low). */
  readonly confidenceGain: number;
  readonly confirmConfidence: number;
  readonly lostConfidence: number;
  /** An unconfirmed track below this is dropped; a confirmed one below `forgetConfidence` is forgotten. */
  readonly dropConfidence: number;
  readonly forgetConfidence: number;
  /** Confidence halves every this many seconds without a glimpse. */
  readonly confidenceHalfLifeSeconds: number;
  /** Rate multiplier for keeping track of a confirmed contact still in view. */
  readonly trackingFactor: number;
  /** Confidence a force gets in a shooter when it comes under its fire (sound, impacts). */
  readonly underFireConfidence: number;
}

/** An abstract weapon category: one burst (fire event) at a time. */
export interface FofWeapon {
  readonly id: string;
  readonly label: string;
  /** Hit probability of one round at a standing, fully visible target, by range (as combat-v1's curves). */
  readonly hitProbabilityByRange: readonly RangeProbability[];
  readonly maxEngagementRangeM: number;
  readonly roundsPerBurst: number;
  readonly secondsBetweenBursts: number;
  /** Rounds carried at the start. */
  readonly basicLoadRounds: number;
  /** Probability that a hit incapacitates. */
  readonly incapacitationProbabilityOnHit: number;
  /** Suppression a burst adds to the soldier aimed at, and to soldiers within `suppressionRadiusM` of the impact (fading out). */
  readonly suppressionPerBurst: number;
  readonly suppressionRadiusM: number;
}

export interface FireConfig {
  readonly weapons: readonly FofWeapon[];
  /** Hit multiplier on a target in each posture. */
  readonly postureHitMultipliers: Readonly<Record<Posture, number>>;
  /** Hit multiplier when the shooter is moving. */
  readonly movingShooterFactor: number;
  /** Burst interval multiplier per soldier, drawn uniformly per burst (variation between soldiers). */
  readonly cadenceJitter: { readonly min: number; readonly max: number };
  /** Leaders fire this much less often (they observe and command). */
  readonly leaderCadenceFactor: number;
  /** Rules of engagement: fire at confirmed contacts (`detected`) or only at identified ones (`identified`). */
  readonly engageLevel: 'detected' | 'identified';
  /** Fire at a contact's last known position while it is out of view, for this long after it was last seen (s); 0: never. */
  readonly areaFireMemorySeconds: number;
  /** Area fire: burst interval multiplier, and hit multiplier for soldiers near the aim point. */
  readonly areaFireCadenceFactor: number;
  readonly areaFireHitFactor: number;
}

export interface SuppressionConfig {
  /** Suppression halves every this many seconds. */
  readonly recoveryHalfLifeSeconds: number;
  /** Suppressed from `suppressedAt` until below `suppressedClearAt`; pinned likewise. */
  readonly suppressedAt: number;
  readonly suppressedClearAt: number;
  readonly pinnedAt: number;
  readonly pinnedClearAt: number;
  /** A suppressed soldier's accuracy is × (1 − accuracyLoss × suppression), and his cadence × `suppressedCadenceFactor`. */
  readonly accuracyLoss: number;
  readonly suppressedCadenceFactor: number;
  /** Prone soldiers take this share of incoming suppression. */
  readonly proneSuppressionFactor: number;
}

export interface ForceBehaviorConfig {
  /** Time from contact until each soldier reacts (takes up his posture, may fire). */
  readonly reactionDelay: UniformSeconds;
  /** On a possible contact the force halts and observes this long before carrying on (s). */
  readonly possibleContactHoldSeconds: number;
  /**
   * A confirmed contact this close (m) brings the force into contact: it halts,
   * takes up a defensive posture and engages. Farther, it observes as for a
   * possible contact, then carries on, alert.
   */
  readonly engageRangeM: number;
  /** After observing and carrying on, a new possible or distant contact halts the force again only after this long (s). */
  readonly reobserveSeconds: number;
  /** In contact with no confirmed contact and no fire for this long, the force holds (s); then resumes after `resumeAfterSeconds`. */
  readonly contactLostSeconds: number;
  readonly resumeAfterSeconds: number;
  /** Effectiveness to resume the mission after contact is lost. */
  readonly resumeEffectiveness: number;
  /** Withdraw when effectiveness falls below this, ... */
  readonly withdrawEffectiveness: number;
  /** ... or mean suppression stays above `withdrawSuppression` for `withdrawSuppressedSeconds`, ... */
  readonly withdrawSuppression: number;
  readonly withdrawSuppressedSeconds: number;
  /** ... or ammunition falls below this share of the basic load. */
  readonly withdrawAmmunitionFraction: number;
  /** How far a withdrawal goes, away from the known threat (m). */
  readonly withdrawDistanceM: number;
  /** A withdrawing force has withdrawn once it has no confirmed contact for this long (s), or arrives. */
  readonly withdrawnClearSeconds: number;
  /** Below this effectiveness the force is combat ineffective (terminal). */
  readonly ineffectiveEffectiveness: number;
}

export interface EffectivenessConfig {
  /** effectiveness = strength × (1 − suppressionWeight × mean suppression) × ammunition × leadership. */
  readonly suppressionWeight: number;
  /** Below this share of the basic load, ammunition scales effectiveness down linearly. */
  readonly ammunitionLowFraction: number;
  /** Leadership factor with every leader down (linear in the share of leaders active). */
  readonly leaderlessFactor: number;
}

export interface TerminationConfig {
  /** Every experiment ends by this simulated time (s from the start). */
  readonly maxDurationSeconds: number;
  /** Stalemate: over this window of contact, no casualties and effectiveness changing less than `stalemateEffectivenessChange` for both, ... */
  readonly stalemateWindowSeconds: number;
  readonly stalemateEffectivenessChange: number;
  /** ... and either both suppressed past this mean, or no hits in the window, or contact regained and lost this many times. */
  readonly stalemateSuppression: number;
  readonly stalemateContactCycles: number;
  /** Mutual disengagement: after contact, neither has a confirmed contact nor fires for this long (s). */
  readonly disengagementSeconds: number;
  /** Both below this share of their basic load: ammunition exhausted. */
  readonly ammunitionExhaustedFraction: number;
  /** An adjudicated outcome notes an advantage when effectiveness differs by at least this. */
  readonly advantageMargin: number;
}

export interface FofConfig {
  readonly schema: typeof FOF_CONFIG_SCHEMA;
  readonly schemaVersion: typeof FOF_CONFIG_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly notes: readonly string[];
  /** Decisions are taken on this grid (Hz): an integer dividing the supported tick rates. */
  readonly decisionHz: number;
  readonly visibility: Readonly<Record<VisibilityClass, VisibilityConditions>>;
  readonly detection: DetectionConfig;
  readonly fire: FireConfig;
  readonly suppression: SuppressionConfig;
  readonly force: ForceBehaviorConfig;
  readonly effectiveness: EffectivenessConfig;
  readonly termination: TerminationConfig;
}

/** Thrown by `validateFofConfig`; the message names the offending path. */
export class FofConfigError extends Error {
  override name = 'FofConfigError';
}

const POSTURES: readonly Posture[] = ['standing', 'kneeling', 'prone'];

/**
 * Checks that `data` is a complete, valid configuration of the current
 * schema and returns it typed. Unknown fields are refused (a misspelt
 * parameter cannot silently fall back), every number must be finite and in
 * its range. Throws a `FofConfigError` naming the first problem.
 */
export function validateFofConfig(data: unknown): FofConfig {
  const fail = (path: string, message: string): never => {
    throw new FofConfigError(`force-on-force configuration ${path}: ${message}`);
  };
  const object = (value: unknown, path: string, keys: readonly string[]) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(path, 'must be an object');
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) fail(`${path}.${key}`, 'is not a known parameter');
    }
    for (const key of keys) {
      if (!(key in record)) fail(`${path}.${key}`, 'is missing');
    }
    return record;
  };
  const number = (value: unknown, path: string, min: number, max = Infinity): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      return fail(path, `must be a number in [${String(min)}, ${String(max)}]`);
    }
    return value;
  };
  const positive = (value: unknown, path: string) => {
    const n = number(value, path, 0);
    if (n <= 0) fail(path, 'must be > 0');
    return n;
  };
  const string = (value: unknown, path: string) => {
    if (typeof value !== 'string' || value === '') fail(path, 'must be a non-empty string');
    return value as string;
  };
  const numbers = (
    record: Record<string, unknown>,
    path: string,
    spec: Record<string, [number, number?]>,
  ) => {
    for (const [key, [min, max]] of Object.entries(spec))
      number(record[key], `${path}.${key}`, min, max);
  };
  const byPosture = (value: unknown, path: string, check: (v: unknown, p: string) => void) => {
    const record = object(value, path, POSTURES);
    for (const p of POSTURES) check(record[p], `${path}.${p}`);
  };

  const root = object(data, '', [
    'schema',
    'schemaVersion',
    'id',
    'version',
    'name',
    'notes',
    'decisionHz',
    'visibility',
    'detection',
    'fire',
    'suppression',
    'force',
    'effectiveness',
    'termination',
  ]);
  if (root['schema'] !== FOF_CONFIG_SCHEMA) fail('.schema', `must be "${FOF_CONFIG_SCHEMA}"`);
  if (root['schemaVersion'] !== FOF_CONFIG_SCHEMA_VERSION) {
    fail('.schemaVersion', `must be ${String(FOF_CONFIG_SCHEMA_VERSION)}`);
  }
  string(root['id'], '.id');
  if (!/^\d+\.\d+\.\d+$/.test(string(root['version'], '.version'))) {
    fail('.version', 'must be a semantic version');
  }
  string(root['name'], '.name');
  if (!Array.isArray(root['notes']) || !root['notes'].every((n) => typeof n === 'string')) {
    fail('.notes', 'must be an array of strings');
  }
  const hz = number(root['decisionHz'], '.decisionHz', 1, 120);
  if (!Number.isInteger(hz)) fail('.decisionHz', 'must be an integer');

  const visibility = object(root['visibility'], '.visibility', VISIBILITY_CLASSES);
  for (const c of VISIBILITY_CLASSES) {
    const v = object(visibility[c], `.visibility.${c}`, [
      'label',
      'backgroundContrast',
      'meteorologicalVisibilityM',
      'maxObservationRangeM',
    ]);
    string(v['label'], `.visibility.${c}.label`);
    number(v['backgroundContrast'], `.visibility.${c}.backgroundContrast`, 0, 2);
    positive(v['meteorologicalVisibilityM'], `.visibility.${c}.meteorologicalVisibilityM`);
    positive(v['maxObservationRangeM'], `.visibility.${c}.maxObservationRangeM`);
  }

  const d = object(root['detection'], '.detection', [
    'scanIntervalSeconds',
    'cycleArcmin',
    'detectionCycles50',
    'identificationCycles50',
    'searchSeconds',
    'unalertedSearchFactor',
    'alertedSearchFactor',
    'centralHalfAngleDeg',
    'regardHalfAngleDeg',
    'peripheralFactor',
    'criticalDimensionM',
    'eyeHeightM',
    'targetSampleHeightsM',
    'movingTargetFactor',
    'firingSignatureFactor',
    'firingSignatureSeconds',
    'movingSpeedMps',
    'confidenceGain',
    'confirmConfidence',
    'lostConfidence',
    'dropConfidence',
    'forgetConfidence',
    'confidenceHalfLifeSeconds',
    'trackingFactor',
    'underFireConfidence',
  ]);
  for (const key of [
    'scanIntervalSeconds',
    'cycleArcmin',
    'detectionCycles50',
    'identificationCycles50',
    'searchSeconds',
    'confidenceHalfLifeSeconds',
  ]) {
    positive(d[key], `.detection.${key}`);
  }
  numbers(d, '.detection', {
    unalertedSearchFactor: [0, 10],
    alertedSearchFactor: [0, 10],
    centralHalfAngleDeg: [0, 180],
    regardHalfAngleDeg: [0, 180],
    peripheralFactor: [0, 1],
    movingTargetFactor: [0, 10],
    firingSignatureFactor: [0, 10],
    firingSignatureSeconds: [0],
    movingSpeedMps: [0],
    confidenceGain: [0, 1],
    confirmConfidence: [0, 1],
    lostConfidence: [0, 1],
    dropConfidence: [0, 1],
    forgetConfidence: [0, 1],
    trackingFactor: [0, 100],
    underFireConfidence: [0, 1],
  });
  const conf = (k: string) => d[k] as number;
  if (!(
    conf('forgetConfidence') <= conf('lostConfidence') &&
    conf('dropConfidence') <= conf('lostConfidence') &&
    conf('lostConfidence') < conf('confirmConfidence')
  )) {
    fail('.detection', 'needs forget, drop ≤ lost < confirm confidence (hysteresis)');
  }
  if ((d['centralHalfAngleDeg'] as number) > (d['regardHalfAngleDeg'] as number)) {
    fail('.detection.centralHalfAngleDeg', 'must not exceed regardHalfAngleDeg');
  }
  byPosture(d['criticalDimensionM'], '.detection.criticalDimensionM', (v, p) => positive(v, p));
  byPosture(d['eyeHeightM'], '.detection.eyeHeightM', (v, p) => positive(v, p));
  byPosture(d['targetSampleHeightsM'], '.detection.targetSampleHeightsM', (v, p) => {
    if (!Array.isArray(v) || v.length === 0) fail(p, 'must be a non-empty array');
    (v as unknown[]).forEach((h, i) => positive(h, `${p}[${String(i)}]`));
  });

  const f = object(root['fire'], '.fire', [
    'weapons',
    'postureHitMultipliers',
    'movingShooterFactor',
    'cadenceJitter',
    'leaderCadenceFactor',
    'engageLevel',
    'areaFireMemorySeconds',
    'areaFireCadenceFactor',
    'areaFireHitFactor',
  ]);
  if (!Array.isArray(f['weapons']) || f['weapons'].length === 0) {
    fail('.fire.weapons', 'must be a non-empty array');
  }
  const ids = new Set<string>();
  (f['weapons'] as unknown[]).forEach((w, i) => {
    const path = `.fire.weapons[${String(i)}]`;
    const weapon = object(w, path, [
      'id',
      'label',
      'hitProbabilityByRange',
      'maxEngagementRangeM',
      'roundsPerBurst',
      'secondsBetweenBursts',
      'basicLoadRounds',
      'incapacitationProbabilityOnHit',
      'suppressionPerBurst',
      'suppressionRadiusM',
    ]);
    const id = string(weapon['id'], `${path}.id`);
    if (ids.has(id)) fail(`${path}.id`, `"${id}" is used twice`);
    ids.add(id);
    string(weapon['label'], `${path}.label`);
    const curve = weapon['hitProbabilityByRange'];
    if (!Array.isArray(curve) || curve.length === 0)
      fail(`${path}.hitProbabilityByRange`, 'must be a non-empty array');
    let last = -1;
    (curve as unknown[]).forEach((point, j) => {
      const pp = `${path}.hitProbabilityByRange[${String(j)}]`;
      const rp = object(point, pp, ['rangeM', 'probability']);
      const r = number(rp['rangeM'], `${pp}.rangeM`, 0);
      if (j === 0 && r !== 0) fail(`${pp}.rangeM`, 'the first point must be at 0 m');
      if (r <= last) fail(`${pp}.rangeM`, 'ranges must increase');
      last = r;
      number(rp['probability'], `${pp}.probability`, 0, 1);
    });
    if (number(weapon['maxEngagementRangeM'], `${path}.maxEngagementRangeM`, 0) < last) {
      fail(`${path}.maxEngagementRangeM`, 'must be at least the last curve range');
    }
    const rounds = positive(weapon['roundsPerBurst'], `${path}.roundsPerBurst`);
    if (!Number.isInteger(rounds)) fail(`${path}.roundsPerBurst`, 'must be an integer');
    positive(weapon['secondsBetweenBursts'], `${path}.secondsBetweenBursts`);
    const load = number(weapon['basicLoadRounds'], `${path}.basicLoadRounds`, 0);
    if (!Number.isInteger(load)) fail(`${path}.basicLoadRounds`, 'must be an integer');
    number(
      weapon['incapacitationProbabilityOnHit'],
      `${path}.incapacitationProbabilityOnHit`,
      0,
      1,
    );
    number(weapon['suppressionPerBurst'], `${path}.suppressionPerBurst`, 0, 1);
    number(weapon['suppressionRadiusM'], `${path}.suppressionRadiusM`, 0);
  });
  byPosture(f['postureHitMultipliers'], '.fire.postureHitMultipliers', (v, p) =>
    number(v, p, 0, 1),
  );
  numbers(f, '.fire', {
    movingShooterFactor: [0, 1],
    leaderCadenceFactor: [0, 1],
    areaFireMemorySeconds: [0],
    areaFireCadenceFactor: [1, 100],
    areaFireHitFactor: [0, 1],
  });
  const jitter = object(f['cadenceJitter'], '.fire.cadenceJitter', ['min', 'max']);
  const jmin = positive(jitter['min'], '.fire.cadenceJitter.min');
  if (number(jitter['max'], '.fire.cadenceJitter.max', jmin) < jmin)
    fail('.fire.cadenceJitter', 'min > max');
  if (f['engageLevel'] !== 'detected' && f['engageLevel'] !== 'identified') {
    fail('.fire.engageLevel', 'must be "detected" or "identified"');
  }

  const s = object(root['suppression'], '.suppression', [
    'recoveryHalfLifeSeconds',
    'suppressedAt',
    'suppressedClearAt',
    'pinnedAt',
    'pinnedClearAt',
    'accuracyLoss',
    'suppressedCadenceFactor',
    'proneSuppressionFactor',
  ]);
  positive(s['recoveryHalfLifeSeconds'], '.suppression.recoveryHalfLifeSeconds');
  numbers(s, '.suppression', {
    suppressedAt: [0, 1],
    suppressedClearAt: [0, 1],
    pinnedAt: [0, 1],
    pinnedClearAt: [0, 1],
    accuracyLoss: [0, 1],
    suppressedCadenceFactor: [1, 100],
    proneSuppressionFactor: [0, 1],
  });
  const sv = (k: string) => s[k] as number;
  if (!(
    sv('suppressedClearAt') < sv('suppressedAt') &&
    sv('pinnedClearAt') < sv('pinnedAt') &&
    sv('suppressedAt') <= sv('pinnedAt')
  )) {
    fail('.suppression', 'needs clear < enter thresholds, and suppressed ≤ pinned');
  }

  const fb = object(root['force'], '.force', [
    'reactionDelay',
    'possibleContactHoldSeconds',
    'engageRangeM',
    'reobserveSeconds',
    'contactLostSeconds',
    'resumeAfterSeconds',
    'resumeEffectiveness',
    'withdrawEffectiveness',
    'withdrawSuppression',
    'withdrawSuppressedSeconds',
    'withdrawAmmunitionFraction',
    'withdrawDistanceM',
    'withdrawnClearSeconds',
    'ineffectiveEffectiveness',
  ]);
  const delay = object(fb['reactionDelay'], '.force.reactionDelay', ['minSeconds', 'maxSeconds']);
  const dmin = number(delay['minSeconds'], '.force.reactionDelay.minSeconds', 0);
  number(delay['maxSeconds'], '.force.reactionDelay.maxSeconds', dmin);
  numbers(fb, '.force', {
    possibleContactHoldSeconds: [0],
    engageRangeM: [0],
    reobserveSeconds: [0],
    contactLostSeconds: [0],
    resumeAfterSeconds: [0],
    resumeEffectiveness: [0, 1],
    withdrawEffectiveness: [0, 1],
    withdrawSuppression: [0, 1],
    withdrawSuppressedSeconds: [0],
    withdrawAmmunitionFraction: [0, 1],
    withdrawDistanceM: [0],
    withdrawnClearSeconds: [0],
    ineffectiveEffectiveness: [0, 1],
  });
  if ((fb['ineffectiveEffectiveness'] as number) > (fb['withdrawEffectiveness'] as number)) {
    fail('.force.ineffectiveEffectiveness', 'must not exceed withdrawEffectiveness');
  }

  const e = object(root['effectiveness'], '.effectiveness', [
    'suppressionWeight',
    'ammunitionLowFraction',
    'leaderlessFactor',
  ]);
  numbers(e, '.effectiveness', {
    suppressionWeight: [0, 1],
    ammunitionLowFraction: [0, 1],
    leaderlessFactor: [0, 1],
  });

  const t = object(root['termination'], '.termination', [
    'maxDurationSeconds',
    'stalemateWindowSeconds',
    'stalemateEffectivenessChange',
    'stalemateSuppression',
    'stalemateContactCycles',
    'disengagementSeconds',
    'ammunitionExhaustedFraction',
    'advantageMargin',
  ]);
  positive(t['maxDurationSeconds'], '.termination.maxDurationSeconds');
  positive(t['stalemateWindowSeconds'], '.termination.stalemateWindowSeconds');
  positive(t['disengagementSeconds'], '.termination.disengagementSeconds');
  numbers(t, '.termination', {
    stalemateEffectivenessChange: [0, 1],
    stalemateSuppression: [0, 1],
    stalemateContactCycles: [1],
    ammunitionExhaustedFraction: [0, 1],
    advantageMargin: [0, 1],
  });
  return data as FofConfig;
}

/** The weapon category `id`, or undefined. */
export function fofWeapon(config: FofConfig, id: string): FofWeapon | undefined {
  return config.fire.weapons.find((w) => w.id === id);
}
