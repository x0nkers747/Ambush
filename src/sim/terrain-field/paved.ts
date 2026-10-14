import type { EnvironmentFeatures } from '../environment';

// Mapped hard ground (car parks, squares, pedestrian areas, mapped
// carriageway outlines; docs/adr/0048) as exact outlines: the ground's
// materials take a signed distance to them, so their edges are as straight as
// mapped. The land cover raster (2 m cells) gave stepped, wavy edges.

/** Paved areas reach this far for the distance to their edge, metres. */
export const PAVED_REACH_M = 12;

export interface PavedArea {
  /** Each ring as x, y pairs (the outline and its holes). */
  readonly rings: readonly Float64Array[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The battlefield's mapped paved areas, in a fixed order (by id). */
export function pavedAreas(features: EnvironmentFeatures): PavedArea[] {
  return (features.landUse ?? [])
    .filter((l) => l.kind === 'paved')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const rings = [l.boundary, ...(l.holes ?? [])].map((ring) => {
        const xy = new Float64Array(ring.length * 2);
        ring.forEach((p, i) => {
          xy[i * 2] = p.x;
          xy[i * 2 + 1] = p.y;
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        });
        return xy;
      });
      return { rings, minX, minY, maxX, maxY };
    });
}

/**
 * Signed distance from (x, y) to the area's edge: negative inside (even-odd,
 * so holes are outside), metres.
 */
export function pavedDistance(area: PavedArea, x: number, y: number): number {
  let inside = false;
  let d2 = Infinity;
  for (const xy of area.rings) {
    const n = xy.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
      const ax = xy[j * 2] ?? 0;
      const ay = xy[j * 2 + 1] ?? 0;
      const bx = xy[i * 2] ?? 0;
      const by = xy[i * 2 + 1] ?? 0;
      if (by > y !== ay > y && x < ((ax - bx) * (y - by)) / (ay - by) + bx) inside = !inside;
      const ex = bx - ax;
      const ey = by - ay;
      const len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2)) : 0;
      const dx = ax + t * ex - x;
      const dy = ay + t * ey - y;
      const e2 = dx * dx + dy * dy;
      if (e2 < d2) d2 = e2;
    }
  }
  const d = Math.sqrt(d2);
  return inside ? -d : d;
}
