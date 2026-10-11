import type { Azimuth } from '#sim';

// The one place that knows Three.js axes (docs/adr/0002). Ambush! works in
// local battlefield metres with X east, Y grid north and Z up; Three.js is
// Y-up. A point (x, y, z) is drawn at (x, z, −y): east stays +X, up is +Y and
// north is −Z. The mapping is a proper rotation (no mirroring), so triangles
// that are counter-clockwise seen from above stay counter-clockwise.

export interface ThreePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Three.js position of a battlefield point (x east, y north, z up). */
export function toThree(x: number, y: number, z: number): ThreePoint {
  return { x, y: z, z: -y };
}

/** Battlefield point (x east, y north, z up) of a Three.js position. */
export function fromThree(p: ThreePoint): { x: number; y: number; z: number } {
  return { x: p.x, y: -p.z, z: p.y };
}

/**
 * Three.js rotation about +Y for an Ambush! azimuth (clockwise from north).
 * An object whose forward axis is −Z (north) then faces the azimuth: Three.js
 * turns counter-clockwise seen from above, hence the sign.
 */
export function yawOf(azimuth: Azimuth): number {
  return -azimuth;
}
