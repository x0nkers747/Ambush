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

/** The centroid of a simple polygon (either winding), or `undefined` when its area is zero. */
export function polygonCentroid(vertices: readonly Vec2[]): Vec2 | undefined {
  let area = 0;
  let cx = 0;
  let cy = 0;
  vertices.forEach((a, i) => {
    const b = vertices[(i + 1) % vertices.length] ?? a;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  });
  return area === 0 ? undefined : { x: cx / (3 * area), y: cy / (3 * area) };
}

/** Area in square metres (either winding). */
export function polygonArea(vertices: readonly Vec2[]): number {
  return Math.abs(signedArea2(vertices)) / 2;
}

/** Whether `p` lies on the polygon's boundary (an edge or vertex). */
export function isOnPolygonBoundary(p: Vec2, vertices: readonly Vec2[]): boolean {
  // Index loops rather than `edges()`: this runs in hot loops (path planning) and must not allocate.
  const n = vertices.length;
  for (let i = 0; i < n; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    if (a && b && onSegment(p, a, b)) return true;
  }
  return false;
}

/**
 * A large polygon's edges by horizontal band (CSR layout: band `k`, from
 * `minY + k·BAND_M`, holds edge indices `edges[start[k]] … edges[start[k + 1] − 1]`;
 * edge `i` runs from vertex `i` to vertex `i + 1`). An edge is listed in
 * every band its y-range touches (inclusive, with a hair of margin), so a
 * band lists every edge that reaches any height within it. Built once per
 * vertex array (polygons are immutable).
 */
export interface PolygonBands {
  readonly minY: number;
  readonly maxY: number;
  readonly count: number;
  readonly start: Int32Array;
  readonly edges: Int32Array;
}

/** Polygons with at least this many vertices get bands (smaller ones are scanned whole). */
const BANDED_MIN_VERTICES = 48;
/** Band height, in metres. */
const BAND_M = 8;
const bandCache = new WeakMap<readonly Vec2[], PolygonBands | null>();

/** The polygon's edge bands, or `null` for a small polygon. */
export function polygonBands(vertices: readonly Vec2[]): PolygonBands | null {
  const known = bandCache.get(vertices);
  if (known !== undefined) return known;
  const n = vertices.length;
  if (n < BANDED_MIN_VERTICES) {
    bandCache.set(vertices, null);
    return null;
  }
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of vertices) {
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  const count = Math.max(1, Math.ceil((maxY - minY) / BAND_M) + 1);
  const eps = BAND_M * 1e-6;
  const range = (i: number): [number, number] => {
    const a = vertices[i] ?? { x: 0, y: 0 };
    const b = vertices[(i + 1) % n] ?? a;
    const lo = Math.floor((Math.min(a.y, b.y) - minY - eps) / BAND_M);
    const hi = Math.floor((Math.max(a.y, b.y) - minY + eps) / BAND_M);
    return [Math.max(0, lo), Math.min(count - 1, hi)];
  };
  const start = new Int32Array(count + 1);
  for (let i = 0; i < n; i += 1) {
    const [lo, hi] = range(i);
    for (let k = lo; k <= hi; k += 1) start[k + 1] = (start[k + 1] ?? 0) + 1;
  }
  for (let k = 1; k <= count; k += 1) start[k] = (start[k] ?? 0) + (start[k - 1] ?? 0);
  const fill = start.slice(0, count);
  const edges = new Int32Array(start[count] ?? 0);
  for (let i = 0; i < n; i += 1) {
    const [lo, hi] = range(i);
    for (let k = lo; k <= hi; k += 1) {
      const at = fill[k] ?? 0;
      edges[at] = i;
      fill[k] = at + 1;
    }
  }
  const bands: PolygonBands = { minY, maxY, count, start, edges };
  bandCache.set(vertices, bands);
  return bands;
}

/**
 * The bands covering heights `y0`…`y1`: `[first, last]` (empty, `first >
 * last`, when the range misses the polygon's heights altogether).
 */
export function bandRange(bands: PolygonBands, y0: number, y1: number): [number, number] {
  if (y1 < bands.minY || y0 > bands.maxY) return [1, 0];
  const first = Math.max(0, Math.floor((y0 - bands.minY) / BAND_M));
  const last = Math.min(bands.count - 1, Math.floor((y1 - bands.minY) / BAND_M));
  return [first, last];
}

/**
 * Whether `p` lies inside the closed polygon: boundary points count as inside.
 * A large polygon is tested on its band at `p`'s height alone (`polygonBands`):
 * only edges reaching that height can hold `p` or cross the ray from it, so
 * the answer is the whole scan's.
 */
export function pointInPolygon(p: Vec2, vertices: readonly Vec2[]): boolean {
  const bands = polygonBands(vertices);
  if (bands) {
    if (p.y < bands.minY || p.y > bands.maxY) return false;
    const k = Math.min(bands.count - 1, Math.floor((p.y - bands.minY) / BAND_M));
    const from = bands.start[k] ?? 0;
    const to = bands.start[k + 1] ?? 0;
    const n = vertices.length;
    for (let j = from; j < to; j += 1) {
      const i = bands.edges[j] ?? 0;
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      if (a && b && onSegment(p, a, b)) return true;
    }
    let inside = false;
    for (let j = from; j < to; j += 1) {
      const i = bands.edges[j] ?? 0;
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      if (!a || !b) continue;
      if (a.y > p.y !== b.y > p.y) {
        const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (x > p.x) inside = !inside;
      }
    }
    return inside;
  }
  if (isOnPolygonBoundary(p, vertices)) return true;
  // Even-odd ray cast toward +X. Off the boundary the half-open rule is exact.
  let inside = false;
  const n = vertices.length;
  for (let i = 0; i < n; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    if (!a || !b) continue;
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
