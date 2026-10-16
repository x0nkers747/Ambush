import { bridgeSurfaces, deckBetween, type NavBridge, type PathPoint } from './bridge-navigation';
import type { Road } from './environment';
import type { Vec2 } from './geometry';
import {
  bridgeCrossings,
  isSegmentWalkable,
  pathLength,
  planOffRoad,
  type PathResult,
} from './navigation';
import type { TerrainDataset } from './terrain';

// Road following (docs/adr/0043). The roads of a terrain as a graph: a node
// at every vertex of every road (OSM ways keep their geometry, so a node
// shared by two ways has the same coordinates in both), an edge between
// consecutive vertices, as long as the line between them. Ways join only
// where they share a node, and not where the node is in the middle of both
// and they are on different levels (a bridge or a tunnel, or another
// `layer`): roads that cross without a junction stay apart. An edge must be
// walkable (clear of buildings and out of water) or run along the deck of a
// bridge soldiers can cross; on a deck it follows the deck's centreline and
// height.
//
// A route to a destination on a road (within `ROAD_REACH_M` of its edge)
// joins the network at the nearest point the soldier can walk to (off road,
// `planOffRoad`), follows the shortest way along the roads, and leaves the
// road at the destination. A destination off the roads, or on
// roads the soldier cannot join, is planned off road as before. Pure and
// deterministic; the network is built once per terrain.

/** A destination this close to a road's edge (metres) is on the road. */
export const ROAD_REACH_M = 2;
/** How many of the nearest road edges are checked, by planning the walk to them, for joining the network. */
const ENTRY_CHECKS = 3;

interface Edge {
  readonly a: number;
  readonly b: number;
  readonly length: number;
  /** The way it belongs to (index into the terrain's roads, sorted by id). */
  readonly road: number;
  /** Half the road's width, metres. */
  readonly halfWidth: number;
  /** The points walked from `a` to `b`: `a`, a bridge deck's centreline points if on one, `b`. */
  readonly points: readonly PathPoint[];
}

export interface RoadNetwork {
  /** Node positions (with the deck's height on a bridge). */
  readonly nodes: readonly PathPoint[];
  readonly edges: readonly Edge[];
  /** Connected part of each node: nodes of the same part are joined by roads. */
  readonly component: Int32Array;
  /** The roads the network was built from, sorted by id. */
  readonly roads: readonly Road[];
  /** Edges left out because they are not walkable (through a building, or over water with no bridge). */
  readonly blockedEdges: number;
}

/** A point on an edge. */
interface EdgePoint {
  readonly edge: number;
  /** Fraction along the edge from `a`. */
  readonly t: number;
  readonly point: PathPoint;
  readonly distance: number;
}

const cache = new WeakMap<TerrainDataset, Built>();

interface Built {
  readonly network: RoadNetwork;
  /** Edges by node (CSR). */
  readonly start: Int32Array;
  readonly incident: Int32Array;
  /** Edge buckets for nearest-edge queries. */
  readonly buckets: Map<number, number[]>;
}

const BUCKET_M = 50;
const bucketKey = (gx: number, gy: number) => gx * 100_003 + gy;
const coordKey = (p: Vec2) => `${String(Math.round(p.x * 1000))},${String(Math.round(p.y * 1000))}`;

/** The level a way is on: bridges and tunnels, and the mapped `layer`. */
function levelOf(road: Road): string {
  const c = road.crossing ?? (road.bridge ? { kind: 'bridge' as const } : undefined);
  const kind = c?.kind === 'bridge' || c?.kind === 'tunnel' ? c.kind : '';
  return `${kind}:${String(c?.layer ?? 0)}`;
}

/** The road network of a terrain, built once per terrain. */
export function roadNetwork(terrain: TerrainDataset): RoadNetwork {
  return built(terrain).network;
}

function built(terrain: TerrainDataset): Built {
  const cached = cache.get(terrain);
  if (cached) return cached;
  const roads = [...terrain.features.roads].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  // Bridges a road may run along: those soldiers can cross, and those over
  // water they may wade (watercourses), whose deck is still the surface walked.
  const { bridges } = bridgeSurfaces(terrain);
  const rejected = new Set(bridgeCrossings(terrain).rejected.map((r) => r.id));
  const usable = bridges.filter((b) => !rejected.has(b.id));
  const carrying = new Map<string, NavBridge[]>();
  for (const b of usable) {
    for (const id of b.roadIds) carrying.set(id, [...(carrying.get(id) ?? []), b]);
  }

  // Each way's vertices, with its bridges' ends inserted where they fall inside a segment.
  const ways = roads.map((road) => {
    let pts: Vec2[] = [...road.centerline];
    for (const b of carrying.get(road.id) ?? []) {
      for (const end of [b.points[0], b.points[b.points.length - 1]]) {
        if (end) pts = insertOnLine(pts, end);
      }
    }
    return pts;
  });

  // Nodes: occurrences at the same coordinates join where they are on the same
  // level, or where either is the end of its way (a bridge meets its approach).
  interface Occurrence {
    readonly way: number;
    readonly vertex: number;
    readonly end: boolean;
    readonly level: string;
  }
  const groups = new Map<string, Occurrence[]>();
  ways.forEach((pts, way) => {
    const level = levelOf(roads[way] ?? ({} as Road));
    pts.forEach((p, vertex) => {
      const key = coordKey(p);
      const occ = { way, vertex, end: vertex === 0 || vertex === pts.length - 1, level };
      const list = groups.get(key);
      if (list) list.push(occ);
      else groups.set(key, [occ]);
    });
  });
  const nodes: PathPoint[] = [];
  const nodeOf = ways.map((pts) => new Int32Array(pts.length).fill(-1));
  for (const list of groups.values()) {
    // Union occurrences that join (small groups: pairwise).
    const parent = list.map((_, i) => i);
    const find = (i: number): number => {
      let r = i;
      while (parent[r] !== r) r = parent[r] ?? r;
      return r;
    };
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a && b && (a.level === b.level || a.end || b.end)) {
          const ra = find(i);
          const rb = find(j);
          if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
        }
      }
    }
    const ids = new Map<number, number>();
    list.forEach((occ, i) => {
      const root = find(i);
      let id = ids.get(root);
      if (id === undefined) {
        const p = ways[occ.way]?.[occ.vertex] ?? { x: 0, y: 0 };
        id = nodes.length;
        nodes.push({ x: p.x, y: p.y });
        ids.set(root, id);
      }
      const row = nodeOf[occ.way];
      if (row) row[occ.vertex] = id;
    });
  }

  // Edges.
  const edges: Edge[] = [];
  let blockedEdges = 0;
  ways.forEach((pts, way) => {
    const road = roads[way];
    if (!road) return;
    const row = nodeOf[way];
    for (let k = 1; k < pts.length; k += 1) {
      const p = pts[k - 1];
      const q = pts[k];
      const a = row?.[k - 1] ?? -1;
      const b = row?.[k] ?? -1;
      if (!p || !q || a < 0 || b < 0 || a === b) continue;
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (length === 0) continue;
      // Along a bridge's deck: its centreline and height.
      let points: PathPoint[] | null = null;
      for (const bridge of carrying.get(road.id) ?? []) {
        const sp = alongBridge(bridge, p);
        const sq = alongBridge(bridge, q);
        const mid = alongBridge(bridge, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
        if (sp !== null && sq !== null && mid !== null) {
          points = deckBetween(bridge, sp, sq);
          points[0] = { ...p, z: points[0]?.z ?? 0 };
          points[points.length - 1] = { ...q, z: points[points.length - 1]?.z ?? 0 };
          break;
        }
      }
      if (!points) {
        if (!isSegmentWalkable(terrain, p, q)) {
          blockedEdges += 1;
          continue;
        }
        points = [p, q];
      }
      edges.push({ a, b, length, road: way, halfWidth: road.widthMeters / 2, points });
    }
  });
  // Deck heights on the nodes at deck edges' ends.
  for (const e of edges) {
    const pa = e.points[0];
    const pb = e.points[e.points.length - 1];
    if (pa?.z !== undefined)
      nodes[e.a] = { x: nodes[e.a]?.x ?? pa.x, y: nodes[e.a]?.y ?? pa.y, z: pa.z };
    if (pb?.z !== undefined)
      nodes[e.b] = { x: nodes[e.b]?.x ?? pb.x, y: nodes[e.b]?.y ?? pb.y, z: pb.z };
  }

  // Incidence (CSR) and connected parts.
  const counts = new Int32Array(nodes.length + 1);
  for (const e of edges) {
    counts[e.a + 1] = (counts[e.a + 1] ?? 0) + 1;
    counts[e.b + 1] = (counts[e.b + 1] ?? 0) + 1;
  }
  for (let i = 1; i < counts.length; i += 1) counts[i] = (counts[i] ?? 0) + (counts[i - 1] ?? 0);
  const start = counts;
  const fill = start.slice(0, nodes.length);
  const incident = new Int32Array(edges.length * 2);
  edges.forEach((e, i) => {
    for (const n of [e.a, e.b]) {
      const at = fill[n] ?? 0;
      incident[at] = i;
      fill[n] = at + 1;
    }
  });
  const component = new Int32Array(nodes.length).fill(-1);
  let parts = 0;
  for (let n = 0; n < nodes.length; n += 1) {
    if (component[n] !== -1) continue;
    const stack = [n];
    component[n] = parts;
    while (stack.length > 0) {
      const u = stack.pop() ?? 0;
      for (let k = start[u] ?? 0; k < (start[u + 1] ?? 0); k += 1) {
        const e = edges[incident[k] ?? 0];
        if (!e) continue;
        const v = e.a === u ? e.b : e.a;
        if (component[v] === -1) {
          component[v] = parts;
          stack.push(v);
        }
      }
    }
    parts += 1;
  }

  // Edge buckets.
  const buckets = new Map<number, number[]>();
  edges.forEach((e, i) => {
    const p = nodes[e.a];
    const q = nodes[e.b];
    if (!p || !q) return;
    for (
      let gx = Math.floor(Math.min(p.x, q.x) / BUCKET_M);
      gx <= Math.floor(Math.max(p.x, q.x) / BUCKET_M);
      gx += 1
    ) {
      for (
        let gy = Math.floor(Math.min(p.y, q.y) / BUCKET_M);
        gy <= Math.floor(Math.max(p.y, q.y) / BUCKET_M);
        gy += 1
      ) {
        const k = bucketKey(gx, gy);
        const list = buckets.get(k);
        if (list) list.push(i);
        else buckets.set(k, [i]);
      }
    }
  });

  const result: Built = {
    network: { nodes, edges, component, roads, blockedEdges },
    start,
    incident,
    buckets,
  };
  cache.set(terrain, result);
  return result;
}

/** A polyline with `p` inserted where it lies inside a segment (within 1 cm), unless it is a vertex already. */
function insertOnLine(pts: readonly Vec2[], p: Vec2): Vec2[] {
  if (pts.some((v) => Math.hypot(v.x - p.x, v.y - p.y) < 0.01)) return [...pts];
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    if (distanceToSegment(p, a, b) < 0.01) return [...pts.slice(0, i), p, ...pts.slice(i)];
  }
  return [...pts];
}

/** Distance along a bridge's centreline of a point on it (within 0.3 m of its samples' line), or `null`. */
function alongBridge(bridge: NavBridge, p: Vec2): number | null {
  const { xy, deck } = bridge.bridge;
  const step = bridge.length / Math.max(1, deck.length - 1);
  let best: { d: number; s: number } | null = null;
  for (let i = 0; i + 3 < xy.length; i += 2) {
    const ax = xy[i] ?? 0;
    const ay = xy[i + 1] ?? 0;
    const dx = (xy[i + 2] ?? 0) - ax;
    const dy = (xy[i + 3] ?? 0) - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy);
    if (d <= 0.3 && (!best || d < best.d)) best = { d, s: (i / 2 + t) * step };
  }
  return best?.s ?? null;
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** The point of edge `i` nearest `p`. */
function onEdge(net: RoadNetwork, i: number, p: Vec2): EdgePoint | null {
  const e = net.edges[i];
  const a = e && net.nodes[e.a];
  const b = e && net.nodes[e.b];
  if (!e || !a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  const point: PathPoint =
    a.z !== undefined && b.z !== undefined ? { x, y, z: a.z + t * (b.z - a.z) } : { x, y };
  return { edge: i, t, point, distance: Math.hypot(p.x - x, p.y - y) };
}

/**
 * The road point a destination is on: the nearest point of an edge whose
 * road's edge (half its width plus `ROAD_REACH_M`) reaches it; `null` when it
 * is off the roads. Ties: the lowest edge.
 */
export function roadPointAt(terrain: TerrainDataset, p: Vec2): EdgePoint | null {
  const { network: net, buckets } = built(terrain);
  let best: EdgePoint | null = null;
  const seen = new Set<number>();
  const gx = Math.floor(p.x / BUCKET_M);
  const gy = Math.floor(p.y / BUCKET_M);
  // Roads are narrower than a bucket: the neighbouring buckets hold every edge in reach.
  const near = [-1, 0, 1].flatMap((dx) =>
    [-1, 0, 1].flatMap((dy) => buckets.get(bucketKey(gx + dx, gy + dy)) ?? []),
  );
  for (const i of near) {
    if (seen.has(i)) continue;
    seen.add(i);
    const e = net.edges[i];
    const q = onEdge(net, i, p);
    if (!e || !q || q.distance > e.halfWidth + ROAD_REACH_M) continue;
    if (!best || q.distance < best.distance || (q.distance === best.distance && i < best.edge))
      best = q;
  }
  return best;
}

/** The nearest points of the nearest `count` edges of component `part` (−1: any), nearest first (ties: lowest edge). */
function nearestEdges(b: Built, p: Vec2, part: number, count: number): EdgePoint[] {
  const net = b.network;
  const gx = Math.floor(p.x / BUCKET_M);
  const gy = Math.floor(p.y / BUCKET_M);
  const found = new Map<number, EdgePoint>();
  const maxRing = Math.ceil(10_000 / BUCKET_M);
  for (let r = 0; r <= maxRing; r += 1) {
    for (let x = gx - r; x <= gx + r; x += 1) {
      for (let y = gy - r; y <= gy + r; y += 1) {
        if (Math.max(Math.abs(x - gx), Math.abs(y - gy)) !== r) continue;
        for (const i of b.buckets.get(bucketKey(x, y)) ?? []) {
          if (found.has(i)) continue;
          const e = net.edges[i];
          if (!e || (part >= 0 && net.component[e.a] !== part)) continue;
          const q = onEdge(net, i, p);
          if (q) found.set(i, q);
        }
      }
    }
    // Every edge not yet seen is at least r bucket widths away.
    const sorted = [...found.values()].sort((u, v) => u.distance - v.distance || u.edge - v.edge);
    const kth = sorted[count - 1];
    if (kth && kth.distance <= r * BUCKET_M) return sorted.slice(0, count);
  }
  return [...found.values()]
    .sort((u, v) => u.distance - v.distance || u.edge - v.edge)
    .slice(0, count);
}

/**
 * Shortest distances along the roads from every node to a point on an edge
 * (Dijkstra; ties by node), and each node's next node toward it (−2: along
 * the goal's own edge to the goal; −1: not reached).
 */
function distancesTo(b: Built, goal: EdgePoint): { dist: Float64Array; next: Int32Array } {
  const net = b.network;
  const dist = new Float64Array(net.nodes.length).fill(Infinity);
  const next = new Int32Array(net.nodes.length).fill(-1);
  const done = new Uint8Array(net.nodes.length);
  const e = net.edges[goal.edge];
  const heap: [number, number][] = [];
  const push = (d: number, n: number) => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const hp = heap[p];
      const hi = heap[i];
      if (!hp || !hi || hp[0] < hi[0] || (hp[0] === hi[0] && hp[1] <= hi[1])) break;
      heap[p] = hi;
      heap[i] = hp;
      i = p;
    }
  };
  const pop = (): [number, number] | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        const less = (u: number, v: number) => {
          const a = heap[u];
          const c = heap[v];
          return !!a && !!c && (a[0] < c[0] || (a[0] === c[0] && a[1] < c[1]));
        };
        if (l < heap.length && less(l, m)) m = l;
        if (r < heap.length && less(r, m)) m = r;
        if (m === i) break;
        const hm = heap[m];
        const hi = heap[i];
        if (!hm || !hi) break;
        heap[m] = hi;
        heap[i] = hm;
        i = m;
      }
    }
    return top;
  };
  if (e) {
    for (const [n, d] of [
      [e.a, goal.t * e.length],
      [e.b, (1 - goal.t) * e.length],
    ] as const) {
      if (d < (dist[n] ?? Infinity)) {
        dist[n] = d;
        next[n] = -2;
        push(d, n);
      }
    }
  }
  for (let top = pop(); top; top = pop()) {
    const [d, u] = top;
    if (done[u]) continue;
    done[u] = 1;
    for (let k = b.start[u] ?? 0; k < (b.start[u + 1] ?? 0); k += 1) {
      const edge = net.edges[b.incident[k] ?? 0];
      if (!edge) continue;
      const v = edge.a === u ? edge.b : edge.a;
      const nd = d + edge.length;
      if (nd < (dist[v] ?? Infinity) || (nd === dist[v] && u < (next[v] ?? -1))) {
        if (nd < (dist[v] ?? Infinity)) push(nd, v);
        dist[v] = nd;
        next[v] = u;
      }
    }
  }
  return { dist, next };
}

/** The points walked along edge `i` from node `from` to its other node. */
function edgeWalk(net: RoadNetwork, i: number, from: number): readonly PathPoint[] {
  const e = net.edges[i];
  if (!e) return [];
  return e.a === from ? e.points : [...e.points].reverse();
}

/** The edge joining two nodes (the shortest, then the lowest). */
function edgeBetween(b: Built, u: number, v: number): number {
  let best = -1;
  for (let k = b.start[u] ?? 0; k < (b.start[u + 1] ?? 0); k += 1) {
    const i = b.incident[k] ?? 0;
    const e = b.network.edges[i];
    if (!e || (e.a === u ? e.b : e.a) !== v) continue;
    const cur = b.network.edges[best];
    if (best < 0 || !cur || e.length < cur.length) best = i;
  }
  return best;
}

/** The points walked along an edge from fraction `t0` to `t1`. */
function edgePart(net: RoadNetwork, i: number, t0: number, t1: number): PathPoint[] {
  const e = net.edges[i];
  if (!e) return [];
  const pts = e.points;
  if (pts.length === 2) {
    const a = onEdgeAt(net, i, t0);
    const b = onEdgeAt(net, i, t1);
    return [a, b];
  }
  // A deck edge: its points between, by their position along the edge.
  const a = net.nodes[e.a] ?? { x: 0, y: 0 };
  const b = net.nodes[e.b] ?? a;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const tOf = (p: Vec2) => ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  const between = pts.slice(1, -1).filter((p) => tOf(p) > lo && tOf(p) < hi);
  if (t1 < t0) between.reverse();
  return [onEdgeAt(net, i, t0), ...between, onEdgeAt(net, i, t1)];
}

/** The point at fraction `t` of edge `i` (with the deck's height on a deck edge). */
function onEdgeAt(net: RoadNetwork, i: number, t: number): PathPoint {
  const e = net.edges[i];
  const a = e && net.nodes[e.a];
  const b = e && net.nodes[e.b];
  if (!a || !b) return { x: 0, y: 0 };
  const x = a.x + t * (b.x - a.x);
  const y = a.y + t * (b.y - a.y);
  return a.z !== undefined && b.z !== undefined ? { x, y, z: a.z + t * (b.z - a.z) } : { x, y };
}

/**
 * A road route from `entry` to `goal` (points on edges), given the distances
 * to the goal: the points walked, and its length. `null` when not joined.
 */
function roadRoute(
  b: Built,
  entry: EdgePoint,
  goal: EdgePoint,
  toGoal: { dist: Float64Array; next: Int32Array },
): { points: PathPoint[]; length: number } | null {
  const net = b.network;
  const e = net.edges[entry.edge];
  if (!e) return null;
  const options: { points: PathPoint[]; length: number }[] = [];
  if (entry.edge === goal.edge) {
    options.push({
      points: edgePart(net, entry.edge, entry.t, goal.t),
      length: Math.abs(entry.t - goal.t) * e.length,
    });
  }
  for (const [node, t, along] of [
    [e.a, 0, entry.t * e.length],
    [e.b, 1, (1 - entry.t) * e.length],
  ] as const) {
    const rest = toGoal.dist[node] ?? Infinity;
    if (!Number.isFinite(rest)) continue;
    const points = edgePart(net, entry.edge, entry.t, t);
    let u: number = node;
    for (let guard = 0; guard <= net.nodes.length; guard += 1) {
      const v = toGoal.next[u] ?? -1;
      if (v === -2) {
        const g = net.edges[goal.edge];
        points.push(...edgePart(net, goal.edge, g?.a === u ? 0 : 1, goal.t).slice(1));
        break;
      }
      if (v < 0) return null;
      const i = edgeBetween(b, u, v);
      points.push(...edgeWalk(net, i, u).slice(1));
      u = v;
    }
    options.push({ points, length: along + rest });
  }
  options.sort((p, q) => p.length - q.length);
  return options[0] ?? null;
}

/** A way to a destination by the roads (`roadsRoute`). */
export interface RoadsRoute {
  /** Every turn of the way, from the start to the destination (as `planPath`'s). */
  readonly turns: readonly PathPoint[];
  /** The off-road walk to the road: its turns, and where it joins the road. */
  readonly joinTurns: readonly PathPoint[];
  readonly entry: PathPoint;
  /** Along the roads: their points from where it joins to where it leaves (both included). */
  readonly road: readonly PathPoint[];
  /** Where it leaves the road, and the off-road walk from there to the destination. */
  readonly exit: PathPoint;
  readonly leaveTurns: readonly PathPoint[];
}

/**
 * The way from `from` to `to` that prefers the roads (a Move order's Prefer
 * roads): off road to the nearest road it can walk to, along the roads to the
 * point of them nearest `to` that `to` can be walked to from, and off road to
 * `to` (which need not be on a road). Of the nearest few roads at each end,
 * the shortest walks, then the shortest road. `null` when no road helps: none
 * can be joined, or the walks to and from the roads come to at least the
 * way straight there (it goes straight there instead).
 */
export function roadsRoute(terrain: TerrainDataset, from: Vec2, to: Vec2): RoadsRoute | null {
  const b = built(terrain);
  const net = b.network;
  if (net.edges.length === 0) return null;
  const direct = planOffRoad(terrain, from, to);
  const straight = direct.ok ? pathLength(from, direct.turns, to) : Infinity;
  let best: (RoadsRoute & { walk: number; length: number }) | null = null;
  for (const goal of nearestEdges(b, to, -1, ENTRY_CHECKS)) {
    const leave = planOffRoad(terrain, goal.point, to);
    if (!leave.ok) continue;
    const leaveWalk = pathLength(goal.point, leave.turns, to);
    if (leaveWalk >= straight) continue;
    const goalEdge = net.edges[goal.edge];
    const part = goalEdge ? (net.component[goalEdge.a] ?? -1) : -1;
    const toGoal = distancesTo(b, goal);
    const here = roadPointAt(terrain, from);
    const hereEdge = here && net.edges[here.edge];
    const entries =
      here && hereEdge && net.component[hereEdge.a] === part
        ? [here]
        : nearestEdges(b, from, part, ENTRY_CHECKS);
    for (const entry of entries) {
      const join = planOffRoad(terrain, from, entry.point);
      if (!join.ok) continue;
      const walk = pathLength(from, join.turns, entry.point) + leaveWalk;
      // Roads help only if the walks to and from them are shorter than the way straight there.
      if (walk >= straight) continue;
      const route = roadRoute(b, entry, goal, toGoal);
      if (!route) continue;
      if (best && (walk > best.walk || (walk === best.walk && route.length >= best.length)))
        continue;
      best = {
        turns: dedupe([...join.turns, ...route.points, ...leave.turns], from, to),
        joinTurns: join.turns,
        entry: entry.point,
        road: route.points,
        exit: goal.point,
        leaveTurns: leave.turns,
        walk,
        length: route.length,
      };
    }
  }
  if (!best) return null;
  const { turns, joinTurns, entry, road, exit, leaveTurns } = best;
  return { turns, joinTurns, entry, road, exit, leaveTurns };
}

/**
 * `planPath` with `followRoads` (docs/adr/0043) to a standable `to`: by the
 * roads when they help (`roadsRoute`), else off road.
 */
export function planRoadPath(terrain: TerrainDataset, from: Vec2, to: Vec2): PathResult {
  const best = roadsRoute(terrain, from, to);
  // No road helps, or none the soldier can join: off road, if anything.
  return best ? { ok: true, turns: best.turns } : planOffRoad(terrain, from, to);
}

/** Of a road waypoint route, points kept no closer than this (metres), but for the last. */
export const ROAD_WAYPOINT_SPACING_M = 25;
/** A road waypoint route keeps only turns that leave the straight line by more than this (metres). */
const ROAD_WAYPOINT_TOLERANCE_M = 3;

/**
 * Waypoints from `from` along the roads to `to` (docs/adr/0043), for a squad
 * told to move to a point on a road: where it joins the nearest road it can
 * walk to, the road's turns (simplified to within a few metres of the road,
 * at most one every `ROAD_WAYPOINT_SPACING_M`), and `to`. `null` when `to`
 * is off the roads or no road leading there can be joined.
 */
export function roadWaypoints(terrain: TerrainDataset, from: Vec2, to: Vec2): Vec2[] | null {
  const best = bestRoadRoute(terrain, from, to);
  if (!best) return null;
  const road = simplify(
    best.road.map((p) => ({ x: p.x, y: p.y })),
    ROAD_WAYPOINT_TOLERANCE_M,
  );
  const out: Vec2[] = [];
  for (const p of [...road, { x: to.x, y: to.y }]) {
    const last = out.at(-1);
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < ROAD_WAYPOINT_SPACING_M) out.pop();
    out.push(p);
  }
  // Where it joins the road is kept (spacing aside), unless it is about where it stands.
  const first = road[0];
  if (first && out[0] !== first) out.unshift(first);
  while (out.length > 1 && out[0] && Math.hypot(out[0].x - from.x, out[0].y - from.y) < 5)
    out.shift();
  return out;
}

/** Douglas–Peucker: the points of a polyline that keep it within `tolerance` metres. */
function simplify(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop() ?? [0, 0];
    const a = points[i];
    const b = points[j];
    if (!a || !b) continue;
    let worst = -1;
    let far = tolerance;
    for (let k = i + 1; k < j; k += 1) {
      const p = points[k];
      if (!p) continue;
      const d = distanceToSegment(p, a, b);
      if (d > far) {
        far = d;
        worst = k;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return points.filter((_, k) => keep[k] === 1);
}

/**
 * The way from `from` to `to` along the roads: the walk to join them, the
 * road route (from where it joins to where it leaves), and the walk off to
 * `to`. `null` when `to` is off the roads or no road leading there can be joined.
 */
function bestRoadRoute(
  terrain: TerrainDataset,
  from: Vec2,
  to: Vec2,
): { turns: PathPoint[]; road: PathPoint[] } | null {
  const b = built(terrain);
  const net = b.network;
  const goal = roadPointAt(terrain, to);
  if (!goal) return null;
  const goalEdge = net.edges[goal.edge];
  const part = goalEdge ? (net.component[goalEdge.a] ?? -1) : -1;
  const toGoal = distancesTo(b, goal);
  // Where to join: on the road the soldier stands on (if joined to the goal's);
  // else the nearest point of the goal's roads the soldier can walk to: of the
  // nearest few, the one with the shortest walk (then the shorter road route).
  const here = roadPointAt(terrain, from);
  const hereEdge = here && net.edges[here.edge];
  const candidates =
    here && hereEdge && net.component[hereEdge.a] === part
      ? [here]
      : nearestEdges(b, from, part, ENTRY_CHECKS);
  let best: { turns: PathPoint[]; walk: number; road: number; points: PathPoint[] } | null = null;
  for (const entry of candidates) {
    const route = roadRoute(b, entry, goal, toGoal);
    if (!route) continue;
    const join = planOffRoad(terrain, from, entry.point);
    if (!join.ok) continue;
    const walk = pathLength(from, join.turns, entry.point);
    if (best && (walk > best.walk || (walk === best.walk && route.length >= best.road))) continue;
    // Then off the road to the destination.
    const leave = planOffRoad(terrain, goal.point, to);
    if (!leave.ok) continue;
    best = {
      turns: dedupe([...join.turns, ...route.points, ...leave.turns], from, to),
      walk,
      road: route.length,
      points: route.points,
    };
  }
  return best ? { turns: best.turns, road: best.points } : null;
}

/** Drops points equal to the one before them (and to the start or the destination). */
function dedupe(points: readonly PathPoint[], from: Vec2, to: Vec2): PathPoint[] {
  const out: PathPoint[] = [];
  let last: Vec2 = from;
  for (const p of points) {
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) continue;
    out.push(p);
    last = p;
  }
  while (out.length > 0) {
    const tail = out[out.length - 1];
    if (tail && Math.hypot(tail.x - to.x, tail.y - to.y) < 1e-6) out.pop();
    else break;
  }
  return out;
}
