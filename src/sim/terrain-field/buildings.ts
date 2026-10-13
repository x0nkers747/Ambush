import type { Building } from '../environment';
import type { BaseSurface } from './base';

// Building pads (research §5.6): a level pad under the footprint and a narrow
// apron round it, at the median of the ground under the footprint, with
// slopes back to the ground. Buildings are drawn down to the pad, so none
// floats or is buried.

export const PAD_APRON_M = 0.8;
const PAD_FILL = 0.6;
const PAD_CUT = 0.8;
const PAD_REACH_M = 5;
const PAD_FADE_M = 2;

export interface PadStamp {
  readonly id: string;
  /** Footprint x, y pairs (a closed ring, last point not repeated). */
  readonly xy: Float64Array;
  readonly level: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly extent: number;
}

function inside(xy: Float64Array, x: number, y: number): boolean {
  let c = false;
  const n = xy.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const xi = xy[2 * i] ?? 0;
    const yi = xy[2 * i + 1] ?? 0;
    const xj = xy[2 * j] ?? 0;
    const yj = xy[2 * j + 1] ?? 0;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Signed distance to the footprint's outline: negative inside. */
export function padDistance(pad: PadStamp, x: number, y: number): number {
  const xy = pad.xy;
  const n = xy.length / 2;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const ax = xy[2 * j] ?? 0;
    const ay = xy[2 * j + 1] ?? 0;
    const dx = (xy[2 * i] ?? 0) - ax;
    const dy = (xy[2 * i + 1] ?? 0) - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx - x;
    const py = ay + t * dy - y;
    const d2 = px * px + py * py;
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  return inside(xy, x, y) ? -d : d;
}

export function padStamps(buildings: readonly Building[], base: BaseSurface): PadStamp[] {
  const sorted = [...buildings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pads: PadStamp[] = [];
  for (const b of sorted) {
    const ring = b.footprint;
    if (ring.length < 3) continue;
    const xy = new Float64Array(ring.length * 2);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    ring.forEach((p, i) => {
      xy[2 * i] = p.x;
      xy[2 * i + 1] = p.y;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    });
    // The median ground under the footprint: corners and a 2 m grid inside.
    const heights: number[] = ring.map((p) => base.at(p.x, p.y));
    for (let x = minX + 1; x < maxX; x += 2)
      for (let y = minY + 1; y < maxY; y += 2) if (inside(xy, x, y)) heights.push(base.at(x, y));
    heights.sort((p, q) => p - q);
    const mid = heights.length >> 1;
    const level =
      heights.length % 2 === 1
        ? (heights[mid] ?? 0)
        : ((heights[mid - 1] ?? 0) + (heights[mid] ?? 0)) / 2;
    pads.push({
      id: b.id,
      xy,
      level,
      minX,
      minY,
      maxX,
      maxY,
      extent: PAD_APRON_M + PAD_REACH_M + PAD_FADE_M,
    });
  }
  return pads;
}

/** Bounds a pad puts on the ground at signed distance `d` from its footprint. */
export function padEffect(
  pad: PadStamp,
  d: number,
  out: { lo: number; hi: number; w: number; core: boolean },
): void {
  const e = d - PAD_APRON_M;
  if (e <= 0) {
    out.lo = pad.level;
    out.hi = pad.level;
    out.w = 1;
    out.core = true;
    return;
  }
  out.lo = pad.level - PAD_FILL * e;
  out.hi = pad.level + PAD_CUT * e;
  const t =
    e <= PAD_REACH_M ? 0 : e >= PAD_REACH_M + PAD_FADE_M ? 1 : (e - PAD_REACH_M) / PAD_FADE_M;
  out.w = 1 - t * t * (3 - 2 * t);
  out.core = false;
}
