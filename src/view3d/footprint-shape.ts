import { pointInPolygon, type Vec2 } from '#sim';

// The shape of a building's footprint, for its roof (docs/adr/0035). Most
// footprints (62–78% at the recorded battlefields) are rectangles, which take
// a ridge roof on their oriented minimum bounding rectangle (OMBR). Most of
// the rest are L, T or U plans of right angles: those are covered by up to
// four rectangles, each roofed on its own, the roofs meeting as on real
// cross-gabled houses. Anything else is irregular, and is roofed flat.

/** A local frame: origin and unit axis `u`; `v` is `u` turned left. Points map to (s, t). */
export interface ShapeFrame {
  readonly ox: number;
  readonly oy: number;
  readonly ux: number;
  readonly uy: number;
}

/** A rectangle in a frame's (s, t) coordinates. */
export interface FrameRect {
  readonly s0: number;
  readonly s1: number;
  readonly t0: number;
  readonly t1: number;
}

export interface FootprintShape {
  readonly kind: 'rectangle' | 'rectilinear' | 'irregular';
  /** Counter-clockwise ring, without a repeated closing corner, near-collinear corners removed. */
  readonly ring: readonly Vec2[];
  readonly area: number;
  readonly frame: ShapeFrame;
  /** The OMBR (the main rectangle for `rectangle`). */
  readonly ombr: FrameRect;
  /** The rectangles covering the footprint (one for `rectangle`, none for `irregular`). */
  readonly rects: readonly FrameRect[];
}

/** Fill of the OMBR above which a footprint counts as a rectangle. */
export const RECTANGLE_FILL = 0.9;
/** Edges within this of the frame's axes count as square to it, degrees. */
const SQUARE_TOLERANCE_DEG = 12;
/** Coordinates closer than this are merged when gridding a rectilinear footprint, metres. */
const SNAP_M = 0.6;
/** At most this many rectangles cover a rectilinear footprint. */
const MAX_RECTS = 4;
/** Each rectangle at least this wide, metres. */
const MIN_RECT_M = 2.5;

export const toLocal = (f: ShapeFrame, p: Vec2) => {
  const dx = p.x - f.ox;
  const dy = p.y - f.oy;
  return { s: dx * f.ux + dy * f.uy, t: -dx * f.uy + dy * f.ux };
};
export const toWorld = (f: ShapeFrame, s: number, t: number): Vec2 => ({
  x: f.ox + s * f.ux - t * f.uy,
  y: f.oy + s * f.uy + t * f.ux,
});

export function signedArea(ring: readonly Vec2[]): number {
  let a = 0;
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length] ?? p;
    a += p.x * q.y - q.x * p.y;
  });
  return a / 2;
}

/** The ring counter-clockwise, without a closing duplicate, near-duplicate and near-collinear corners removed. */
export function cleanRing(footprint: readonly Vec2[]): Vec2[] {
  let ring = [...footprint];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && ring.length > 3 && first.x === last.x && first.y === last.y) ring.pop();
  if (signedArea(ring) < 0) ring.reverse();
  // Drop corners within 5 cm of the previous one, then corners whose turn is under 4°.
  ring = ring.filter((p, i) => {
    const prev = ring[(i + ring.length - 1) % ring.length] ?? p;
    return i === 0 || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.05;
  });
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length && ring.length > 3; i += 1) {
      const a = ring[(i + ring.length - 1) % ring.length] ?? { x: 0, y: 0 };
      const b = ring[i] ?? a;
      const c = ring[(i + 1) % ring.length] ?? b;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      if (Math.abs(Math.atan2(cross, dot)) < (4 * Math.PI) / 180) {
        ring.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return ring;
}

/** The oriented minimum bounding rectangle, testing every edge direction. */
export function ombr(ring: readonly Vec2[]): { frame: ShapeFrame; rect: FrameRect } {
  let best: { area: number; frame: ShapeFrame; rect: FrameRect } | null = null;
  const o = ring[0] ?? { x: 0, y: 0 };
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i] ?? o;
    const b = ring[(i + 1) % ring.length] ?? a;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const frame = { ox: o.x, oy: o.y, ux: (b.x - a.x) / len, uy: (b.y - a.y) / len };
    let s0 = Infinity;
    let s1 = -Infinity;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const p of ring) {
      const { s, t } = toLocal(frame, p);
      s0 = Math.min(s0, s);
      s1 = Math.max(s1, s);
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
    const area = (s1 - s0) * (t1 - t0);
    // Ties (parallel edges) keep the first: deterministic.
    if (!best || area < best.area - 1e-9) best = { area, frame, rect: { s0, s1, t0, t1 } };
  }
  if (!best) throw new RangeError('a footprint needs at least two distinct corners');
  const { frame, rect } = best;
  return { frame, rect };
}

/** Analyses a footprint for roofing. */
export function footprintShape(footprint: readonly Vec2[]): FootprintShape {
  const ring = cleanRing(footprint);
  const area = signedArea(ring);
  const { frame, rect } = ombr(ring);
  const fill = area / ((rect.s1 - rect.s0) * (rect.t1 - rect.t0));
  if (ring.length >= 3 && fill >= RECTANGLE_FILL) {
    return { kind: 'rectangle', ring, area, frame, ombr: rect, rects: [rect] };
  }
  const rects = rectilinearCover(ring, frame);
  return rects
    ? { kind: 'rectilinear', ring, area, frame, ombr: rect, rects }
    : { kind: 'irregular', ring, area, frame, ombr: rect, rects: [] };
}

/**
 * Up to `MAX_RECTS` rectangles (in the frame), each inside the footprint,
 * together covering it: for footprints whose edges are all square to the
 * frame. Greedy on a grid of the footprint's own coordinates: each step takes
 * the rectangle covering most of what is still uncovered (overlaps allowed,
 * as cross-gabled roofs overlap). Null when the footprint is not rectilinear,
 * or needs more rectangles.
 */
export function rectilinearCover(ring: readonly Vec2[], frame: ShapeFrame): FrameRect[] | null {
  if (ring.length < 4 || ring.length > 20) return null;
  const local = ring.map((p) => toLocal(frame, p));
  const tol = Math.sin((SQUARE_TOLERANCE_DEG * Math.PI) / 180);
  for (let i = 0; i < local.length; i += 1) {
    const a = local[i] ?? { s: 0, t: 0 };
    const b = local[(i + 1) % local.length] ?? a;
    const len = Math.hypot(b.s - a.s, b.t - a.t);
    if (len < 1e-6) continue;
    const across = Math.min(Math.abs(b.s - a.s), Math.abs(b.t - a.t)) / len;
    if (across > tol) return null;
  }
  const snap = (values: number[]) => {
    const sorted = [...values].sort((x, y) => x - y);
    const out: number[] = [];
    for (const v of sorted) {
      const lastV = out[out.length - 1];
      if (lastV === undefined || v - lastV > SNAP_M) out.push(v);
    }
    return out;
  };
  const ss = snap(local.map((p) => p.s));
  const ts = snap(local.map((p) => p.t));
  const nx = ss.length - 1;
  const ny = ts.length - 1;
  if (nx < 1 || ny < 1) return null;
  const poly = local.map((p) => ({ x: p.s, y: p.t }));
  const inside: boolean[] = [];
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const cs = ((ss[i] ?? 0) + (ss[i + 1] ?? 0)) / 2;
      const ct = ((ts[j] ?? 0) + (ts[j + 1] ?? 0)) / 2;
      inside.push(pointInPolygon({ x: cs, y: ct }, poly));
    }
  }
  const cellArea = (i: number, j: number) =>
    ((ss[i + 1] ?? 0) - (ss[i] ?? 0)) * ((ts[j + 1] ?? 0) - (ts[j] ?? 0));
  const covered = inside.map(() => false);
  const rects: FrameRect[] = [];
  while (rects.length < MAX_RECTS && covered.some((c, k) => !c && inside[k])) {
    let best: {
      gain: number;
      area: number;
      i0: number;
      i1: number;
      j0: number;
      j1: number;
    } | null = null;
    for (let i0 = 0; i0 < nx; i0 += 1) {
      for (let i1 = i0; i1 < nx; i1 += 1) {
        for (let j0 = 0; j0 < ny; j0 += 1) {
          for (let j1 = j0; j1 < ny; j1 += 1) {
            let ok = true;
            let gain = 0;
            let area = 0;
            for (let j = j0; j <= j1 && ok; j += 1) {
              for (let i = i0; i <= i1; i += 1) {
                const k = j * nx + i;
                if (!inside[k]) {
                  ok = false;
                  break;
                }
                const a = cellArea(i, j);
                area += a;
                if (!covered[k]) gain += a;
              }
            }
            if (!ok || gain <= 0) continue;
            const w = (ss[i1 + 1] ?? 0) - (ss[i0] ?? 0);
            const h = (ts[j1 + 1] ?? 0) - (ts[j0] ?? 0);
            if (Math.min(w, h) < MIN_RECT_M) continue;
            if (
              !best ||
              gain > best.gain + 1e-9 ||
              (Math.abs(gain - best.gain) <= 1e-9 && area > best.area)
            ) {
              best = { gain, area, i0, i1, j0, j1 };
            }
          }
        }
      }
    }
    if (!best) return null;
    for (let j = best.j0; j <= best.j1; j += 1) {
      for (let i = best.i0; i <= best.i1; i += 1) covered[j * nx + i] = true;
    }
    rects.push({
      s0: ss[best.i0] ?? 0,
      s1: ss[best.i1 + 1] ?? 0,
      t0: ts[best.j0] ?? 0,
      t1: ts[best.j1 + 1] ?? 0,
    });
  }
  // Every cell inside must be covered (tiny uncovered slivers are allowed).
  let missing = 0;
  inside.forEach((v, k) => {
    if (v && !covered[k]) missing += cellArea(k % nx, Math.floor(k / nx));
  });
  const total = inside.reduce((s, v, k) => s + (v ? cellArea(k % nx, Math.floor(k / nx)) : 0), 0);
  return missing <= 0.02 * total && rects.length > 0 ? rects : null;
}
