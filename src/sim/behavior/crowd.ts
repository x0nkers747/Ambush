import type { Soldier } from '../state';

// Personal space (docs/behavior-lab/03 §7.3), anticipated: a Marine eases
// away from anyone who will come within `personalSpace` of him in the next
// `horizon` seconds at their present velocities, the sooner the harder (a
// time-to-collision rule, after Karamouzas, Skinner & Guy 2014). Two meeting
// head-on each step to their own right. Positions and velocities are read
// from a snapshot taken at the start of the substep, so the order Marines
// are moved in changes nothing; neighbours come from a uniform grid of
// buckets filled in soldier order.

const BUCKETS = 4096;
const seen = new Int32Array(9);
const scratch = { x: 0, y: 0 };
/** How far ahead the rule looks (s). */
export const AVOID_HORIZON_S = 1;
/** Neighbours are looked for within this (m): personal space plus two walkers closing for the horizon. */
export const CROWD_CELL_M = 6;

/** Active soldiers' positions at one moment, bucketed for neighbour queries. */
export interface Crowd {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** Whether soldier i takes up space (active). */
  readonly present: Uint8Array;
  readonly head: Int32Array;
  readonly next: Int32Array;
  readonly cell: number;
}

/** A crowd for `count` soldiers (reused across substeps). */
export function createCrowd(count: number, cell: number): Crowd {
  return {
    x: new Float64Array(count),
    y: new Float64Array(count),
    vx: new Float64Array(count),
    vy: new Float64Array(count),
    present: new Uint8Array(count),
    head: new Int32Array(BUCKETS),
    next: new Int32Array(count),
    cell,
  };
}

function bucket(cx: number, cy: number): number {
  return (Math.imul(cx, 73_856_093) ^ Math.imul(cy, 19_349_663)) & (BUCKETS - 1);
}

/**
 * Fills `crowd` with the soldiers' current positions, and the velocities
 * of those steered by a task (`velocity`, by soldier index; others count as standing).
 */
export function fillCrowd(
  crowd: Crowd,
  soldiers: readonly Pick<Soldier, 'position' | 'status'>[],
  velocity?: (i: number, out: { x: number; y: number }) => void,
): void {
  crowd.head.fill(-1);
  crowd.vx.fill(0);
  crowd.vy.fill(0);
  if (velocity) {
    for (let i = 0; i < soldiers.length; i += 1) {
      velocity(i, scratch);
      crowd.vx[i] = scratch.x;
      crowd.vy[i] = scratch.y;
    }
  }
  for (let i = 0; i < soldiers.length; i += 1) {
    const s = soldiers[i];
    if (!s) continue;
    crowd.x[i] = s.position.x;
    crowd.y[i] = s.position.y;
    const present = s.status === 'active';
    crowd.present[i] = present ? 1 : 0;
    if (!present) continue;
    const b = bucket(Math.floor(s.position.x / crowd.cell), Math.floor(s.position.y / crowd.cell));
    crowd.next[i] = crowd.head[b] ?? -1;
    crowd.head[b] = i;
  }
}

/**
 * The velocity (m/s) easing soldier `i` away from those who will come
 * within `space` metres of him within `horizon` s: each pushes from the
 * point of closest approach, in proportion to how far inside his space that
 * is and how soon it comes; the sum is capped at `speed`.
 */
export function separation(
  crowd: Crowd,
  i: number,
  space: number,
  speed: number,
  out: { x: number; y: number },
  horizon = AVOID_HORIZON_S,
): { x: number; y: number } {
  out.x = 0;
  out.y = 0;
  const xi = crowd.x[i] ?? 0;
  const yi = crowd.y[i] ?? 0;
  const vxi = crowd.vx[i] ?? 0;
  const vyi = crowd.vy[i] ?? 0;
  const cx = Math.floor(xi / crowd.cell);
  const cy = Math.floor(yi / crowd.cell);
  let seenCount = 0;
  for (let ox = -1; ox <= 1; ox += 1) {
    for (let oy = -1; oy <= 1; oy += 1) {
      // Distinct cells may share a bucket: visit each bucket once.
      const b = bucket(cx + ox, cy + oy);
      let visited = false;
      for (let k = 0; k < seenCount; k += 1) if (seen[k] === b) visited = true;
      if (visited) continue;
      seen[seenCount] = b;
      seenCount += 1;
      for (let j = crowd.head[b] ?? -1; j >= 0; j = crowd.next[j] ?? -1) {
        if (j === i) continue;
        const px = xi - (crowd.x[j] ?? 0);
        const py = yi - (crowd.y[j] ?? 0);
        if (px * px + py * py >= crowd.cell * crowd.cell) continue;
        const rvx = vxi - (crowd.vx[j] ?? 0);
        const rvy = vyi - (crowd.vy[j] ?? 0);
        const vv = rvx * rvx + rvy * rvy;
        // Time of closest approach within the horizon, and where.
        const t = vv > 1e-9 ? Math.min(horizon, Math.max(0, -(px * rvx + py * rvy) / vv)) : 0;
        const qx = px + rvx * t;
        const qy = py + rvy * t;
        const q = Math.sqrt(qx * qx + qy * qy);
        if (q >= space) continue;
        const w = ((space - q) / space) * (1 - (0.5 * t) / horizon);
        if (q > 1e-6) {
          out.x += (qx / q) * w;
          out.y += (qy / q) * w;
        } else if (vv > 1e-9) {
          // Head-on: step to one's own right of the closing direction
          // (each sees the other's relative velocity reversed: they part).
          const v = Math.sqrt(vv);
          out.x += (rvy / v) * w;
          out.y += (-rvx / v) * w;
        } else {
          out.x += i < j ? w : -w;
        }
      }
    }
  }
  const m = Math.sqrt(out.x * out.x + out.y * out.y);
  const scale = m > 1 ? speed / m : speed;
  out.x *= scale;
  out.y *= scale;
  return out;
}
