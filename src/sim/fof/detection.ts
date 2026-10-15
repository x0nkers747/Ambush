import { surfaceHeightAt } from '../bridge-navigation';
import { boundsOf, type Box } from '../environment';
import { azimuthDelta, azimuthOf, type Vec2 } from '../geometry';
import { pointInPolygon, segmentIntersectionParams } from '../polygon';
import { nextFloat, type RngState } from '../rng';
import { sightLineTracer } from '../sight-tracer';
import type { Soldier } from '../state';
import type { TerrainDataset } from '../terrain';
import type { DetectionConfig, VisibilityConditions } from './config';
import type { FofTrack, TrackLevel } from './types';

// Detection (docs/behavior-lab/force-on-force/02): geometric visibility is
// not detection. A sight line only makes a soldier detectable; whether he is
// seen in a given look is a draw whose probability grows with how many
// resolvable cycles of him the observer's eye gets, after contrast, clutter,
// haze, partial cover and his own movement or fire (a Johnson-criteria /
// target-transfer-probability-function abstraction), and with how long the
// observer looks (an exponential search-time law). Each glimpse adds to his
// force's confidence in a track; the track's level follows the confidence
// with hysteresis.

/** One cycle per this many radians per arc minute. */
const ARCMIN_RAD = Math.PI / (180 * 60);

/**
 * The target transfer probability function: the probability of the task at
 * `cycles` resolvable cycles, when `cycles50` give 50 %.
 * P = x^E / (1 + x^E), x = cycles / cycles50, E = 2.7 + 0.7 x.
 */
export function ttpf(cycles: number, cycles50: number): number {
  if (!(cycles > 0)) return 0;
  const x = cycles / cycles50;
  const e = 2.7 + 0.7 * x;
  const xe = Math.pow(x, e);
  return Number.isFinite(xe) ? xe / (1 + xe) : 1;
}

/** What one observer gets of one target, for the detection draw. */
export interface Sighting {
  readonly rangeM: number;
  /** Share of the target's sample points in clear sight (0: not visible). */
  readonly visibleFraction: number;
  /** Light left after vegetation along the line (1: none in the way). */
  readonly transmission: number;
  /** Search rate multiplier of the observer's attention toward the target (central, peripheral). */
  readonly attention: number;
}

/** Where the target is for the observer, before any sight line: range and attention. */
export interface Glance {
  readonly rangeM: number;
  readonly attention: number;
}

/**
 * The target's range and the observer's attention toward him, or `null`
 * when he is out of range or outside the observer's field of regard (no
 * attempt). Cheap: no sight line.
 */
export function glance(
  observer: Soldier,
  target: Soldier,
  detection: DetectionConfig,
  conditions: VisibilityConditions,
): Glance | null {
  const dx = target.position.x - observer.position.x;
  const dy = target.position.y - observer.position.y;
  const rangeM = Math.hypot(dx, dy);
  if (rangeM > conditions.maxObservationRangeM || rangeM < 1e-6) return null;
  const off = Math.abs(azimuthDelta(observer.azimuth, azimuthOf(dx, dy))) * (180 / Math.PI);
  if (off > detection.regardHalfAngleDeg) return null;
  const attention = off <= detection.centralHalfAngleDeg ? 1 : detection.peripheralFactor;
  return { rangeM, attention };
}

/**
 * The observer's view of the target, or `null` when the target is out of
 * range or outside his field of regard (no attempt).
 */
export function sight(
  terrain: TerrainDataset,
  observer: Soldier,
  target: Soldier,
  detection: DetectionConfig,
  conditions: VisibilityConditions,
): Sighting | null {
  const seen = glance(observer, target, detection, conditions);
  return seen ? traceSight(terrain, observer, target, detection, seen) : null;
}

/** The sight lines of a glance: the share of the target in clear sight, and the light through vegetation. */
export function traceSight(
  terrain: TerrainDataset,
  observer: Soldier,
  target: Soldier,
  detection: DetectionConfig,
  { rangeM, attention }: Glance,
): Sighting {
  const tracer = sightLineTracer(terrain);
  const eye = {
    x: observer.position.x,
    y: observer.position.y,
    z:
      surfaceHeightAt(terrain, observer.position.x, observer.position.y) +
      detection.eyeHeightM[observer.posture],
  };
  const ground = surfaceHeightAt(terrain, target.position.x, target.position.y);
  const heights = detection.targetSampleHeightsM[target.posture];
  // The sample points share their map path: one walk for all of them.
  const clear = tracer.clearCount(
    eye,
    target.position.x,
    target.position.y,
    heights.map((h) => ground + h),
  );
  const visibleFraction = clear / heights.length;
  const transmission =
    visibleFraction > 0 ? vegetationTransmission(terrain, observer.position, target.position) : 0;
  return { rangeM, visibleFraction, transmission, attention };
}

/**
 * Resolvable cycles of the target: its critical dimension seen through the
 * part of it in view, over the eye's cycle at that range, scaled by
 * contrast (background, haze) and by what draws the eye (movement, fire).
 */
export function cyclesOnTarget(
  sighting: Sighting,
  criticalDimensionM: number,
  detection: DetectionConfig,
  conditions: VisibilityConditions,
  cue: number,
): number {
  const angle = sighting.rangeM * detection.cycleArcmin * ARCMIN_RAD;
  const haze = Math.exp((-3.912 * sighting.rangeM) / conditions.meteorologicalVisibilityM);
  return (
    ((criticalDimensionM * sighting.visibleFraction * sighting.transmission) / angle) *
    conditions.backgroundContrast *
    haze *
    cue
  );
}

/** Probability of at least one success in `seconds` at `rate` per second. */
export function chanceIn(rate: number, seconds: number): number {
  return rate > 0 ? 1 - Math.exp(-rate * seconds) : 0;
}

/** A track's confidence at time `t` (it halves every half-life since it was last seen). */
export function confidenceAt(track: FofTrack, t: number, halfLifeSeconds: number): number {
  return track.confidence * Math.pow(2, -(t - track.lastSeenAt) / halfLifeSeconds);
}

/**
 * A track's level at `t` from its confidence, with hysteresis: confirmed at
 * `confirmConfidence`, lost below `lostConfidence`, and gone (`null`) below
 * `dropConfidence` unconfirmed or `forgetConfidence` confirmed.
 */
export function levelAt(
  track: FofTrack,
  t: number,
  detection: DetectionConfig,
): { level: TrackLevel | null; confirmed: boolean } {
  const c = confidenceAt(track, t, detection.confidenceHalfLifeSeconds);
  const confirmed = track.confirmed || c >= detection.confirmConfidence - 1e-12;
  if (!confirmed) return { level: c < detection.dropConfidence ? null : 'possible', confirmed };
  if (c < detection.forgetConfidence) return { level: null, confirmed };
  if (c < detection.lostConfidence) return { level: 'lost', confirmed };
  return { level: track.identified ? 'identified' : 'detected', confirmed };
}

/** One draw: `true` with probability `p`. Always takes a number from `rng`. */
export function draw(rng: RngState, p: number): boolean {
  return nextFloat(rng) < p;
}

interface PreparedArea {
  readonly box: Box;
  readonly boundary: readonly Vec2[];
  readonly holes: readonly (readonly Vec2[])[];
  readonly see: number;
}

const prepared = new WeakMap<TerrainDataset, readonly PreparedArea[]>();

function areasOf(terrain: TerrainDataset): readonly PreparedArea[] {
  let areas = prepared.get(terrain);
  if (!areas) {
    areas = terrain.features.vegetation.map((v) => ({
      box: boundsOf(v.boundary),
      boundary: v.boundary,
      holes: v.holes ?? [],
      see: v.seeThroughMeters,
    }));
    prepared.set(terrain, areas);
  }
  return areas;
}

/**
 * Light left along the ground line from `a` to `b` after vegetation: one
 * minus the summed depth inside each area over its see-through depth (the
 * line of sight's own obscuration rule, as a fraction short of blocking),
 * at least 0. Canopy height is not considered: soldiers stand below it.
 */
export function vegetationTransmission(terrain: TerrainDataset, a: Vec2, b: Vec2): number {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0) return 1;
  let obscured = 0;
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  for (const area of areasOf(terrain)) {
    const { box } = area;
    if (box.maxX < minX || box.minX > maxX || box.maxY < minY || box.minY > maxY) continue;
    const cuts = [0, 1];
    for (const ring of [area.boundary, ...area.holes]) {
      for (let i = 0; i < ring.length; i += 1) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        if (p && q) cuts.push(...segmentIntersectionParams(a, b, p, q));
      }
    }
    cuts.sort((x, y) => x - y);
    let inside = 0;
    for (let i = 1; i < cuts.length; i += 1) {
      const t0 = cuts[i - 1] ?? 0;
      const t1 = cuts[i] ?? 0;
      if (t1 - t0 <= 0) continue;
      const m = (t0 + t1) / 2;
      const p = { x: a.x + m * (b.x - a.x), y: a.y + m * (b.y - a.y) };
      if (pointInPolygon(p, area.boundary) && !area.holes.some((h) => pointInPolygon(p, h))) {
        inside += (t1 - t0) * length;
      }
    }
    obscured += inside / area.see;
  }
  return Math.max(0, 1 - obscured);
}
