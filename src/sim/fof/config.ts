import type { RangeProbability } from './hit-probability';
import type { Posture } from '../state';

// Force-on-force configuration (docs/behavior-lab/force-on-force): every
// parameter of the experimental detection, fire, suppression, organizational
// and termination models, as versioned, validated plain data. The kernel
// reads these values and nothing else. The defaults live in the exercise
// layer (src/exercise/forces/fof-v2.json); the research note
// (docs/behavior-lab/force-on-force/02-detection-research.md) says which are
// taken from the literature and which are experimental.

export const FOF_CONFIG_SCHEMA = 'ambush.fof-config';
/** 2: weapons with feeds, fire modes, reloads and area effects (docs/behavior-lab/force-on-force/06). */
export const FOF_CONFIG_SCHEMA_VERSION = 2;

/** A uniformly distributed duration, in seconds: min ≤ value < max (or exactly min when equal). */
export interface UniformSeconds {
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

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

/** What a weapon is (docs/behavior-lab/force-on-force/06 §2); categories can be added. */
export type WeaponCategory = 'rifle' | 'carbine' | 'lightMachineGun' | 'grenadeLauncher';
export const WEAPON_CATEGORIES: readonly WeaponCategory[] = [
  'rifle',
  'carbine',
  'lightMachineGun',
  'grenadeLauncher',
];

/** How a weapon is fed: a magazine, a belt, or one round at a time (a launcher). */
export type FeedKind = 'magazine' | 'belt' | 'single';

/** A whole number drawn uniformly in [min, max]. */
export interface IntegerRange {
  readonly min: number;
  readonly max: number;
}

/**
 * A fire mode: bursts of `roundsPerBurst` rounds, one every
 * `secondsBetweenBursts` (from one burst's start to the next), both drawn per
 * burst. Doctrinal rates, not the mechanism's cyclic rate (06 §2).
 */
export interface FireMode {
  readonly roundsPerBurst: IntegerRange;
  readonly secondsBetweenBursts: UniformSeconds;
}

/**
 * An area-effect weapon (a grenade launcher): where it may be fired, how its
 * rounds land and what they do (06 §4). Its rounds are resolved by area, not
 * by the hit curve.
 */
export interface AreaEffect {
  /** Not fired closer than this (arming and safety distance), m. */
  readonly minRangeM: number;
  /** Radial landing error: up to `atZeroM + range / 100 × per100M` metres, uniformly in area. */
  readonly dispersionM: { readonly atZeroM: number; readonly per100M: number };
  /** Incapacitation probability at the burst, at `casualtyRadiusM`, and none beyond `maxEffectRadiusM` (linear between). */
  readonly incapacitationAtCentre: number;
  readonly casualtyRadiusM: number;
  readonly incapacitationAtCasualtyRadius: number;
  readonly maxEffectRadiusM: number;
  /** Prone soldiers' incapacitation probability is × this. */
  readonly proneFactor: number;
  /** Not fired when a friendly soldier is this close to the aim point, m. */
  readonly friendlyClearanceM: number;
  /** Chance of choosing it at a firing opportunity when it may be fired: at a target in sight, or area fire. */
  readonly employProbability: { readonly aimed: number; readonly area: number };
  /** Least time between two rounds of it (s). */
  readonly minSecondsBetweenShots: number;
}

/**
 * A weapon (06): its feed and ammunition, fire modes, reload, accuracy and
 * effect. Fire events stay abstract: a burst is one event.
 */
export interface FofWeapon {
  readonly id: string;
  readonly label: string;
  readonly category: WeaponCategory;
  /** The ammunition it fires (a label, e.g. "5.56×45 mm"). */
  readonly ammunition: string;
  readonly feed: FeedKind;
  /** Rounds a full magazine, belt or launcher holds. */
  readonly capacity: number;
  /** Rounds carried at the start, the loaded ones included (one full feed loaded). */
  readonly basicLoadRounds: number;
  /** Time to reload it (s). */
  readonly reloadSeconds: UniformSeconds;
  /**
   * In a lull, a magazine below this share of its capacity is changed for a
   * full one (its rounds go back to the reserve); 0: never (belts, launchers).
   */
  readonly tacticalReloadBelow: number;
  readonly sustained: FireMode;
  readonly rapid: FireMode;
  /** A burst of n rounds counts as 1 + (n − 1) × this aimed rounds toward its hit chance (rounds of a burst are not independent). */
  readonly burstRoundWeight: number;
  /** Hit probability of one round at a standing, fully visible target, by range (`hitProbabilityAt`); empty for area weapons. */
  readonly hitProbabilityByRange: readonly RangeProbability[];
  readonly maxEngagementRangeM: number;
  /** Probability that a hit incapacitates. */
  readonly incapacitationProbabilityOnHit: number;
  /** Suppression a burst adds to the soldier aimed at, and to soldiers within `suppressionRadiusM` of the impact (fading out). */
  readonly suppressionPerBurst: number;
  readonly suppressionRadiusM: number;
  /** Area effect (grenade launchers); `null` for direct-fire weapons. */
  readonly area: AreaEffect | null;
}

/** When a soldier fires at his weapon's rapid rate rather than its sustained one (06 §3). */
export interface RapidFireConfig {
  /** For this long after his force opened fire (s). */
  readonly afterOpeningSeconds: number;
  /** At targets this close (m). */
  readonly withinRangeM: number;
  /** While his force assaults. */
  readonly whenAssaulting: boolean;
}

export interface FireConfig {
  readonly weapons: readonly FofWeapon[];
  /** Hit multiplier on a target in each posture. */
  readonly postureHitMultipliers: Readonly<Record<Posture, number>>;
  /** Hit multiplier when the shooter is moving. */
  readonly movingShooterFactor: number;
  /** When fire is at the rapid rate. */
  readonly rapidFire: RapidFireConfig;
  /** A soldier who has not fired for this long changes a part-empty magazine (s; `FofWeapon.tacticalReloadBelow`). */
  readonly lullReloadSeconds: number;
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
  /**
   * Actions on contact `continue`: halted in contact with no soldier able to
   * fire at an enemy he can see for this long (and not pinned), it presses on
   * toward its destination, firing on the move, and does not halt for
   * contact again for as long (s).
   */
  readonly pressOnSeconds: number;
  /**
   * Ambush (docs/behavior-lab/force-on-force/08): a force lying in wait in
   * its ambush position is concealed: the enemy cannot detect its soldiers
   * farther than this (m).
   */
  readonly concealmentRangeM: number;
  /**
   * Ambush: within the concealment range, what a concealed soldier
   * (camouflaged, still, prone) shows of himself: the resolvable cycles on
   * him are multiplied by this (1: as any prone soldier).
   */
  readonly concealedDetectionFactor: number;
  /** Ambush: it opens fire once this share of an enemy squad's active soldiers is in its kill zone. */
  readonly ambushTriggerShare: number;
  /**
   * Ambush: an enemy squad caught in the kill zone is surprised: its
   * soldiers react (take cover, return fire) this much later than they
   * otherwise would (s).
   */
  readonly ambushSurpriseSeconds: number;
  /**
   * Ambush: an ambush sprung with surprise fires from steady, prepared prone
   * positions, without the stress of being fired upon: its aimed fire's hit
   * probability per round is multiplied by this (at most 0.95) until it is
   * fired upon, for at most `ambushAccuracySeconds`.
   */
  readonly ambushAccuracyFactor: number;
  readonly ambushAccuracySeconds: number;
  /** Attacking: seconds in contact (returning fire, locating the enemy) before it assaults. */
  readonly assaultAfterSeconds: number;
  /**
   * Attacking: it assaults a believed enemy position only farther than this
   * (m; closer, it fights where it is), and moves its objective when the
   * believed position has shifted this far.
   */
  readonly assaultRetargetM: number;
  /**
   * Fire and movement: one element (a fire team with the leader; half a
   * team without subordinate units) rushes this far (m) toward the enemy at
   * `boundPaceMps`, then goes down and fires; once it has been down
   * `boundRestSeconds`, the next element bounds.
   */
  readonly boundLengthM: number;
  readonly boundPaceMps: number;
  readonly boundRestSeconds: number;
  /**
   * A bound ends at a firing position: among points from half to the whole
   * bound length, up to this many degrees either side of straight at the
   * enemy, the one from which the element (prone) sees most of the enemy
   * positions its force knows of. 0: straight at the enemy, the whole length.
   */
  readonly boundSearchDegrees: number;
  /** An order's destination is reached within this distance of the squad's centre (m). */
  readonly arrivalRadiusM: number;
  /** An attack is done once on its objective with no enemy within reach this long (s). */
  readonly attackClearSeconds: number;
  /** An attack not done this long after it began has failed (s): orders never hold a squad forever. */
  readonly attackTimeoutSeconds: number;
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
    'rapidFire',
    'lullReloadSeconds',
    'leaderCadenceFactor',
    'engageLevel',
    'areaFireMemorySeconds',
    'areaFireCadenceFactor',
    'areaFireHitFactor',
  ]);
  if (!Array.isArray(f['weapons']) || f['weapons'].length === 0) {
    fail('.fire.weapons', 'must be a non-empty array');
  }
  const integer = (value: unknown, path: string, min: number) => {
    const n = number(value, path, min);
    if (!Number.isInteger(n)) fail(path, 'must be an integer');
    return n;
  };
  const seconds = (value: unknown, path: string, min = 0) => {
    const r = object(value, path, ['minSeconds', 'maxSeconds']);
    const lo = number(r['minSeconds'], `${path}.minSeconds`, min);
    if (number(r['maxSeconds'], `${path}.maxSeconds`, min) < lo)
      fail(path, 'minSeconds > maxSeconds');
    if (lo <= 0 && min > 0) fail(`${path}.minSeconds`, 'must be > 0');
  };
  const mode = (value: unknown, path: string) => {
    const m = object(value, path, ['roundsPerBurst', 'secondsBetweenBursts']);
    const r = object(m['roundsPerBurst'], `${path}.roundsPerBurst`, ['min', 'max']);
    const lo = integer(r['min'], `${path}.roundsPerBurst.min`, 1);
    if (integer(r['max'], `${path}.roundsPerBurst.max`, 1) < lo)
      fail(`${path}.roundsPerBurst`, 'min > max');
    seconds(m['secondsBetweenBursts'], `${path}.secondsBetweenBursts`, 1e-9);
  };
  const ids = new Set<string>();
  (f['weapons'] as unknown[]).forEach((w, i) => {
    const path = `.fire.weapons[${String(i)}]`;
    const weapon = object(w, path, [
      'id',
      'label',
      'category',
      'ammunition',
      'feed',
      'capacity',
      'basicLoadRounds',
      'reloadSeconds',
      'tacticalReloadBelow',
      'sustained',
      'rapid',
      'burstRoundWeight',
      'hitProbabilityByRange',
      'maxEngagementRangeM',
      'incapacitationProbabilityOnHit',
      'suppressionPerBurst',
      'suppressionRadiusM',
      'area',
    ]);
    const id = string(weapon['id'], `${path}.id`);
    if (ids.has(id)) fail(`${path}.id`, `"${id}" is used twice`);
    ids.add(id);
    string(weapon['label'], `${path}.label`);
    string(weapon['ammunition'], `${path}.ammunition`);
    if (!(WEAPON_CATEGORIES as readonly unknown[]).includes(weapon['category']))
      fail(`${path}.category`, `must be one of ${WEAPON_CATEGORIES.join(', ')}`);
    const feed = weapon['feed'];
    if (feed !== 'magazine' && feed !== 'belt' && feed !== 'single')
      fail(`${path}.feed`, 'must be "magazine", "belt" or "single"');
    const capacity = integer(weapon['capacity'], `${path}.capacity`, 1);
    if (feed === 'single' && capacity !== 1)
      fail(`${path}.capacity`, 'must be 1 for a single-round feed');
    integer(weapon['basicLoadRounds'], `${path}.basicLoadRounds`, 0);
    seconds(weapon['reloadSeconds'], `${path}.reloadSeconds`, 1e-9);
    number(weapon['tacticalReloadBelow'], `${path}.tacticalReloadBelow`, 0, 1);
    if (feed !== 'magazine' && (weapon['tacticalReloadBelow'] as number) > 0)
      fail(`${path}.tacticalReloadBelow`, 'only magazines are changed part-empty');
    mode(weapon['sustained'], `${path}.sustained`);
    mode(weapon['rapid'], `${path}.rapid`);
    number(weapon['burstRoundWeight'], `${path}.burstRoundWeight`, 0, 1);
    const area = weapon['area'];
    const curve = weapon['hitProbabilityByRange'];
    if (!Array.isArray(curve) || (curve.length === 0 && area === null))
      fail(
        `${path}.hitProbabilityByRange`,
        'must be a non-empty array (empty only for area weapons)',
      );
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
    number(
      weapon['incapacitationProbabilityOnHit'],
      `${path}.incapacitationProbabilityOnHit`,
      0,
      1,
    );
    number(weapon['suppressionPerBurst'], `${path}.suppressionPerBurst`, 0, 1);
    number(weapon['suppressionRadiusM'], `${path}.suppressionRadiusM`, 0);
    if (area !== null) {
      const ap = `${path}.area`;
      const a = object(area, ap, [
        'minRangeM',
        'dispersionM',
        'incapacitationAtCentre',
        'casualtyRadiusM',
        'incapacitationAtCasualtyRadius',
        'maxEffectRadiusM',
        'proneFactor',
        'friendlyClearanceM',
        'employProbability',
        'minSecondsBetweenShots',
      ]);
      if (number(a['minRangeM'], `${ap}.minRangeM`, 0) > (weapon['maxEngagementRangeM'] as number))
        fail(`${ap}.minRangeM`, 'must not exceed maxEngagementRangeM');
      const d = object(a['dispersionM'], `${ap}.dispersionM`, ['atZeroM', 'per100M']);
      number(d['atZeroM'], `${ap}.dispersionM.atZeroM`, 0);
      number(d['per100M'], `${ap}.dispersionM.per100M`, 0);
      const centre = number(a['incapacitationAtCentre'], `${ap}.incapacitationAtCentre`, 0, 1);
      const radius = positive(a['casualtyRadiusM'], `${ap}.casualtyRadiusM`);
      if (
        number(a['incapacitationAtCasualtyRadius'], `${ap}.incapacitationAtCasualtyRadius`, 0, 1) >
        centre
      )
        fail(`${ap}.incapacitationAtCasualtyRadius`, 'must not exceed incapacitationAtCentre');
      if (number(a['maxEffectRadiusM'], `${ap}.maxEffectRadiusM`, 0) < radius)
        fail(`${ap}.maxEffectRadiusM`, 'must be at least casualtyRadiusM');
      number(a['proneFactor'], `${ap}.proneFactor`, 0, 1);
      number(a['friendlyClearanceM'], `${ap}.friendlyClearanceM`, 0);
      const e = object(a['employProbability'], `${ap}.employProbability`, ['aimed', 'area']);
      number(e['aimed'], `${ap}.employProbability.aimed`, 0, 1);
      number(e['area'], `${ap}.employProbability.area`, 0, 1);
      number(a['minSecondsBetweenShots'], `${ap}.minSecondsBetweenShots`, 0);
      if (feed !== 'single') fail(`${path}.feed`, 'area weapons are single-round launchers');
    }
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
    lullReloadSeconds: [0],
  });
  const rapid = object(f['rapidFire'], '.fire.rapidFire', [
    'afterOpeningSeconds',
    'withinRangeM',
    'whenAssaulting',
  ]);
  number(rapid['afterOpeningSeconds'], '.fire.rapidFire.afterOpeningSeconds', 0);
  number(rapid['withinRangeM'], '.fire.rapidFire.withinRangeM', 0);
  if (typeof rapid['whenAssaulting'] !== 'boolean')
    fail('.fire.rapidFire.whenAssaulting', 'must be true or false');
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
    'pressOnSeconds',
    'concealmentRangeM',
    'concealedDetectionFactor',
    'ambushTriggerShare',
    'ambushSurpriseSeconds',
    'ambushAccuracyFactor',
    'ambushAccuracySeconds',
    'withdrawSuppression',
    'withdrawSuppressedSeconds',
    'withdrawAmmunitionFraction',
    'withdrawDistanceM',
    'withdrawnClearSeconds',
    'ineffectiveEffectiveness',
    'assaultAfterSeconds',
    'assaultRetargetM',
    'boundLengthM',
    'boundPaceMps',
    'boundRestSeconds',
    'boundSearchDegrees',
    'arrivalRadiusM',
    'attackClearSeconds',
    'attackTimeoutSeconds',
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
    pressOnSeconds: [1, 3600],
    concealmentRangeM: [0],
    concealedDetectionFactor: [0.01, 1],
    ambushTriggerShare: [0.01, 1],
    ambushSurpriseSeconds: [0, 60],
    ambushAccuracyFactor: [1, 10],
    ambushAccuracySeconds: [0, 120],
    withdrawSuppression: [0, 1],
    withdrawSuppressedSeconds: [0],
    withdrawAmmunitionFraction: [0, 1],
    withdrawDistanceM: [0],
    withdrawnClearSeconds: [0],
    ineffectiveEffectiveness: [0, 1],
    assaultAfterSeconds: [0],
    assaultRetargetM: [0],
    boundLengthM: [1],
    boundPaceMps: [0.1],
    boundRestSeconds: [0],
    boundSearchDegrees: [0, 90],
    arrivalRadiusM: [1],
    attackClearSeconds: [0],
    attackTimeoutSeconds: [1],
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
