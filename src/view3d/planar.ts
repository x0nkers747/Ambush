// Planar subdivision of convex pieces (docs/adr/0044): convex polygons, as
// flat [x0, y0, x1, y1, …] arrays, made disjoint by subtracting what was
// placed before them. Used to draw road surfaces as one coherent paved area
// rather than overlapping ribbons. Pure and deterministic: the result depends
// only on the pieces and the order they are placed in.

/** Pieces (and slivers of pieces) smaller than this are dropped, m². */
export const MIN_PLANAR_AREA = 1e-3;
/** Points closer than this to a cutting line count as on it, metres. */
const EPS = 1e-7;

/** Twice the signed area; positive for counter-clockwise (x east, y north). */
export function signedArea2(poly: readonly number[]): number {
  let s = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    s += (poly[2 * i] ?? 0) * (poly[2 * j + 1] ?? 0) - (poly[2 * j] ?? 0) * (poly[2 * i + 1] ?? 0);
  }
  return s;
}

/** The polygon counter-clockwise. */
export function ccw(poly: readonly number[]): number[] {
  if (signedArea2(poly) >= 0) return [...poly];
  const out: number[] = [];
  for (let i = poly.length / 2 - 1; i >= 0; i -= 1)
    out.push(poly[2 * i] ?? 0, poly[2 * i + 1] ?? 0);
  return out;
}

/**
 * The part of a convex polygon on one side of the line through (ax, ay) and
 * (bx, by): to its left (`left`) or right. Sutherland–Hodgman on one edge.
 */
function halfPlane(
  poly: readonly number[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  left: boolean,
): number[] {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const side = (x: number, y: number) => {
    const d = (dx * (y - ay) - dy * (x - ax)) / len;
    return left ? d : -d;
  };
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const px = poly[2 * i] ?? 0;
    const py = poly[2 * i + 1] ?? 0;
    const qx = poly[2 * j] ?? 0;
    const qy = poly[2 * j + 1] ?? 0;
    const dp = side(px, py);
    const dq = side(qx, qy);
    if (dp >= -EPS) out.push(px, py);
    if ((dp > EPS && dq < -EPS) || (dp < -EPS && dq > EPS)) {
      const t = dp / (dp - dq);
      out.push(px + t * (qx - px), py + t * (qy - py));
    }
  }
  return dedupe(out);
}

/** Drops consecutive (and closing) duplicate points. */
function dedupe(poly: number[]): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i += 1) {
    const x = poly[2 * i] ?? 0;
    const y = poly[2 * i + 1] ?? 0;
    const lx = out[out.length - 2];
    const ly = out[out.length - 1];
    if (lx !== undefined && ly !== undefined && Math.abs(lx - x) < 1e-9 && Math.abs(ly - y) < 1e-9)
      continue;
    out.push(x, y);
  }
  while (
    out.length >= 4 &&
    Math.abs((out[0] ?? 0) - (out[out.length - 2] ?? 0)) < 1e-9 &&
    Math.abs((out[1] ?? 0) - (out[out.length - 1] ?? 0)) < 1e-9
  )
    out.splice(-2, 2);
  return out;
}

/** Drops vertices on the line between their neighbours (they only make slivers when triangulated). */
function dropCollinear(poly: readonly number[]): number[] {
  let pts = poly;
  for (let pass = 0; pass < 3; pass += 1) {
    const n = pts.length / 2;
    if (n <= 3) return [...pts];
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const px = pts[2 * ((i + n - 1) % n)] ?? 0;
      const py = pts[2 * ((i + n - 1) % n) + 1] ?? 0;
      const x = pts[2 * i] ?? 0;
      const y = pts[2 * i + 1] ?? 0;
      const nx = pts[2 * ((i + 1) % n)] ?? 0;
      const ny = pts[2 * ((i + 1) % n) + 1] ?? 0;
      const cross = (x - px) * (ny - py) - (y - py) * (nx - px);
      const len = Math.hypot(nx - px, ny - py);
      if (len > 0 && Math.abs(cross) / len < 1e-6) continue;
      out.push(x, y);
    }
    if (out.length === pts.length) return out;
    pts = out;
  }
  return [...pts];
}

const big = (poly: readonly number[]) =>
  poly.length >= 6 && Math.abs(signedArea2(poly)) / 2 >= MIN_PLANAR_AREA;

/**
 * Convex `p` minus convex `q` (both counter-clockwise): disjoint convex
 * pieces. For each edge of `q`, the part of what is left of `p` outside that
 * edge is a piece; the rest goes on to the next edge, and what is left after
 * the last edge lies inside `q`.
 */
export function convexMinus(p: readonly number[], q: readonly number[]): number[][] {
  const out: number[][] = [];
  let rest: number[] = [...p];
  const n = q.length / 2;
  for (let i = 0; i < n && rest.length >= 6; i += 1) {
    const j = (i + 1) % n;
    const ax = q[2 * i] ?? 0;
    const ay = q[2 * i + 1] ?? 0;
    const bx = q[2 * j] ?? 0;
    const by = q[2 * j + 1] ?? 0;
    const outside = dropCollinear(halfPlane(rest, ax, ay, bx, by, false));
    if (big(outside)) out.push(outside);
    rest = halfPlane(rest, ax, ay, bx, by, true);
  }
  return out;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boxOf(poly: readonly number[]): Box {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i] ?? 0;
    const y = poly[i + 1] ?? 0;
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
  }
  return box;
}

/**
 * Whether two convex polygons (counter-clockwise) overlap by more than a
 * touch: no edge of either separates them (separating axis test).
 */
export function convexOverlap(p: readonly number[], q: readonly number[]): boolean {
  const separated = (a: readonly number[], b: readonly number[]) => {
    const n = a.length / 2;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      const ax = a[2 * i] ?? 0;
      const ay = a[2 * i + 1] ?? 0;
      const ex = (a[2 * j] ?? 0) - ax;
      const ey = (a[2 * j + 1] ?? 0) - ay;
      const len = Math.hypot(ex, ey);
      if (len === 0) continue;
      // Every point of b on the right of (or on) this edge: separated.
      let all = true;
      for (let k = 0; k < b.length && all; k += 2) {
        if ((ex * ((b[k + 1] ?? 0) - ay) - ey * ((b[k] ?? 0) - ax)) / len > 1e-6) all = false;
      }
      if (all) return true;
    }
    return false;
  };
  return !separated(p, q) && !separated(q, p);
}

const overlaps = (a: Box, b: Box) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

/** A placed piece: its polygon (counter-clockwise), bounds and owner. */
interface Placed<O> {
  readonly poly: readonly number[];
  readonly box: Box;
  readonly owner: O;
}

/** Bucket size of the occupancy index, metres. */
const BUCKET_M = 16;

/**
 * Space taken by placed pieces, for subtracting from later ones. A piece is
 * cut only by placed pieces whose owner `interacts` with it (e.g. roads on
 * the same level), so grade-separated surfaces stay whole.
 */
export class Occupancy<O> {
  private readonly buckets = new Map<number, number[]>();
  private readonly placed: Placed<O>[] = [];
  private stamp = new Uint32Array(0);
  private query = 0;
  private readonly interacts: (placed: O, piece: O) => boolean;

  constructor(interacts: (placed: O, piece: O) => boolean) {
    this.interacts = interacts;
  }

  /** Records a convex piece as taken (its owner as given). */
  add(poly: readonly number[], owner: O): void {
    const p = ccw(poly);
    const box = boxOf(p);
    const index = this.placed.length;
    this.placed.push({ poly: p, box, owner });
    for (let gx = Math.floor(box.minX / BUCKET_M); gx <= Math.floor(box.maxX / BUCKET_M); gx += 1) {
      for (
        let gy = Math.floor(box.minY / BUCKET_M);
        gy <= Math.floor(box.maxY / BUCKET_M);
        gy += 1
      ) {
        const k = gx * 100_003 + gy;
        const list = this.buckets.get(k);
        if (list) list.push(index);
        else this.buckets.set(k, [index]);
      }
    }
  }

  /** Scratch list of candidate indices (reused: `free` is the hot path). */
  private readonly found: number[] = [];

  /** The placed pieces that may overlap a box and interact with `owner`, in the order placed. */
  private near(box: Box, owner: O): number[] {
    if (this.stamp.length < this.placed.length) {
      const grown = new Uint32Array(Math.max(1024, this.placed.length * 2));
      grown.set(this.stamp);
      this.stamp = grown;
    }
    this.query = (this.query + 1) >>> 0;
    if (this.query === 0) {
      this.stamp.fill(0);
      this.query = 1;
    }
    const found = this.found;
    found.length = 0;
    const gx0 = Math.floor(box.minX / BUCKET_M);
    const gx1 = Math.floor(box.maxX / BUCKET_M);
    const gy0 = Math.floor(box.minY / BUCKET_M);
    const gy1 = Math.floor(box.maxY / BUCKET_M);
    for (let gx = gx0; gx <= gx1; gx += 1) {
      for (let gy = gy0; gy <= gy1; gy += 1) {
        const list = this.buckets.get(gx * 100_003 + gy);
        if (!list) continue;
        for (const i of list) {
          if (this.stamp[i] === this.query) continue;
          this.stamp[i] = this.query;
          const p = this.placed[i];
          if (p && overlaps(p.box, box) && this.interacts(p.owner, owner)) found.push(i);
        }
      }
    }
    // In the order placed, so the result does not depend on the buckets' order.
    if (found.length > 1) found.sort((a, b) => a - b);
    return found;
  }

  /** What is left of a convex piece outside every interacting placed piece: disjoint convex pieces. */
  free(poly: readonly number[], owner: O): number[][] {
    const start = ccw(poly);
    const near = this.near(boxOf(start), owner);
    if (near.length === 0) return [start];
    let pieces = [start];
    for (const i of near) {
      const q = this.placed[i];
      if (!q) continue;
      let next: number[][] | null = null;
      for (let k = 0; k < pieces.length; k += 1) {
        const p = pieces[k] ?? [];
        if (overlaps(boxOf(p), q.box) && convexOverlap(p, q.poly)) {
          next ??= pieces.slice(0, k);
          next.push(...convexMinus(p, q.poly));
        } else if (next) next.push(p);
      }
      if (next) pieces = next;
      if (pieces.length === 0) break;
    }
    return pieces;
  }

  /** Places a piece: returns what is left of it (as `free`) and records the whole piece as taken. */
  place(poly: readonly number[], owner: O): number[][] {
    const pieces = this.free(poly, owner);
    if (pieces.length > 0) this.add(poly, owner);
    return pieces;
  }

  get size(): number {
    return this.placed.length;
  }

  /** Every placed piece (counter-clockwise) and its owner, in the order placed. */
  forEach(fn: (poly: readonly number[], owner: O) => void): void {
    for (const p of this.placed) fn(p.poly, p.owner);
  }
}
