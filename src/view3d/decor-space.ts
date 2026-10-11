// The room the roadside details take (docs/adr/0036): an incremental
// spatial hash of what has been placed so far, as discs (posts, trunks,
// signs) and corridors (paths and driveways, fences). Generators run in
// priority order (mapped features, access ways, poles and lamps, trees,
// small props), and each asks whether its spot is still free of what
// higher-priority generators placed, so a tree gives way to a driveway,
// never the reverse. Queries look only at nearby cells. Pure.

/** Categories of placed things, for statistics and for selective tests. */
export type SpaceKind = 'path' | 'post' | 'tree' | 'barrier' | 'prop' | 'entrance';

const CELL = 8;
const key = (i: number, j: number) => i * 100_003 + j;

export class DecorSpace {
  private readonly discs: number[] = []; // x, y, r
  private readonly discKinds: SpaceKind[] = [];
  private readonly segs: number[] = []; // ax, ay, bx, by, halfWidth
  private readonly segKinds: SpaceKind[] = [];
  private readonly discCells = new Map<number, number[]>();
  private readonly segCells = new Map<number, number[]>();
  /** The largest radius or half-width added, for how far queries look. */
  private reach = 0;

  addDisc(x: number, y: number, r: number, kind: SpaceKind): void {
    const i = this.discs.length / 3;
    this.discs.push(x, y, r);
    this.discKinds.push(kind);
    this.reach = Math.max(this.reach, r);
    const k = key(Math.floor(x / CELL), Math.floor(y / CELL));
    const list = this.discCells.get(k) ?? [];
    list.push(i);
    this.discCells.set(k, list);
  }

  addSegment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    halfWidth: number,
    kind: SpaceKind,
  ): void {
    const s = this.segs.length / 5;
    this.segs.push(ax, ay, bx, by, halfWidth);
    this.segKinds.push(kind);
    this.reach = Math.max(this.reach, halfWidth);
    for (
      let i = Math.floor((Math.min(ax, bx) - halfWidth) / CELL);
      i <= Math.floor((Math.max(ax, bx) + halfWidth) / CELL);
      i++
    ) {
      for (
        let j = Math.floor((Math.min(ay, by) - halfWidth) / CELL);
        j <= Math.floor((Math.max(ay, by) + halfWidth) / CELL);
        j++
      ) {
        const k = key(i, j);
        const list = this.segCells.get(k) ?? [];
        list.push(s);
        this.segCells.set(k, list);
      }
    }
  }

  addPolyline(
    points: readonly { x: number; y: number }[],
    halfWidth: number,
    kind: SpaceKind,
  ): void {
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (a && b) this.addSegment(a.x, a.y, b.x, b.y, halfWidth, kind);
    }
  }

  /**
   * Whether a thing of radius `r` at (x, y) keeps clear of everything placed
   * (of the given kinds, or all), discs by the sum of radii and corridors by
   * their half-width plus `r`.
   */
  free(x: number, y: number, r: number, kinds?: readonly SpaceKind[]): boolean {
    const look = Math.ceil((r + this.reach) / CELL);
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(y / CELL);
    for (let a = -look; a <= look; a += 1) {
      for (let b = -look; b <= look; b += 1) {
        for (const d of this.discCells.get(key(ci + a, cj + b)) ?? []) {
          if (kinds && !kinds.includes(this.discKinds[d] ?? 'prop')) continue;
          const dx = x - (this.discs[d * 3] ?? 0);
          const dy = y - (this.discs[d * 3 + 1] ?? 0);
          const rr = r + (this.discs[d * 3 + 2] ?? 0);
          if (dx * dx + dy * dy < rr * rr) return false;
        }
      }
    }
    for (const s of this.segCells.get(key(ci, cj)) ?? []) {
      if (kinds && !kinds.includes(this.segKinds[s] ?? 'prop')) continue;
      if (this.segmentGap(s, x, y) < r) return false;
    }
    // Corridors are bucketed by their own extent: look round for wide queries.
    if (r > 0) {
      const reach = Math.ceil(r / CELL);
      for (let a = -reach; a <= reach; a += 1) {
        for (let b = -reach; b <= reach; b += 1) {
          if (a === 0 && b === 0) continue;
          for (const s of this.segCells.get(key(ci + a, cj + b)) ?? []) {
            if (kinds && !kinds.includes(this.segKinds[s] ?? 'prop')) continue;
            if (this.segmentGap(s, x, y) < r) return false;
          }
        }
      }
    }
    return true;
  }

  /** Distance from (x, y) to the nearest corridor's edge (of the given kinds), at most `limit`. */
  corridorDistance(x: number, y: number, limit: number, kinds?: readonly SpaceKind[]): number {
    let best = limit;
    const look = Math.ceil(limit / CELL);
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(y / CELL);
    for (let a = -look; a <= look; a += 1) {
      for (let b = -look; b <= look; b += 1) {
        for (const s of this.segCells.get(key(ci + a, cj + b)) ?? []) {
          if (kinds && !kinds.includes(this.segKinds[s] ?? 'prop')) continue;
          best = Math.min(best, this.segmentGap(s, x, y));
        }
      }
    }
    return Math.max(0, best);
  }

  /** The nearest point on a corridor's centreline (of the given kinds) within `limit`, or null. */
  nearestCorridor(
    x: number,
    y: number,
    limit: number,
    kinds: readonly SpaceKind[],
  ): { x: number; y: number; distance: number } | null {
    let best: { x: number; y: number; distance: number } | null = null;
    const look = Math.ceil(limit / CELL);
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(y / CELL);
    for (let a = -look; a <= look; a += 1) {
      for (let b = -look; b <= look; b += 1) {
        for (const s of this.segCells.get(key(ci + a, cj + b)) ?? []) {
          if (!kinds.includes(this.segKinds[s] ?? 'prop')) continue;
          const p = this.closest(s, x, y);
          const d = Math.hypot(p.x - x, p.y - y);
          if (d <= limit && (!best || d < best.distance - 1e-9)) best = { ...p, distance: d };
        }
      }
    }
    return best;
  }

  private closest(s: number, x: number, y: number) {
    const ax = this.segs[s * 5] ?? 0;
    const ay = this.segs[s * 5 + 1] ?? 0;
    const dx = (this.segs[s * 5 + 2] ?? 0) - ax;
    const dy = (this.segs[s * 5 + 3] ?? 0) - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    return { x: ax + t * dx, y: ay + t * dy };
  }

  private segmentGap(s: number, x: number, y: number): number {
    const p = this.closest(s, x, y);
    return Math.hypot(x - p.x, y - p.y) - (this.segs[s * 5 + 4] ?? 0);
  }
}
