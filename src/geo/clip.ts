import { pointInPolygon, type Vec2 } from '#sim';

// Clipping imported geometry to the battlefield rectangle (docs/adr/0014).
// Polygons are clipped by a Weiler–Atherton walk specialised to a convex,
// axis-aligned clip window: the parts of the outline inside the rectangle are
// joined along the rectangle's edge. A polygon that leaves and re-enters the
// rectangle becomes several separate polygons, never one with zero-width
// bridges, so every result can be a simple polygon. Points on the boundary
// are snapped exactly onto it, so they pass the terrain's "on the map" check.

export interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Parameters [t0, t1] of the part of segment a–b inside the closed rectangle (Liang–Barsky), or null. */
export function clipSegment(a: Vec2, b: Vec2, r: Rect): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: [number, number][] = [
    [-dx, a.x - r.minX],
    [dx, r.maxX - a.x],
    [-dy, a.y - r.minY],
    [dy, r.maxY - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [t0, t1];
}

const inside = (p: Vec2, r: Rect) =>
  p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;

/** A point on segment a–b, snapped onto the rectangle when it lies (numerically) on its edge. */
function pointAt(a: Vec2, b: Vec2, t: number, r: Rect): Vec2 {
  if (t === 0) return a;
  if (t === 1) return b;
  const eps = 1e-9 * Math.max(1, Math.abs(r.maxX - r.minX), Math.abs(r.maxY - r.minY));
  const snap = (v: number, lo: number, hi: number) =>
    Math.abs(v - lo) <= eps ? lo : Math.abs(v - hi) <= eps ? hi : Math.min(hi, Math.max(lo, v));
  return {
    x: snap(a.x + t * (b.x - a.x), r.minX, r.maxX),
    y: snap(a.y + t * (b.y - a.y), r.minY, r.maxY),
  };
}

/** Distance along the rectangle's edge, counter-clockwise from its south-west corner. */
function perimeterParam(p: Vec2, r: Rect): number {
  const w = r.maxX - r.minX;
  const h = r.maxY - r.minY;
  const eps = 1e-9 * Math.max(1, w, h);
  if (Math.abs(p.y - r.minY) <= eps) return p.x - r.minX;
  if (Math.abs(p.x - r.maxX) <= eps) return w + (p.y - r.minY);
  if (Math.abs(p.y - r.maxY) <= eps) return w + h + (r.maxX - p.x);
  return 2 * w + h + (r.maxY - p.y);
}

/** Twice the signed area (shoelace): positive for a counter-clockwise ring (x east, y north). */
export function signedArea(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a && b) s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Removes consecutive repeats; for a ring (`closed`), also a repeated closing point. */
export function dedupe(points: readonly Vec2[], closed = true, tolerance = 1e-6): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > tolerance || Math.abs(last.y - p.y) > tolerance)
      out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (
    closed &&
    out.length > 1 &&
    first &&
    last &&
    Math.abs(first.x - last.x) <= tolerance &&
    Math.abs(first.y - last.y) <= tolerance
  ) {
    out.pop();
  }
  return out;
}

/**
 * The parts of a polygon ring inside the rectangle, each a counter-clockwise
 * ring. Empty when they do not overlap; the rectangle itself when the polygon
 * contains it. The input may be either orientation, without a closing point.
 */
export function clipPolygon(ring: readonly Vec2[], r: Rect): Vec2[][] {
  let poly = dedupe(ring);
  if (poly.length < 3) return [];
  if (signedArea(poly) < 0) poly = [...poly].reverse();
  const n = poly.length;
  const start = poly.findIndex((p) => !inside(p, r));
  if (start < 0) return [poly]; // entirely within the rectangle
  const rotated = [...poly.slice(start), ...poly.slice(0, start)];

  // Inside chains: from an entry point on the edge to an exit point on the edge.
  const chains: Vec2[][] = [];
  let open: Vec2[] | null = null;
  for (let i = 0; i < n; i += 1) {
    const a = rotated[i];
    const b = rotated[(i + 1) % n];
    if (!a || !b) continue;
    const range = clipSegment(a, b, r);
    if (!range) continue;
    const [t0, t1] = range;
    open ??= [pointAt(a, b, t0, r)];
    if (t1 < 1) {
      open.push(pointAt(a, b, t1, r));
      const chain = dedupe(open);
      if (chain.length >= 2) chains.push(chain);
      open = null;
    } else {
      open.push(b);
    }
  }
  if (chains.length === 0) {
    const centre = { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 };
    return pointInPolygon(centre, poly)
      ? [
          [
            { x: r.minX, y: r.minY },
            { x: r.maxX, y: r.minY },
            { x: r.maxX, y: r.maxY },
            { x: r.minX, y: r.maxY },
          ],
        ]
      : [];
  }

  // Join chains: from each exit, follow the edge counter-clockwise to the next entry.
  const perimeter = 2 * (r.maxX - r.minX + r.maxY - r.minY);
  const corners = [
    { s: 0, p: { x: r.minX, y: r.minY } },
    { s: r.maxX - r.minX, p: { x: r.maxX, y: r.minY } },
    { s: r.maxX - r.minX + (r.maxY - r.minY), p: { x: r.maxX, y: r.maxY } },
    { s: 2 * (r.maxX - r.minX) + (r.maxY - r.minY), p: { x: r.minX, y: r.maxY } },
  ];
  const entry = chains.map((c) => perimeterParam(c[0] ?? { x: 0, y: 0 }, r));
  const used = new Array<boolean>(chains.length).fill(false);
  const result: Vec2[][] = [];
  for (let k = 0; k < chains.length; k += 1) {
    if (used[k]) continue;
    const out: Vec2[] = [];
    let j = k;
    for (let guard = 0; guard <= chains.length; guard += 1) {
      used[j] = true;
      const chain = chains[j] ?? [];
      out.push(...chain);
      const exit = perimeterParam(chain[chain.length - 1] ?? { x: 0, y: 0 }, r);
      // The next entry counter-clockwise from this exit (an entry at the same spot counts).
      let next = -1;
      let best = Number.POSITIVE_INFINITY;
      for (let m = 0; m < chains.length; m += 1) {
        const d = ((entry[m] ?? 0) - exit + perimeter) % perimeter;
        if (d < best) {
          best = d;
          next = m;
        }
      }
      // Corners passed on the way, in travel order (the list is sorted by distance along the edge).
      for (const corner of [...corners, ...corners.map((c) => ({ s: c.s + perimeter, p: c.p }))]) {
        const d = corner.s - exit;
        if (d > 0 && d < best) out.push(corner.p);
      }
      if (next === k || next < 0 || used[next]) break;
      j = next;
    }
    const ring = dedupe(out);
    if (ring.length >= 3) result.push(ring);
  }
  return result;
}

/** The parts of a polyline inside the rectangle, each with at least two distinct points. */
export function clipPolyline(line: readonly Vec2[], r: Rect): Vec2[][] {
  const pts = dedupe(line, false);
  const pieces: Vec2[][] = [];
  let open: Vec2[] | null = null;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) continue;
    const range = clipSegment(a, b, r);
    if (!range) {
      if (open) pieces.push(open);
      open = null;
      continue;
    }
    const [t0, t1] = range;
    if (!open || t0 > 0) {
      if (open) pieces.push(open);
      open = [pointAt(a, b, t0, r)];
    }
    open.push(pointAt(a, b, t1, r));
    if (t1 < 1) {
      pieces.push(open);
      open = null;
    }
  }
  if (open) pieces.push(open);
  return pieces.map((p) => dedupe(p, false)).filter((p) => p.length >= 2);
}
