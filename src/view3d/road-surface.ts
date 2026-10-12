import type { Road, RoadClass, Vec2 } from '#sim';
import { meshBuffers, type Draper, type MeshBuffers } from './drape';
import { Occupancy } from './planar';

// Road surfaces as one coherent paved area (docs/adr/0044). The road network
// is drawn from convex pieces, as before (docs/adr/0030): a rectangle for each
// segment, a fan on the outside of each bend, a junction area where ways meet,
// and now small fillets in the corners between vehicle roads. What changes is
// that the pieces no longer overlap: they are placed in order of priority
// (major roads first, then paved, unpaved, tracks and paths; wider before
// narrower; then by id), and each is cut by what was placed before it. So a
// side road stops at the edge of the road it joins, a junction is one surface
// in the style of its most important road, and two surfaces never lie on top
// of each other, whatever the angles, widths or number of ways.
//
// Levels: OpenStreetMap topology, not 2D geometry, decides what joins. Ways
// cut each other only when they are on the same level (bridge, tunnel and
// `layer` tags), or share a node (a bridge meeting its approach road). An
// overpass and the road under it, or a road under a bridge, stay whole.
// Tunnels (but not culverts, which are pipes under the road) are not drawn
// on the surface at all.

/** Road classes in order of priority, most important first. */
export const CLASS_PRIORITY: readonly RoadClass[] = ['major', 'paved', 'unpaved', 'track', 'path'];

/** Fan and disc smoothness: the largest angle one straight edge stands for. */
const ARC_STEP = Math.PI / 12;
/** Corner fillets: at most this radius (metres), and half the narrower road's width. */
const FILLET_MAX_M = 2.5;
/** Fillets only between roads meeting at between these angles (radians). */
const FILLET_MIN_ANGLE = (35 * Math.PI) / 180;
const FILLET_MAX_ANGLE = (150 * Math.PI) / 180;

/** Nodes shared by ways are matched to the millimetre. */
const key = (p: Vec2) => `${String(Math.round(p.x * 1000))},${String(Math.round(p.y * 1000))}`;

/** A line drawn on the surface. */
export interface SurfaceLine<S extends string> {
  readonly id: string;
  readonly style: S;
  /** Lower is drawn first and keeps its surface. */
  readonly rank: number;
  readonly centerline: readonly Vec2[];
  readonly halfWidth: number;
  /** The level the line is on: lines on different levels never cut each other. */
  readonly level: string;
  /** Vehicle roads get corner fillets where they meet. */
  readonly fillets: boolean;
  /** Other lines it counts as joined to (sharing a node), besides those found here. */
  readonly joins?: readonly string[];
  /**
   * Decoration that gives way to every other surface, whatever its level
   * (verges, driveways): cut even by a road on a bridge beside it.
   */
  readonly yields?: boolean;
  /**
   * Draw only the band beyond this half width (a verge along its road): two
   * strips per segment and a ring on the outside of each bend; no junction area.
   */
  readonly inner?: number;
}

/** The level a road is on: bridge or tunnel, and its mapped `layer`. */
export function roadLevel(road: Road): string {
  const c = road.crossing ?? (road.bridge ? { kind: 'bridge' as const } : undefined);
  const kind = c?.kind === 'bridge' || c?.kind === 'tunnel' ? c.kind : '';
  return `${kind}:${String(c?.layer ?? 0)}`;
}

/** Whether a road is drawn on the surface: everything but tunnels (a culvert is a pipe under the road). */
export function onSurface(road: Road): boolean {
  return !(road.crossing?.kind === 'tunnel' && road.crossing.value !== 'culvert');
}

interface Incidence {
  readonly line: number;
  /** Unit direction from the node along the segment. */
  readonly dx: number;
  readonly dy: number;
  /** Length of the segment. */
  readonly length: number;
}

interface Piece {
  readonly poly: readonly number[];
  readonly line: number;
  /** Order among a line's pieces: segments, then bends and junctions, then fillets. */
  readonly order: number;
}

export interface SurfaceStats {
  /** Time spent cutting pieces and draping them, ms. */
  readonly cutMs: number;
  readonly drapeMs: number;
  /** Convex pieces before and after cutting. */
  readonly pieces: number;
  readonly cutPieces: number;
  readonly junctions: number;
  readonly fillets: number;
}

/**
 * Drapes lines as disjoint surfaces, returning one mesh per style and the
 * occupancy (for subtracting later surfaces, e.g. verges and driveways).
 * `offset` gives each style's height above the ground.
 */
export function drapeSurface<S extends string>(
  lines: readonly SurfaceLine<S>[],
  draper: Draper,
  offset: (style: S) => number,
  occupancy = new Occupancy<SurfaceOwner>(interacts),
): {
  meshes: Map<S, MeshBuffers>;
  occupancy: Occupancy<SurfaceOwner>;
  /** For each line, the lines it is joined to. */
  joined: ReadonlyMap<string, ReadonlySet<string>>;
  stats: SurfaceStats;
} {
  const sorted = [...lines].sort(
    (a, b) =>
      a.rank - b.rank || b.halfWidth - a.halfWidth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  // The nodes: segments meeting at each shared point.
  const nodes = new Map<string, { p: Vec2; edges: Incidence[] }>();
  const points = sorted.map((line) => {
    const pts: Vec2[] = [];
    for (const p of line.centerline) {
      const last = pts[pts.length - 1];
      if (!last || key(last) !== key(p)) pts.push(p);
    }
    return pts;
  });
  sorted.forEach((_, li) => {
    const pts = points[li] ?? [];
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length === 0) continue;
      for (const [p, q] of [
        [a, b],
        [b, a],
      ] as const) {
        const k = key(p);
        let node = nodes.get(k);
        if (!node) {
          node = { p, edges: [] };
          nodes.set(k, node);
        }
        node.edges.push({
          line: li,
          dx: (q.x - p.x) / length,
          dy: (q.y - p.y) / length,
          length,
        });
      }
    }
  });
  // Lines joined at a node interact even on different levels (a bridge and its approach).
  const joined = sorted.map(() => new Set<string>());
  for (const { edges } of nodes.values()) {
    const ls = [...new Set(edges.map((e) => e.line))];
    for (const a of ls) for (const b of ls) if (a !== b) joined[a]?.add(sorted[b]?.id ?? '');
  }
  sorted.forEach((line, i) => {
    for (const id of line.joins ?? []) joined[i]?.add(id);
  });
  const owners: SurfaceOwner[] = sorted.map((line, i) => ({
    id: line.id,
    style: line.style,
    level: line.level,
    joined: joined[i] ?? new Set(),
    yields: line.yields === true,
  }));

  const pieces: Piece[] = [];
  let junctions = 0;
  let fillets = 0;
  sorted.forEach((line, li) => {
    const pts = points[li] ?? [];
    const h = line.halfWidth;
    const inner = line.inner;
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      const ux = -(b.y - a.y) / len;
      const uy = (b.x - a.x) / len;
      const band = (from: number, to: number) => [
        a.x + ux * from,
        a.y + uy * from,
        b.x + ux * from,
        b.y + uy * from,
        b.x + ux * to,
        b.y + uy * to,
        a.x + ux * to,
        a.y + uy * to,
      ];
      if (inner === undefined) pieces.push({ poly: band(-h, h), line: li, order: 0 });
      else {
        pieces.push({ poly: band(inner, h), line: li, order: 0 });
        pieces.push({ poly: band(-h, -inner), line: li, order: 0 });
      }
    }
  });
  // Bends and junctions, in a fixed order of nodes.
  const nodeList = [...nodes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [, { p, edges }] of nodeList) {
    if (edges.length < 2) continue; // a free end: cut square
    const [e1, e2] = edges;
    const l1 = e1 && sorted[e1.line];
    const l2 = e2 && sorted[e2.line];
    if (
      edges.length === 2 &&
      e1 &&
      e2 &&
      l1 &&
      l1.style === l2?.style &&
      l1.halfWidth === l2.halfWidth &&
      l1.level === l2.level
    ) {
      for (const poly of fan(p, e1, e2, l1.halfWidth, l1.inner))
        pieces.push({ poly, line: e1.line, order: 1 });
      continue;
    }
    junctions += 1;
    // A band (a verge) has no junction area: the roads there cover it.
    if (edges.every((e) => sorted[e.line]?.inner !== undefined)) continue;
    // A junction area per level: a disc as wide as the most important line there.
    const levels = [...new Set(edges.map((e) => sorted[e.line]?.level ?? ''))];
    for (const level of levels) {
      const mine = edges.filter((e) => sorted[e.line]?.level === level);
      const top = Math.min(...mine.map((e) => e.line));
      const owner = sorted[top];
      if (!owner) continue;
      const radius = Math.max(
        ...mine
          .filter((e) => sorted[e.line]?.style === owner.style)
          .map((e) => sorted[e.line]?.halfWidth ?? 0),
      );
      pieces.push({ poly: disc(p, radius), line: top, order: 1 });
      // Fillets in the corners between vehicle roads, in the style of the lesser road.
      const around = mine
        .filter((e) => sorted[e.line]?.fillets)
        .map((e) => ({ e, angle: Math.atan2(e.dy, e.dx) }))
        .sort((u, v) => u.angle - v.angle);
      if (around.length < 2) continue;
      around.forEach((u, k) => {
        const v = around[(k + 1) % around.length];
        if (!v || v === u) return;
        let gap = v.angle - u.angle;
        if (gap <= 0) gap += 2 * Math.PI;
        if (gap < FILLET_MIN_ANGLE || gap > FILLET_MAX_ANGLE) return;
        const lu = sorted[u.e.line];
        const lv = sorted[v.e.line];
        if (!lu || !lv) return;
        const poly = fillet(p, u.e, lu.halfWidth, v.e, lv.halfWidth, gap);
        if (poly.length === 0) return;
        fillets += 1;
        const lesser = Math.max(u.e.line, v.e.line);
        for (const tri of poly) pieces.push({ poly: tri, line: lesser, order: 2 });
      });
    }
  }
  // Placed by line priority, then piece order (stable within a line).
  const placed = pieces
    .map((piece, i) => ({ piece, i }))
    .sort((a, b) => a.piece.line - b.piece.line || a.piece.order - b.piece.order || a.i - b.i);
  const meshes = new Map<S, MeshBuffers>();
  let cutPieces = 0;
  let cutMs = 0;
  let drapeMs = 0;
  for (const { piece } of placed) {
    const line = sorted[piece.line];
    const owner = owners[piece.line];
    if (!line || !owner) continue;
    const t0 = performance.now();
    const free = occupancy.place(piece.poly, owner);
    const t1 = performance.now();
    cutMs += t1 - t0;
    let out = meshes.get(line.style);
    if (!out) {
      out = meshBuffers();
      meshes.set(line.style, out);
    }
    for (const poly of free) {
      draper.convex(poly, offset(line.style), out);
      cutPieces += 1;
    }
    drapeMs += performance.now() - t1;
  }
  return {
    meshes,
    occupancy,
    joined: new Map(owners.map((o) => [o.id, o.joined])),
    stats: { cutMs, drapeMs, pieces: pieces.length, cutPieces, junctions, fillets },
  };
}

/** Who placed a surface piece: a line, its level and the lines it shares a node with. */
export interface SurfaceOwner {
  readonly id: string;
  /** The surface layer (style) it is drawn in. */
  readonly style: string;
  readonly level: string;
  readonly joined: ReadonlySet<string>;
  readonly yields: boolean;
}

/**
 * Pieces of different surface layers cut each other when they are on the
 * same level, or on different levels where their lines are joined; a piece
 * that yields (a verge, a driveway) is cut by every other layer. Pieces of
 * one layer do not: they belong to one mesh of one material, draped exactly
 * on the same ground, so where they overlap they are the same surface, and
 * cutting them would only fragment the mesh.
 */
export function interacts(placed: SurfaceOwner, piece: SurfaceOwner): boolean {
  if (placed.style === piece.style) return false;
  return piece.yields || placed.level === piece.level || piece.joined.has(placed.id);
}

/**
 * Fills the gap on the outside of a bend between two segments of equal
 * width: triangles from the bend's point, or (for a band beyond `inner`)
 * quads of the ring between `inner` and `h`.
 */
function fan(p: Vec2, e1: Incidence, e2: Incidence, h: number, inner?: number): number[][] {
  const cos = e1.dx * e2.dx + e1.dy * e2.dy;
  if (cos < -0.999999) return []; // straight on: the rectangles already meet
  let n1x = -e1.dy;
  let n1y = e1.dx;
  if (n1x * e2.dx + n1y * e2.dy > 0) [n1x, n1y] = [-n1x, -n1y];
  let n2x = -e2.dy;
  let n2y = e2.dx;
  if (n2x * e1.dx + n2y * e1.dy > 0) [n2x, n2y] = [-n2x, -n2y];
  const a1 = Math.atan2(n1y, n1x);
  let sweep = Math.atan2(n1x * n2y - n1y * n2x, n1x * n2x + n1y * n2y);
  if (cos > 0.999999) sweep = Math.PI;
  if (Math.abs(sweep) < 1e-9) return [];
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const out: number[][] = [];
  let px = p.x + n1x * h;
  let py = p.y + n1y * h;
  for (let k = 1; k <= steps; k += 1) {
    const a = a1 + (sweep * k) / steps;
    const qx = p.x + Math.cos(a) * h;
    const qy = p.y + Math.sin(a) * h;
    if (inner === undefined) out.push([p.x, p.y, px, py, qx, qy]);
    else {
      const a0 = a1 + (sweep * (k - 1)) / steps;
      out.push([
        p.x + Math.cos(a0) * inner,
        p.y + Math.sin(a0) * inner,
        px,
        py,
        qx,
        qy,
        p.x + Math.cos(a) * inner,
        p.y + Math.sin(a) * inner,
      ]);
    }
    px = qx;
    py = qy;
  }
  return out;
}

/** A disc of radius `h` (corners just outside the circle, so its edge never cuts inside a line's width). */
function disc(p: Vec2, h: number): number[] {
  const steps = Math.max(8, Math.ceil((2 * Math.PI) / ARC_STEP));
  const r = h / Math.cos(Math.PI / steps);
  const points: number[] = [];
  for (let k = 0; k < steps; k += 1) {
    const a = (2 * Math.PI * k) / steps;
    points.push(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
  }
  return points;
}

/**
 * The fillet in the corner between two roads leaving a node at an angle
 * `gap` (counter-clockwise from `u` to `v`): the area between their facing
 * edges and an arc tangent to both, as triangles from the corner.
 */
function fillet(
  p: Vec2,
  u: Incidence,
  hu: number,
  v: Incidence,
  hv: number,
  gap: number,
): number[][] {
  // The facing edges: u's left edge, v's right edge.
  const ux = u.dx;
  const uy = u.dy;
  const vx = v.dx;
  const vy = v.dy;
  const au = { x: p.x - uy * hu, y: p.y + ux * hu };
  const av = { x: p.x + vy * hv, y: p.y - vx * hv };
  // Their intersection: the corner.
  const det = ux * vy - uy * vx;
  if (Math.abs(det) < 1e-9) return [];
  const t = ((av.x - au.x) * vy - (av.y - au.y) * vx) / det;
  const corner = { x: au.x + ux * t, y: au.y + uy * t };
  const s = ((av.x - au.x) * uy - (av.y - au.y) * ux) / det;
  if (t < 0 || s < 0) return [];
  const r = Math.min(FILLET_MAX_M, Math.min(hu, hv) * 0.75);
  // Distance from the corner to the tangent points along each edge.
  const d = r / Math.tan(gap / 2);
  // The tangent points must lie on the segments, past the corner.
  if (t + d > u.length * 0.5 || s + d > v.length * 0.5) return [];
  const tu = { x: corner.x + ux * d, y: corner.y + uy * d };
  const tv = { x: corner.x + vx * d, y: corner.y + vy * d };
  // The arc's centre: on the bisector, r from both edges.
  const bx = ux + vx;
  const by = uy + vy;
  const bl = Math.hypot(bx, by);
  if (bl < 1e-9) return [];
  const c = {
    x: corner.x + (bx / bl) * (r / Math.sin(gap / 2)),
    y: corner.y + (by / bl) * (r / Math.sin(gap / 2)),
  };
  const a0 = Math.atan2(tu.y - c.y, tu.x - c.x);
  let sweep = Math.atan2(tv.y - c.y, tv.x - c.x) - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (ARC_STEP / 2)));
  const out: number[][] = [];
  let prev = tu;
  for (let k = 1; k <= steps; k += 1) {
    const a = a0 + (sweep * k) / steps;
    const q = k === steps ? tv : { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
    out.push([corner.x, corner.y, prev.x, prev.y, q.x, q.y]);
    prev = q;
  }
  return out;
}
