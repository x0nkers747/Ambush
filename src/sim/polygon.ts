import type { Vec2 } from './geometry';

// Plane polygon geometry for engagement areas (docs/adr/0010). Polygons are
// closed: points on the boundary count as inside. All tests are exact
// floating-point predicates with no tolerances, so results are deterministic.

/** Path parameters closer than this are the same point (≈ 1e-10 m on a 100 m path). */
const PARAM_EPSILON = 1e-12;

/** Twice the signed area; positive for counter-clockwise vertices. */
export function signedArea2(vertices: readonly Vec2[]): number {
  let sum = 0;
  vertices.forEach((a, i) => {
    const b = vertices[(i + 1) % vertices.length] ?? a;
    sum += a.x * b.y - b.x * a.y;
  });
  return sum;
}

/** Area in square metres (either winding). */
export function polygonArea(vertices: readonly Vec2[]): number {
  return Math.abs(signedArea2(vertices)) / 2;
}

/** Whether `p` lies on the polygon's boundary (an edge or vertex). */
export function isOnPolygonBoundary(p: Vec2, vertices: readonly Vec2[]): boolean {
  return edges(vertices).some(([a, b]) => onSegment(p, a, b));
}

/** Whether `p` lies inside the closed polygon: boundary points count as inside. */
export function pointInPolygon(p: Vec2, vertices: readonly Vec2[]): boolean {
  if (isOnPolygonBoundary(p, vertices)) return true;
  // Even-odd ray cast toward +X. Off the boundary the half-open rule is exact.
  let inside = false;
  for (const [a, b] of edges(vertices)) {
    if (a.y > p.y !== b.y > p.y) {
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x > p.x) inside = !inside;
    }
  }
  return inside;
}

/**
 * Where a straight path from `a` to `b` enters the closed polygon: the
 * parameters s ∈ [0, 1] (point a + s·(b − a)) at which it passes from outside
 * to the boundary. Touching the boundary counts as entering; a path that starts
 * inside or on the boundary has not entered at s = 0. Ascending.
 */
export function segmentPolygonEntries(a: Vec2, b: Vec2, vertices: readonly Vec2[]): number[] {
  const params = new Set<number>();
  for (const [p, q] of edges(vertices)) {
    for (const s of segmentIntersectionParams(a, b, p, q)) params.add(s);
  }
  // Edges meeting at a vertex can yield parameters a few ulps apart for the same point.
  const sorted = [...params]
    .sort((x, y) => x - y)
    .filter((s, i, all) => i === 0 || s - (all[i - 1] ?? s) > PARAM_EPSILON);
  const at = (s: number): Vec2 => ({ x: a.x + s * (b.x - a.x), y: a.y + s * (b.y - a.y) });

  const entries: number[] = [];
  let outside = !pointInPolygon(a, vertices);
  sorted.forEach((s, i) => {
    // Every parameter is a boundary point, which counts as inside.
    if (outside) entries.push(s);
    const next = sorted[i + 1] ?? 1;
    outside = s < 1 && !pointInPolygon(at((s + next) / 2), vertices);
  });
  return entries;
}

/**
 * Whether the vertices form a simple polygon: at least three distinct vertices,
 * non-zero area, and no edge touching another except adjacent edges at their
 * shared vertex.
 */
export function isSimplePolygon(vertices: readonly Vec2[]): boolean {
  const n = vertices.length;
  if (n < 3 || signedArea2(vertices) === 0) return false;
  const list = edges(vertices);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const [a, b] = list[i] ?? [];
      const [c, d] = list[j] ?? [];
      if (!a || !b || !c || !d) continue;
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (!adjacent) {
        if (segmentIntersectionParams(a, b, c, d).length > 0) return false;
      } else {
        // Adjacent edges share exactly one vertex: they must not fold back onto each other.
        const shared = j === i + 1 ? b : a;
        const [u, v] = j === i + 1 ? [a, d] : [b, c];
        if (cross(shared, u, v) === 0 && dot(shared, u, v) > 0) return false;
      }
    }
  }
  return true;
}

/**
 * Parameters s ∈ [0, 1] along segment a→b where it meets segment p→q: one
 * value for a crossing or touch, the two ends of the shared part when the
 * segments overlap collinearly, none otherwise.
 */
export function segmentIntersectionParams(a: Vec2, b: Vec2, p: Vec2, q: Vec2): number[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ex = q.x - p.x;
  const ey = q.y - p.y;
  const denom = dx * ey - dy * ex;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  if (denom !== 0) {
    const s = (wx * ey - wy * ex) / denom;
    const u = (wx * dy - wy * dx) / denom;
    return s >= 0 && s <= 1 && u >= 0 && u <= 1 ? [s] : [];
  }
  if (wx * dy - wy * dx !== 0) return []; // parallel, not collinear
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return onSegment(a, p, q) ? [0] : [];
  const sp = (wx * dx + wy * dy) / lengthSq;
  const sq = ((q.x - a.x) * dx + (q.y - a.y) * dy) / lengthSq;
  const lo = Math.max(0, Math.min(sp, sq));
  const hi = Math.min(1, Math.max(sp, sq));
  if (lo > hi) return [];
  return lo === hi ? [lo] : [lo, hi];
}

function edges(vertices: readonly Vec2[]): [Vec2, Vec2][] {
  return vertices.map((a, i) => [a, vertices[(i + 1) % vertices.length] ?? a]);
}

function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  return (
    cross(a, b, p) === 0 &&
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  );
}

/** Cross product of (u − o) and (v − o). */
function cross(o: Vec2, u: Vec2, v: Vec2): number {
  return (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x);
}

/** Dot product of (u − o) and (v − o). */
function dot(o: Vec2, u: Vec2, v: Vec2): number {
  return (u.x - o.x) * (v.x - o.x) + (u.y - o.y) * (v.y - o.y);
}
