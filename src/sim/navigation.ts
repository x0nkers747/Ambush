import { boundsOf, impassableWater, type Box, type Building, type WaterArea } from './environment';
import type { Vec2 } from './geometry';
import { pointInPolygon, segmentIntersectionParams } from './polygon';
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
  for (const { building, box } of obstacles(terrain)) {
    if (!near(box, p, OBSTACLE_CLEARANCE_M)) continue;
    if (pointInPolygon(p, building.footprint))
      return { kind: 'insideBuilding', buildingId: building.id };
    if (distanceToPolygon(p, building.footprint) < OBSTACLE_CLEARANCE_M) {
      return { kind: 'tooCloseToBuilding', buildingId: building.id };
    }
  }
  for (const { water, box } of waterObstacles(terrain)) {
    if (near(box, p, 0) && pointInPolygon(p, water.boundary)) {
      return { kind: 'inWater', waterId: water.id };
    }
  }
  return null;
}

/** Whether a soldier can walk straight from `a` to `b`, keeping clear of every building and out of water. */
export function isSegmentWalkable(terrain: TerrainDataset, a: Vec2, b: Vec2): boolean {
  // The terrain is a rectangle, so a segment between two points on it stays on it.
  if (!isOnTerrain(terrain, a.x, a.y) || !isOnTerrain(terrain, b.x, b.y)) return false;
  const segmentBox = boundsOf([a, b]);
  return (
    obstacles(terrain).every(
      ({ building, box }) =>
        !overlaps(box, segmentBox, OBSTACLE_CLEARANCE_M) ||
        segmentClearOfPolygon(a, b, building.footprint, OBSTACLE_CLEARANCE_M),
    ) &&
    waterObstacles(terrain).every(
      ({ water, box }) =>
        !overlaps(box, segmentBox, 0) || segmentClearOfPolygon(a, b, water.boundary, 0),
    )
  );
}

/**
 * A walkable path from `from` to `to`: the generated turn points between them.
 * Fails when `to` is not a valid place to stand or cannot be reached.
 */
export function planPath(terrain: TerrainDataset, from: Vec2, to: Vec2): PathResult {
  const problem = pointProblem(terrain, to);
  if (problem) return { ok: false, problem };
  if (isSegmentWalkable(terrain, from, to)) return { ok: true, turns: [] };

  const grid = navGrid(terrain);
  const start = connect(terrain, grid, from);
  const goal = connect(terrain, grid, to);
  if (start === undefined || goal === undefined)
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

const obstacleCache = new WeakMap<TerrainDataset, readonly Obstacle[]>();
const waterCache = new WeakMap<TerrainDataset, readonly { water: WaterArea; box: Box }[]>();

/** Impassable water with bounds, computed once per terrain. */
function waterObstacles(terrain: TerrainDataset): readonly { water: WaterArea; box: Box }[] {
  let list = waterCache.get(terrain);
  if (!list) {
    list = impassableWater(terrain.features).map((water) => ({
      water,
      box: boundsOf(water.boundary),
    }));
    waterCache.set(terrain, list);
  }
  return list;
}

/** Buildings with their bounds, computed once per terrain. A spatial index can replace this later. */
function obstacles(terrain: TerrainDataset): readonly Obstacle[] {
  let list = obstacleCache.get(terrain);
  if (!list) {
    list = terrain.features.buildings.map((building) => ({
      building,
      box: boundsOf(building.footprint),
    }));
    obstacleCache.set(terrain, list);
  }
  return list;
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

function edges(polygon: readonly Vec2[]): [Vec2, Vec2][] {
  return polygon.map((a, i) => [a, polygon[(i + 1) % polygon.length] ?? a]);
}

/** Distance from `p` to the polygon's boundary. */
function distanceToPolygon(p: Vec2, polygon: readonly Vec2[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const [a, b] of edges(polygon)) best = Math.min(best, distanceToSegment(p, a, b));
  return best;
}

/** Whether segment a–b stays outside the polygon and at least `clearance` from it. */
function segmentClearOfPolygon(
  a: Vec2,
  b: Vec2,
  polygon: readonly Vec2[],
  clearance: number,
): boolean {
  if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return false;
  for (const [p, q] of edges(polygon)) {
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
}

const gridCache = new WeakMap<TerrainDataset, NavGrid>();

/**
 * Cells whose centre lies inside a building, or within the clearance plus half
 * a cell diagonal of one, are blocked. That margin guarantees that a straight
 * step between two adjacent free cell centres keeps the full clearance, so
 * every grid path is walkable under the exact test.
 */
function navGrid(terrain: TerrainDataset): NavGrid {
  const cached = gridCache.get(terrain);
  if (cached) return cached;
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const width = (columns - 1) * cellSize;
  const height = (rows - 1) * cellSize;
  const grid = {
    originX,
    originY,
    columns: Math.floor(width / NAV_CELL_M),
    rows: Math.floor(height / NAV_CELL_M),
    blocked: new Uint8Array(Math.floor(width / NAV_CELL_M) * Math.floor(height / NAV_CELL_M)),
  };
  const margin = OBSTACLE_CLEARANCE_M + (NAV_CELL_M * Math.SQRT2) / 2;
  for (const { building, box } of obstacles(terrain)) {
    const c0 = Math.max(0, Math.floor((box.minX - margin - originX) / NAV_CELL_M));
    const c1 = Math.min(grid.columns - 1, Math.ceil((box.maxX + margin - originX) / NAV_CELL_M));
    const r0 = Math.max(0, Math.floor((box.minY - margin - originY) / NAV_CELL_M));
    const r1 = Math.min(grid.rows - 1, Math.ceil((box.maxY + margin - originY) / NAV_CELL_M));
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const p = cellCentre(grid, r * grid.columns + c);
        if (
          pointInPolygon(p, building.footprint) ||
          distanceToPolygon(p, building.footprint) < margin
        ) {
          grid.blocked[r * grid.columns + c] = 1;
        }
      }
    }
  }
  // Water: no clearance, but a cell's centre must be half a cell diagonal from
  // the shore, so that no grid step between two free cells can cross it.
  const half = (NAV_CELL_M * Math.SQRT2) / 2;
  for (const { water, box } of waterObstacles(terrain)) {
    const c0 = Math.max(0, Math.floor((box.minX - half - originX) / NAV_CELL_M));
    const c1 = Math.min(grid.columns - 1, Math.ceil((box.maxX + half - originX) / NAV_CELL_M));
    const r0 = Math.max(0, Math.floor((box.minY - half - originY) / NAV_CELL_M));
    const r1 = Math.min(grid.rows - 1, Math.ceil((box.maxY + half - originY) / NAV_CELL_M));
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const p = cellCentre(grid, r * grid.columns + c);
        if (pointInPolygon(p, water.boundary) || distanceToPolygon(p, water.boundary) < half) {
          grid.blocked[r * grid.columns + c] = 1;
        }
      }
    }
  }
  gridCache.set(terrain, grid);
  return grid;
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

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * A* over the 8-connected grid with the octile-distance heuristic. Diagonal
 * steps may not cut a blocked corner. Ties are broken by lower f, then lower h,
 * then lower cell index, so the result never depends on insertion order.
 */
function aStar(grid: NavGrid, start: number, goal: number): number[] | undefined {
  const gc = goal % grid.columns;
  const gr = Math.floor(goal / grid.columns);
  const heuristic = (cell: number) => {
    const dx = Math.abs((cell % grid.columns) - gc);
    const dy = Math.abs(Math.floor(cell / grid.columns) - gr);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const g = new Float64Array(grid.blocked.length).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(grid.blocked.length).fill(-1);
  const closed = new Uint8Array(grid.blocked.length);
  const open = new MinHeap();
  g[start] = 0;
  open.push(heuristic(start), heuristic(start), start);

  while (open.size > 0) {
    const cell = open.pop();
    if (closed[cell]) continue;
    if (cell === goal) {
      const path = [goal];
      for (let c = parent[goal] ?? -1; c !== -1; c = parent[c] ?? -1) path.push(c);
      return path.reverse();
    }
    closed[cell] = 1;
    const c = cell % grid.columns;
    const r = Math.floor(cell / grid.columns);
    for (const [dc, dr, cost] of NEIGHBOURS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= grid.columns || nr >= grid.rows) continue;
      const next = nr * grid.columns + nc;
      if (grid.blocked[next] || closed[next]) continue;
      if (
        dc !== 0 &&
        dr !== 0 &&
        (grid.blocked[r * grid.columns + nc] || grid.blocked[nr * grid.columns + c])
      )
        continue;
      const tentative = (g[cell] ?? 0) + cost;
      if (tentative < (g[next] ?? Number.POSITIVE_INFINITY)) {
        g[next] = tentative;
        parent[next] = cell;
        const h = heuristic(next);
        open.push(tentative + h, h, next);
      }
    }
  }
  return undefined;
}

/** Binary min-heap ordered by (f, h, cell). */
class MinHeap {
  private readonly items: [number, number, number][] = [];

  get size(): number {
    return this.items.length;
  }

  push(f: number, h: number, cell: number): void {
    const items = this.items;
    items.push([f, h, cell]);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(items[i], items[p])) break;
      swap(items, i, p);
      i = p;
    }
  }

  pop(): number {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (last && items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && less(items[l], items[m])) m = l;
        if (r < items.length && less(items[r], items[m])) m = r;
        if (m === i) break;
        swap(items, i, m);
        i = m;
      }
    }
    return top?.[2] ?? -1;
  }
}

function less(
  a: [number, number, number] | undefined,
  b: [number, number, number] | undefined,
): boolean {
  if (!a || !b) return false;
  return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
}

function swap(items: [number, number, number][], i: number, j: number): void {
  const t = items[i];
  const u = items[j];
  if (!t || !u) return;
  items[i] = u;
  items[j] = t;
}
