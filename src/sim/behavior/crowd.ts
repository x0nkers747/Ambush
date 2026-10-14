import type { Soldier } from '../state';

// Personal space (docs/behavior-lab/03 §7.3): Marines closer than
// `personalSpace` ease apart. Positions are read from a snapshot taken at the
// start of the substep, so the order Marines are moved in changes nothing;
// neighbours come from a uniform grid of buckets filled in soldier order.

const BUCKETS = 4096;
const seen = new Int32Array(9);

/** Active soldiers' positions at one moment, bucketed for neighbour queries. */
export interface Crowd {
  readonly x: Float64Array;
  readonly y: Float64Array;
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
    present: new Uint8Array(count),
    head: new Int32Array(BUCKETS),
    next: new Int32Array(count),
    cell,
  };
}

function bucket(cx: number, cy: number): number {
  return (Math.imul(cx, 73_856_093) ^ Math.imul(cy, 19_349_663)) & (BUCKETS - 1);
}

/** Fills `crowd` with the soldiers' current positions. */
export function fillCrowd(
  crowd: Crowd,
  soldiers: readonly Pick<Soldier, 'position' | 'status'>[],
): void {
  crowd.head.fill(-1);
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
 * The velocity (m/s) easing soldier `i` away from those within `space`
 * metres: each pushes in proportion to how far inside his space it is; the
 * sum is capped at `speed`. Two soldiers on the same spot part along x, by
 * index.
 */
export function separation(
  crowd: Crowd,
  i: number,
  space: number,
  speed: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  out.x = 0;
  out.y = 0;
  const xi = crowd.x[i] ?? 0;
  const yi = crowd.y[i] ?? 0;
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
        const dx = xi - (crowd.x[j] ?? 0);
        const dy = yi - (crowd.y[j] ?? 0);
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r >= space) continue;
        const w = (space - r) / space;
        if (r > 1e-9) {
          out.x += (dx / r) * w;
          out.y += (dy / r) * w;
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
