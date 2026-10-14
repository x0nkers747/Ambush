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

/** A paved area's ground: z = a + b x + c y, or null where the ground is too uneven for one plane. */
export interface PavedPlane {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/** Ground varying more than this from the best plane (RMS, metres) is not flattened. */
export const PAVED_PLANE_MAX_RMS_M = 0.6;
/** Points fitted per area, at most (on a regular grid over it). */
const PLANE_POINTS = 400;

/**
 * The plane each paved area is graded to: the least-squares fit of the
 * ground under it (car parks and squares are laid flat, or on an even slope),
 * or null where the ground is too uneven (a long paved street over a hill).
 */
export function pavedPlane(
  area: PavedArea,
  ground: (x: number, y: number) => number,
): PavedPlane | null {
  const w = area.maxX - area.minX;
  const h = area.maxY - area.minY;
  const step = Math.max(1, Math.sqrt((w * h) / PLANE_POINTS));
  // Normal equations about the box's centre (well conditioned).
  const ox = (area.minX + area.maxX) / 2;
  const oy = (area.minY + area.maxY) / 2;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  const zs: [number, number, number][] = [];
  for (let y = area.minY + step / 2; y < area.maxY; y += step)
    for (let x = area.minX + step / 2; x < area.maxX; x += step) {
      if (pavedDistance(area, x, y) >= 0) continue;
      const z = ground(x, y);
      const u = x - ox;
      const v = y - oy;
      n += 1;
      sx += u;
      sy += v;
      sz += z;
      sxx += u * u;
      syy += v * v;
      sxy += u * v;
      sxz += u * z;
      syz += v * z;
      zs.push([u, v, z]);
    }
  if (n < 3) return null;
  // Solve [n sx sy; sx sxx sxy; sy sxy syy] [a b c] = [sz sxz syz] (Cramer's rule).
  const det3 = (m: number[]) =>
    (m[0] ?? 0) * ((m[4] ?? 0) * (m[8] ?? 0) - (m[5] ?? 0) * (m[7] ?? 0)) -
    (m[1] ?? 0) * ((m[3] ?? 0) * (m[8] ?? 0) - (m[5] ?? 0) * (m[6] ?? 0)) +
    (m[2] ?? 0) * ((m[3] ?? 0) * (m[7] ?? 0) - (m[4] ?? 0) * (m[6] ?? 0));
  const M = [n, sx, sy, sx, sxx, sxy, sy, sxy, syy];
  const D = det3(M);
  let a: number;
  let b = 0;
  let c = 0;
  if (Math.abs(D) < 1e-9) a = sz / n;
  else {
    a = det3([sz, sx, sy, sxz, sxx, sxy, syz, sxy, syy]) / D;
    b = det3([n, sz, sy, sx, sxz, sxy, sy, syz, syy]) / D;
    c = det3([n, sx, sz, sx, sxx, sxz, sy, sxy, syz]) / D;
  }
  let r2 = 0;
  for (const [u, v, z] of zs) r2 += (z - (a + b * u + c * v)) ** 2;
  if (Math.sqrt(r2 / n) > PAVED_PLANE_MAX_RMS_M) return null;
  return { a: a - b * ox - c * oy, b, c };
}
