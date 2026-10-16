import { azimuthDelta, normalizeAzimuth } from '../geometry';
import { crewState, type MountState, type VehicleCombat } from './state';
import type { MountSpec, PlatformPoint, PlatformSpec } from './types';

// Mounts (docs/combined-arms.md §3): turrets, cupolas and launchers turning
// (traverse, relative to their parent) and lifting (elevation), each tick,
// toward where they are being laid, within their limits and never faster
// than their rates. The simulation's orientation is the truth: the views
// draw it.

const DEG = Math.PI / 180;

/** Where a vehicle is and faces, for its mounts. */
export interface HullPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radians clockwise from grid north. */
  readonly heading: number;
}

/** A signed angle in (−π, π]. */
export function signedAngle(a: number): number {
  const d = normalizeAzimuth(a);
  return d > Math.PI ? d - 2 * Math.PI : d;
}

/** The mount's spec and state, by id. */
function specOf(platform: PlatformSpec, id: string): MountSpec | undefined {
  return platform.mounts.find((m) => m.id === id);
}

function stateOf(combat: VehicleCombat, id: string): MountState | undefined {
  return combat.mounts.find((m) => m.id === id);
}

/** The azimuth (grid, rad) its parent faces: the hull's heading turned by every mount above it. */
export function parentAzimuth(
  platform: PlatformSpec,
  combat: VehicleCombat,
  mountId: string,
  heading: number,
): number {
  let az = heading;
  for (let at = specOf(platform, mountId)?.parent ?? null; at !== null;) {
    az += stateOf(combat, at)?.azimuth ?? 0;
    at = specOf(platform, at)?.parent ?? null;
  }
  return normalizeAzimuth(az);
}

/** The azimuth (grid, rad) a mount faces. */
export function mountAzimuth(
  platform: PlatformSpec,
  combat: VehicleCombat,
  mountId: string,
  heading: number,
): number {
  return normalizeAzimuth(
    parentAzimuth(platform, combat, mountId, heading) + (stateOf(combat, mountId)?.azimuth ?? 0),
  );
}

/** A platform point turned to `azimuth` and placed at `origin`. */
function place(origin: { x: number; y: number; z: number }, p: PlatformPoint, azimuth: number) {
  const fx = Math.sin(azimuth);
  const fy = Math.cos(azimuth);
  // Right of forward (fx, fy) is (fy, −fx).
  return {
    x: origin.x + p.forward * fx + p.right * fy,
    y: origin.y + p.forward * fy - p.right * fx,
    z: origin.z + p.up,
  };
}

/** A mount's pivot on the map (m): its parents' pivots and turns applied. */
export function mountPivot(
  platform: PlatformSpec,
  combat: VehicleCombat,
  mountId: string,
  hull: HullPose,
): { x: number; y: number; z: number } {
  const chain: MountSpec[] = [];
  for (let at: string | null = mountId; at !== null;) {
    const spec = specOf(platform, at);
    if (!spec) break;
    chain.unshift(spec);
    at = spec.parent;
  }
  let origin = { x: hull.x, y: hull.y, z: hull.z };
  let azimuth = hull.heading;
  for (const spec of chain) {
    origin = place(origin, spec.pivot, azimuth);
    azimuth += stateOf(combat, spec.id)?.azimuth ?? 0;
  }
  return origin;
}

/** A weapon's muzzle on the map: its mount's pivot, turned and lifted. */
export function muzzleOf(
  platform: PlatformSpec,
  combat: VehicleCombat,
  weaponId: string,
  hull: HullPose,
): { x: number; y: number; z: number } {
  const w = platform.weapons.find((x) => x.id === weaponId);
  if (!w) return { x: hull.x, y: hull.y, z: hull.z };
  const pivot = mountPivot(platform, combat, w.mount, hull);
  const az = mountAzimuth(platform, combat, w.mount, hull.heading);
  const el = stateOf(combat, w.mount)?.elevation ?? 0;
  const flat = w.muzzle.forward * Math.cos(el);
  return place(
    pivot,
    { forward: flat, right: w.muzzle.right, up: w.muzzle.up + w.muzzle.forward * Math.sin(el) },
    az,
  );
}

/** The relative azimuth a mount needs to bear on a grid azimuth, or `null` beyond its traverse. */
export function relativeBearing(spec: MountSpec, parentAz: number, gridAz: number): number | null {
  const rel = signedAngle(gridAz - parentAz);
  if (!spec.traverse) return rel;
  return rel >= -spec.traverse.leftDeg * DEG - 1e-9 && rel <= spec.traverse.rightDeg * DEG + 1e-9
    ? rel
    : null;
}

/** The orientation a mount must take to bear on a point, or `null` when it cannot (traverse, elevation). */
export function layFor(
  platform: PlatformSpec,
  combat: VehicleCombat,
  mountId: string,
  hull: HullPose,
  target: { x: number; y: number; z: number },
): { azimuth: number; elevation: number } | null {
  const spec = specOf(platform, mountId);
  if (!spec) return null;
  const pivot = mountPivot(platform, combat, mountId, hull);
  const dx = target.x - pivot.x;
  const dy = target.y - pivot.y;
  const range = Math.hypot(dx, dy);
  const az = relativeBearing(
    spec,
    parentAzimuth(platform, combat, mountId, hull.heading),
    Math.atan2(dx, dy),
  );
  if (az === null) return null;
  const el = Math.atan2(target.z - pivot.z, Math.max(range, 1e-6));
  if (el < spec.elevation.minDeg * DEG - 1e-9 || el > spec.elevation.maxDeg * DEG + 1e-9)
    return null;
  return { azimuth: az, elevation: el };
}

/**
 * How fast an operator lays (a share of the mount's rates): his state, or
 * the alternate's when he is out (slower); 0 with neither (the mount is still).
 */
export function layingFactor(spec: MountSpec, combat: VehicleCombat): number {
  const own = crewState(combat, spec.operator);
  if (own === 'operational') return 1;
  if (own === 'degraded') return 0.6;
  if (spec.alternate === undefined) return 0;
  const alt = crewState(combat, spec.alternate);
  return alt === 'operational' ? 0.7 : alt === 'degraded' ? 0.45 : 0;
}

/** Each mount turns and lifts toward its goal for `dt` seconds (unless disabled or unmanned). */
export function slewMounts(platform: PlatformSpec, combat: VehicleCombat, dt: number): void {
  for (const spec of platform.mounts) {
    const m = stateOf(combat, spec.id);
    if (!m || m.disabled) continue;
    const factor = layingFactor(spec, combat);
    if (factor <= 0) continue;
    const maxAz = spec.traverseRateDegS * DEG * factor * dt;
    const maxEl = spec.elevationRateDegS * DEG * factor * dt;
    // All round: the shorter way; limited: straight there, inside the limits.
    const delta = spec.traverse
      ? m.goalAzimuth - m.azimuth
      : azimuthDelta(m.azimuth, m.goalAzimuth);
    m.azimuth =
      Math.abs(delta) <= maxAz
        ? spec.traverse
          ? m.goalAzimuth
          : signedAngle(m.goalAzimuth)
        : signedAngle(m.azimuth + Math.sign(delta) * maxAz);
    const de = m.goalElevation - m.elevation;
    m.elevation = Math.abs(de) <= maxEl ? m.goalElevation : m.elevation + Math.sign(de) * maxEl;
  }
}

/** Whether a mount is laid on its goal (within the tolerances, degrees). */
export function isLaid(m: MountState, azTolDeg: number, elTolDeg: number): boolean {
  return (
    Math.abs(signedAngle(m.goalAzimuth - m.azimuth)) <= azTolDeg * DEG + 1e-9 &&
    Math.abs(m.goalElevation - m.elevation) <= elTolDeg * DEG + 1e-9
  );
}

/** Seconds a mount needs to come onto a relative azimuth (by its rate, with the operator it has). */
export function secondsToLay(
  spec: MountSpec,
  combat: VehicleCombat,
  m: MountState,
  azimuth: number,
): number {
  const factor = layingFactor(spec, combat);
  if (factor <= 0 || m.disabled) return Infinity;
  const delta = spec.traverse ? azimuth - m.azimuth : signedAngle(azimuth - m.azimuth);
  return Math.abs(delta) / (spec.traverseRateDegS * DEG * factor);
}
