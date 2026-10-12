import { boundsOf, impassableWater, type Box, type Building, type WaterArea } from './environment';
import type { Vec2 } from './geometry';
import { pointInPolygon, segmentIntersectionParams } from './polygon';
import { deepFreeze } from './shared-terrain';
import { isOnTerrain, type TerrainDataset } from './terrain';

// Basic path planning around hard obstacles (docs/adr/0011): buildings, kept
// clear of by `OBSTACLE_CLEARANCE_M`, and standing water (docs/adr/0014), which
// may be walked up to but not into. Between two map points: a straight line
// if it avoids every obstacle; otherwise A* on
// a navigation grid, then string-pulling into a few straight legs. Pure and
// deterministic; the same function plans for the simulation and for the
// planning display, so what is shown is what will be walked.

/** How far a soldier's path keeps from building walls, in metres. */
export const OBSTACLE_CLEARANCE_M = 0.75;
/** Navigation grid spacing in metres. */
export const NAV_CELL_M = 2;
/** How far (in cells) a point may be from the grid cell it connects through. */
const CONNECT_RADIUS_CELLS = 3;

/** Why a point cannot be walked to. */
export type PointProblem =
  | { readonly kind: 'offTerrain' }
  | { readonly kind: 'insideBuilding'; readonly buildingId: string }
  | { readonly kind: 'tooCloseToBuilding'; readonly buildingId: string }
  | { readonly kind: 'inWater'; readonly waterId: string };

export type PathResult =
  /** `turns`: the generated intermediate points between start and goal (often none). */
  | { readonly ok: true; readonly turns: readonly Vec2[] }
  | { readonly ok: false; readonly problem: PointProblem | { readonly kind: 'unreachable' } };

/** Whether a soldier may stand at `p`, or why not. */
export function pointProblem(terrain: TerrainDataset, p: Vec2): PointProblem | null {
  if (!isOnTerrain(terrain, p.x, p.y)) return { kind: 'offTerrain' };
  const index = obstacleIndex(terrain);
  // A bucket lists its obstacles in index order (buildings, then water), so
  // the first problem found is the same as in a scan of every obstacle.
  const bucket = bucketAt(index, p);
  for (let k = index.start[bucket] ?? 0; k < (index.start[bucket + 1] ?? 0); k += 1) {
    const i = index.items[k] ?? 0;
    const building = index.buildings[i];
    if (building) {
      const { building: b, box } = building;
      if (!near(box, p, OBSTACLE_CLEARANCE_M)) continue;
      if (pointInPolygon(p, b.footprint)) return { kind: 'insideBuilding', buildingId: b.id };
      if (distanceToPolygon(p, b.footprint) < OBSTACLE_CLEARANCE_M) {
        return { kind: 'tooCloseToBuilding', buildingId: b.id };
      }
      continue;
    }
    const water = index.water[i - index.buildings.length];
    if (water && near(water.box, p, 0) && pointInPolygon(p, water.water.boundary)) {
      return { kind: 'inWater', waterId: water.water.id };
    }
  }
  return null;
}

/** How far past the water's edge a point moved out of water stands, in metres. */
export const ASHORE_MARGIN_M = 1;

/**
 * For a point in or against a building, or in water: the nearest point clear
 * of it where `accept` agrees (e.g. a soldier can stand there and reach it),
 * or `null` when there is none within `maxDistanceM`.
 *
 * First the point just outside the obstacle's outline nearest `p` (a
 * building's clearance plus a small margin, or `ASHORE_MARGIN_M` onto the
 * bank); where that lands in or against another obstacle (water mapped as
 * several polygons, a building on the bank), it steps out of that one too, a
 * few times. Failing that (refused, or nowhere clear), the nearest acceptable
 * point on rings round `p`, 1 m apart. A point with no problem is returned as
 * it is when acceptable; one off the map gives `null`. Deterministic.
 */
export function nearestClearPoint(
  terrain: TerrainDataset,
  p: Vec2,
  accept: (q: Vec2) => boolean = () => true,
  maxDistanceM = 40,
): Vec2 | null {
  const ok = (q: Vec2) => pointProblem(terrain, q) === null && accept(q);
  const problem = pointProblem(terrain, p);
  if (problem === null) return accept(p) ? p : null;
  if (problem.kind === 'offTerrain') return null;
  let q: Vec2 = p;
  let current: PointProblem | null = problem;
  for (let step = 0; step < MAX_STEPS_OUT && current; step += 1) {
    const next = stepOut(terrain, q, current);
    if (!next) break;
    q = next;
    current = pointProblem(terrain, q);
  }
  if (current === null && Math.hypot(q.x - p.x, q.y - p.y) <= maxDistanceM && accept(q)) return q;
  for (let r = 1; r <= maxDistanceM; r += 1) {
    const steps = Math.max(8, Math.ceil((2 * Math.PI * r) / 1.5));
    for (let k = 0; k < steps; k += 1) {
      const angle = (2 * Math.PI * k) / steps;
      const c = { x: p.x + r * Math.sin(angle), y: p.y + r * Math.cos(angle) };
      if (ok(c)) return c;
    }
  }
  return null;
}

/** How many obstacles in a row `nearestClearPoint` steps out of before searching round the point. */
const MAX_STEPS_OUT = 4;

/** The point just outside the obstacle of `problem` nearest `p`, or `null` when there is none. */
function stepOut(terrain: TerrainDataset, p: Vec2, problem: PointProblem): Vec2 | null {
  switch (problem.kind) {
    case 'insideBuilding':
    case 'tooCloseToBuilding': {
      const footprint = terrain.features.buildings.find(
        (b) => b.id === problem.buildingId,
      )?.footprint;
      return footprint ? outsideRing(footprint, p, OBSTACLE_CLEARANCE_M + 0.5) : null;
    }
    case 'inWater': {
      const boundary = impassableWater(terrain.features).find(
        (w) => w.id === problem.waterId,
      )?.boundary;
      return boundary ? outsideRing(boundary, p, ASHORE_MARGIN_M) : null;
    }
    case 'offTerrain':
      return null;
  }
}

/** The point `reach` metres outside a ring's nearest edge to `p`, along the edge's outward normal. */
function outsideRing(ring: readonly Vec2[], p: Vec2, reach: number): Vec2 | null {
  let best: { point: Vec2; distance: number; outward: Vec2 } | null = null;
  const n = ring.length;
  const ccw = signedArea(ring) > 0;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) continue;
    const t = Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0), 1);
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    const distance = Math.hypot(p.x - point.x, p.y - point.y);
    // The edge's outward normal: right of the edge for a counter-clockwise outline.
    const length = Math.sqrt(lengthSq);
    const outward = ccw ? { x: dy / length, y: -dx / length } : { x: -dy / length, y: dx / length };
    if (!best || distance < best.distance) best = { point, distance, outward };
  }
  return best
    ? { x: best.point.x + best.outward.x * reach, y: best.point.y + best.outward.y * reach }
    : null;
}

/** Twice-the-sign of a ring's area: positive when counter-clockwise (x east, y north). */
function signedArea(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a && b) s += a.x * b.y - b.x * a.y;
  }
  return s;
}

/** Whether a soldier can walk straight from `a` to `b`, keeping clear of every building and out of water. */
export function isSegmentWalkable(terrain: TerrainDataset, a: Vec2, b: Vec2): boolean {
  // The terrain is a rectangle, so a segment between two points on it stays on it.
  if (!isOnTerrain(terrain, a.x, a.y) || !isOnTerrain(terrain, b.x, b.y)) return false;
  const segmentBox = boundsOf([a, b]);
  const index = obstacleIndex(terrain);
  // Only obstacles registered in the buckets the segment crosses can be near
  // it; for every other one the exact test below is true (see `obstacleIndex`).
  return everyObstacleAlong(index, a, b, (i) => {
    const building = index.buildings[i];
    if (building) {
      return (
        !overlaps(building.box, segmentBox, OBSTACLE_CLEARANCE_M) ||
        segmentClearOfPolygon(a, b, building.building.footprint, building.box, OBSTACLE_CLEARANCE_M)
      );
    }
    const water = index.water[i - index.buildings.length];
    return (
      !water ||
      !overlaps(water.box, segmentBox, 0) ||
      segmentClearOfPolygon(a, b, water.water.boundary, water.box, 0)
    );
  });
}

/**
 * A walkable path from `from` to `to`: the generated turn points between them.
 * Fails when `to` is not a valid place to stand or cannot be reached.
 *
 * Paths that need the navigation grid are remembered per terrain (the most
 * recent `PATH_CACHE_SIZE`), since editing and building a scenario plan the
 * same legs many times. The function is pure, so a remembered result is the
 * one it would compute again; results are frozen so no caller can change them.
 */
export function planPath(terrain: TerrainDataset, from: Vec2, to: Vec2): PathResult {
  const problem = pointProblem(terrain, to);
  if (problem) return { ok: false, problem };
  if (isSegmentWalkable(terrain, from, to)) return { ok: true, turns: [] };

  let paths = pathCache.get(terrain);
  if (!paths) {
    paths = new Map();
    pathCache.set(terrain, paths);
  }
  const key = `${String(from.x)},${String(from.y)}>${String(to.x)},${String(to.y)}`;
  const known = paths.get(key);
  if (known) {
    // Most recently used last.
    paths.delete(key);
    paths.set(key, known);
    return known;
  }
  const result = deepFreeze(planGridPath(terrain, from, to));
  if (paths.size >= PATH_CACHE_SIZE) paths.delete(paths.keys().next().value ?? '');
  paths.set(key, result);
  return result;
}

/** How many grid paths `planPath` remembers per terrain. */
export const PATH_CACHE_SIZE = 256;

const pathCache = new WeakMap<TerrainDataset, Map<string, PathResult>>();

/** `planPath` between points not joined by a straight walkable line. */
function planGridPath(terrain: TerrainDataset, from: Vec2, to: Vec2): PathResult {
  const grid = navGrid(terrain);
  const start = connect(terrain, grid, from);
  const goal = connect(terrain, grid, to);
  // Cells in different connected areas cannot be joined: A* would only find
  // that out by searching the whole of the start's area.
  if (start === undefined || goal === undefined || !connected(grid, start, goal))
    return { ok: false, problem: { kind: 'unreachable' } };
  const cells = aStar(grid, start, goal);
  if (!cells) return { ok: false, problem: { kind: 'unreachable' } };
  const nodes = [from, ...cells.map((c) => cellCentre(grid, c)), to];
  return { ok: true, turns: stringPull(terrain, nodes).slice(1, -1) };
}

/**
 * Removes unnecessary nodes: from each kept node, jump to the farthest later
 * node reachable in a straight walkable line. Deterministic, and never makes a
 * path longer.
 */
export function stringPull(terrain: TerrainDataset, nodes: readonly Vec2[]): Vec2[] {
  const first = nodes[0];
  if (!first) return [];
  const result = [first];
  let i = 0;
  while (i < nodes.length - 1) {
    let next = i + 1;
    for (let j = nodes.length - 1; j > i + 1; j -= 1) {
      const a = nodes[i];
      const b = nodes[j];
      if (a && b && isSegmentWalkable(terrain, a, b)) {
        next = j;
        break;
      }
    }
    const node = nodes[next];
    if (node) result.push(node);
    i = next;
  }
  return result;
}

// --- Obstacles ---------------------------------------------------------------

interface Obstacle {
  readonly building: Building;
  readonly box: Box;
}

interface WaterObstacle {
  readonly water: WaterArea;
  readonly box: Box;
}

/**
 * Buildings and impassable water, with their bounds, bucketed on a coarse
 * grid so that a query only looks at the obstacles near it. Obstacle `i` is
 * building `i`, or water `i − buildings.length`; each bucket lists the
 * obstacles registered in it in that order (CSR layout: bucket `k` holds
 * `items[start[k]] … items[start[k + 1] − 1]`).
 *
 * An obstacle is registered in every bucket its bounds, grown by the largest
 * margin any query uses plus `INDEX_SLACK_M`, overlap. So an obstacle missing
 * from every bucket a point or segment touches is more than that margin (plus
 * the slack, far beyond rounding error) from it, and the exact tests would
 * pass it anyway: the index changes no answer, only how fast it is found.
 */
interface ObstacleIndex {
  readonly buildings: readonly Obstacle[];
  readonly water: readonly WaterObstacle[];
  readonly originX: number;
  readonly originY: number;
  readonly columns: number;
  readonly rows: number;
  readonly start: Int32Array;
  readonly items: Int32Array;
  /** Per obstacle: the query that last visited it (so each is tested once per query). */
  readonly visited: Uint32Array;
  query: number;
}

/** Bucket size of the obstacle index, in metres. */
const INDEX_BUCKET_M = 32;
/** Extra margin around registered obstacles, in metres; see `ObstacleIndex`. */
const INDEX_SLACK_M = 1;

const indexCache = new WeakMap<TerrainDataset, ObstacleIndex>();

/** The obstacle index, built once per terrain (terrain is immutable, docs/adr/0006). */
function obstacleIndex(terrain: TerrainDataset): ObstacleIndex {
  const cached = indexCache.get(terrain);
  if (cached) return cached;
  const { originX, originY, cellSize, columns: samplesX, rows: samplesY } = terrain.heightfield;
  const buildings = terrain.features.buildings.map((building) => ({
    building,
    box: boundsOf(building.footprint),
  }));
  const water = impassableWater(terrain.features).map((w) => ({
    water: w,
    box: boundsOf(w.boundary),
  }));
  const columns = Math.max(1, Math.ceil(((samplesX - 1) * cellSize) / INDEX_BUCKET_M));
  const rows = Math.max(1, Math.ceil(((samplesY - 1) * cellSize) / INDEX_BUCKET_M));
  const ranges = [...buildings.map(({ box }) => box), ...water.map(({ box }) => box)].map(
    (box, i) => {
      const m = (i < buildings.length ? OBSTACLE_CLEARANCE_M : 0) + INDEX_SLACK_M;
      const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
      return {
        c0: clamp(Math.floor((box.minX - m - originX) / INDEX_BUCKET_M), columns),
        c1: clamp(Math.floor((box.maxX + m - originX) / INDEX_BUCKET_M), columns),
        r0: clamp(Math.floor((box.minY - m - originY) / INDEX_BUCKET_M), rows),
        r1: clamp(Math.floor((box.maxY + m - originY) / INDEX_BUCKET_M), rows),
      };
    },
  );
  const counts = new Int32Array(columns * rows + 1);
  for (const { c0, c1, r0, r1 } of ranges) {
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const k = r * columns + c + 1;
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
  }
  for (let k = 1; k < counts.length; k += 1) counts[k] = (counts[k] ?? 0) + (counts[k - 1] ?? 0);
  const start = counts;
  const fill = start.slice(0, columns * rows);
  const items = new Int32Array(start[columns * rows] ?? 0);
  ranges.forEach(({ c0, c1, r0, r1 }, i) => {
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const k = r * columns + c;
        const at = fill[k] ?? 0;
        items[at] = i;
        fill[k] = at + 1;
      }
    }
  });
  const index: ObstacleIndex = {
    buildings,
    water,
    originX,
    originY,
    columns,
    rows,
    start,
    items,
    visited: new Uint32Array(ranges.length),
    query: 0,
  };
  indexCache.set(terrain, index);
  return index;
}

/** The bucket holding a point on the terrain. */
function bucketAt(index: ObstacleIndex, p: Vec2): number {
  const c = Math.min(
    index.columns - 1,
    Math.max(0, Math.floor((p.x - index.originX) / INDEX_BUCKET_M)),
  );
  const r = Math.min(
    index.rows - 1,
    Math.max(0, Math.floor((p.y - index.originY) / INDEX_BUCKET_M)),
  );
  return r * index.columns + c;
}

/**
 * Whether `test` holds for every obstacle registered in a bucket that segment
 * a–b passes through (each tested once). Stops at the first failure; since
 * the result is a conjunction, the order of the tests does not matter.
 */
function everyObstacleAlong(
  index: ObstacleIndex,
  a: Vec2,
  b: Vec2,
  test: (obstacle: number) => boolean,
): boolean {
  index.query = (index.query + 1) >>> 0;
  if (index.query === 0) {
    index.visited.fill(0);
    index.query = 1;
  }
  const query = index.query;
  const { originX, originY, columns, rows } = index;
  const eps = INDEX_BUCKET_M * 1e-6;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rowOf = (y: number) =>
    Math.min(rows - 1, Math.max(0, Math.floor((y - originY) / INDEX_BUCKET_M)));
  const columnOf = (x: number) =>
    Math.min(columns - 1, Math.max(0, Math.floor((x - originX) / INDEX_BUCKET_M)));
  const r0 = rowOf(Math.min(a.y, b.y) - eps);
  const r1 = rowOf(Math.max(a.y, b.y) + eps);
  for (let r = r0; r <= r1; r += 1) {
    // The part of the segment within this row of buckets (with a hair of margin).
    let x0 = Math.min(a.x, b.x);
    let x1 = Math.max(a.x, b.x);
    if (dy !== 0) {
      const y0 = originY + r * INDEX_BUCKET_M - eps;
      const y1 = originY + (r + 1) * INDEX_BUCKET_M + eps;
      const t0 = Math.min(1, Math.max(0, (y0 - a.y) / dy));
      const t1 = Math.min(1, Math.max(0, (y1 - a.y) / dy));
      x0 = Math.min(a.x + t0 * dx, a.x + t1 * dx);
      x1 = Math.max(a.x + t0 * dx, a.x + t1 * dx);
    }
    const c1 = columnOf(x1 + eps);
    for (let c = columnOf(x0 - eps); c <= c1; c += 1) {
      const k = r * columns + c;
      for (let j = index.start[k] ?? 0; j < (index.start[k + 1] ?? 0); j += 1) {
        const i = index.items[j] ?? 0;
        if (index.visited[i] === query) continue;
        index.visited[i] = query;
        if (!test(i)) return false;
      }
    }
  }
  return true;
}

function near(box: Box, p: Vec2, margin: number): boolean {
  return (
    p.x >= box.minX - margin &&
    p.x <= box.maxX + margin &&
    p.y >= box.minY - margin &&
    p.y <= box.maxY + margin
  );
}

function overlaps(a: Box, b: Box, margin: number): boolean {
  return (
    a.minX - margin <= b.maxX &&
    b.minX <= a.maxX + margin &&
    a.minY - margin <= b.maxY &&
    b.minY <= a.maxY + margin
  );
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0), 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// The polygon loops below use indices rather than an edge list: they run in
// the hottest loops of path planning and must not allocate.

/** Distance from `p` to the polygon's boundary. */
function distanceToPolygon(p: Vec2, polygon: readonly Vec2[]): number {
  let best = Number.POSITIVE_INFINITY;
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n] ?? a;
    if (a && b) best = Math.min(best, distanceToSegment(p, a, b));
  }
  return best;
}

/** Edges whose bounds are this much further than the clearance from a segment's are skipped, in metres. */
const EDGE_SKIP_SLACK_M = 1e-3;

/**
 * Whether segment a–b stays outside the polygon (with bounds `box`) and at
 * least `clearance` from it. Points outside the bounds are not in the
 * polygon, and an edge whose bounds are further than the clearance from the
 * segment's can neither cross it nor come within the clearance, so both are
 * skipped without changing the answer.
 */
function segmentClearOfPolygon(
  a: Vec2,
  b: Vec2,
  polygon: readonly Vec2[],
  box: Box,
  clearance: number,
): boolean {
  if (
    (near(box, a, 0) && pointInPolygon(a, polygon)) ||
    (near(box, b, 0) && pointInPolygon(b, polygon))
  )
    return false;
  const sMinX = Math.min(a.x, b.x);
  const sMaxX = Math.max(a.x, b.x);
  const sMinY = Math.min(a.y, b.y);
  const sMaxY = Math.max(a.y, b.y);
  const reach = clearance + EDGE_SKIP_SLACK_M;
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const p = polygon[i];
    const q = polygon[(i + 1) % n] ?? p;
    if (!p || !q) continue;
    if (
      Math.min(p.x, q.x) - sMaxX > reach ||
      sMinX - Math.max(p.x, q.x) > reach ||
      Math.min(p.y, q.y) - sMaxY > reach ||
      sMinY - Math.max(p.y, q.y) > reach
    )
      continue;
    if (segmentIntersectionParams(a, b, p, q).length > 0) return false;
    // Non-intersecting segments are closest at one of the four endpoints.
    if (
      Math.min(
        distanceToSegment(a, p, q),
        distanceToSegment(b, p, q),
        distanceToSegment(p, a, b),
        distanceToSegment(q, a, b),
      ) < clearance
    ) {
      return false;
    }
  }
  return true;
}

// --- Navigation grid -------------------------------------------------------------

interface NavGrid {
  readonly originX: number;
  readonly originY: number;
  readonly columns: number;
  readonly rows: number;
  /** 1 where a soldier may not stand, row-major from the south-west. */
  readonly blocked: Uint8Array;
  /** Connected areas of free cells (`connected`), labelled on first use. */
  areas?: Int32Array;
}

const gridCache = new WeakMap<TerrainDataset, NavGrid>();

/**
 * The navigation grid, built once per terrain (terrain is immutable,
 * docs/adr/0006); exported for tests.
 *
 * Cells whose centre lies inside a building, or within the clearance plus half
 * a cell diagonal of one, are blocked. That margin guarantees that a straight
 * step between two adjacent free cell centres keeps the full clearance, so
 * every grid path is walkable under the exact test.
 */
export function navGrid(terrain: TerrainDataset): NavGrid {
  const cached = gridCache.get(terrain);
  if (cached) return cached;
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const width = (columns - 1) * cellSize;
  const height = (rows - 1) * cellSize;
  const grid: NavGrid = {
    originX,
    originY,
    columns: Math.floor(width / NAV_CELL_M),
    rows: Math.floor(height / NAV_CELL_M),
    blocked: new Uint8Array(Math.floor(width / NAV_CELL_M) * Math.floor(height / NAV_CELL_M)),
  };
  const { buildings, water } = obstacleIndex(terrain);
  const margin = OBSTACLE_CLEARANCE_M + (NAV_CELL_M * Math.SQRT2) / 2;
  for (const { building, box } of buildings) blockPolygon(grid, building.footprint, box, margin);
  // Water: no clearance, but a cell's centre must be half a cell diagonal from
  // the shore, so that no grid step between two free cells can cross it.
  const half = (NAV_CELL_M * Math.SQRT2) / 2;
  for (const { water: w, box } of water) blockPolygon(grid, w.boundary, box, half);
  gridCache.set(terrain, grid);
  return grid;
}

/**
 * Blocks every cell whose centre is inside the polygon (boundary included) or
 * closer than `margin` to its boundary: exactly the cells for which
 * `pointInPolygon(centre) || distanceToPolygon(centre) < margin`, but without
 * testing every cell of the polygon's bounds against every edge (which took
 * minutes for a large river).
 *
 * - Inside: along each row of cell centres, the even-odd ray cast toward +X
 *   crosses the same edges at the same x for every cell, so the crossings are
 *   computed once per row, with the same arithmetic as `pointInPolygon`, and a
 *   centre is inside when an odd number of them lie east of it. A centre on
 *   the boundary is at distance 0, so the margin test blocks it.
 * - Near the boundary: the distance is a minimum over edges, so each edge
 *   blocks the cells closer than `margin` to it; only the cells in a narrow
 *   band along the edge (one cell wider than needed on each side) are tested,
 *   with the same distance function.
 */
function blockPolygon(grid: NavGrid, polygon: readonly Vec2[], box: Box, margin: number): void {
  const { originX, originY, columns, blocked } = grid;
  const columnRange = (x0: number, x1: number): [number, number] => [
    Math.max(0, Math.floor((x0 - originX) / NAV_CELL_M)),
    Math.min(columns - 1, Math.ceil((x1 - originX) / NAV_CELL_M)),
  ];
  const rowRange = (y0: number, y1: number): [number, number] => [
    Math.max(0, Math.floor((y0 - originY) / NAV_CELL_M)),
    Math.min(grid.rows - 1, Math.ceil((y1 - originY) / NAV_CELL_M)),
  ];
  const [c0, c1] = columnRange(box.minX - margin, box.maxX + margin);
  const [r0, r1] = rowRange(box.minY - margin, box.maxY + margin);
  const n = polygon.length;

  // Inside.
  const crossings: number[] = [];
  for (let r = r0; r <= r1; r += 1) {
    const y = originY + (r + 0.5) * NAV_CELL_M;
    crossings.length = 0;
    for (let i = 0; i < n; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      if (a && b && a.y > y !== b.y > y)
        crossings.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    if (crossings.length === 0) continue;
    crossings.sort((u, v) => u - v);
    let west = 0; // crossings at or west of the centre
    for (let c = c0; c <= c1; c += 1) {
      const x = originX + (c + 0.5) * NAV_CELL_M;
      while (west < crossings.length && (crossings[west] ?? 0) <= x) west += 1;
      if ((crossings.length - west) % 2 === 1) blocked[r * columns + c] = 1;
    }
  }

  // Near the boundary.
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n] ?? a;
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const [er0, er1] = rowRange(Math.min(a.y, b.y) - margin, Math.max(a.y, b.y) + margin);
    for (let r = Math.max(r0, er0); r <= Math.min(r1, er1); r += 1) {
      const y = originY + (r + 0.5) * NAV_CELL_M;
      // The part of the edge within `margin` of this row of centres, widened by `margin`.
      let x0 = Math.min(a.x, b.x);
      let x1 = Math.max(a.x, b.x);
      if (dy !== 0) {
        const t0 = Math.min(1, Math.max(0, (y - margin - a.y) / dy));
        const t1 = Math.min(1, Math.max(0, (y + margin - a.y) / dy));
        x0 = Math.min(a.x + t0 * dx, a.x + t1 * dx);
        x1 = Math.max(a.x + t0 * dx, a.x + t1 * dx);
      }
      const [ec0, ec1] = columnRange(x0 - margin - NAV_CELL_M, x1 + margin + NAV_CELL_M);
      for (let c = Math.max(c0, ec0); c <= Math.min(c1, ec1); c += 1) {
        const cell = r * columns + c;
        if (blocked[cell]) continue;
        const p = { x: originX + (c + 0.5) * NAV_CELL_M, y };
        if (distanceToSegment(p, a, b) < margin) blocked[cell] = 1;
      }
    }
  }
}

/**
 * Whether two free cells are joined by grid steps, i.e. whether `aStar` can
 * find a path between them. Areas are labelled once per grid (`labelAreas`).
 */
function connected(grid: NavGrid, a: number, b: number): boolean {
  grid.areas ??= labelAreas(grid);
  return grid.areas[a] === grid.areas[b];
}

/**
 * Labels the connected areas of free cells under the steps `aStar` may take.
 * A diagonal step needs both cells beside it free, so it never joins cells
 * that two orthogonal steps would not: the areas are the 4-connected ones.
 * They are found from runs of free cells along each row, joining runs that
 * share a column with a run in the row below (union-find), so the work is
 * one pass over the cells rather than a flood fill. 0 marks blocked cells.
 */
function labelAreas(grid: NavGrid): Int32Array {
  const { columns, rows, blocked } = grid;
  const runRow: number[] = [];
  const runStart: number[] = [];
  const runEnd: number[] = []; // inclusive
  const parent: number[] = [];
  const find = (run: number): number => {
    let root = run;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    // Path compression.
    for (let x = run; x !== root;) {
      const next = parent[x] ?? root;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  let below = 0; // first run of the previous row
  for (let r = 0; r < rows; r += 1) {
    const first = runStart.length;
    for (let c = 0; c < columns;) {
      if (blocked[r * columns + c]) {
        c += 1;
        continue;
      }
      const c0 = c;
      while (c < columns && !blocked[r * columns + c]) c += 1;
      const run = runStart.length;
      runRow.push(r);
      runStart.push(c0);
      runEnd.push(c - 1);
      parent.push(run);
      // Join every run of the row below that shares a column with this one.
      for (let k = below; k < first; k += 1) {
        if ((runEnd[k] ?? -1) < c0) continue;
        if ((runStart[k] ?? columns) > c - 1) break;
        const a = find(k);
        const b = find(run);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
    below = first;
  }
  const areas = new Int32Array(blocked.length);
  for (let run = 0; run < runStart.length; run += 1) {
    const offset = (runRow[run] ?? 0) * columns;
    areas.fill(find(run) + 1, offset + (runStart[run] ?? 0), offset + (runEnd[run] ?? 0) + 1);
  }
  return areas;
}

function cellCentre(grid: NavGrid, cell: number): Vec2 {
  return {
    x: grid.originX + ((cell % grid.columns) + 0.5) * NAV_CELL_M,
    y: grid.originY + (Math.floor(cell / grid.columns) + 0.5) * NAV_CELL_M,
  };
}

/** The nearest free cell (ties: lowest index) joined to `p` by a walkable straight line. */
function connect(terrain: TerrainDataset, grid: NavGrid, p: Vec2): number | undefined {
  const c0 = Math.floor((p.x - grid.originX) / NAV_CELL_M);
  const r0 = Math.floor((p.y - grid.originY) / NAV_CELL_M);
  const candidates: { cell: number; distance: number }[] = [];
  for (let r = r0 - CONNECT_RADIUS_CELLS; r <= r0 + CONNECT_RADIUS_CELLS; r += 1) {
    for (let c = c0 - CONNECT_RADIUS_CELLS; c <= c0 + CONNECT_RADIUS_CELLS; c += 1) {
      if (r < 0 || c < 0 || r >= grid.rows || c >= grid.columns) continue;
      const cell = r * grid.columns + c;
      if (grid.blocked[cell]) continue;
      const centre = cellCentre(grid, cell);
      candidates.push({ cell, distance: Math.hypot(centre.x - p.x, centre.y - p.y) });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.cell - b.cell);
  return candidates.find(({ cell }) => isSegmentWalkable(terrain, p, cellCentre(grid, cell)))?.cell;
}

// The eight grid steps (column, row, length), as parallel arrays for the hot loops below.
const STEP_DC = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const STEP_DR = [0, 0, 1, -1, 1, -1, 1, -1] as const;
const STEP_COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2] as const;

/**
 * A* over the 8-connected grid with the octile-distance heuristic. Diagonal
 * steps may not cut a blocked corner. Ties are broken by lower f, then lower h,
 * then lower cell index, so the result never depends on insertion order.
 */
function aStar(grid: NavGrid, start: number, goal: number): number[] | undefined {
  const { columns, rows, blocked } = grid;
  const gc = goal % columns;
  const gr = Math.floor(goal / columns);
  const heuristic = (c: number, r: number) => {
    const dx = Math.abs(c - gc);
    const dy = Math.abs(r - gr);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  // Fresh typed arrays are zero-filled lazily, so a short search touches
  // little memory: `from` holds the parent cell + 1 (0: not reached yet, or
  // the start), and `g` is only read for cells already reached.
  const g = new Float64Array(blocked.length);
  const from = new Int32Array(blocked.length);
  const closed = new Uint8Array(blocked.length);
  const open = new MinHeap();
  const h0 = heuristic(start % columns, Math.floor(start / columns));
  open.push(h0, h0, start);

  while (open.size > 0) {
    const cell = open.pop();
    if (closed[cell]) continue;
    if (cell === goal) {
      const path = [goal];
      for (let c = (from[goal] ?? 0) - 1; c !== -1; c = (from[c] ?? 0) - 1) path.push(c);
      return path.reverse();
    }
    closed[cell] = 1;
    const c = cell % columns;
    const r = Math.floor(cell / columns);
    const gCell = g[cell] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      const dc = STEP_DC[k] ?? 0;
      const dr = STEP_DR[k] ?? 0;
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= columns || nr >= rows) continue;
      const next = nr * columns + nc;
      if (blocked[next] || closed[next]) continue;
      // Diagonal steps may not cut a blocked corner.
      if (dc !== 0 && dr !== 0 && (blocked[r * columns + nc] || blocked[nr * columns + c]))
        continue;
      const tentative = gCell + (STEP_COST[k] ?? 0);
      // The start is closed before any neighbour is reached, so `from` 0 here means unreached.
      if (from[next] === 0 || tentative < (g[next] ?? 0)) {
        g[next] = tentative;
        from[next] = cell + 1;
        const h = heuristic(nc, nr);
        open.push(tentative + h, h, next);
      }
    }
  }
  return undefined;
}

/**
 * Binary min-heap ordered by (f, h, cell), in typed arrays. Equal entries are
 * indistinguishable, so the order of pops depends only on what was pushed.
 */
class MinHeap {
  size = 0;
  private f = new Float64Array(4096);
  private h = new Float64Array(4096);
  private cells = new Int32Array(4096);

  push(f: number, h: number, cell: number): void {
    if (this.size === this.cells.length) this.grow();
    const fs = this.f;
    const hs = this.h;
    const cs = this.cells;
    let i = this.size;
    this.size += 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pf = fs[p] ?? 0;
      const ph = hs[p] ?? 0;
      const pc = cs[p] ?? 0;
      if (!(f < pf || (f === pf && (h < ph || (h === ph && cell < pc))))) break;
      fs[i] = pf;
      hs[i] = ph;
      cs[i] = pc;
      i = p;
    }
    fs[i] = f;
    hs[i] = h;
    cs[i] = cell;
  }

  pop(): number {
    if (this.size === 0) return -1;
    const fs = this.f;
    const hs = this.h;
    const cs = this.cells;
    const top = cs[0] ?? -1;
    this.size -= 1;
    const n = this.size;
    if (n === 0) return top;
    // Sift the last entry down from the root.
    const f = fs[n] ?? 0;
    const h = hs[n] ?? 0;
    const cell = cs[n] ?? 0;
    let i = 0;
    for (;;) {
      let m = 2 * i + 1;
      if (m >= n) break;
      let mf = fs[m] ?? 0;
      let mh = hs[m] ?? 0;
      let mc = cs[m] ?? 0;
      const r = m + 1;
      if (r < n) {
        const rf = fs[r] ?? 0;
        const rh = hs[r] ?? 0;
        const rc = cs[r] ?? 0;
        if (rf < mf || (rf === mf && (rh < mh || (rh === mh && rc < mc)))) {
          m = r;
          mf = rf;
          mh = rh;
          mc = rc;
        }
      }
      if (!(mf < f || (mf === f && (mh < h || (mh === h && mc < cell))))) break;
      fs[i] = mf;
      hs[i] = mh;
      cs[i] = mc;
      i = m;
    }
    fs[i] = f;
    hs[i] = h;
    cs[i] = cell;
    return top;
  }

  private grow(): void {
    const f = new Float64Array(this.cells.length * 2);
    const h = new Float64Array(this.cells.length * 2);
    const cells = new Int32Array(this.cells.length * 2);
    f.set(this.f);
    h.set(this.h);
    cells.set(this.cells);
    this.f = f;
    this.h = h;
    this.cells = cells;
  }
}
