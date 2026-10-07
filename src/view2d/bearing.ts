import { azimuthOf, type Azimuth, type Vec2 } from '#sim';

// Conversions between simulation azimuths (radians clockwise from grid north)
// and the whole-degree bearings shown to the trainee: 000° North, 090° East.

/** Whole-degree bearing in [0, 359] for an azimuth. */
export function bearingDegrees(azimuth: Azimuth): number {
  return Math.round((azimuth * 180) / Math.PI) % 360;
}

/** Three-digit bearing label, e.g. "045°". */
export function formatBearing(azimuth: Azimuth): string {
  return `${String(bearingDegrees(azimuth)).padStart(3, '0')}°`;
}

/** Azimuth of a whole-degree bearing. */
export function azimuthFromBearing(degrees: number): Azimuth {
  return ((((Math.round(degrees) % 360) + 360) % 360) * Math.PI) / 180;
}

/**
 * Facing chosen by dragging toward `pointer` from `anchor` (both map points),
 * snapped to whole degrees. `undefined` when the two coincide.
 */
export function facingToward(anchor: Vec2, pointer: Vec2): Azimuth | undefined {
  const dx = pointer.x - anchor.x;
  const dy = pointer.y - anchor.y;
  if (dx === 0 && dy === 0) return undefined;
  return azimuthFromBearing((azimuthOf(dx, dy) * 180) / Math.PI);
}
