// Coordinate frame, units and azimuth convention: docs/adr/0002.

/** A position in the simulation frame: metres, X = East, Y = North (grid), Z = Up. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A point on the map plane: metres, X = East, Y = North. Elevation comes from terrain. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Radians clockwise from grid north (+Y), normalized to [0, 2π). */
export type Azimuth = number;

const TWO_PI = 2 * Math.PI;

export function normalizeAzimuth(radians: number): Azimuth {
  const a = ((radians % TWO_PI) + TWO_PI) % TWO_PI;
  // Tiny negative inputs round up to exactly 2π.
  return a === TWO_PI ? 0 : a;
}

export function azimuthFromDegrees(degrees: number): Azimuth {
  return normalizeAzimuth((degrees * Math.PI) / 180);
}

/** Azimuth of the map vector (dx, dy); 0 for the zero vector. */
export function azimuthOf(dx: number, dy: number): Azimuth {
  return normalizeAzimuth(Math.atan2(dx, dy));
}

/**
 * Signed shortest rotation from azimuth `from` to azimuth `to`, in (−π, π].
 * Positive is clockwise. An exact reversal (π) turns clockwise.
 */
export function azimuthDelta(from: Azimuth, to: Azimuth): number {
  const d = normalizeAzimuth(to - from);
  return d > Math.PI ? d - TWO_PI : d;
}

/** Rotates `from` toward `to` by at most `maxRadians`, landing exactly on `to` when within reach. */
export function turnToward(from: Azimuth, to: Azimuth, maxRadians: number): Azimuth {
  const delta = azimuthDelta(from, to);
  if (Math.abs(delta) <= maxRadians) return to;
  return normalizeAzimuth(from + Math.sign(delta) * maxRadians);
}
