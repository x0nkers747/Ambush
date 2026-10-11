import type { Vec2 } from '#sim';

// Spatial indexes for placing vegetation (docs/adr/0031): exact
// point-in-polygon and distance-to-edge queries that stay fast for polygons of
// thousands of corners and for hundreds of thousands of queries. Pure.

/** A polygon with holes, its edges bucketed by horizontal bands for containment tests. */
export interface PolygonIndex {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Whether (x, y) lies inside the boundary and outside every hole (even–odd). */
  contains(x: number, y: number): boolean;
}

const BAND_M = 8;

export function polygonIndex(rings: readonly (readonly Vec2[])[]): PolygonIndex {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of rings[0] ?? []) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const bandCount = Math.max(1, Math.ceil((maxY - minY) / BAND_M) + 1);
  const bands: number[][] = Array.from({ length: bandCount }, () => []);
  for (const ring of rings) {
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length] ?? a;
      if (a.y === b.y) return;
      const lo = Math.max(0, Math.floor((Math.min(a.y, b.y) - minY) / BAND_M));
      const hi = Math.min(bandCount - 1, Math.floor((Math.max(a.y, b.y) - minY) / BAND_M));
      for (let k = lo; k <= hi; k += 1) bands[k]?.push(a.x, a.y, b.x, b.y);
    });
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    contains(x, y) {
      if (x < minX || x > maxX || y < minY || y > maxY) return false;
      const band = bands[Math.floor((y - minY) / BAND_M)];
      if (!band) return false;
      let inside = false;
      for (let i = 0; i < band.length; i += 4) {
        const ax = band[i] ?? 0;
        const ay = band[i + 1] ?? 0;
        const bx = band[i + 2] ?? 0;
        const by = band[i + 3] ?? 0;
        if (ay > y !== by > y && ax + ((y - ay) * (bx - ax)) / (by - ay) > x) inside = !inside;
      }
      return inside;
    },
  };
}

/**
 * Line segments with a half-width (road and waterway centrelines, polygon
 * edges with none), bucketed on a uniform grid for "is anything within d of
 * this point?" and "how far is the nearest?" queries.
 */
export interface SegmentGrid {
  /** Whether a segment lies within its half-width plus `margin` of (x, y). */
  near(x: number, y: number, margin: number): boolean;
  /** Distance from (x, y) to the nearest segment's edge (centreline less half-width), at most `limit`. */
  distance(x: number, y: number, limit: number): number;
}

export function segmentGrid(
  segments: ArrayLike<number>,
  /** The largest margin or limit that will be asked for. */
  reach: number,
  cell = 25,
): SegmentGrid {
  const buckets = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 100_003 + j;
  const n = segments.length / 5;
  for (let s = 0; s < n; s += 1) {
    const ax = segments[s * 5] ?? 0;
    const ay = segments[s * 5 + 1] ?? 0;
    const bx = segments[s * 5 + 2] ?? 0;
    const by = segments[s * 5 + 3] ?? 0;
    const h = (segments[s * 5 + 4] ?? 0) + reach;
    for (
      let i = Math.floor((Math.min(ax, bx) - h) / cell);
      i <= Math.floor((Math.max(ax, bx) + h) / cell);
      i++
    ) {
      for (
        let j = Math.floor((Math.min(ay, by) - h) / cell);
        j <= Math.floor((Math.max(ay, by) + h) / cell);
        j++
      ) {
        const k = key(i, j);
        let list = buckets.get(k);
        if (!list) {
          list = [];
          buckets.set(k, list);
        }
        list.push(s);
      }
    }
  }
  /** Distance from (x, y) to segment s's edge. */
  const gap = (s: number, x: number, y: number) => {
    const ax = segments[s * 5] ?? 0;
    const ay = segments[s * 5 + 1] ?? 0;
    const dx = (segments[s * 5 + 2] ?? 0) - ax;
    const dy = (segments[s * 5 + 3] ?? 0) - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy) - (segments[s * 5 + 4] ?? 0);
  };
  const bucket = (x: number, y: number) =>
    buckets.get(key(Math.floor(x / cell), Math.floor(y / cell)));
  return {
    near(x, y, margin) {
      for (const s of bucket(x, y) ?? []) if (gap(s, x, y) < margin) return true;
      return false;
    },
    distance(x, y, limit) {
      let best = limit;
      for (const s of bucket(x, y) ?? []) best = Math.min(best, gap(s, x, y));
      return Math.max(0, best);
    },
  };
}

/** The segments of polylines as [ax, ay, bx, by, halfWidth, …]. */
export function polylineSegments(
  lines: readonly { readonly points: readonly Vec2[]; readonly halfWidth: number }[],
  closed = false,
): Float64Array {
  const out: number[] = [];
  for (const { points, halfWidth } of lines) {
    const n = points.length;
    for (let i = 0; i < (closed ? n : n - 1); i += 1) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (a && b) out.push(a.x, a.y, b.x, b.y, halfWidth);
    }
  }
  return Float64Array.from(out);
}
