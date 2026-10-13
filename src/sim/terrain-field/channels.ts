import type { Waterway, WaterwayKind } from '../environment';
import type { WaterQuery } from '../water-grading';
import type { BaseSurface } from './base';

// Small watercourses the water grading does not level (streams, ditches and
// drains mapped as lines, ADR 0040): a channel cut into the ground along the
// line, its bed falling downstream, with water in it and banks either side.

const DEPTH: Readonly<Record<WaterwayKind, number>> = {
  river: 1.0,
  canal: 1.0,
  stream: 0.55,
  drain: 0.45,
  ditch: 0.4,
};
const WATER: Readonly<Record<WaterwayKind, number>> = {
  river: 0.4,
  canal: 0.4,
  stream: 0.22,
  drain: 0.12,
  ditch: 0.1,
};
const STEP_M = 2;
const SMOOTH = 4;
export const CHANNEL_BANK_REACH_M = 3;
const CHANNEL_BANK_FADE_M = 1.5;

export interface ChannelStamp {
  readonly id: string;
  readonly kind: WaterwayKind;
  readonly xy: Float64Array;
  readonly cum: Float64Array;
  /** Water level every `STEP_M` along it. */
  readonly level: Float64Array;
  readonly half: number;
  /** Depth of water at the centre, metres. */
  readonly water: number;
  readonly extent: number;
}

export const CHANNEL_STEP_M = STEP_M;

function pointAt(xy: Float64Array, cum: Float64Array, s: number): [number, number] {
  const n = cum.length;
  let i = 0;
  while (i < n - 2 && (cum[i + 1] ?? 0) < s) i += 1;
  const l = (cum[i + 1] ?? 0) - (cum[i] ?? 0);
  const t = l > 0 ? (s - (cum[i] ?? 0)) / l : 0;
  const ax = xy[2 * i] ?? 0;
  const ay = xy[2 * i + 1] ?? 0;
  return [ax + t * ((xy[2 * i + 2] ?? 0) - ax), ay + t * ((xy[2 * i + 3] ?? 0) - ay)];
}

export function channelLevelAt(c: ChannelStamp, s: number): number {
  const p = c.level;
  const n = p.length;
  const total = c.cum[c.cum.length - 1] ?? 0;
  const u = (s < 0 ? 0 : s > total ? total : s) / STEP_M;
  let i = Math.floor(u);
  if (i >= n - 1) i = n - 2;
  if (i < 0) return p[0] ?? 0;
  const t = u - i;
  return (p[i] ?? 0) + t * ((p[i + 1] ?? 0) - (p[i] ?? 0));
}

/** Channels for the waterways the water grading left as lines. */
export function channelStamps(
  waterways: readonly Waterway[],
  base: BaseSurface,
  water: WaterQuery | null,
): ChannelStamp[] {
  const out: ChannelStamp[] = [];
  const sorted = [...waterways].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const w of sorted) {
    const n = w.centerline.length;
    if (n < 2) continue;
    // Levelled by the water grading (a river channel or inside a water area): not ours.
    const mid = w.centerline[Math.floor(n / 2)] ?? { x: 0, y: 0 };
    if (water?.at(mid.x, mid.y)?.inWater === true) continue;
    const xy = new Float64Array(2 * n);
    const cum = new Float64Array(n);
    w.centerline.forEach((p, i) => {
      xy[2 * i] = p.x;
      xy[2 * i + 1] = p.y;
      if (i > 0) {
        const dx = p.x - (xy[2 * i - 2] ?? 0);
        const dy = p.y - (xy[2 * i - 1] ?? 0);
        cum[i] = (cum[i - 1] ?? 0) + Math.sqrt(dx * dx + dy * dy);
      }
    });
    const total = cum[n - 1] ?? 0;
    if (total < 2) continue;
    const m = Math.ceil(total / STEP_M) + 1;
    const ground = new Float64Array(m);
    for (let i = 0; i < m; i += 1) {
      const [px, py] = pointAt(xy, cum, Math.min(total, i * STEP_M));
      ground[i] = base.at(px, py);
    }
    // Smoothed ground, then the bed never rising downstream (the mapped
    // direction, unless the ground clearly runs the other way).
    const smooth = new Float64Array(m);
    for (let i = 0; i < m; i += 1) {
      const a = Math.max(0, i - SMOOTH);
      const b = Math.min(m - 1, i + SMOOTH);
      let sum = 0;
      for (let k = a; k <= b; k += 1) sum += ground[k] ?? 0;
      smooth[i] = sum / (b - a + 1);
    }
    const reverse = (smooth[m - 1] ?? 0) > (smooth[0] ?? 0) + 1;
    const depth = DEPTH[w.kind];
    const level = new Float64Array(m);
    let run = Infinity;
    for (let k = 0; k < m; k += 1) {
      const i = reverse ? m - 1 - k : k;
      const bed = (smooth[i] ?? 0) - depth;
      run = bed < run ? bed : run;
      // Never more than a metre below its own depth under the ground, and
      // never above it: a stream runs in the ground, not on a levee.
      const floor = (ground[i] ?? 0) - depth - 1;
      const own = (smooth[i] ?? 0) - depth;
      const bedAt = run < floor ? floor : run > own ? own : run;
      level[i] = bedAt + WATER[w.kind];
    }
    const half = Math.max(0.5, Math.min(4, w.widthMeters / 2));
    out.push({
      id: w.id,
      kind: w.kind,
      xy,
      cum,
      level,
      half,
      water: WATER[w.kind],
      extent: half + CHANNEL_BANK_REACH_M + CHANNEL_BANK_FADE_M,
    });
  }
  return out;
}

/** Bounds a channel puts on the ground at distance d from its line, where its water is at `level`. */
export function channelEffect(
  c: ChannelStamp,
  d: number,
  level: number,
  out: { lo: number; hi: number; w: number; core: boolean },
): void {
  if (d <= c.half) {
    const u = d / c.half;
    const z = level - c.water * (1 - u * u) - 0.04;
    out.lo = z;
    out.hi = z;
    out.w = 1;
    out.core = true;
    return;
  }
  const e = d - c.half;
  out.lo = level - 0.04 + 0.03 * e;
  out.hi = level - 0.04 + 0.55 * e;
  const t =
    e <= CHANNEL_BANK_REACH_M
      ? 0
      : e >= CHANNEL_BANK_REACH_M + CHANNEL_BANK_FADE_M
        ? 1
        : (e - CHANNEL_BANK_REACH_M) / CHANNEL_BANK_FADE_M;
  out.w = 1 - t * t * (3 - 2 * t);
  out.core = false;
}
