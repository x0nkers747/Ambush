import type { Vec2 } from '#sim';
import { meshBuffers, type Draper, type MeshBuffers } from './drape';

// Continuous ribbons for networks of lines: roads and waterways
// (docs/adr/0030). OpenStreetMap cuts one visible road into many ways, and
// ways meet at junctions of every shape. Rather than offsetting each way into
// a ribbon (which folds over itself on tight bends and leaves wedges or
// overlaps where ways meet), the network is drawn as the union of simple
// convex pieces, all draped on the ground at the same height for one style:
//
//   - a rectangle for every segment of every centreline;
//   - where exactly two segments of one style and width meet (a bend, or one
//     way continuing another), a fan filling the gap on the outside of the
//     bend, so the edge stays continuous and round;
//   - at a junction or where the width or style changes, a disc as wide as
//     the widest line of that style there, which fills the corners between
//     the lines whatever their angles: T-junctions, crossroads, curved and
//     shallow junctions, and mixed widths.
//
// Pieces of one style overlap only where they lie in the same plane with the
// same colour and normal, so the overlap cannot show. Different styles are
// separated by their offsets above the ground. Line ends that meet nothing
// are cut square. Centrelines are used exactly as imported, so the 3D network
// matches the 2D map.

export interface NetworkLine<S extends string> {
  readonly id: string;
  readonly style: S;
  readonly centerline: readonly Vec2[];
  readonly halfWidth: number;
}

interface Incidence<S> {
  /** Unit direction from the node along the segment. */
  readonly dx: number;
  readonly dy: number;
  readonly halfWidth: number;
  readonly style: S;
}

/** Nodes shared by lines are matched to the millimetre. */
const key = (p: Vec2) => `${String(Math.round(p.x * 1000))},${String(Math.round(p.y * 1000))}`;

/** Fan and disc smoothness: the largest angle one straight edge stands for. */
const ARC_STEP = Math.PI / 12;

/**
 * Drapes a network of lines, returning one mesh per style. Lines are taken in
 * order of id, so the result does not depend on the order they were loaded in.
 * `offset` gives each style's height above the ground.
 */
export function drapeNetwork<S extends string>(
  lines: readonly NetworkLine<S>[],
  draper: Draper,
  offset: (style: S) => number,
): Map<S, MeshBuffers> {
  const sorted = [...lines].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map<S, MeshBuffers>();
  const buffers = (style: S) => {
    let b = out.get(style);
    if (!b) {
      b = meshBuffers();
      out.set(style, b);
    }
    return b;
  };
  const nodes = new Map<string, { p: Vec2; edges: Incidence<S>[] }>();
  const touch = (p: Vec2, toward: Vec2, line: NetworkLine<S>) => {
    const k = key(p);
    let node = nodes.get(k);
    if (!node) {
      node = { p, edges: [] };
      nodes.set(k, node);
    }
    const len = Math.hypot(toward.x - p.x, toward.y - p.y);
    node.edges.push({
      dx: (toward.x - p.x) / len,
      dy: (toward.y - p.y) / len,
      halfWidth: line.halfWidth,
      style: line.style,
    });
  };

  for (const line of sorted) {
    const h = line.halfWidth;
    const z = offset(line.style);
    const out = buffers(line.style);
    // Consecutive duplicate points (to the millimetre) are dropped.
    const points: Vec2[] = [];
    for (const p of line.centerline) {
      const last = points[points.length - 1];
      if (!last || key(last) !== key(p)) points.push(p);
    }
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      const nx = (-(b.y - a.y) / len) * h;
      const ny = ((b.x - a.x) / len) * h;
      draper.convex(
        [a.x - nx, a.y - ny, b.x - nx, b.y - ny, b.x + nx, b.y + ny, a.x + nx, a.y + ny],
        z,
        out,
      );
      touch(a, b, line);
      touch(b, a, line);
    }
  }

  for (const { p, edges } of nodes.values()) {
    if (edges.length < 2) continue; // a free end: cut square
    const styles = [...new Set(edges.map((e) => e.style))];
    for (const style of styles) {
      const mine = edges.filter((e) => e.style === style);
      const out = buffers(style);
      const z = offset(style);
      const [e1, e2] = mine;
      if (edges.length === 2 && e1 && e2?.halfWidth === e1.halfWidth) {
        fan(p, e1, e2, draper, z, out);
      } else {
        disc(p, Math.max(...mine.map((e) => e.halfWidth)), draper, z, out);
      }
    }
  }
  return out;
}

/** Fills the gap on the outside of a bend between two segments of equal width. */
function fan<S>(
  p: Vec2,
  e1: Incidence<S>,
  e2: Incidence<S>,
  draper: Draper,
  z: number,
  out: MeshBuffers,
) {
  const h = e1.halfWidth;
  const cos = e1.dx * e2.dx + e1.dy * e2.dy;
  if (cos < -0.999999) return; // straight on: the rectangles already meet
  // Each segment's end edge, on the side away from the other segment.
  let n1x = -e1.dy;
  let n1y = e1.dx;
  if (n1x * e2.dx + n1y * e2.dy > 0) [n1x, n1y] = [-n1x, -n1y];
  let n2x = -e2.dy;
  let n2y = e2.dx;
  if (n2x * e1.dx + n2y * e1.dy > 0) [n2x, n2y] = [-n2x, -n2y];
  const a1 = Math.atan2(n1y, n1x);
  let sweep = Math.atan2(n1x * n2y - n1y * n2x, n1x * n2x + n1y * n2y);
  // A segment doubling back on itself: half a disc beyond its end.
  if (cos > 0.999999) sweep = Math.PI;
  if (Math.abs(sweep) < 1e-9) return;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP));
  let px = p.x + n1x * h;
  let py = p.y + n1y * h;
  for (let k = 1; k <= steps; k += 1) {
    const a = a1 + (sweep * k) / steps;
    const qx = p.x + Math.cos(a) * h;
    const qy = p.y + Math.sin(a) * h;
    draper.convex([p.x, p.y, px, py, qx, qy], z, out);
    px = qx;
    py = qy;
  }
}

/** A disc of radius `h` at a junction. */
function disc(p: Vec2, h: number, draper: Draper, z: number, out: MeshBuffers) {
  const steps = Math.max(8, Math.ceil((2 * Math.PI) / ARC_STEP));
  // Corners just outside the circle, so its edge never cuts inside a line's width.
  const r = h / Math.cos(Math.PI / steps);
  const points: number[] = [];
  for (let k = 0; k < steps; k += 1) {
    const a = (2 * Math.PI * k) / steps;
    points.push(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
  }
  draper.convex(points, z, out);
}
