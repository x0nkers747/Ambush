import { isSimplePolygon, type EnvironmentFeatures, type Vec2 } from '#sim';

// Woods from a raster (docs/adr/0050): the mapped features drawn on a 1 m
// grid (what may not become a wood), and the woods in a mask of tree pixels
// traced as simple polygons with their clearings. Shared by tree cover from
// canopy heights (canopy.ts) and the imagery classifier (tools/tree-cover.ts).
// Pure and deterministic: the same mask gives the same woods.

/** Woods smaller than this are dropped, m². */
export const MIN_WOOD_M2 = 40;
/** Clearings at least this big are kept as holes; smaller gaps are filled, m². */
export const MIN_CLEARING_M2 = 400;
/** Mapped vegetation keeps this margin, metres: a wood traced from a raster never meets it. */
export const MAPPED_MARGIN_M = 4;

/** A 1 m grid over the battlefield: `width` × `height` cells from its south-west corner (x0, y0). */
export interface WoodGrid {
  readonly x0: number;
  readonly y0: number;
  readonly width: number;
  readonly height: number;
}

/** Fills polygons (outer rings and holes, even–odd) into `mask` with `value`. */
export function fillPolygon(
  g: WoodGrid,
  rings: readonly (readonly Vec2[])[],
  mask: Uint8Array,
  value: number,
): void {
  const { x0, y0, width: W, height: H } = g;
  let lo = Infinity;
  let hi = -Infinity;
  for (const ring of rings)
    for (const p of ring) {
      lo = Math.min(lo, p.y - y0);
      hi = Math.max(hi, p.y - y0);
    }
  const xs: number[] = [];
  for (let y = Math.max(0, Math.floor(lo)); y <= Math.min(H - 1, Math.ceil(hi)); y += 1) {
    const yc = y + 0.5;
    xs.length = 0;
    for (const ring of rings)
      ring.forEach((a, k) => {
        const b = ring[(k + 1) % ring.length] ?? a;
        const ay = a.y - y0;
        const by = b.y - y0;
        if (ay <= yc !== by <= yc) xs.push(a.x - x0 + ((yc - ay) / (by - ay)) * (b.x - a.x));
      });
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil((xs[k] ?? 0) - 0.5));
      const xb = Math.min(W - 1, Math.floor((xs[k + 1] ?? 0) - 0.5));
      mask.fill(value, y * W + xa, Math.max(y * W + xa, y * W + xb + 1));
    }
  }
}

/** Marks every cell within `half` metres of a polyline. */
export function strokeLine(
  g: WoodGrid,
  line: readonly Vec2[],
  half: number,
  mask: Uint8Array,
): void {
  const { x0, y0, width: W, height: H } = g;
  for (let k = 0; k + 1 < line.length; k += 1) {
    const a = line[k];
    const b = line[k + 1];
    if (!a || !b) continue;
    const ax = a.x - x0;
    const ay = a.y - y0;
    const bx = b.x - x0;
    const by = b.y - y0;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const ys = Math.max(0, Math.floor(Math.min(ay, by) - half));
    const ye = Math.min(H - 1, Math.ceil(Math.max(ay, by) + half));
    const xs = Math.max(0, Math.floor(Math.min(ax, bx) - half));
    const xe = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + half));
    for (let y = ys; y <= ye; y += 1)
      for (let x = xs; x <= xe; x += 1) {
        const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / l2));
        const px = ax + t * dx - x - 0.5;
        const py = ay + t * dy - y - 0.5;
        if (px * px + py * py <= half * half) mask[y * W + x] = 1;
      }
  }
}

/** Grows a mask by `radius` cells (a square), separably. */
export function dilate(g: WoodGrid, mask: Uint8Array, radius: number): Uint8Array {
  return spread(g, mask, radius, 1);
}

/** Shrinks a mask by `radius` cells (a square), separably. */
export function erode(g: WoodGrid, mask: Uint8Array, radius: number): Uint8Array {
  return spread(g, mask, radius, 0);
}

/** Dilation (`keep` 1: any set cell within reach sets) or erosion (`keep` 0: any clear cell clears). */
function spread(g: WoodGrid, mask: Uint8Array, radius: number, keep: 0 | 1): Uint8Array {
  const { width: W, height: H } = g;
  const rows = spreadLines(mask, W, H, W, 1, radius, keep);
  return spreadLines(rows, H, W, 1, W, radius, keep);
}

/** One pass of `spread`: `lines` lines of `n` cells, lines `lineStride` apart, cells `step` apart. */
function spreadLines(
  from: Uint8Array,
  n: number,
  lines: number,
  lineStride: number,
  step: number,
  radius: number,
  keep: 0 | 1,
): Uint8Array {
  const to = new Uint8Array(from.length).fill(keep ? 0 : 1);
  for (let line = 0; line < lines; line += 1) {
    const base = line * lineStride;
    let last = -Infinity;
    for (let k = 0; k < n; k += 1) {
      const i = base + k * step;
      if (from[i] === keep) last = k;
      if (k - last <= radius) to[i] = keep;
    }
    let next = Infinity;
    for (let k = n - 1; k >= 0; k -= 1) {
      const i = base + k * step;
      if (from[i] === keep) next = k;
      if (next - k <= radius) to[i] = keep;
    }
  }
  return to;
}

/** What the mapped features rule out, on the grid. */
export interface MappedMasks {
  /** Mapped vegetation (woods, scrub, tree lines). */
  readonly vegetation: Uint8Array;
  /** Mapped vegetation and `MAPPED_MARGIN_M` round it. */
  readonly nearVegetation: Uint8Array;
  /** Buildings, roads and their verges, water and paved ground: never a wood. */
  readonly blocked: Uint8Array;
}

/** The mapped features drawn on the grid. */
export function mappedMasks(g: WoodGrid, f: EnvironmentFeatures): MappedMasks {
  const n = g.width * g.height;
  const vegetation = new Uint8Array(n);
  for (const v of f.vegetation) {
    if (v.kind === 'treeLine') strokeLine(g, v.boundary, MAPPED_MARGIN_M, vegetation);
    else fillPolygon(g, [v.boundary, ...(v.holes ?? [])], vegetation, 1);
  }
  const blocked = new Uint8Array(n);
  for (const b of f.buildings) fillPolygon(g, [b.footprint], blocked, 1);
  for (const r of f.roads) strokeLine(g, r.centerline, r.widthMeters / 2 + 1, blocked);
  for (const w of f.water ?? []) if (w.kind === 'water') fillPolygon(g, [w.boundary], blocked, 1);
  for (const w of f.waterways ?? []) strokeLine(g, w.centerline, w.widthMeters / 2 + 1, blocked);
  for (const l of f.landUse ?? []) if (l.kind === 'paved') fillPolygon(g, [l.boundary], blocked, 1);
  return { vegetation, nearVegetation: dilate(g, vegetation, MAPPED_MARGIN_M), blocked };
}

type Point = [number, number];

/** A wood traced from a mask: its ring and clearings in grid metres, its cells. */
export interface TracedWood {
  readonly ring: Point[];
  readonly holes: Point[][];
  readonly areaM2: number;
  /** Its cells, as indices into the mask (clearings excluded). */
  readonly cells: readonly number[];
}

/**
 * The woods of a mask of tree cells: each 4-connected region of at least
 * `minM2` cells, its gaps under `MIN_CLEARING_M2` filled, larger ones kept
 * as clearings, traced along its cell edges and simplified, kept only as a
 * simple polygon. Coordinates are grid metres (add the grid's corner for the
 * battlefield frame).
 */
export function traceWoods(g: WoodGrid, keep: Uint8Array, minM2 = MIN_WOOD_M2): TracedWood[] {
  const { width: W, height: H } = g;
  const comp = new Int32Array(W * H).fill(-1);
  const out: TracedWood[] = [];
  const stack: number[] = [];
  const steps = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  let id = 0;
  for (let s = 0; s < W * H; s += 1) {
    if (!keep[s] || comp[s] !== -1) continue;
    id += 1;
    const cells: number[] = [];
    stack.push(s);
    comp[s] = id;
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    while (stack.length > 0) {
      const k = stack.pop() ?? 0;
      cells.push(k);
      const x = k % W;
      const y = (k - x) / W;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const [dx, dy] of steps) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx;
        if (keep[nk] && comp[nk] === -1) {
          comp[nk] = id;
          stack.push(nk);
        }
      }
    }
    if (cells.length < minM2) continue;
    // The wood in its own box, with a cell of margin.
    const w = x1 - x0 + 3;
    const h = y1 - y0 + 3;
    const m = new Uint8Array(w * h);
    for (const k of cells) {
      const x = k % W;
      m[((k - x) / W - y0 + 1) * w + (x - x0 + 1)] = 1;
    }
    // Background regions: the one at the border is outside; the rest are gaps.
    const region = new Int32Array(w * h).fill(-1);
    const gaps: number[] = [];
    for (let s2 = 0; s2 < w * h; s2 += 1) {
      if (m[s2] || region[s2] !== -1) continue;
      const rid = s2 === 0 ? 0 : gaps.length + 1;
      const queue = [s2];
      region[s2] = rid;
      let size = 0;
      while (queue.length > 0) {
        const k = queue.pop() ?? 0;
        size += 1;
        const x = k % w;
        const y = (k - x) / w;
        for (const [dx, dy] of steps) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nk = ny * w + nx;
          if (!m[nk] && region[nk] === -1) {
            region[nk] = rid;
            queue.push(nk);
          }
        }
      }
      if (rid !== 0) gaps.push(size);
    }
    const holeRegions: number[] = [];
    gaps.forEach((size, gi) => {
      if (size < MIN_CLEARING_M2) {
        for (let k = 0; k < w * h; k += 1) if (region[k] === gi + 1) m[k] = 1;
      } else holeRegions.push(gi + 1);
    });
    const toGrid = (ring: Point[]): Point[] => ring.map(([x, y]) => [x + x0 - 1, y + y0 - 1]);
    const first = (test: (k: number) => boolean): Point | null => {
      for (let k = 0; k < w * h; k += 1) if (test(k)) return [k % w, Math.floor(k / w)];
      return null;
    };
    const inWood = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
    const start = first((k) => m[k] === 1);
    const outer = start && simpleRing(toGrid(traceRing(inWood, start, 8 * w * h)));
    if (!outer) continue;
    const holes: Point[][] = [];
    for (const rid of holeRegions) {
      const inHole = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < w && y < h && region[y * w + x] === rid;
      const hs = first((k) => region[k] === rid);
      // A clearing joined only diagonally can trace badly: such clearings are left out.
      const traced = hs ? traceRing(inHole, hs, 8 * w * h) : [];
      const hole = traced.length > 0 ? simpleRing(toGrid(traced)) : null;
      if (hole) holes.push(hole);
    }
    out.push({ ring: outer, holes, areaM2: cells.length, cells });
  }
  return out;
}

/** The outline of a 4-connected region, by following its cell edges from its first cell's corner. */
function traceRing(
  inside: (x: number, y: number) => boolean,
  [sx, sy]: Point,
  limit: number,
): Point[] {
  const pts: Point[] = [];
  let px = sx;
  let py = sy;
  let dir = 0;
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const left = (x: number, y: number, d: number) =>
    d === 0
      ? inside(x, y)
      : d === 1
        ? inside(x - 1, y)
        : d === 2
          ? inside(x - 1, y - 1)
          : inside(x, y - 1);
  const right = (x: number, y: number, d: number) =>
    d === 0
      ? inside(x, y - 1)
      : d === 1
        ? inside(x, y)
        : d === 2
          ? inside(x - 1, y)
          : inside(x - 1, y - 1);
  for (let guard = 0; guard < limit; guard += 1) {
    pts.push([px, py]);
    px += DX[dir] ?? 0;
    py += DY[dir] ?? 0;
    if (px === sx && py === sy) return pts;
    if (right(px, py, dir)) dir = (dir + 3) % 4;
    else if (!left(px, py, dir)) dir = (dir + 1) % 4;
  }
  return [];
}

/** Douglas–Peucker simplification of a ring's points. */
function simplify(p: readonly Point[], tolerance: number): Point[] {
  if (p.length < 4) return [...p];
  const keep = new Uint8Array(p.length);
  keep[0] = 1;
  keep[p.length - 1] = 1;
  const stack: Point[] = [[0, p.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() ?? [0, 0];
    const [ax, ay] = p[a] ?? [0, 0];
    const [bx, by] = p[b] ?? [0, 0];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i += 1) {
      const [qx, qy] = p[i] ?? [0, 0];
      const d = Math.abs((by - ay) * (qx - ax) - (bx - ax) * (qy - ay)) / l;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

/** The ring simplified as much as it stays a simple polygon, or null. */
function simpleRing(ring: readonly Point[]): Point[] | null {
  for (const tolerance of [1.2, 2, 3]) {
    const s = simplify(ring, tolerance);
    if (s.length >= 4 && isSimplePolygon(s.map(([x, y]) => ({ x, y })))) return s;
  }
  return null;
}
