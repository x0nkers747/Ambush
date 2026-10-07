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
