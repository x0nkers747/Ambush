import type { Vec2, Vec3 } from './geometry';
import { queryFeatures, type PreparedBuilding, type PreparedVegetation } from './los';
import type { TerrainDataset } from './terrain';
import { isRefinedAt, refinementIndex, sampleSurface, typedSamples } from './terrain-surface';

// A fast sight-line tracer for viewsheds (docs/adr/0020). It decides exactly
// what `traceSightLine` decides (obstructed or not) for every sight line: every
// value a decision depends on is computed with the same floating-point
// operations, in the same order. It does far less work:
//
// - It walks the line from the eye and stops at the first obstruction.
//   `traceSightLine` computes and sorts every cut point of the whole line
//   first; most viewshed cells are hidden, often close to the observer.
// - Cut points come in increasing order without sorting: the terrain grid
//   lines and diagonals are three arithmetic sequences, merged on the fly.
// - Feature edges and features come from a bucket index, loaded only as the
//   walk reaches each bucket, instead of every feature whose bounding box
//   overlaps the line's.
// - Point-in-polygon tests look only at the polygon edges whose y-range can
//   contain the point (an index by horizontal band), which are the only edges
//   that can change the reference's answer.
//
// `traceSightLine` stays the reference, and the only tracer combat uses. Tests
// check that the two agree on every cell of full viewsheds.

/** Bucket size of the feature and edge index, in metres. */
const BUCKET_M = 32;
/** Features and edges are indexed in every bucket their box comes within this distance of. */
const INDEX_MARGIN_M = 1;
/** Widening of feature boxes, in metres, and of their parameter ranges along a line. */
const BOX_EPSILON_M = 1e-6;
const T_EPSILON = 1e-9;
/** `nextCut` sources besides the terrain sequences. */
const END = -1;
const PENDING = -2;
/** Polygons with more vertices than this get a band index and a raster for point-in-polygon tests. */
const BANDED_MIN_VERTICES = 12;
/** Raster cell size, and how far every edge must stay from a cell for the raster to answer, in metres. */
const RASTER_M = 4;
const RASTER_MARGIN_M = 0.25;
/** Polygons whose box would need more raster cells than this use the band index only. */
const RASTER_MAX_CELLS = 4_000_000;

/**
 * Margin of an obstruction proof, in metres: how far the ground must rise above
 * the sight line, or how far inside a building and below its roof the line
 * must pass. Far larger than any rounding (around 1e-10 m on a 5 km map), so
 * a proof never depends on rounding.
 */
export const PROOF_MARGIN_M = 0.01;

/**
 * What obstructed a sight line, kept to prove neighbouring sight lines
 * obstructed without tracing them (`provesBlocked`). Mutable, reused.
 */
export interface Obstruction {
  /** 0 none (the line was clear), 1 terrain, 2 building, 3 vegetation. */
  kind: 0 | 1 | 2 | 3;
  /**
   * Where the obstruction began: terrain, the deepest point of the ground
   * above the line nearby; building, where the line entered it; vegetation,
   * where the obscuration that ended the line began.
   */
  x: number;
  y: number;
  /** Where the line was found obstructed. */
  hx: number;
  hy: number;
  /** Building: its index. */
  building: number;
}

export const noObstruction = (): Obstruction => ({
  kind: 0,
  x: 0,
  y: 0,
  hx: 0,
  hy: 0,
  building: 0,
});

export interface SightLineTracer {
  /**
   * Whether the sight line from eye `a` to target `b` (as for
   * `traceSightLine`: map coordinates and elevations, distinct in X/Y) is
   * obstructed. Always `traceSightLine(terrain, a, b) !== null`. When
   * `obstruction` is given, records what obstructed it.
   */
  blocked(a: Vec3, b: Vec3, obstruction?: Obstruction): boolean;
  /**
   * How many of the sight lines from eye `a` to the points (`x`, `y`,
   * `zs[i]`) are clear: exactly the number of `zs` for which `blocked` is
   * false, in one walk of their common map path.
   */
  clearCount(a: Vec3, x: number, y: number, zs: readonly number[]): number;
  /**
   * Whether the terrain or building obstruction of another sight line proves
   * this one obstructed too, at a glance: a point of this line where the
   * ground stands at least `PROOF_MARGIN_M` above it, or where it passes that
   * far inside the building and below its roof. Either makes
   * `traceSightLine` report an obstruction there or earlier. `false` proves
   * nothing.
   */
  provesQuickly(a: Vec3, b: Vec3, obstruction: Obstruction): boolean;
  /**
   * Whether walking this line through the stretch where another was
   * obstructed finds an obstruction. The walk finds only obstructions the
   * reference finds too (see `walk`). `false` proves nothing.
   */
  provesByWalking(a: Vec3, b: Vec3, obstruction: Obstruction): boolean;
}

const tracers = new WeakMap<TerrainDataset, SightLineTracer>();

/** The tracer for a terrain, built once per terrain object. */
export function sightLineTracer(terrain: TerrainDataset): SightLineTracer {
  let tracer = tracers.get(terrain);
  if (!tracer) {
    tracer = createTracer(terrain);
    tracers.set(terrain, tracer);
  }
  return tracer;
}

/**
 * `pointInPolygon` (boundary points inside, even-odd elsewhere) over only the
 * edges whose closed y-range may contain the point: any other edge can be
 * neither on the boundary at the point nor counted by the even-odd rule.
 */
type PolygonTest = (x: number, y: number) => boolean;

function polygonTest(vertices: readonly Vec2[]): PolygonTest {
  const n = vertices.length;
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const bx = new Float64Array(n);
  const by = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    ax[i] = a?.x ?? Number.NaN;
    ay[i] = a?.y ?? Number.NaN;
    bx[i] = b?.x ?? Number.NaN;
    by[i] = b?.y ?? Number.NaN;
  }
  // Exactly `onSegment(p, a, b)` and the even-odd step of `pointInPolygon` for edge i.
  const onEdge = (i: number, x: number, y: number) => {
    const x0 = ax[i] ?? 0;
    const y0 = ay[i] ?? 0;
    const x1 = bx[i] ?? 0;
    const y1 = by[i] ?? 0;
    return (
      (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0) === 0 &&
      x >= Math.min(x0, x1) &&
      x <= Math.max(x0, x1) &&
      y >= Math.min(y0, y1) &&
      y <= Math.max(y0, y1)
    );
  };
  const crosses = (i: number, x: number, y: number) => {
    const x0 = ax[i] ?? 0;
    const y0 = ay[i] ?? 0;
    const x1 = bx[i] ?? 0;
    const y1 = by[i] ?? 0;
    return y0 > y !== y1 > y && x0 + ((y - y0) * (x1 - x0)) / (y1 - y0) > x;
  };
  if (n <= BANDED_MIN_VERTICES) {
    return (x, y) => {
      // One pass: any edge through the point decides; otherwise the parity.
      let inside = false;
      for (let i = 0; i < n; i += 1) {
        if (onEdge(i, x, y)) return true;
        if (crosses(i, x, y)) inside = !inside;
      }
      return inside;
    };
  }
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    minY = Math.min(minY, ay[i] ?? Infinity);
    maxY = Math.max(maxY, ay[i] ?? -Infinity);
  }
  const bandCount = Math.max(1, Math.ceil(n / 4));
  const bandHeight = (maxY - minY) / bandCount || 1;
  const bandOf = (y: number) => Math.floor((y - minY) / bandHeight);
  const lists: number[][] = Array.from({ length: bandCount }, () => []);
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, bandOf(Math.min(ay[i] ?? 0, by[i] ?? 0)) - 1);
    const hi = Math.min(bandCount - 1, bandOf(Math.max(ay[i] ?? 0, by[i] ?? 0)) + 1);
    for (let k = lo; k <= hi; k += 1) lists[k]?.push(i);
  }
  const bands = lists.map((l) => Int32Array.from(l));
  const exact = (x: number, y: number): boolean => {
    // Outside the polygon's y-range no edge's closed y-range contains y.
    if (!(y >= minY && y <= maxY)) return false;
    const band = bands[Math.min(bandCount - 1, Math.max(0, bandOf(y)))];
    if (!band) return false;
    for (const i of band) if (onEdge(i, x, y)) return true;
    let inside = false;
    for (const i of band) if (crosses(i, x, y)) inside = !inside;
    return inside;
  };

  // A raster of the polygon's box: cells no edge comes within RASTER_MARGIN_M
  // of are wholly inside or wholly outside, and the exact test, which is exact
  // that far from every edge, gives the same answer anywhere in them.
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < n; i += 1) {
    minX = Math.min(minX, ax[i] ?? Infinity);
    maxX = Math.max(maxX, ax[i] ?? -Infinity);
  }
  const cols = Math.ceil((maxX - minX) / RASTER_M) + 1;
  const rasterRows = Math.ceil((maxY - minY) / RASTER_M) + 1;
  if (!(cols * rasterRows <= RASTER_MAX_CELLS)) return exact;
  /** 0 near an edge (use the exact test), 1 outside, 2 inside. */
  const raster = new Uint8Array(cols * rasterRows);
  const near = new Uint8Array(cols * rasterRows);
  for (let i = 0; i < n; i += 1) {
    const x0 = ax[i] ?? 0;
    const y0 = ay[i] ?? 0;
    const x1 = bx[i] ?? 0;
    const y1 = by[i] ?? 0;
    const c0 = Math.max(0, Math.floor((Math.min(x0, x1) - RASTER_MARGIN_M - minX) / RASTER_M));
    const c1 = Math.min(
      cols - 1,
      Math.floor((Math.max(x0, x1) + RASTER_MARGIN_M - minX) / RASTER_M),
    );
    const r0 = Math.max(0, Math.floor((Math.min(y0, y1) - RASTER_MARGIN_M - minY) / RASTER_M));
    const r1 = Math.min(
      rasterRows - 1,
      Math.floor((Math.max(y0, y1) + RASTER_MARGIN_M - minY) / RASTER_M),
    );
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        // Does the edge pass through the cell grown by the margin? (Liang–Barsky clip.)
        const cx0 = minX + c * RASTER_M - RASTER_MARGIN_M;
        const cy0 = minY + r * RASTER_M - RASTER_MARGIN_M;
        const size = RASTER_M + 2 * RASTER_MARGIN_M;
        let lo = 0;
        let hi = 1;
        const ex = x1 - x0;
        const ey = y1 - y0;
        const clip = (p: number, q: number) => {
          if (p === 0) {
            if (q < 0) hi = -1;
            return;
          }
          const t = q / p;
          if (p < 0) lo = Math.max(lo, t);
          else hi = Math.min(hi, t);
        };
        clip(-ex, x0 - cx0);
        clip(ex, cx0 + size - x0);
        clip(-ey, y0 - cy0);
        clip(ey, cy0 + size - y0);
        if (lo <= hi) near[r * cols + c] = 1;
      }
    }
  }
  for (let r = 0; r < rasterRows; r += 1) {
    let state = 0;
    for (let c = 0; c < cols; c += 1) {
      const k = r * cols + c;
      if (near[k]) {
        state = 0;
        continue;
      }
      // A run of cells with no edge between them shares one answer.
      if (state === 0) {
        state = exact(minX + (c + 0.5) * RASTER_M, minY + (r + 0.5) * RASTER_M) ? 2 : 1;
      }
      raster[k] = state;
    }
  }
  return (x, y) => {
    const c = Math.floor((x - minX) / RASTER_M);
    const r = Math.floor((y - minY) / RASTER_M);
    if (c >= 0 && c < cols && r >= 0 && r < rasterRows) {
      const state = raster[r * cols + c];
      if (state === 1) return false;
      if (state === 2) return true;
    }
    return exact(x, y);
  };
}

/** Whether (x, y) lies within `PROOF_MARGIN_M` of an edge of the polygon. */
function nearEdge(polygon: readonly Vec2[], x: number, y: number): boolean {
  for (let k = 0; k < polygon.length; k += 1) {
    const p = polygon[k];
    const q = polygon[(k + 1) % polygon.length];
    if (!p || !q) continue;
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const lengthSq = ex * ex + ey * ey;
    const u =
      lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - p.x) * ex + (y - p.y) * ey) / lengthSq));
    const ox = p.x + u * ex - x;
    const oy = p.y + u * ey - y;
    if (ox * ox + oy * oy < PROOF_MARGIN_M * PROOF_MARGIN_M) return true;
  }
  return false;
}

interface Feature {
  readonly box: PreparedBuilding['box'];
  readonly test: PolygonTest;
  readonly holes: readonly PolygonTest[];
}

function createTracer(terrain: TerrainDataset): SightLineTracer {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const elevations = Float64Array.from(terrain.heightfield.elevations);
  // Refined cells (docs/adr/0032): their fine lines are cuts too, and the
  // ground there is the fine surface.
  const refinementSource = refinementIndex(terrain);
  const refinement = refinementSource
    ? { ...refinementSource, samples: typedSamples(refinementSource.samples) }
    : null;
  const fineFactor = refinement?.factor ?? 1;
  /** Terrain cut sequences: coarse x, y, diagonal, then the fine ones where refined. */
  const sequenceCount = refinement ? 6 : 3;
  const maxX = originX + (columns - 1) * cellSize;
  const maxY = originY + (rows - 1) * cellSize;
  const { buildings, vegetation } = queryFeatures(terrain);
  const nb = buildings.length;
  const featureCount = nb + vegetation.length;
  const features: Feature[] = [
    ...buildings.map((f) => ({ box: f.box, test: polygonTest(f.polygon), holes: [] })),
    ...vegetation.map((f) => ({
      box: f.box,
      test: polygonTest(f.polygon),
      holes: f.holes.map(polygonTest),
    })),
  ];

  // Every polygon edge, in the reference's order (buildings, then each
  // vegetation boundary followed by its holes).
  const edgeList: [Vec2, Vec2][] = [];
  const addEdges = (polygon: readonly Vec2[]) => {
    for (let k = 0; k < polygon.length; k += 1) {
      const p = polygon[k];
      const q = polygon[(k + 1) % polygon.length];
      if (p && q) edgeList.push([p, q]);
    }
  };
  for (const f of buildings) addEdges(f.polygon);
  for (const f of vegetation) {
    addEdges(f.polygon);
    for (const hole of f.holes) addEdges(hole);
  }
  const edgeCount = edgeList.length;
  const px = new Float64Array(edgeCount);
  const py = new Float64Array(edgeCount);
  const qx = new Float64Array(edgeCount);
  const qy = new Float64Array(edgeCount);
  edgeList.forEach(([p, q], i) => {
    px[i] = p.x;
    py[i] = p.y;
    qx[i] = q.x;
    qy[i] = q.y;
  });

  // Bucket index (CSR): features by bounding box, edges by their own box.
  const bucketCols = Math.max(1, Math.ceil((maxX - originX) / BUCKET_M));
  const bucketRows = Math.max(1, Math.ceil((maxY - originY) / BUCKET_M));
  const buckets = bucketCols * bucketRows;
  const clampC = (v: number) => Math.min(bucketCols - 1, Math.max(0, v));
  const clampR = (v: number) => Math.min(bucketRows - 1, Math.max(0, v));
  const index = (count: number, boxOf: (i: number) => [number, number, number, number]) => {
    const ranges = Array.from({ length: count }, (_, i) => {
      const [x0, y0, x1, y1] = boxOf(i);
      return [
        clampC(Math.floor((x0 - INDEX_MARGIN_M - originX) / BUCKET_M)),
        clampR(Math.floor((y0 - INDEX_MARGIN_M - originY) / BUCKET_M)),
        clampC(Math.floor((x1 + INDEX_MARGIN_M - originX) / BUCKET_M)),
        clampR(Math.floor((y1 + INDEX_MARGIN_M - originY) / BUCKET_M)),
      ] as const;
    });
    const starts = new Int32Array(buckets + 1);
    for (const [c0, r0, c1, r1] of ranges)
      for (let r = r0; r <= r1; r += 1)
        for (let c = c0; c <= c1; c += 1) {
          const k = r * bucketCols + c + 1;
          starts[k] = (starts[k] ?? 0) + 1;
        }
    for (let i = 1; i <= buckets; i += 1) starts[i] = (starts[i] ?? 0) + (starts[i - 1] ?? 0);
    const items = new Int32Array(starts[buckets] ?? 0);
    const fill = Int32Array.from(starts);
    ranges.forEach(([c0, r0, c1, r1], i) => {
      for (let r = r0; r <= r1; r += 1)
        for (let c = c0; c <= c1; c += 1) {
          const k = r * bucketCols + c;
          items[fill[k] ?? 0] = i;
          fill[k] = (fill[k] ?? 0) + 1;
        }
    });
    return { starts, items };
  };
  const featureIndex = index(featureCount, (i) => {
    const box = features[i]?.box;
    return box ? [box.minX, box.minY, box.maxX, box.maxY] : [0, 0, -1, -1];
  });
  const edgeIndex = index(edgeCount, (i) => [
    Math.min(px[i] ?? 0, qx[i] ?? 0),
    Math.min(py[i] ?? 0, qy[i] ?? 0),
    Math.max(px[i] ?? 0, qx[i] ?? 0),
    Math.max(py[i] ?? 0, qy[i] ?? 0),
  ]);

  // --- Per-line state, reused ---------------------------------------------------
  const featureStamp = new Int32Array(featureCount);
  const edgeStamp = new Int32Array(edgeCount);
  let line = 0;
  let ax = 0;
  let ay = 0;
  let az = 0;
  let bx = 0;
  let by = 0;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  // Feature cuts known so far, sorted, consumed from the head.
  let pending = new Float64Array(256);
  let head = 0;
  let tail = 0;
  // Terrain cut sequences: v0, v1, next k, last k, step, current t.
  const v0s = new Float64Array(6);
  const v1s = new Float64Array(6);
  const kNext = new Float64Array(6);
  const kLast = new Float64Array(6);
  const kStep = new Float64Array(6);
  const seqT = new Float64Array(6);
  // Bucket walk.
  let bc = 0;
  let br = 0;
  let stepC = 0;
  let stepR = 0;
  let tMaxC = 0;
  let tMaxR = 0;
  let tDeltaC = 0;
  let tDeltaR = 0;
  let nextBucketT = 0;
  let endTaken = false;
  // Candidate features: waiting (by entry t) and active (by feature id, the reference's order).
  let candEnter = new Float64Array(256);
  let candExit = new Float64Array(256);
  let candId = new Int32Array(256);
  let candCount = 0;
  const waiting: number[] = [];
  const active: number[] = [];
  const inBuildings: PreparedBuilding[] = [];
  const inVegetation: PreparedVegetation[] = [];

  // Exactly `heightAt` (the same function), on the copied samples.
  const ground = (x: number, y: number): number => {
    if (!(x >= originX && x <= maxX && y >= originY && y <= maxY)) {
      throw new RangeError(`(${String(x)}, ${String(y)}) is outside the terrain`);
    }
    return sampleSurface(terrain.heightfield, elevations, refinement, x, y);
  };

  const pushPending = (t: number) => {
    // A cut at or before the start of the walk changes nothing after it (a cut
    // at 0 equals the first cut, which the reference skips).
    if (!(t > tMin)) return;
    if (tail === pending.length) {
      const live = pending.subarray(head, tail);
      const bigger = new Float64Array(Math.max(256, live.length * 2));
      bigger.set(live);
      pending = bigger;
      tail -= head;
      head = 0;
    }
    let i = tail;
    while (i > head && (pending[i - 1] ?? 0) > t) {
      pending[i] = pending[i - 1] ?? 0;
      i -= 1;
    }
    pending[i] = t;
    tail += 1;
  };

  /** Exactly `segmentIntersectionParams(a, b, p, q)` for edge e, pushing its results. */
  const edgeCrossings = (e: number) => {
    const ex = (qx[e] ?? 0) - (px[e] ?? 0);
    const ey = (qy[e] ?? 0) - (py[e] ?? 0);
    const denom = dx * ey - dy * ex;
    const wx = (px[e] ?? 0) - ax;
    const wy = (py[e] ?? 0) - ay;
    if (denom !== 0) {
      const s = (wx * ey - wy * ex) / denom;
      const u = (wx * dy - wy * dx) / denom;
      if (s >= 0 && s <= 1 && u >= 0 && u <= 1) pushPending(s);
      return;
    }
    if (wx * dy - wy * dx !== 0) return;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return; // a sight line always has length
    const sp = (wx * dx + wy * dy) / lengthSq;
    const sq = (((qx[e] ?? 0) - ax) * dx + ((qy[e] ?? 0) - ay) * dy) / lengthSq;
    const lo = Math.max(0, Math.min(sp, sq));
    const hi = Math.min(1, Math.max(sp, sq));
    if (lo > hi) return;
    pushPending(lo);
    if (lo !== hi) pushPending(hi);
  };

  const addCandidate = (id: number, tEnter: number, tExit: number) => {
    if (candCount === candId.length) {
      const grow = <T extends Float64Array | Int32Array>(old: T, make: (n: number) => T) => {
        const bigger = make(old.length * 2);
        bigger.set(old);
        return bigger;
      };
      candEnter = grow(candEnter, (n) => new Float64Array(n));
      candExit = grow(candExit, (n) => new Float64Array(n));
      candId = grow(candId, (n) => new Int32Array(n));
    }
    const c = candCount;
    candCount += 1;
    candEnter[c] = tEnter;
    candExit[c] = tExit;
    candId[c] = id;
    // Waiting candidates are kept sorted by entry t.
    let i = waiting.length;
    waiting.push(c);
    while (i > 0 && (candEnter[waiting[i - 1] ?? 0] ?? 0) > tEnter) {
      waiting[i] = waiting[i - 1] ?? 0;
      i -= 1;
    }
    waiting[i] = c;
  };

  /** Loads the current bucket's edges and features, then steps to the next bucket. */
  const loadBucket = () => {
    const bucket = br * bucketCols + bc;
    for (let i = edgeIndex.starts[bucket] ?? 0; i < (edgeIndex.starts[bucket + 1] ?? 0); i += 1) {
      const e = edgeIndex.items[i] ?? 0;
      if (edgeStamp[e] === line) continue;
      edgeStamp[e] = line;
      edgeCrossings(e);
    }
    for (
      let i = featureIndex.starts[bucket] ?? 0;
      i < (featureIndex.starts[bucket + 1] ?? 0);
      i += 1
    ) {
      const id = featureIndex.items[i] ?? 0;
      if (featureStamp[id] === line) continue;
      featureStamp[id] = line;
      const box = features[id]?.box;
      if (!box) continue;
      // The line's parameter range within the (slightly widened) box.
      let lo = 0;
      let hi = 1;
      if (dx === 0) {
        if (ax < box.minX - BOX_EPSILON_M || ax > box.maxX + BOX_EPSILON_M) continue;
      } else {
        const ta = (box.minX - BOX_EPSILON_M - ax) / dx;
        const tb = (box.maxX + BOX_EPSILON_M - ax) / dx;
        lo = Math.max(lo, Math.min(ta, tb));
        hi = Math.min(hi, Math.max(ta, tb));
      }
      if (dy === 0) {
        if (ay < box.minY - BOX_EPSILON_M || ay > box.maxY + BOX_EPSILON_M) continue;
      } else {
        const ta = (box.minY - BOX_EPSILON_M - ay) / dy;
        const tb = (box.maxY + BOX_EPSILON_M - ay) / dy;
        lo = Math.max(lo, Math.min(ta, tb));
        hi = Math.min(hi, Math.max(ta, tb));
      }
      // A line that misses the box crosses none of its edges and is never inside it.
      if (lo > hi + T_EPSILON) continue;
      addCandidate(id, lo - T_EPSILON, hi + T_EPSILON);
    }
    if (tMaxC < tMaxR) {
      nextBucketT = tMaxC;
      tMaxC += tDeltaC;
      bc += stepC;
    } else {
      nextBucketT = tMaxR;
      tMaxR += tDeltaR;
      br += stepR;
    }
    if (!(nextBucketT <= 1) || bc < 0 || br < 0 || bc >= bucketCols || br >= bucketRows) {
      nextBucketT = Infinity;
    }
  };

  /** Cuts at or before this are not part of the current walk (0 for a whole line). */
  let tMin = 0;

  /** The next value of terrain sequence s strictly inside (tMin, 1), or Infinity. */
  const advance = (s: number) => {
    const v0 = v0s[s] ?? 0;
    const v1 = v1s[s] ?? 0;
    const step = kStep[s] ?? 0;
    const last = kLast[s] ?? 0;
    for (;;) {
      const k = kNext[s] ?? 0;
      if (step > 0 ? k > last : k < last) {
        seqT[s] = Infinity;
        return;
      }
      kNext[s] = k + step;
      // Fine sequences: not the coarse lines, and only inside refined cells
      // (the reference's test, on the same point).
      if (s >= 3 && k % fineFactor === 0) continue;
      const t = (k - v0) / (v1 - v0);
      if (t > tMin && t < 1) {
        if (
          s >= 3 &&
          refinement &&
          !isRefinedAt(terrain.heightfield, refinement, ax + t * dx, ay + t * dy)
        ) {
          continue;
        }
        seqT[s] = t;
        return;
      }
    }
  };

  /** The next cut in increasing order (the end, 1, then Infinity), loading buckets it may depend on. */
  const nextCut = (): number => {
    for (;;) {
      let t = endTaken ? Infinity : 1;
      // 0–5 terrain sequences, END the end, PENDING the pending feature cuts.
      let source = END;
      for (let s = 0; s < sequenceCount; s += 1) {
        const v = seqT[s] ?? Infinity;
        if (v < t) {
          t = v;
          source = s;
        }
      }
      if (head < tail) {
        const p = pending[head] ?? Infinity;
        if (p <= t) {
          t = p;
          source = PENDING;
        }
      }
      // Feature cuts at or before t may still be unknown: load buckets first.
      if (nextBucketT !== Infinity && nextBucketT <= t + T_EPSILON) {
        loadBucket();
        continue;
      }
      if (source === PENDING) head += 1;
      else if (source === END) endTaken = true;
      else advance(source);
      return t;
    }
  };

  /** Moves begun candidates into `active` (by feature id) and drops finished ones. */
  const collect = (tm: number) => {
    let moved = 0;
    while (moved < waiting.length && (candEnter[waiting[moved] ?? 0] ?? Infinity) <= tm) {
      const c = waiting[moved] ?? 0;
      let i = active.length;
      active.push(c);
      while (i > 0 && (candId[active[i - 1] ?? 0] ?? 0) > (candId[c] ?? 0)) {
        active[i] = active[i - 1] ?? 0;
        i -= 1;
      }
      active[i] = c;
      moved += 1;
    }
    if (moved > 0) waiting.splice(0, moved);
    let kept = 0;
    for (const c of active) if ((candExit[c] ?? -Infinity) >= tm) active[kept++] = c;
    active.length = kept;
  };

  /** The reference's `inside(f, x, y)`: box, polygon, and not in a hole. */
  const inside = (f: Feature, x: number, y: number) => {
    const { box } = f;
    if (!(x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY)) return false;
    if (!f.test(x, y)) return false;
    for (const hole of f.holes) if (hole(x, y)) return false;
    return true;
  };

  /** Where the obstruction is recorded during a walk, if anywhere. */
  let record: Obstruction | undefined;
  const buildingIndex = new Map(buildings.map((f, i) => [f, i]));
  // Sub-parts of a piece, sorted (the reference's `parts`).
  const parts = new Float64Array(64);
  let partCount = 0;
  const addPart = (t: number) => {
    let i = partCount;
    while (i > 0 && (parts[i - 1] ?? 0) > t) {
      parts[i] = parts[i - 1] ?? 0;
      i -= 1;
    }
    parts[i] = t;
    partCount += 1;
  };

  /**
   * Records a terrain obstruction: the deepest point of the ground above the
   * line among the next few cuts from piece start t0, the best proof for
   * neighbouring lines.
   */
  const recordTerrain = (rec: Obstruction, t0: number, c0: number) => {
    let bestT = t0;
    let best = c0;
    for (let i = 0; i < 24; i += 1) {
      const t = nextCut();
      if (t === Infinity) break;
      const c = az + t * dz - ground(ax + t * dx, ay + t * dy);
      if (c < best) {
        best = c;
        bestT = t;
      } else if (c > best + 2) break;
    }
    rec.kind = 1;
    rec.x = ax + bestT * dx;
    rec.y = ay + bestT * dy;
    rec.hx = rec.x;
    rec.hy = rec.y;
  };

  /**
   * Starts a walk of the line (ax, ay, az)–(bx, by) from `tStart`: the
   * terrain cut sequences, the bucket traversal and the candidate lists.
   * Depends on the line's map positions only, not on its heights.
   */
  function begin(tStart: number): void {
    line += 1;
    if (line === 0x7fffffff) {
      featureStamp.fill(0);
      edgeStamp.fill(0);
      line = 1;
    }
    tMin = tStart;
    head = 0;
    tail = 0;
    candCount = 0;
    waiting.length = 0;
    active.length = 0;
    endTaken = false;

    // Terrain cuts: three sequences in increasing t, each with the reference's
    // formula t = (k − v0) / (v1 − v0), from the first after tStart.
    const gx0 = (ax - originX) / cellSize;
    const gy0 = (ay - originY) / cellSize;
    const gx1 = (bx - originX) / cellSize;
    const gy1 = (by - originY) / cellSize;
    v0s[0] = gx0;
    v1s[0] = gx1;
    v0s[1] = gy0;
    v1s[1] = gy1;
    v0s[2] = gx0 - gy0;
    v1s[2] = gx1 - gy1;
    v0s[3] = gx0 * fineFactor;
    v1s[3] = gx1 * fineFactor;
    v0s[4] = gy0 * fineFactor;
    v1s[4] = gy1 * fineFactor;
    v0s[5] = (gx0 - gy0) * fineFactor;
    v1s[5] = (gx1 - gy1) * fineFactor;
    for (let s = 0; s < sequenceCount; s += 1) {
      const v0 = v0s[s] ?? 0;
      const v1 = v1s[s] ?? 0;
      seqT[s] = Infinity;
      if (v0 === v1) continue;
      const lo = Math.min(v0, v1);
      const hi = Math.max(v0, v1);
      const vs = v0 + tStart * (v1 - v0);
      if (v1 > v0) {
        kStep[s] = 1;
        kNext[s] = Math.max(Math.ceil(lo), Math.floor(vs) - 1);
        kLast[s] = Math.floor(hi);
      } else {
        kStep[s] = -1;
        kNext[s] = Math.min(Math.floor(hi), Math.ceil(vs) + 1);
        kLast[s] = Math.ceil(lo);
      }
      advance(s);
    }

    // Buckets along the line from the start point, in order (Amanatides–Woo).
    const sx = ax + tStart * dx;
    const sy = ay + tStart * dy;
    bc = clampC(Math.floor((sx - originX) / BUCKET_M));
    br = clampR(Math.floor((sy - originY) / BUCKET_M));
    stepC = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    stepR = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    tMaxC = stepC === 0 ? Infinity : (originX + (bc + (stepC > 0 ? 1 : 0)) * BUCKET_M - ax) / dx;
    tMaxR = stepR === 0 ? Infinity : (originY + (br + (stepR > 0 ? 1 : 0)) * BUCKET_M - ay) / dy;
    tDeltaC = stepC === 0 ? Infinity : BUCKET_M / Math.abs(dx);
    tDeltaR = stepR === 0 ? Infinity : BUCKET_M / Math.abs(dy);
    nextBucketT = tStart;
  }

  /**
   * Walks the line from `tStart` and returns 1 when it finds an obstruction, 0
   * when it reaches the end clear, and -1 when it passes `tEnd` without one.
   *
   * From 0 this is exactly the reference's trace. From a later cut it is a
   * proof: every piece that begins after the first cut past `tStart` is
   * exactly the reference's piece (cuts and their order do not depend on
   * where the walk starts), and is checked as the reference checks it. Earlier
   * pieces are only walked through. Vegetation obscuration starts from 0
   * instead of what the reference had gathered by then: since floating-point
   * addition is monotonic, it never exceeds the reference's, so an
   * obstruction found here is found by the reference at the same point or
   * earlier. A walk from a later start proves obstruction, never clearness.
   */
  function walk(a: Vec3, b: Vec3, tStart: number, tEnd: number): number {
    ax = a.x;
    ay = a.y;
    az = a.z;
    bx = b.x;
    by = b.y;
    dx = bx - ax;
    dy = by - ay;
    dz = b.z - az;
    const distance = Math.hypot(dx, dy);
    begin(tStart);

    // From 0 the first cut is 0 itself; feature cuts at 0 equal it and are skipped.
    let previous = tStart;
    let t0 = tStart;
    let c0 = az + t0 * dz - ground(ax + t0 * dx, ay + t0 * dy);
    // Pieces beginning at or before `checkAfter` are walked through, not checked.
    let checkAfter = tStart > 0 ? Number.NaN : -1;
    let obscuration = 0;
    let obscuredFrom = -1;
    for (;;) {
      const t1 = nextCut();
      if (t1 === Infinity) return 0;
      if (t1 > tEnd) return -1;
      if (Number.isNaN(checkAfter)) checkAfter = t1;
      // Cuts closer than 1e-12 to the previous one are the same point.
      if (!(t1 - previous > 1e-12)) {
        previous = t1;
        continue;
      }
      previous = t1;
      const c1 = az + t1 * dz - ground(ax + t1 * dx, ay + t1 * dy);
      if (!(t0 > checkAfter)) {
        t0 = t1;
        c0 = c1;
        continue;
      }
      inBuildings.length = 0;
      inVegetation.length = 0;
      if (waiting.length + active.length > 0) {
        const tm = (t0 + t1) / 2;
        const mx = ax + ((t0 + t1) / 2) * dx;
        const my = ay + ((t0 + t1) / 2) * dy;
        collect(tm);
        for (const c of active) {
          const id = candId[c] ?? 0;
          const f = features[id];
          if (!f || !inside(f, mx, my)) continue;
          if (id < nb) {
            const building = buildings[id];
            if (building) inBuildings.push(building);
          } else {
            const area = vegetation[id - nb];
            if (area) inVegetation.push(area);
          }
        }
      }
      if (inBuildings.length + inVegetation.length === 0 && c0 >= 0 && c1 >= 0) {
        t0 = t1;
        c0 = c1;
        continue;
      }

      // From here on, exactly the reference's handling of a piece. Its
      // clearance(t) is cc0 + ((t − ct0) / (t1 − ct0)) × (c1 − cc0); its
      // crossing(level) the root of clearance − level when they change sign.
      const ct0 = t0;
      const cc0 = c0;
      partCount = 0;
      addPart(t0);
      addPart(t1);
      if ((cc0 - 0) * (c1 - 0) < 0) addPart(ct0 + ((cc0 - 0) / (cc0 - c1)) * (t1 - ct0));
      for (const f of inBuildings) {
        const v0 = az + t0 * dz - f.roofZ;
        const v1 = az + t1 * dz - f.roofZ;
        if (v0 * v1 < 0) addPart(t0 + (v0 / (v0 - v1)) * (t1 - t0));
      }
      for (const f of inVegetation) {
        const level = f.canopy;
        if ((cc0 - level) * (c1 - level) < 0) {
          addPart(ct0 + ((cc0 - level) / (cc0 - c1)) * (t1 - ct0));
        }
      }
      for (let j = 0; j + 1 < partCount; j += 1) {
        const s0 = parts[j] ?? t0;
        const s1 = parts[j + 1] ?? t1;
        if (s1 <= s0) continue;
        const sm = (s0 + s1) / 2;
        const clearance = cc0 + ((sm - ct0) / (t1 - ct0)) * (c1 - cc0);
        if (clearance < 0) {
          if (record) recordTerrain(record, t0, c0);
          return 1;
        }
        const lineZ = az + sm * dz;
        for (const f of inBuildings) {
          if (lineZ < f.roofZ) {
            if (record) {
              record.kind = 2;
              record.building = buildingIndex.get(f) ?? 0;
              record.x = ax + s0 * dx;
              record.y = ay + s0 * dy;
              record.hx = record.x;
              record.hy = record.y;
            }
            return 1;
          }
        }
        if (inVegetation.length === 0) continue;
        let rate = 0;
        let densest: PreparedVegetation | undefined;
        for (const f of inVegetation) {
          if (!(clearance < f.canopy)) continue;
          const r = 1 / f.seeThrough;
          rate += r;
          const best = densest ? 1 / densest.seeThrough : -1;
          if (!densest || r > best || (r === best && f.id < densest.id)) densest = f;
        }
        const length = (s1 - s0) * distance;
        if (densest && rate > 0 && obscuredFrom < 0) obscuredFrom = s0;
        if (densest && rate > 0 && obscuration + rate * length >= 1) {
          if (record) {
            record.kind = 3;
            record.x = ax + obscuredFrom * dx;
            record.y = ay + obscuredFrom * dy;
            record.hx = ax + s0 * dx;
            record.hy = ay + s0 * dy;
          }
          return 1;
        }
        obscuration += rate * length;
      }
      t0 = t1;
      c0 = c1;
    }
  }

  // Scratch for building proofs.
  const crossingParams = new Float64Array(64);

  /** Whether some point of the line passes PROOF_MARGIN_M inside building i and below its roof. */
  function passesThroughBuilding(a: Vec3, b: Vec3, i: number): boolean {
    const f = buildings[i];
    const test = features[i]?.test;
    if (!f || !test) return false;
    const lx = b.x - a.x;
    const ly = b.y - a.y;
    const lz = b.z - a.z;
    // Quick rejection: the line must reach the footprint's box.
    const { box } = f;
    let lo = 0;
    let hi = 1;
    if (lx === 0) {
      if (a.x < box.minX || a.x > box.maxX) return false;
    } else {
      const ta = (box.minX - a.x) / lx;
      const tb = (box.maxX - a.x) / lx;
      lo = Math.max(lo, Math.min(ta, tb));
      hi = Math.min(hi, Math.max(ta, tb));
    }
    if (ly === 0) {
      if (a.y < box.minY || a.y > box.maxY) return false;
    } else {
      const ta = (box.minY - a.y) / ly;
      const tb = (box.maxY - a.y) / ly;
      lo = Math.max(lo, Math.min(ta, tb));
      hi = Math.min(hi, Math.max(ta, tb));
    }
    if (lo > hi) return false;
    // Pieces of the line between its crossings of the footprint's edges.
    let n = 0;
    crossingParams[n++] = 0;
    const polygon = f.polygon;
    for (let k = 0; k < polygon.length && n < crossingParams.length - 1; k += 1) {
      const p = polygon[k];
      const q = polygon[(k + 1) % polygon.length];
      if (!p || !q) continue;
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      const denom = lx * ey - ly * ex;
      if (denom === 0) continue;
      const s = ((p.x - a.x) * ey - (p.y - a.y) * ex) / denom;
      if (!(s > 0 && s < 1)) continue;
      let j = n;
      while (j > 1 && (crossingParams[j - 1] ?? 0) > s) {
        crossingParams[j] = crossingParams[j - 1] ?? 0;
        j -= 1;
      }
      crossingParams[j] = s;
      n += 1;
    }
    crossingParams[n++] = 1;
    for (let j = 0; j + 1 < n; j += 1) {
      const t = ((crossingParams[j] ?? 0) + (crossingParams[j + 1] ?? 0)) / 2;
      if (!(a.z + t * lz < f.roofZ - PROOF_MARGIN_M)) continue;
      const x = a.x + t * lx;
      const y = a.y + t * ly;
      if (test(x, y) && !nearEdge(polygon, x, y)) return true;
    }
    return false;
  }

  /** Window of a proof walk before and after the projected obstruction, in metres. */
  const WINDOW_BEFORE_M = 16;
  const WINDOW_AFTER_M = 48;

  /** Parameter of the point of line a–b as far from the eye as (x, y). */
  const along = (a: Vec3, b: Vec3, x: number, y: number) => {
    const lx = b.x - a.x;
    const ly = b.y - a.y;
    const ex = x - a.x;
    const ey = y - a.y;
    return Math.sqrt((ex * ex + ey * ey) / (lx * lx + ly * ly));
  };

  function provesQuickly(a: Vec3, b: Vec3, obstruction: Obstruction): boolean {
    if (obstruction.kind === 1) {
      // The point of this line as far from the eye as the recorded point.
      const t = along(a, b, obstruction.x, obstruction.y);
      if (!(t > 0 && t < 1)) return false;
      const x = a.x + t * (b.x - a.x);
      const y = a.y + t * (b.y - a.y);
      // Rounding can place a point a hair off the map: no proof there.
      if (!(x >= originX && x <= maxX && y >= originY && y <= maxY)) return false;
      return ground(x, y) - (a.z + t * (b.z - a.z)) > PROOF_MARGIN_M;
    }
    if (obstruction.kind === 2) return passesThroughBuilding(a, b, obstruction.building);
    return false;
  }

  function provesByWalking(a: Vec3, b: Vec3, obstruction: Obstruction): boolean {
    if (obstruction.kind === 0) return false;
    // Walk this line through the stretch where the other was obstructed.
    const length = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    const from = Math.max(0, along(a, b, obstruction.x, obstruction.y) - WINDOW_BEFORE_M / length);
    const to = along(a, b, obstruction.hx, obstruction.hy) + WINDOW_AFTER_M / length;
    if (!(from < 1)) return false;
    record = undefined;
    return walk(a, b, from, to) === 1;
  }

  function blocked(a: Vec3, b: Vec3, obstruction?: Obstruction): boolean {
    record = obstruction;
    if (record) record.kind = 0;
    const result = walk(a, b, 0, Infinity);
    record = undefined;
    return result === 1;
  }

  // Lanes of `clearCount`: one per target height.
  let laneDz = new Float64Array(4);
  let laneC0 = new Float64Array(4);
  let laneObscuration = new Float64Array(4);
  let laneObscuredFrom = new Float64Array(4);
  let laneAlive = new Uint8Array(4);
  const laneParts = new Float64Array(64);

  /**
   * How many of the sight lines from eye `a` to the points (bx, by, zs[i])
   * are clear: for each, exactly `!blocked(a, { x: bx, y: by, z: zs[i] })`.
   * The lines share their map path, so it is walked once: its cuts, feature
   * buckets and ground heights are the same for every line, and each line's
   * pieces are checked with its own heights, with the same floating-point
   * operations in the same order as `walk` checks them.
   */
  function clearCount(a: Vec3, tx: number, ty: number, zs: readonly number[]): number {
    const n = zs.length;
    if (laneDz.length < n) {
      laneDz = new Float64Array(n);
      laneC0 = new Float64Array(n);
      laneObscuration = new Float64Array(n);
      laneObscuredFrom = new Float64Array(n);
      laneAlive = new Uint8Array(n);
    }
    ax = a.x;
    ay = a.y;
    az = a.z;
    bx = tx;
    by = ty;
    dx = bx - ax;
    dy = by - ay;
    dz = 0;
    const distance = Math.hypot(dx, dy);
    begin(0);
    let previous = 0;
    let t0 = 0;
    const g0 = ground(ax + t0 * dx, ay + t0 * dy);
    let alive = n;
    for (let i = 0; i < n; i += 1) {
      laneDz[i] = (zs[i] ?? 0) - az;
      laneC0[i] = az + t0 * (laneDz[i] ?? 0) - g0;
      laneObscuration[i] = 0;
      laneObscuredFrom[i] = -1;
      laneAlive[i] = 1;
    }
    for (;;) {
      const t1 = nextCut();
      if (t1 === Infinity) return alive;
      if (!(t1 - previous > 1e-12)) {
        previous = t1;
        continue;
      }
      previous = t1;
      const g1 = ground(ax + t1 * dx, ay + t1 * dy);
      inBuildings.length = 0;
      inVegetation.length = 0;
      if (waiting.length + active.length > 0) {
        const tm = (t0 + t1) / 2;
        const mx = ax + ((t0 + t1) / 2) * dx;
        const my = ay + ((t0 + t1) / 2) * dy;
        collect(tm);
        for (const c of active) {
          const id = candId[c] ?? 0;
          const f = features[id];
          if (!f || !inside(f, mx, my)) continue;
          if (id < nb) {
            const building = buildings[id];
            if (building) inBuildings.push(building);
          } else {
            const area = vegetation[id - nb];
            if (area) inVegetation.push(area);
          }
        }
      }
      for (let i = 0; i < n; i += 1) {
        if (laneAlive[i] === 0) continue;
        const ldz = laneDz[i] ?? 0;
        const c0 = laneC0[i] ?? 0;
        const c1 = az + t1 * ldz - g1;
        laneC0[i] = c1;
        if (inBuildings.length + inVegetation.length === 0 && c0 >= 0 && c1 >= 0) continue;
        if (pieceBlocks(i, t0, t1, c0, c1, ldz, distance)) {
          laneAlive[i] = 0;
          alive -= 1;
        }
      }
      if (alive === 0) return 0;
      t0 = t1;
    }
  }

  /** `walk`'s handling of one piece, for lane `i` of `clearCount`: whether it obstructs the lane. */
  function pieceBlocks(
    i: number,
    t0: number,
    t1: number,
    c0: number,
    c1: number,
    ldz: number,
    distance: number,
  ): boolean {
    const ct0 = t0;
    const cc0 = c0;
    let count = 0;
    const add = (t: number) => {
      let j = count;
      while (j > 0 && (laneParts[j - 1] ?? 0) > t) {
        laneParts[j] = laneParts[j - 1] ?? 0;
        j -= 1;
      }
      laneParts[j] = t;
      count += 1;
    };
    add(t0);
    add(t1);
    if ((cc0 - 0) * (c1 - 0) < 0) add(ct0 + ((cc0 - 0) / (cc0 - c1)) * (t1 - ct0));
    for (const f of inBuildings) {
      const v0 = az + t0 * ldz - f.roofZ;
      const v1 = az + t1 * ldz - f.roofZ;
      if (v0 * v1 < 0) add(t0 + (v0 / (v0 - v1)) * (t1 - t0));
    }
    for (const f of inVegetation) {
      const level = f.canopy;
      if ((cc0 - level) * (c1 - level) < 0) {
        add(ct0 + ((cc0 - level) / (cc0 - c1)) * (t1 - ct0));
      }
    }
    for (let j = 0; j + 1 < count; j += 1) {
      const s0 = laneParts[j] ?? t0;
      const s1 = laneParts[j + 1] ?? t1;
      if (s1 <= s0) continue;
      const sm = (s0 + s1) / 2;
      const clearance = cc0 + ((sm - ct0) / (t1 - ct0)) * (c1 - cc0);
      if (clearance < 0) return true;
      const lineZ = az + sm * ldz;
      for (const f of inBuildings) if (lineZ < f.roofZ) return true;
      if (inVegetation.length === 0) continue;
      let rate = 0;
      let densest: PreparedVegetation | undefined;
      for (const f of inVegetation) {
        if (!(clearance < f.canopy)) continue;
        const r = 1 / f.seeThrough;
        rate += r;
        const best = densest ? 1 / densest.seeThrough : -1;
        if (!densest || r > best || (r === best && f.id < densest.id)) densest = f;
      }
      const length = (s1 - s0) * distance;
      const obscuration = laneObscuration[i] ?? 0;
      if (densest && rate > 0 && (laneObscuredFrom[i] ?? -1) < 0) laneObscuredFrom[i] = s0;
      if (densest && rate > 0 && obscuration + rate * length >= 1) return true;
      laneObscuration[i] = obscuration + rate * length;
    }
    return false;
  }

  return { blocked, clearCount, provesQuickly, provesByWalking };
}
