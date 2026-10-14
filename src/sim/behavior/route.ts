import type { Vec2 } from '../geometry';
import { isSegmentWalkable } from '../navigation';
import type { TerrainDataset } from '../terrain';
import type { GroupRoute } from './types';

// The organization's one route (docs/behavior-lab/03 §7.1): the navigation's
// path (`planPath`) with each corner replaced by a circular arc, measured by
// arc length. Slots are defined along it, so its point, tangent and
// curvature at any arc length are what the formation follows.

/** Arcs are drawn with points at most this far apart (radians, metres). */
const ORIGIN: Vec2 = Object.freeze({ x: 0, y: 0 });
const ARC_STEP_RAD = (5 * Math.PI) / 180;
const ARC_STEP_M = 2;
/** A corner whose arc is not walkable is retried with half the radius, this many times. */
const ROUNDING_TRIES = 4;

/** A point of the route: position, unit tangent, signed curvature (1/m, + turning right). */
export interface RoutePoint {
  x: number;
  y: number;
  tx: number;
  ty: number;
  k: number;
}

export function routePoint(): RoutePoint {
  return { x: 0, y: 0, tx: 0, ty: 1, k: 0 };
}

/**
 * The route through `points` (start, turn points, destination) with corners
 * rounded to `radius` where the ground allows: a corner's arc is shortened
 * to fit the straight pieces either side, and halved until it is walkable
 * (else the corner stays sharp). Points closer than 1 mm are merged.
 * `heading` is the start's tangent when the route has no length.
 */
export function buildGroupRoute(
  terrain: TerrainDataset,
  points: readonly Vec2[],
  radius: number,
  heading: Vec2 = { x: 0, y: 1 },
): GroupRoute {
  const p: Vec2[] = [];
  for (const q of points) {
    const last = p[p.length - 1];
    if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1e-3) p.push({ x: q.x, y: q.y });
  }
  const out = {
    x: [] as number[],
    y: [] as number[],
    tx: [] as number[],
    ty: [] as number[],
    k: [] as number[],
  };
  const push = (x: number, y: number, tx: number, ty: number) => {
    out.x.push(x);
    out.y.push(y);
    out.tx.push(tx);
    out.ty.push(ty);
    out.k.push(0);
  };
  const first = p[0] ?? { x: 0, y: 0 };
  if (p.length < 2) {
    const h = Math.hypot(heading.x, heading.y) || 1;
    push(first.x, first.y, heading.x / h, heading.y / h);
    return finish(out);
  }
  const dir = (i: number): Vec2 => {
    const a = p[i] ?? ORIGIN;
    const b = p[i + 1] ?? ORIGIN;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  };
  const len = (i: number): number => {
    const a = p[i] ?? ORIGIN;
    const b = p[i + 1] ?? ORIGIN;
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  const d0 = dir(0);
  push(first.x, first.y, d0.x, d0.y);
  const n = p.length - 1;
  for (let i = 1; i < n; i += 1) {
    const corner = p[i] ?? ORIGIN;
    const a = dir(i - 1);
    const b = dir(i);
    const cos = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y));
    const theta = Math.acos(cos);
    const cross = a.x * b.y - a.y * b.x;
    if (theta < 1e-6) continue;
    const half = Math.tan(theta / 2);
    const availIn = i - 1 === 0 ? len(i - 1) : len(i - 1) / 2;
    const availOut = i + 1 === n ? len(i) : len(i) / 2;
    let r = Math.min(radius, Math.min(availIn, availOut) / half);
    let arc: RoutePoint[] | null = null;
    for (let tries = 0; tries <= ROUNDING_TRIES && r > 0.5; tries += 1, r /= 2) {
      const candidate = arcPoints(corner, a, b, theta, cross, r);
      let walkable = true;
      for (let j = 0; j + 1 < candidate.length && walkable; j += 1) {
        walkable = isSegmentWalkable(terrain, candidate[j] ?? ORIGIN, candidate[j + 1] ?? ORIGIN);
      }
      if (walkable) {
        arc = candidate;
        break;
      }
    }
    if (!arc) {
      // A sharp corner: the tangent there is halfway between the two pieces.
      const mx = a.x + b.x;
      const my = a.y + b.y;
      const m = Math.hypot(mx, my) || 1;
      push(corner.x, corner.y, mx / m, my / m);
      continue;
    }
    for (const q of arc) {
      push(q.x, q.y, q.tx, q.ty);
      out.k[out.k.length - 1] = q.k;
    }
    // The arc's last point starts a straight piece.
    out.k[out.k.length - 1] = 0;
  }
  const end = p[n] ?? ORIGIN;
  const dn = dir(n - 1);
  push(end.x, end.y, dn.x, dn.y);
  return finish(out);
}

/** Points of the arc of radius `r` replacing the corner (curvature on each, for the piece it starts). */
function arcPoints(
  corner: Vec2,
  a: Vec2,
  b: Vec2,
  theta: number,
  cross: number,
  r: number,
): RoutePoint[] {
  const t = r * Math.tan(theta / 2);
  const ax = corner.x - a.x * t;
  const ay = corner.y - a.y * t;
  // Turning right (clockwise) when the cross product is negative; the centre
  // is on the side the route turns toward.
  const right = cross < 0;
  const side = right ? 1 : -1;
  const cx = ax + a.y * r * side;
  const cy = ay - a.x * r * side;
  const steps = Math.max(1, Math.ceil(theta / ARC_STEP_RAD), Math.ceil((theta * r) / ARC_STEP_M));
  const k = side / r;
  const points: RoutePoint[] = [];
  for (let j = 0; j <= steps; j += 1) {
    // Clockwise rotation by φ for a right turn, counter-clockwise for a left one.
    const phi = side * theta * (j / steps);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const vx = ax - cx;
    const vy = ay - cy;
    points.push({
      x: j === steps ? corner.x + b.x * t : cx + vx * c + vy * s,
      y: j === steps ? corner.y + b.y * t : cy - vx * s + vy * c,
      tx: a.x * c + a.y * s,
      ty: -a.x * s + a.y * c,
      k: j === steps ? 0 : k,
    });
  }
  return points;
}

function finish(out: {
  x: number[];
  y: number[];
  tx: number[];
  ty: number[];
  k: number[];
}): GroupRoute {
  const cum = [0];
  for (let i = 1; i < out.x.length; i += 1) {
    cum.push(
      (cum[i - 1] ?? 0) +
        Math.hypot((out.x[i] ?? 0) - (out.x[i - 1] ?? 0), (out.y[i] ?? 0) - (out.y[i - 1] ?? 0)),
    );
  }
  return { ...out, cum, length: cum[cum.length - 1] ?? 0 };
}

/**
 * The route at arc length `s`, written into `out`: position, unit tangent
 * (interpolated between points), and the curvature of the piece there.
 * Before the start and past the end the route goes on straight along its
 * first and last tangent.
 */
export function routeAt(route: GroupRoute, s: number, out: RoutePoint): RoutePoint {
  const n = route.cum.length;
  const last = n - 1;
  if (s <= 0 || n === 1) {
    const tx = route.tx[0] ?? 0;
    const ty = route.ty[0] ?? 1;
    const d = Math.min(s, 0);
    out.x = (route.x[0] ?? 0) + tx * d;
    out.y = (route.y[0] ?? 0) + ty * d;
    out.tx = tx;
    out.ty = ty;
    out.k = 0;
    return out;
  }
  if (s >= route.length) {
    const tx = route.tx[last] ?? 0;
    const ty = route.ty[last] ?? 1;
    const d = s - route.length;
    out.x = (route.x[last] ?? 0) + tx * d;
    out.y = (route.y[last] ?? 0) + ty * d;
    out.tx = tx;
    out.ty = ty;
    out.k = 0;
    return out;
  }
  const i = segmentAt(route, s);
  const s0 = route.cum[i] ?? 0;
  const l = (route.cum[i + 1] ?? s0) - s0;
  const u = l > 0 ? (s - s0) / l : 0;
  const x0 = route.x[i] ?? 0;
  const y0 = route.y[i] ?? 0;
  out.x = x0 + ((route.x[i + 1] ?? x0) - x0) * u;
  out.y = y0 + ((route.y[i + 1] ?? y0) - y0) * u;
  const tx0 = route.tx[i] ?? 0;
  const ty0 = route.ty[i] ?? 1;
  const tx = tx0 + ((route.tx[i + 1] ?? tx0) - tx0) * u;
  const ty = ty0 + ((route.ty[i + 1] ?? ty0) - ty0) * u;
  const m = Math.sqrt(tx * tx + ty * ty) || 1;
  out.tx = tx / m;
  out.ty = ty / m;
  out.k = route.k[i] ?? 0;
  return out;
}

/** Index of the route piece containing arc length `s` (0 < s < length). */
function segmentAt(route: GroupRoute, s: number): number {
  let lo = 0;
  let hi = route.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((route.cum[mid] ?? 0) <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The largest |curvature| of the route between arc lengths `s0` and `s1`
 * (for the anchor to slow before a bend, not on it).
 */
export function maxCurvature(route: GroupRoute, s0: number, s1: number): number {
  const a = Math.max(0, s0);
  const b = Math.min(route.length, s1);
  if (!(b > a)) return 0;
  let i = segmentAt(route, Math.max(a, 1e-9));
  let k = 0;
  for (; i < route.cum.length - 1 && (route.cum[i] ?? 0) < b; i += 1) {
    k = Math.max(k, Math.abs(route.k[i] ?? 0));
  }
  return k;
}
