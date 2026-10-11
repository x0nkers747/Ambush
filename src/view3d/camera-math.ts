import type { ThreePoint } from './axes';

// The tactical camera's geometry (docs/adr/0029), in Three.js axes (x east,
// y up, z south) and free of Three.js itself, so it can be tested and shared
// by later camera modes (soldier follow, ground level, free flight, AAR).

/** Ground elevation at a Three.js (x, z), or `null` off the battlefield. */
export type GroundAt = (x: number, z: number) => number | null;

export interface BattlefieldExtent {
  readonly minX: number;
  readonly maxX: number;
  /** Battlefield y (north) bounds; Three.js z is −y. */
  readonly minY: number;
  readonly maxY: number;
}

/** The camera never comes closer to the ground than this, in metres. */
export const GROUND_CLEARANCE_M = 2;
/** The camera's elevation angle in the default view: 40° below the horizon, looking north. */
export const DEFAULT_PITCH_DEG = 40;
/** The orbit never goes past this angle from straight down, so the view never flips under the ground. */
export const MAX_POLAR_DEG = 88;
/** Closest zoom to the focus point, in metres. */
export const MIN_DISTANCE_M = 15;

/** The farthest zoom: 2.5 battlefield widths. */
export function maxDistance(extent: BattlefieldExtent): number {
  return 2.5 * Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY);
}

/**
 * The default overhead view: focused on the battlefield's centre (on the
 * ground), looking north and down at `DEFAULT_PITCH_DEG`, far enough for the
 * whole battlefield's width and depth to fit the view (`fovDeg` vertical).
 */
export function defaultView(
  extent: BattlefieldExtent,
  groundAt: GroundAt,
  fovDeg: number,
  aspect: number,
): { target: ThreePoint; position: ThreePoint } {
  const cx = (extent.minX + extent.maxX) / 2;
  const cy = (extent.minY + extent.maxY) / 2;
  const target = { x: cx, y: groundAt(cx, 0 - cy) ?? 0, z: 0 - cy };
  const width = extent.maxX - extent.minX;
  const depth = extent.maxY - extent.minY;
  const halfV = ((fovDeg / 2) * Math.PI) / 180;
  const halfH = Math.atan(Math.tan(halfV) * Math.max(aspect, 0.1));
  const pitch = (DEFAULT_PITCH_DEG * Math.PI) / 180;
  // Fit the width across the view, and the depth as foreshortened by the pitch.
  const forWidth = width / 2 / Math.tan(halfH);
  const forDepth = ((depth / 2) * Math.sin(pitch)) / Math.tan(halfV);
  const distance = 1.1 * Math.max(forWidth, forDepth);
  // South of the target (+z), above it.
  const position = {
    x: target.x,
    y: target.y + distance * Math.sin(pitch),
    z: target.z + distance * Math.cos(pitch),
  };
  const ground = groundAt(position.x, position.z);
  return {
    target,
    position:
      ground !== null && position.y < ground + GROUND_CLEARANCE_M
        ? { ...position, y: ground + GROUND_CLEARANCE_M }
        : position,
  };
}

/** The point clamped onto the battlefield (Three.js x and z). */
export function clampToExtent(p: ThreePoint, extent: BattlefieldExtent): ThreePoint {
  return {
    x: Math.min(Math.max(p.x, extent.minX), extent.maxX),
    y: p.y,
    z: Math.min(Math.max(p.z, -extent.maxY), -extent.minY),
  };
}

/**
 * The camera position raised, if needed, to stay `GROUND_CLEARANCE_M` above
 * the ground under it; off the battlefield, above `floor` (e.g. the apron).
 */
export function keepAboveGround(
  position: ThreePoint,
  groundAt: GroundAt,
  floor: number | null = null,
): ThreePoint {
  const ground = groundAt(position.x, position.z) ?? floor;
  return ground !== null && position.y < ground + GROUND_CLEARANCE_M
    ? { ...position, y: ground + GROUND_CLEARANCE_M }
    : position;
}

/**
 * Where a ray from `origin` along `direction` first meets the ground, or
 * `null` if it leaves the battlefield or goes `maxDistance` without meeting
 * it. Marches in steps no longer than the height above the ground allows
 * (at most `step` metres), then bisects to a centimetre.
 */
export function groundHit(
  origin: ThreePoint,
  direction: ThreePoint,
  groundAt: GroundAt,
  maxDistance: number,
  step = 5,
): ThreePoint | null {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length === 0) return null;
  const d = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
  const at = (t: number) => ({
    x: origin.x + d.x * t,
    y: origin.y + d.y * t,
    z: origin.z + d.z * t,
  });
  /** Height of the ray above the ground at t; `null` off the battlefield. */
  const above = (t: number) => {
    const p = at(t);
    const g = groundAt(p.x, p.z);
    return g === null ? null : p.y - g;
  };
  let t = 0;
  // From outside the battlefield (e.g. far overhead), skip ahead to its edge.
  while (above(t) === null && t < maxDistance) t += step;
  let previous = t;
  while (t <= maxDistance) {
    const h = above(t);
    if (h === null) return null;
    if (h <= 0) {
      let lo = previous;
      let hi = t;
      for (let k = 0; k < 40 && hi - lo > 0.005; k += 1) {
        const mid = (lo + hi) / 2;
        const hm = above(mid);
        if (hm !== null && hm <= 0) hi = mid;
        else lo = mid;
      }
      const p = at(hi);
      return { x: p.x, y: groundAt(p.x, p.z) ?? p.y, z: p.z };
    }
    previous = t;
    // A falling ray cannot reach the ground sooner than its height allows on
    // slopes up to 45°; never step less than 0.25 m nor more than `step`.
    t += Math.min(step, Math.max(0.25, h / 2));
  }
  return null;
}
