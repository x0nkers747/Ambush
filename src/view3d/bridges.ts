import { BRIDGE_STYLES, type Bridge, type BridgeIndex, type Vec2 } from '#sim';
import type { CoordinatedBridges } from './bridge-complexes';
import type { MeshBuffers, MeshData } from './drape';
import { finishMesh, meshBuffers } from './drape';
import { Occupancy } from './planar';
import { srgbToLinear } from './terrain-mesh';

// Bridges in 3D (docs/adr/0041): the simulation plans them (`planBridges`,
// in #sim, so soldiers cross the bridges drawn); the 3D view draws each as a
// deck, its sides, barriers and supports, with the road's own draped surface
// and markings lifted onto it. Decoration: picking never hits a bridge.
//
// Decks mapped side by side as one structure (docs/adr/0044,
// bridge-complexes.ts) are drawn as one: their slab is one surface (pieces
// cut so none lies on another), and side walls, barriers and abutments stand
// only on the structure's outside, never inside it. Barriers also stop where
// another road joins the bridge, and piers are not doubled.

export {
  APPROACH_M,
  BRIDGE_MIN_WATERWAY_M,
  BRIDGE_STYLES,
  BRIDGE_VERSION,
  bridgeIndex,
  bridgeStyleOf,
  CLEARANCE_M,
  END_BLEND_M,
  FOOT_CLEARANCE_M,
  MAX_GRADE,
  MAX_RAMP_M,
  MERGE_GAP_M,
  MIN_CROSSING_M,
  planBridges,
  type Bridge,
  type BridgeIndex,
  type BridgePlan,
  type BridgeStyle,
  type BridgeStyleSpec,
} from '#sim';

const COLORS = {
  concrete: 0x9d9a93,
  underside: 0x6f6d68,
  metal: 0xb9bcbd,
  post: 0x7e8183,
  railing: 0x5b5f61,
} as const;

// --- Lifting the road onto the deck -------------------------------------------------------------

/** Longest triangle edge on a bridge before it is split (so the road follows the deck's profile), metres. */
const MAX_EDGE_M = 2;

/**
 * A draped mesh (road surfaces, verges, markings, paths) with every vertex on
 * a bridge raised onto its deck, keeping its height above the ground: flat
 * across the deck, blending into the draped road at the deck's ends.
 * Triangles on a bridge are split first, so the surface follows the deck's
 * profile. Display only: a copy; the ground and the input are untouched.
 */
export function liftOntoBridges(
  mesh: MeshData,
  index: BridgeIndex,
  ground: (x: number, y: number) => number,
): MeshData {
  if (index.count === 0 || mesh.triangleCount === 0) return mesh;
  const out: MeshBuffers = meshBuffers(mesh.colors !== null);
  const p = mesh.positions;
  const nrm = mesh.normals;
  const col = mesh.colors;
  interface V {
    x: number;
    y: number;
    z: number;
    n: [number, number, number];
    c: [number, number, number] | null;
  }
  const vertex = (i: number): V => ({
    x: p[3 * i] ?? 0,
    y: -(p[3 * i + 2] ?? 0),
    z: p[3 * i + 1] ?? 0,
    n: [nrm[3 * i] ?? 0, nrm[3 * i + 1] ?? 1, nrm[3 * i + 2] ?? 0],
    c: col ? [col[3 * i] ?? 0, col[3 * i + 1] ?? 0, col[3 * i + 2] ?? 0] : null,
  });
  const mix = (a: V, b: V): V => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
    n: [(a.n[0] + b.n[0]) / 2, (a.n[1] + b.n[1]) / 2, (a.n[2] + b.n[2]) / 2],
    c: a.c && b.c ? [(a.c[0] + b.c[0]) / 2, (a.c[1] + b.c[1]) / 2, (a.c[2] + b.c[2]) / 2] : null,
  });
  const emit = (v: V) => {
    const at = index.at(v.x, v.y);
    let z = v.z;
    let n = v.n;
    if (at) {
      const offset = v.z - ground(v.x, v.y);
      const followed = v.z + (at.deck - at.centreGround);
      z = followed + at.blend * (at.deck + offset - followed);
      // Never below where it was draped: the terrain would cover it there.
      // A deck is flat across at its centre line's ground, so near a deck's
      // end on a sloping bank, or where a structure's decks were lowered to
      // meet their roads (docs/adr/0044), the deck can be lower than the
      // ground beside it.
      if (z < v.z) z = v.z;
      else if (at.blend > 0.5) n = [0, 1, 0];
    }
    out.positions.push(v.x, z, -v.y);
    out.normals.push(...n);
    if (out.colors && v.c) out.colors.push(...v.c);
  };
  const split = (a: V, b: V, c: V, depth: number) => {
    const ab = Math.hypot(a.x - b.x, a.y - b.y);
    const bc = Math.hypot(b.x - c.x, b.y - c.y);
    const ca = Math.hypot(c.x - a.x, c.y - a.y);
    const longest = Math.max(ab, bc, ca);
    if (longest <= MAX_EDGE_M || depth > 12) {
      emit(a);
      emit(b);
      emit(c);
      return;
    }
    // Split the longest edge (keeping the winding).
    if (longest === ab) {
      const m = mix(a, b);
      split(a, m, c, depth + 1);
      split(m, b, c, depth + 1);
    } else if (longest === bc) {
      const m = mix(b, c);
      split(a, b, m, depth + 1);
      split(a, m, c, depth + 1);
    } else {
      const m = mix(c, a);
      split(a, b, m, depth + 1);
      split(m, b, c, depth + 1);
    }
  };
  // Only triangles near a bridge are rebuilt; the rest are copied as they are, in runs.
  const near = new Uint8Array(mesh.triangleCount);
  let touched = 0;
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const o = 9 * t;
    const x0 = p[o] ?? 0;
    const x1 = p[o + 3] ?? 0;
    const x2 = p[o + 6] ?? 0;
    const y0 = -(p[o + 2] ?? 0);
    const y1 = -(p[o + 5] ?? 0);
    const y2 = -(p[o + 8] ?? 0);
    if (
      index.touches(
        Math.min(x0, x1, x2),
        Math.min(y0, y1, y2),
        Math.max(x0, x1, x2),
        Math.max(y0, y1, y2),
      ) &&
      // On a deck: a corner, an edge's middle or the centre (draped triangles are small).
      (index.at(x0, y0) !== null ||
        index.at(x1, y1) !== null ||
        index.at(x2, y2) !== null ||
        index.at((x0 + x1) / 2, (y0 + y1) / 2) !== null ||
        index.at((x1 + x2) / 2, (y1 + y2) / 2) !== null ||
        index.at((x2 + x0) / 2, (y2 + y0) / 2) !== null ||
        index.at((x0 + x1 + x2) / 3, (y0 + y1 + y2) / 3) !== null)
    ) {
      near[t] = 1;
      touched += 1;
    }
  }
  if (touched === 0) return mesh;
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    if (!near[t]) continue;
    const a = vertex(3 * t);
    const b = vertex(3 * t + 1);
    const c = vertex(3 * t + 2);
    split(a, b, c, 0);
  }
  const keep = mesh.triangleCount - touched;
  const total = keep * 9 + out.positions.length;
  const positions = new Float32Array(total);
  const normals = new Float32Array(total);
  const colors = col ? new Float32Array(total) : null;
  let at = 0;
  let t = 0;
  while (t < mesh.triangleCount) {
    if (near[t]) {
      t += 1;
      continue;
    }
    let e = t;
    while (e < mesh.triangleCount && !near[e]) e += 1;
    positions.set(p.subarray(9 * t, 9 * e), at);
    normals.set(nrm.subarray(9 * t, 9 * e), at);
    if (colors && col) colors.set(col.subarray(9 * t, 9 * e), at);
    at += 9 * (e - t);
    t = e;
  }
  positions.set(out.positions, at);
  normals.set(out.normals, at);
  if (colors && out.colors) colors.set(out.colors, at);
  return { positions, normals, colors, triangleCount: total / 9 };
}

// --- Structure ------------------------------------------------------------------------------------

const rgb = (c: number): [number, number, number] => [
  srgbToLinear((c >> 16) & 255),
  srgbToLinear((c >> 8) & 255),
  srgbToLinear(c & 255),
];

/** A quad (two triangles) a, b, c, d counter-clockwise seen from its front, flat-shaded. Three.js axes in. */
function quad(
  out: MeshBuffers,
  v: readonly (readonly [number, number, number])[],
  color: [number, number, number],
) {
  const [a, b, c, d] = v;
  if (!a || !b || !c || !d) return;
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const wx = d[0] - a[0];
  const wy = d[1] - a[1];
  const wz = d[2] - a[2];
  let nx = uy * wz - uz * wy;
  let ny = uz * wx - ux * wz;
  let nz = ux * wy - uy * wx;
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-9)) return;
  nx /= l;
  ny /= l;
  nz /= l;
  for (const q of [a, b, c, a, c, d]) {
    out.positions.push(q[0], q[1], q[2]);
    out.normals.push(nx, ny, nz);
    out.colors?.push(...color);
  }
}

/**
 * A box along a run of the deck: between offsets `left` and `right` across
 * it (metres, positive to the left of the direction of travel), from `below`
 * to `above` the deck's top, from sample `k0` to `k1`. Its long faces follow
 * the deck; its ends are closed.
 */
function strip(
  out: MeshBuffers,
  b: Bridge,
  k0: number,
  k1: number,
  left: number,
  right: number,
  below: number,
  above: number,
  color: [number, number, number],
  faces: { top?: boolean; bottom?: boolean; ends?: boolean } = {},
) {
  const n = b.deck.length;
  const pt = (k: number, side: number, h: number): [number, number, number] => {
    const i = Math.max(0, Math.min(n - 1, k));
    const x = b.xy[2 * i] ?? 0;
    const y = b.xy[2 * i + 1] ?? 0;
    const j0 = Math.max(0, i - 1);
    const j1 = Math.min(n - 1, i + 1);
    let dx = (b.xy[2 * j1] ?? 0) - (b.xy[2 * j0] ?? 0);
    let dy = (b.xy[2 * j1 + 1] ?? 0) - (b.xy[2 * j0 + 1] ?? 0);
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    // Left of travel: (−dy, dx).
    const px = x - dy * side;
    const py = y + dx * side;
    return [px, (b.deck[i] ?? 0) + h, -py];
  };
  for (let k = k0; k < k1; k += 1) {
    // Left face (outward to the left), right face, top, bottom.
    quad(
      out,
      [pt(k + 1, left, below), pt(k, left, below), pt(k, left, above), pt(k + 1, left, above)],
      color,
    );
    quad(
      out,
      [pt(k, right, below), pt(k + 1, right, below), pt(k + 1, right, above), pt(k, right, above)],
      color,
    );
    if (faces.top !== false) {
      quad(
        out,
        [pt(k, right, above), pt(k + 1, right, above), pt(k + 1, left, above), pt(k, left, above)],
        color,
      );
    }
    if (faces.bottom !== false) {
      quad(
        out,
        [pt(k, left, below), pt(k + 1, left, below), pt(k + 1, right, below), pt(k, right, below)],
        color,
      );
    }
  }
  if (faces.ends !== false) {
    quad(
      out,
      [pt(k0, left, below), pt(k0, right, below), pt(k0, right, above), pt(k0, left, above)],
      color,
    );
    quad(
      out,
      [pt(k1, right, below), pt(k1, left, below), pt(k1, left, above), pt(k1, right, above)],
      color,
    );
  }
}

/** A vertical box (a post, a pier) centred on deck sample `k` at offset `side`, from `bottom` to `top` (absolute heights). */
function column(
  out: MeshBuffers,
  b: Bridge,
  k: number,
  side: number,
  alongHalf: number,
  acrossHalf: number,
  bottom: number,
  top: number,
  color: [number, number, number],
) {
  const n = b.deck.length;
  const i = Math.max(0, Math.min(n - 1, k));
  const j0 = Math.max(0, i - 1);
  const j1 = Math.min(n - 1, i + 1);
  let dx = (b.xy[2 * j1] ?? 0) - (b.xy[2 * j0] ?? 0);
  let dy = (b.xy[2 * j1 + 1] ?? 0) - (b.xy[2 * j0 + 1] ?? 0);
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  const cx = (b.xy[2 * i] ?? 0) - dy * side;
  const cy = (b.xy[2 * i + 1] ?? 0) + dx * side;
  const corner = (a: number, c: number, h: number): [number, number, number] => [
    cx + dx * a - dy * c,
    h,
    -(cy + dy * a + dx * c),
  ];
  const A = alongHalf;
  const C = acrossHalf;
  // Four sides, outward.
  quad(
    out,
    [corner(-A, -C, bottom), corner(A, -C, bottom), corner(A, -C, top), corner(-A, -C, top)],
    color,
  );
  quad(
    out,
    [corner(A, -C, bottom), corner(A, C, bottom), corner(A, C, top), corner(A, -C, top)],
    color,
  );
  quad(
    out,
    [corner(A, C, bottom), corner(-A, C, bottom), corner(-A, C, top), corner(A, C, top)],
    color,
  );
  quad(
    out,
    [corner(-A, C, bottom), corner(-A, -C, bottom), corner(-A, -C, top), corner(-A, C, top)],
    color,
  );
  quad(
    out,
    [corner(-A, -C, top), corner(A, -C, top), corner(A, C, top), corner(-A, C, top)],
    color,
  );
}

/** Where a barrier run stands: its deck, side and centre line (map x, y pairs), for diagnostics. */
export interface BarrierRun {
  readonly deck: string;
  readonly side: 1 | -1;
  readonly points: readonly number[];
}

export interface BridgeGeometry {
  readonly mesh: MeshData;
  /** The barrier runs and piers placed (docs/adr/0044 diagnostics). */
  readonly barriers: readonly BarrierRun[];
  readonly pierAt: readonly { readonly deck: string; readonly x: number; readonly y: number }[];
  readonly bridges: number;
  readonly mapped: number;
  readonly inferred: number;
  readonly piers: number;
  readonly lowClearance: number;
}

/** How the decks of one structure are drawn together (docs/adr/0044). */
export interface StructureContext {
  readonly coordinated: CoordinatedBridges;
  /** Whether a road that is not on deck `deck`'s structure has its surface at (x, y): a road joining the bridge. */
  readonly roadEntrance: (deck: number, x: number, y: number) => boolean;
}

/** A shared slab's triangle is split where the structure's surface strays this far from it, metres. */
const SLAB_FLAT_M = 0.02;

/** Piers of one structure closer than this are one pier, metres. */
const PIER_MERGE_M = 4;

/**
 * The bridges' structure: deck slab, barriers, abutments and piers, one
 * vertex-coloured mesh. With a `context`, `bridges` are its coordinated decks,
 * and structures of several decks are drawn as one.
 */
export function bridgeGeometry(
  bridges: readonly Bridge[],
  ground: (x: number, y: number) => number,
  context?: StructureContext,
): BridgeGeometry {
  const out = meshBuffers(true);
  const coordinated = context?.coordinated;
  const slabs = new Map<number, Occupancy<number>>();
  const piersOf = new Map<number, { x: number; y: number }[]>();
  const barrierRuns: BarrierRun[] = [];
  const pierAt: { deck: string; x: number; y: number }[] = [];
  const concrete = rgb(COLORS.concrete);
  const underside = rgb(COLORS.underside);
  const metal = rgb(COLORS.metal);
  const post = rgb(COLORS.post);
  const railing = rgb(COLORS.railing);
  let piers = 0;
  bridges.forEach((b, bi) => {
    const spec = BRIDGE_STYLES[b.style];
    const complex = coordinated?.complexOf[bi] ?? -1;
    const shared = (coordinated?.complexes[complex]?.members.length ?? 1) > 1;
    const onOther = (x: number, y: number, margin = 0) =>
      shared && (coordinated?.onOtherDeck(bi, x, y, margin) ?? false);
    const n = b.deck.length - 1;
    // The part that stands clear of the road: where the deck is lifted, or over water.
    let k0 = 0;
    while (k0 < n && (b.lift[k0] ?? 0) < 0.15 && !b.wet[k0]) k0 += 1;
    let k1 = n;
    while (k1 > k0 && (b.lift[k1] ?? 0) < 0.15 && !b.wet[k1]) k1 -= 1;
    // A metre or two either side, onto the banks.
    k0 = Math.max(0, k0 - 2);
    k1 = Math.min(n, k1 + 2);
    if (k1 - k0 < 2) return;
    const H = b.halfWidth;
    // The deck slab: just under the road's surface (which is lifted onto it).
    if (!shared || !coordinated) {
      strip(out, b, k0, k1, H, -H, -spec.thickness, 0.02, concrete, { bottom: false });
      strip(
        out,
        b,
        k0,
        k1,
        H - 0.05,
        -H + 0.05,
        -spec.thickness,
        -spec.thickness + 0.01,
        underside,
        {
          top: false,
          ends: false,
        },
      );
    } else {
      let slab = slabs.get(complex);
      if (!slab) {
        slab = new Occupancy<number>(() => true);
        slabs.set(complex, slab);
      }
      sharedSlab(out, b, k0, k1, H, spec.thickness, slab, coordinated, bi, concrete, underside);
    }
    // Barriers along both edges: on the structure's outside, and not across a road joining it.
    for (const side of [1, -1] as const) {
      const at = (k: number, across: number) => edgePoint(b, k, side * across);
      const free = (k: number) => {
        const p = at(k, H - 0.15);
        return !onOther(p.x, p.y, 0.3) && !(context?.roadEntrance(bi, p.x, p.y) ?? false);
      };
      for (const [r0, r1] of runs(k0, k1, free)) {
        const line: number[] = [];
        for (let k = r0; k <= r1; k += 1) {
          const p = at(k, H - 0.15);
          line.push(p.x, p.y);
        }
        barrierRuns.push({ deck: b.id, side, points: line });
        const outer = side * (H - 0.02);
        const inner = side * (H - 0.3);
        const [l, r] = side > 0 ? [outer, inner] : [inner, outer];
        if (spec.barrier === 'parapet') {
          strip(out, b, r0, r1, l, r, 0, 0.85, concrete);
        } else if (spec.barrier === 'guardrail') {
          const off = side * (H - 0.35);
          for (let k = r0; k <= r1; k += 2)
            column(
              out,
              b,
              k,
              off - side * 0.05,
              0.06,
              0.06,
              (b.deck[k] ?? 0) - 0.1,
              (b.deck[k] ?? 0) + 0.75,
              post,
            );
          const [rl, rr] = side > 0 ? [off + 0.04, off - 0.04] : [off - 0.04, off + 0.04];
          strip(out, b, r0, r1, rl, rr, 0.45, 0.75, metal);
        } else {
          const off = side * (H - 0.12);
          for (let k = r0; k <= r1; k += 2)
            column(out, b, k, off, 0.04, 0.04, b.deck[k] ?? 0, (b.deck[k] ?? 0) + 1.05, railing);
          const [rl, rr] = side > 0 ? [off + 0.04, off - 0.04] : [off - 0.04, off + 0.04];
          strip(out, b, r0, r1, rl, rr, 1.0, 1.1, railing);
          strip(out, b, r0, r1, rl, rr, 0.5, 0.56, railing);
        }
      }
    }
    // Abutments: where the deck meets the banks, down into the ground (not inside the structure).
    for (const k of [k0, k1]) {
      const x = b.xy[2 * k] ?? 0;
      const y = b.xy[2 * k + 1] ?? 0;
      if (onOther(x, y)) continue;
      const top = (b.deck[k] ?? 0) - spec.thickness;
      const bottom = Math.min(ground(x, y), b.under[k] ?? ground(x, y)) - 1;
      if (top - bottom > 0.2) column(out, b, k, 0, 0.6, H, bottom, top, concrete);
    }
    // Piers: evenly between the banks over water, when the span is long.
    // (Or over a dip it spans high above the ground: a viaduct.)
    const open = (k: number) => b.wet[k] === true || (b.lift[k] ?? 0) > 2;
    let w0 = k0;
    while (w0 < k1 && !open(w0)) w0 += 1;
    let w1 = k1;
    while (w1 > w0 && !open(w1)) w1 -= 1;
    const span = w1 - w0;
    const count = span > spec.maxSpan ? Math.ceil(span / spec.maxSpan) - 1 : 0;
    for (let p = 1; p <= count; p += 1) {
      const k = Math.round(w0 + (span * p) / (count + 1));
      const x = b.xy[2 * k] ?? 0;
      const y = b.xy[2 * k + 1] ?? 0;
      const top = (b.deck[k] ?? 0) - spec.thickness;
      const bottom = ground(x, y) - 0.5;
      if (top - bottom < 0.3) continue;
      // One pier where the decks of a structure would each have one.
      if (shared) {
        const placed = piersOf.get(complex) ?? [];
        if (placed.some((q) => Math.hypot(q.x - x, q.y - y) < PIER_MERGE_M + H)) continue;
        placed.push({ x, y });
        piersOf.set(complex, placed);
      }
      if (b.style === 'major') {
        for (const side of [0.55, -0.55])
          column(out, b, k, side * H, 0.6, 0.6, bottom, top, concrete);
      } else column(out, b, k, 0, 0.5, H * 0.8, bottom, top, concrete);
      piers += 1;
      pierAt.push({ deck: b.id, x, y });
    }
  });
  return {
    mesh: finishMesh(out),
    barriers: barrierRuns,
    pierAt,
    bridges: bridges.length,
    mapped: bridges.filter((b) => b.mapped).length,
    inferred: bridges.filter((b) => !b.mapped).length,
    piers,
    lowClearance: bridges.filter((b) => b.lowClearance).length,
  };
}

/** The point `across` metres left of deck sample `k`'s centreline. */
function edgePoint(b: Bridge, k: number, across: number): { x: number; y: number } {
  const n = b.deck.length;
  const i = Math.max(0, Math.min(n - 1, k));
  const j0 = Math.max(0, i - 1);
  const j1 = Math.min(n - 1, i + 1);
  let dx = (b.xy[2 * j1] ?? 0) - (b.xy[2 * j0] ?? 0);
  let dy = (b.xy[2 * j1 + 1] ?? 0) - (b.xy[2 * j0 + 1] ?? 0);
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  return { x: (b.xy[2 * i] ?? 0) - dy * across, y: (b.xy[2 * i + 1] ?? 0) + dx * across };
}

/** The runs of consecutive samples from `k0` to `k1` where `free` holds, at least one segment long. */
function runs(k0: number, k1: number, free: (k: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let k = k0; k <= k1 + 1; k += 1) {
    const ok = k <= k1 && free(k);
    if (ok && start < 0) start = k;
    if (!ok && start >= 0) {
      if (k - 1 > start) out.push([start, k - 1]);
      start = -1;
    }
  }
  return out;
}

/**
 * A deck's part of a shared slab: the strip under the deck from sample `k0`
 * to `k1`, cut so that it does not overlap the decks of its structure drawn
 * before it, at the structure's shared height; side walls only where its
 * edge is not inside another deck of the structure.
 */
function sharedSlab(
  out: MeshBuffers,
  b: Bridge,
  k0: number,
  k1: number,
  H: number,
  thickness: number,
  slab: Occupancy<number>,
  coordinated: CoordinatedBridges,
  bi: number,
  concrete: [number, number, number],
  underside: [number, number, number],
) {
  // The height the road is lifted to (`liftOntoBridges`), so the slab stays just under it.
  const height = (x: number, y: number, k: number) =>
    coordinated.index.at(x, y)?.deck ?? b.deck[k] ?? 0;
  for (let k = k0; k < k1; k += 1) {
    const l0 = edgePoint(b, k, H);
    const l1 = edgePoint(b, k + 1, H);
    const r0 = edgePoint(b, k, -H);
    const r1 = edgePoint(b, k + 1, -H);
    // Top (counter-clockwise from above, so its normal points up) and
    // underside. They take the structure's height at each vertex, so they
    // follow the same surface the road is lifted onto: where that surface is
    // not flat across a triangle (decks of different heights meet in it), the
    // triangle is split, down to edges of `MAX_EDGE_M` as the road's are.
    const flatWithin = (a: Vec2, c: Vec2, d: Vec2) => {
      const za = height(a.x, a.y, k);
      const zc = height(c.x, c.y, k);
      const zd = height(d.x, d.y, k);
      const off = (x: number, y: number, z: number) => Math.abs(height(x, y, k) - z) > SLAB_FLAT_M;
      return !(
        off((a.x + c.x) / 2, (a.y + c.y) / 2, (za + zc) / 2) ||
        off((c.x + d.x) / 2, (c.y + d.y) / 2, (zc + zd) / 2) ||
        off((d.x + a.x) / 2, (d.y + a.y) / 2, (zd + za) / 2) ||
        off((a.x + c.x + d.x) / 3, (a.y + c.y + d.y) / 3, (za + zc + zd) / 3)
      );
    };
    const emit = (a: Vec2, c: Vec2, d: Vec2, depth: number) => {
      const ac = Math.hypot(a.x - c.x, a.y - c.y);
      const cd = Math.hypot(c.x - d.x, c.y - d.y);
      const da = Math.hypot(d.x - a.x, d.y - a.y);
      const longest = Math.max(ac, cd, da);
      if (longest > MAX_EDGE_M && depth < 12 && !flatWithin(a, c, d)) {
        const mid = (p: Vec2, q: Vec2) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
        if (longest === ac) {
          const m = mid(a, c);
          emit(a, m, d, depth + 1);
          emit(m, c, d, depth + 1);
        } else if (longest === cd) {
          const m = mid(c, d);
          emit(a, c, m, depth + 1);
          emit(a, m, d, depth + 1);
        } else {
          const m = mid(d, a);
          emit(a, c, m, depth + 1);
          emit(m, c, d, depth + 1);
        }
        return;
      }
      // A sliver left by cutting, thinner than float32 positions can tell
      // apart (0.5 mm, as the draper drops them): nothing to draw.
      const twice = Math.abs((c.x - a.x) * (d.y - a.y) - (d.x - a.x) * (c.y - a.y));
      if (twice <= 1e-9 || twice / longest < 5e-4) return;
      const za = height(a.x, a.y, k);
      const zc = height(c.x, c.y, k);
      const zd = height(d.x, d.y, k);
      triangle(
        out,
        [a.x, za + 0.02, -a.y],
        [c.x, zc + 0.02, -c.y],
        [d.x, zd + 0.02, -d.y],
        concrete,
      );
      triangle(
        out,
        [a.x, za - thickness, -a.y],
        [d.x, zd - thickness, -d.y],
        [c.x, zc - thickness, -c.y],
        underside,
      );
    };
    for (const piece of slab.place([r0.x, r0.y, r1.x, r1.y, l1.x, l1.y, l0.x, l0.y], bi)) {
      const m = piece.length / 2;
      const v = (i: number): Vec2 => ({ x: piece[2 * i] ?? 0, y: piece[2 * i + 1] ?? 0 });
      for (let i = 1; i + 1 < m; i += 1) emit(v(0), v(i), v(i + 1), 0);
    }
    // Side walls, outside the structure only.
    for (const [p, q] of [
      [l1, l0],
      [r0, r1],
    ] as const) {
      const mx = (p.x + q.x) / 2;
      const my = (p.y + q.y) / 2;
      if (coordinated.onOtherDeck(bi, mx, my, -0.05)) continue;
      const zp = height(p.x, p.y, k);
      const zq = height(q.x, q.y, k + 1);
      quad(
        out,
        [
          [p.x, zp - thickness, -p.y],
          [q.x, zq - thickness, -q.y],
          [q.x, zq + 0.02, -q.y],
          [p.x, zp + 0.02, -p.y],
        ],
        concrete,
      );
    }
  }
  // Ends, where they are not inside the structure.
  for (const [k, sign] of [
    [k0, 1],
    [k1, -1],
  ] as const) {
    const c = edgePoint(b, k, 0);
    if (coordinated.onOtherDeck(bi, c.x, c.y, -0.05)) continue;
    const l = edgePoint(b, k, H);
    const r = edgePoint(b, k, -H);
    const [p, q] = sign > 0 ? [l, r] : [r, l];
    const zp = height(p.x, p.y, k);
    const zq = height(q.x, q.y, k);
    quad(
      out,
      [
        [p.x, zp - thickness, -p.y],
        [q.x, zq - thickness, -q.y],
        [q.x, zq + 0.02, -q.y],
        [p.x, zp + 0.02, -p.y],
      ],
      concrete,
    );
  }
}

/** One flat-shaded triangle, counter-clockwise seen from its front (Three.js axes). */
function triangle(
  out: MeshBuffers,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  color: [number, number, number],
) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const wx = c[0] - a[0];
  const wy = c[1] - a[1];
  const wz = c[2] - a[2];
  let nx = uy * wz - uz * wy;
  let ny = uz * wx - ux * wz;
  let nz = ux * wy - uy * wx;
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-9)) return;
  nx /= l;
  ny /= l;
  nz /= l;
  for (const q of [a, b, c]) {
    out.positions.push(q[0], q[1], q[2]);
    out.normals.push(nx, ny, nz);
    out.colors?.push(...color);
  }
}
