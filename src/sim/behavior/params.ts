// Tuning parameters of unit movement (docs/behavior-lab/03 §8). None of these
// is doctrine: doctrine sets principles (sight or voice contact, no parade
// precision), not tolerances. They are calibration values, measured in the
// Behavior Lab, and part of the world (fingerprinted) when a scenario
// overrides them.

export interface BehaviorParams {
  /** Internal integration rate (Hz). Tick rates dividing it give identical results. */
  readonly substepHz: number;
  /** Anchor acceleration and braking (m/s²). */
  readonly anchorAccel: number;
  readonly anchorDecel: number;
  /** Deceleration the anchor plans for arriving at the destination (m/s²). */
  readonly anchorArriveDecel: number;
  /**
   * Pace law: the anchor keeps full pace while the worst Marine is less than
   * `lagStart` intervals behind his slot, and stops when he is `lagStop` behind.
   */
  readonly lagStart: number;
  readonly lagStop: number;
  /** Highest speed of a slot on a bend, as a multiple of pace (the anchor slows to keep to it). */
  readonly bendSpeedFactor: number;
  /**
   * The anchor never slows below this × pace for a bend: round a tight
   * corner (in a town) a wide formation cannot wheel, so its outer Marines
   * fall behind and catch up instead of the whole unit crawling.
   */
  readonly minBendPace: number;
  /** Marines' top speed as a multiple of pace (catch-up; no running). */
  readonly maxSpeedFactor: number;
  /** Correction speed per metre of error (1/s), and the error (× interval) below which none is applied. */
  readonly trackingGain: number;
  readonly deadBand: number;
  /** Marines' acceleration, braking and sideways (turning) acceleration (m/s²). */
  readonly accel: number;
  readonly decel: number;
  readonly lateralAccel: number;
  /**
   * Falling in: there is no forming up before moving off. The leader steps
   * off at once and the others make for their slots on the move; a Marine
   * has fallen in once within `joinBand` intervals of his slot. Until all
   * have (or for `joinTimeout` s at most), the unit keeps to `joinPace` ×
   * pace, and Marines still falling in do not hold it back.
   */
  readonly joinBand: number;
  readonly joinPace: number;
  readonly joinTimeout: number;
  /** Slots blend from the route into the final layout over this many seconds. */
  readonly settleBlend: number;
  /** In position: within `latchRadius` m of the slot and slower than `latchSpeed`; out again beyond `unlatchRadius`. */
  readonly latchRadius: number;
  readonly latchSpeed: number;
  readonly unlatchRadius: number;
  /** Settling gives up waiting after this many seconds (outcome `arrivedIncomplete`). */
  readonly settleTimeout: number;
  /** Route corners are rounded to the formation's half-width plus this (m). */
  readonly cornerMargin: number;
  /** Facing follows the direction of travel above this speed (m/s). */
  readonly facingSpeed: number;
  /**
   * Personal variation: each Marine's slot drifts within `driftRadius`
   * intervals, changing course every `driftSeconds` (seeded, smooth), so the
   * formation is never a rigid shape. It fades out while settling.
   */
  readonly driftRadius: number;
  readonly driftSeconds: number;
  /** Personal space (m): Marines closer than this ease apart, up to `separationSpeed` m/s. */
  readonly personalSpace: number;
  readonly separationSpeed: number;
  /**
   * Out of contact: farther than `contactRadius` intervals (at least
   * `contactMinimum` m) from his slot; after `stragglerSeconds` the pace law
   * stops waiting for him.
   */
  readonly contactRadius: number;
  readonly contactMinimum: number;
  readonly stragglerSeconds: number;
  /** Stuck: less than `stuckProgress` m nearer his slot over `stuckSeconds`, while not near it. */
  readonly stuckProgress: number;
  readonly stuckSeconds: number;
  /** How often a Marine checks his way to his slot and plans a way round an obstacle (s), and how near a detour point counts as reached (m). */
  readonly detourCheckSeconds: number;
  readonly detourReach: number;
}

export const DEFAULT_BEHAVIOR_PARAMS: BehaviorParams = Object.freeze({
  substepHz: 120,
  anchorAccel: 0.5,
  anchorDecel: 1.0,
  anchorArriveDecel: 0.4,
  lagStart: 0.5,
  lagStop: 2.0,
  bendSpeedFactor: 1.15,
  minBendPace: 0.5,
  maxSpeedFactor: 1.3,
  trackingGain: 0.3,
  deadBand: 0.15,
  accel: 1.0,
  decel: 2.0,
  lateralAccel: 1.5,
  joinBand: 0.25,
  joinPace: 0.75,
  joinTimeout: 60,
  settleBlend: 3,
  latchRadius: 1.0,
  latchSpeed: 0.2,
  unlatchRadius: 2.0,
  settleTimeout: 60,
  cornerMargin: 2,
  facingSpeed: 0.3,
  driftRadius: 0.1,
  driftSeconds: 8,
  personalSpace: 1.2,
  separationSpeed: 1.2,
  contactRadius: 3,
  contactMinimum: 30,
  stragglerSeconds: 10,
  stuckProgress: 0.5,
  stuckSeconds: 10,
  detourCheckSeconds: 0.25,
  detourReach: 1.5,
});

/** Throws a RangeError naming the first invalid parameter. */
export function validateBehaviorParams(params: BehaviorParams): void {
  for (const key of Object.keys(DEFAULT_BEHAVIOR_PARAMS) as (keyof BehaviorParams)[]) {
    const value = params[key];
    if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      throw new RangeError(`behavior.${key} must be a finite number >= 0, got ${String(value)}`);
    }
  }
  if (!Number.isInteger(params.substepHz) || params.substepHz < 1) {
    throw new RangeError(
      `behavior.substepHz must be a positive integer, got ${String(params.substepHz)}`,
    );
  }
  if (!(params.lagStop > params.lagStart)) {
    throw new RangeError('behavior.lagStop must be greater than behavior.lagStart');
  }
  if (!(params.maxSpeedFactor >= 1) || !(params.unlatchRadius >= params.latchRadius)) {
    throw new RangeError('behavior.maxSpeedFactor must be >= 1 and unlatchRadius >= latchRadius');
  }
}
