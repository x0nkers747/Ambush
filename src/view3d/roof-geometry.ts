import type { BuildingAppearance } from '#sim';
import type { RoofKind } from './building-style';
import {
  toLocal,
  toWorld,
  type FootprintShape,
  type FrameRect,
  type ShapeFrame,
} from './footprint-shape';
import type { Rgb } from './drape';
import type { SurfaceBuilder, SurfaceVertex } from './surface-mesh';

// Roofs for the 3D view's buildings (docs/adr/0035). Pure.
//
// A pitched roof is built on each rectangle of the footprint's shape (one
// for a rectangle, up to four for an L, T or U plan): gabled, hipped, or (on
// rectangles only) a single sloping skillion. Every face is a plane through
// the eaves line, rising at one slope, so faces meet exactly along hips and
// ridges, and roofs on overlapping rectangles meet along valleys where the
// depth buffer finds them. A narrower wing that runs into a wider part stops
// at that part's ridge line, where its end is hidden under the wider roof.
// Overhangs extend every eaves edge outwards; a fascia board and a level
// soffit close them, so a roof never shows a gap or floats.
//
// Heights: line of sight treats a building as a block whose top is the
// reference roof elevation (`buildingRoofElevations`). A pitched roof keeps
// the same mean height: eaves half its rise below the reference, ridge half
// above. When the source gives both the building's height and its roof
// height, that height is the ridge's, as OSM defines it: ridge at the
// reference, eaves a roof height below. The rise is capped so the walls are
// at least 2.4 m tall; a roof rising less than 0.5 m is drawn flat.

/** Walls stand at least this tall under a pitched roof, metres. */
export const MIN_WALL_M = 2.4;
/** A roof rising less than this is drawn flat, metres. */
export const MIN_RISE_M = 0.5;
/** Depth of the fascia board along the eaves, metres. */
const FASCIA_M = 0.2;

/** A rectangle of the roof: `along` is the ridge's axis in the shape's frame. */
export interface RoofRect {
  readonly rect: FrameRect;
  readonly along: 's' | 't';
  /** Ends (low and high along the ridge) that run into a wider part: no hip, no overhang. */
  readonly openStart: boolean;
  readonly openEnd: boolean;
  /** Skillion only: whether the low eaves is on the low side across the ridge axis. */
  readonly lowFirst: boolean;
}

export interface RoofPlan {
  readonly kind: RoofKind;
  readonly frame: ShapeFrame;
  readonly rects: readonly RoofRect[];
  /** Eaves height (the low eaves for a skillion), absolute metres. */
  readonly eaves: number;
  /** Rise per metre run. 0 for flat. */
  readonly slope: number;
  /** Rise of the main rectangle's roof, metres. */
  readonly rise: number;
  readonly overhang: number;
  /** Highest point of the roof, absolute metres. */
  readonly top: number;
}

export interface RoofInput {
  readonly shape: FootprintShape;
  readonly kind: RoofKind;
  readonly pitchDegrees: number;
  readonly overhangM: number;
  /** Reference roof elevation (line of sight's), absolute metres. */
  readonly reference: number;
  /** Lowest ground at the footprint's corners. */
  readonly base: number;
  readonly appearance: BuildingAppearance | undefined;
  /** A deterministic number in [0, 1) for this building. */
  readonly chance: number;
}

const flatPlan = (input: RoofInput): RoofPlan => ({
  kind: 'flat',
  frame: input.shape.frame,
  rects: [],
  eaves: input.reference,
  slope: 0,
  rise: 0,
  overhang: 0,
  top: input.reference,
});

const width = (r: FrameRect, along: 's' | 't') => (along === 's' ? r.t1 - r.t0 : r.s1 - r.s0);
const length = (r: FrameRect, along: 's' | 't') => (along === 's' ? r.s1 - r.s0 : r.t1 - r.t0);

/** Plans a building's roof. */
export function planRoof(input: RoofInput): RoofPlan {
  const { shape, appearance: look } = input;
  let kind = input.kind;
  if (kind === 'flat' || shape.kind === 'irregular' || shape.rects.length === 0) {
    return flatPlan(input);
  }
  if (kind === 'skillion' && shape.kind !== 'rectangle') kind = 'gabled';

  // The ridge of each rectangle runs along its long side.
  const sorted = [...shape.rects].sort(
    (a, b) => (b.s1 - b.s0) * (b.t1 - b.t0) - (a.s1 - a.s0) * (a.t1 - a.t0),
  );
  const main = sorted[0];
  if (!main) return flatPlan(input);
  const mainCentre = { s: (main.s0 + main.s1) / 2, t: (main.t0 + main.t1) / 2 };
  let alongs = sorted.map((r, i): 's' | 't' => {
    const ls = r.s1 - r.s0;
    const lt = r.t1 - r.t0;
    if (i > 0 && Math.abs(ls - lt) < 0.15 * Math.max(ls, lt)) {
      // A squarish wing: its ridge runs out from the main part.
      const ds = Math.abs((r.s0 + r.s1) / 2 - mainCentre.s);
      const dt = Math.abs((r.t0 + r.t1) / 2 - mainCentre.t);
      return ds >= dt ? 's' : 't';
    }
    return ls >= lt ? 's' : 't';
  });
  if (shape.kind === 'rectangle' && kind !== 'hipped') {
    // The source's ridge orientation or slope direction, when given.
    const long = alongs[0] ?? 's';
    const short = long === 's' ? 't' : 's';
    if (look?.roofOrientation === 'across') alongs = [short];
    if (look?.roofOrientation === 'along') alongs = [long];
    if (look?.roofDirectionDegrees !== undefined) {
      // The bearing the roof faces (down the slope): the ridge runs across it.
      const b = (look.roofDirectionDegrees * Math.PI) / 180;
      const dx = Math.sin(b);
      const dy = Math.cos(b);
      const f = shape.frame;
      const alongS = Math.abs(dx * f.ux + dy * f.uy);
      alongs = [alongS > Math.SQRT1_2 ? 't' : 's'];
    }
  }

  // The slope from the pitch, or from the source's roof height.
  const mainAlong = alongs[0] ?? 's';
  const mainWidth = width(main, mainAlong);
  const run = kind === 'skillion' ? mainWidth : mainWidth / 2;
  if (!(run > 0)) return flatPlan(input);
  const height = input.reference - input.base;
  const tagged = look?.roofHeightMeters;
  let rise =
    tagged ?? Math.tan((Math.min(60, Math.max(3, input.pitchDegrees)) * Math.PI) / 180) * run;
  const ridgeAtReference = tagged !== undefined && look?.heightMeters !== undefined;
  const cap = ridgeAtReference ? height - MIN_WALL_M : 2 * (height - MIN_WALL_M);
  rise = Math.min(rise, cap);
  if (!(rise >= MIN_RISE_M)) return flatPlan(input);
  const slope = rise / run;
  const eaves = ridgeAtReference ? input.reference - rise : input.reference - rise / 2;

  // Narrower wings that run across a wider part stop at its ridge line.
  const rects: RoofRect[] = sorted.map((rect, i) => ({
    rect,
    along: alongs[i] ?? 's',
    openStart: false,
    openEnd: false,
    lowFirst: input.chance < 0.5,
  }));
  if (look?.roofDirectionDegrees !== undefined && kind === 'skillion' && rects[0]) {
    // The roof faces (slopes down towards) the given bearing.
    const r0 = rects[0];
    const b = (look.roofDirectionDegrees * Math.PI) / 180;
    const f = shape.frame;
    const across = r0.along === 's' ? { x: -f.uy, y: f.ux } : { x: f.ux, y: f.uy };
    rects[0] = { ...r0, lowFirst: Math.sin(b) * across.x + Math.cos(b) * across.y < 0 };
  }
  for (let j = 0; j < rects.length; j += 1) {
    const r = rects[j];
    if (!r) continue;
    let { rect, openStart, openEnd } = r;
    for (let i = 0; i < rects.length; i += 1) {
      const wide = rects[i];
      if (!wide || i === j || wide.along === r.along) continue;
      if (width(wide.rect, wide.along) < width(r.rect, r.along)) continue;
      if (width(wide.rect, wide.along) === width(r.rect, r.along) && i > j) continue;
      // `r` runs along the axis across `wide`'s ridge: compare along that axis.
      const lo = r.along === 's' ? r.rect.s0 : r.rect.t0;
      const hi = r.along === 's' ? r.rect.s1 : r.rect.t1;
      const wlo = r.along === 's' ? wide.rect.s0 : wide.rect.t0;
      const whi = r.along === 's' ? wide.rect.s1 : wide.rect.t1;
      const mid = (wlo + whi) / 2;
      // And they must overlap across it.
      const clo = r.along === 's' ? r.rect.t0 : r.rect.s0;
      const chi = r.along === 's' ? r.rect.t1 : r.rect.s1;
      const wclo = r.along === 's' ? wide.rect.t0 : wide.rect.s0;
      const wchi = r.along === 's' ? wide.rect.t1 : wide.rect.s1;
      if (chi <= wclo + 1e-6 || clo >= wchi - 1e-6) continue;
      const outBelow = lo < wlo - 1e-6;
      const outAbove = hi > whi + 1e-6;
      if (outBelow && !outAbove && hi > mid - 1e-6) {
        rect =
          r.along === 's'
            ? { ...rect, s1: Math.min(rect.s1, mid) }
            : { ...rect, t1: Math.min(rect.t1, mid) };
        openEnd = true;
      } else if (outAbove && !outBelow && lo < mid + 1e-6) {
        rect =
          r.along === 's'
            ? { ...rect, s0: Math.max(rect.s0, mid) }
            : { ...rect, t0: Math.max(rect.t0, mid) };
        openStart = true;
      } else if (!outAbove && !outBelow && lo >= wlo - 1e-6 && hi <= whi + 1e-6) {
        // Wholly within the wider part's span: its ends are under that roof.
        openStart = true;
        openEnd = true;
      }
    }
    rects[j] = { ...r, rect, openStart, openEnd };
  }
  // Hipped rectangles keep their ridge on the long side.
  const kept = rects.filter((r) => length(r.rect, r.along) > 0.5 && width(r.rect, r.along) > 0.5);
  const top = Math.max(
    ...kept.map((r) =>
      kind === 'skillion'
        ? eaves + slope * width(r.rect, r.along)
        : eaves + (slope * width(r.rect, r.along)) / 2,
    ),
  );
  return {
    kind,
    frame: shape.frame,
    rects: kept,
    eaves,
    slope,
    rise,
    overhang: input.overhangM,
    top,
  };
}

/** A rectangle in (a along the ridge, b across it) coordinates. */
interface RidgeRect {
  readonly a0: number;
  readonly a1: number;
  readonly b0: number;
  readonly b1: number;
  /** (a, b) to map coordinates. */
  world(a: number, b: number): { x: number; y: number };
  /** Map coordinates to (a, b). */
  local(x: number, y: number): { a: number; b: number };
  /** Unit map directions of +a and +b. */
  readonly da: { readonly x: number; readonly y: number };
  readonly db: { readonly x: number; readonly y: number };
}

function ridgeRect(frame: ShapeFrame, r: RoofRect): RidgeRect {
  const { rect } = r;
  const S = { x: frame.ux, y: frame.uy };
  const T = { x: -frame.uy, y: frame.ux };
  if (r.along === 's') {
    return {
      a0: rect.s0,
      a1: rect.s1,
      b0: rect.t0,
      b1: rect.t1,
      world: (a, b) => toWorld(frame, a, b),
      local: (x, y) => {
        const p = toLocal(frame, { x, y });
        return { a: p.s, b: p.t };
      },
      da: S,
      db: T,
    };
  }
  return {
    a0: rect.t0,
    a1: rect.t1,
    b0: rect.s0,
    b1: rect.s1,
    world: (a, b) => toWorld(frame, b, a),
    local: (x, y) => {
      const p = toLocal(frame, { x, y });
      return { a: p.t, b: p.s };
    },
    da: T,
    db: S,
  };
}

/** Height of one rectangle's roof surface at (a, b), or null outside its extent with overhang. */
function rectRoofAt(
  plan: RoofPlan,
  r: RoofRect,
  rr: RidgeRect,
  a: number,
  b: number,
): number | null {
  const o = plan.overhang + 1e-6;
  const ea0 = rr.a0 - (r.openStart ? 1e-6 : o);
  const ea1 = rr.a1 + (r.openEnd ? 1e-6 : o);
  if (a < ea0 || a > ea1 || b < rr.b0 - o || b > rr.b1 + o) return null;
  const k = plan.slope;
  const h = (rr.b1 - rr.b0) / 2;
  const bc = (rr.b0 + rr.b1) / 2;
  if (plan.kind === 'skillion') {
    const run = r.lowFirst ? b - rr.b0 : rr.b1 - b;
    return plan.eaves + k * run;
  }
  let d = h - Math.abs(b - bc);
  if (plan.kind === 'hipped') {
    if (!r.openStart) d = Math.min(d, a - rr.a0);
    if (!r.openEnd) d = Math.min(d, rr.a1 - a);
  }
  return plan.eaves + k * d;
}

/** The roof surface's height above a point, the highest of its rectangles'; null where none covers it. */
export function roofHeightAt(plan: RoofPlan, x: number, y: number): number | null {
  let best: number | null = null;
  for (const r of plan.rects) {
    const rr = ridgeRect(plan.frame, r);
    const { a, b } = rr.local(x, y);
    const z = rectRoofAt(plan, r, rr, a, b);
    if (z !== null && (best === null || z > best)) best = z;
  }
  return best;
}

export interface RoofColours {
  readonly roof: Rgb;
  readonly roofLayer: number;
  readonly wall: Rgb;
  readonly wallLayer: number;
  readonly wallTileM: number;
  readonly roofTileM: number;
  readonly trim: Rgb;
  /** Wall texture v is measured from here. */
  readonly base: number;
}

/** A gable end: its triangle's corners in map coordinates and the direction it faces. */
export interface GableEnd {
  readonly left: { readonly x: number; readonly y: number };
  readonly right: { readonly x: number; readonly y: number };
  readonly eaves: number;
  readonly apex: number;
  readonly nx: number;
  readonly ny: number;
}

/**
 * Emits a pitched roof: its faces, gable triangles (in the wall's material),
 * fascia boards and soffits. Returns the gable ends.
 */
export function emitPitchedRoof(plan: RoofPlan, out: SurfaceBuilder, c: RoofColours): GableEnd[] {
  const gables: GableEnd[] = [];
  const k = plan.slope;
  const o = plan.overhang;
  const stretch = Math.sqrt(1 + k * k);
  for (const r of plan.rects) {
    const rr = ridgeRect(plan.frame, r);
    const { a0, a1, b0, b1, da, db } = rr;
    const h = (b1 - b0) / 2;
    const bc = (b0 + b1) / 2;
    const ea0 = a0 - (r.openStart ? 0 : o);
    const ea1 = a1 + (r.openEnd ? 0 : o);
    const eb0 = b0 - o;
    const eb1 = b1 + o;
    const E = plan.eaves;
    const zAt = (a: number, b: number) => rectRoofAt(plan, r, rr, a, b) ?? E;
    /**
     * A roof vertex. Texture u runs along the eaves `e`, v up the slope from
     * the eaves line through (ea, eb) (real lengths, so tiles keep their size).
     */
    const roofVertex = (
      a: number,
      b: number,
      e: { readonly x: number; readonly y: number },
      up: { readonly x: number; readonly y: number },
      z = zAt(a, b),
    ): SurfaceVertex => {
      const p = rr.world(a, b);
      return {
        x: p.x,
        y: p.y,
        z,
        u: (p.x * e.x + p.y * e.y) / c.roofTileM,
        v: ((p.x * up.x + p.y * up.y) * stretch) / c.roofTileM,
      };
    };
    const neg = (d: { readonly x: number; readonly y: number }) => ({ x: -d.x, y: -d.y });
    const up: [number, number, number] = [0, 0, 1];
    const down: [number, number, number] = [0, 0, -1];
    // Each roof face, and its underside (seen under the overhangs) as plain trim.
    const roofQuad = (p: SurfaceVertex, q: SurfaceVertex, r2: SurfaceVertex, s2: SurfaceVertex) => {
      out.quad(p, q, r2, s2, up, c.roof, c.roofLayer);
      out.quad(p, q, r2, s2, down, c.trim, -1);
    };
    const roofTriangle = (p: SurfaceVertex, q: SurfaceVertex, r2: SurfaceVertex) => {
      out.triangle(p, q, r2, up, c.roof, c.roofLayer);
      out.triangle(p, q, r2, down, c.trim, -1);
    };
    const zEdge = E - k * o;

    if (plan.kind === 'skillion') {
      const lowSide = r.lowFirst ? eb0 : eb1;
      const upDir = r.lowFirst ? db : neg(db);
      const zLow = E - k * o;
      const zHigh = E + k * (b1 - b0 + o);
      const zb = (b: number) => (b === lowSide ? zLow : zHigh);
      const v = (a: number, b: number) => roofVertex(a, b, da, upDir, zb(b));
      roofQuad(v(ea0, eb0), v(ea1, eb0), v(ea1, eb1), v(ea0, eb1));
      const wallZ = (b: number) => (b === (r.lowFirst ? b0 : b1) ? E : E + k * (b1 - b0));
      emitEavesTrim(out, rr, ea0, ea1, eb0, b0, zb(eb0), wallZ(b0), true, c.trim);
      emitEavesTrim(out, rr, ea0, ea1, eb1, b1, zb(eb1), wallZ(b1), false, c.trim);
      continue;
    }

    const ridgeZ = E + k * h;
    const hipped = plan.kind === 'hipped';
    const ra0 = hipped && !r.openStart ? Math.min(a0 + h, (a0 + a1) / 2) : ea0;
    const ra1 = hipped && !r.openEnd ? Math.max(a1 - h, (a0 + a1) / 2) : ea1;
    // The two long faces.
    const side = (eb: number, upDir: { readonly x: number; readonly y: number }) => {
      const v = (a: number, b: number, z: number) => roofVertex(a, b, da, upDir, z);
      roofQuad(v(ea0, eb, zEdge), v(ea1, eb, zEdge), v(ra1, bc, ridgeZ), v(ra0, bc, ridgeZ));
    };
    side(eb0, db);
    side(eb1, neg(db));
    emitEavesTrim(out, rr, ea0, ea1, eb0, b0, zEdge, E, true, c.trim);
    emitEavesTrim(out, rr, ea0, ea1, eb1, b1, zEdge, E, false, c.trim);

    // The ends: hipped faces, or gable triangles in the wall's material.
    const end = (atStart: boolean) => {
      const open = atStart ? r.openStart : r.openEnd;
      const ea = atStart ? ea0 : ea1;
      const a = atStart ? a0 : a1;
      const ra = atStart ? ra0 : ra1;
      const outward = atStart ? neg(da) : da;
      if (hipped && !open) {
        const inward = atStart ? da : neg(da);
        const v = (aa: number, bb: number, z: number) => roofVertex(aa, bb, db, inward, z);
        roofTriangle(v(ea, eb0, zEdge), v(ea, eb1, zEdge), v(ra, bc, ridgeZ));
        emitEndTrim(out, rr, ea, a, eb0, eb1, zEdge, atStart, c.trim);
        return;
      }
      // An open end lies under the wider part's roof: nothing to close.
      if (open) return;
      const wall = (bb: number, z: number): SurfaceVertex => {
        const p = rr.world(a, bb);
        return {
          x: p.x,
          y: p.y,
          z,
          u: (p.x * -outward.y + p.y * outward.x) / c.wallTileM,
          v: (z - c.base) / c.wallTileM,
        };
      };
      out.triangle(
        wall(b0, E),
        wall(b1, E),
        wall(bc, ridgeZ),
        [outward.x, outward.y, 0],
        c.wall,
        c.wallLayer,
      );
      const left = rr.world(a, atStart ? b1 : b0);
      const right = rr.world(a, atStart ? b0 : b1);
      gables.push({
        left,
        right,
        eaves: E,
        apex: ridgeZ,
        nx: outward.x,
        ny: outward.y,
      });
    };
    end(true);
    end(false);
  }
  return gables;
}

/**
 * The fascia board under an eaves edge at `eb` (the overhang's outer edge, the
 * roof there at `z`; `wb` is the wall line, the roof there at `wallZ`), and
 * the level soffit from it back to the wall, never above the wall's top.
 */
function emitEavesTrim(
  out: SurfaceBuilder,
  rr: RidgeRect,
  ea0: number,
  ea1: number,
  eb: number,
  wb: number,
  z: number,
  wallZ: number,
  low: boolean,
  trim: Rgb,
) {
  const outward = low ? { x: -rr.db.x, y: -rr.db.y } : rr.db;
  const v = (a: number, b: number, zz: number): SurfaceVertex => ({
    ...rr.world(a, b),
    z: zz,
    u: 0,
    v: 0,
  });
  const zb = Math.min(z - FASCIA_M, wallZ);
  out.quad(
    v(ea0, eb, zb),
    v(ea1, eb, zb),
    v(ea1, eb, z),
    v(ea0, eb, z),
    [outward.x, outward.y, 0],
    trim,
    -1,
  );
  if (Math.abs(eb - wb) > 1e-3) {
    out.quad(v(ea0, wb, zb), v(ea1, wb, zb), v(ea1, eb, zb), v(ea0, eb, zb), [0, 0, -1], trim, -1);
  }
}

/** The fascia and soffit along a hipped end. */
function emitEndTrim(
  out: SurfaceBuilder,
  rr: RidgeRect,
  ea: number,
  wa: number,
  eb0: number,
  eb1: number,
  z: number,
  atStart: boolean,
  trim: Rgb,
) {
  const outward = atStart ? { x: -rr.da.x, y: -rr.da.y } : rr.da;
  const v = (a: number, b: number, zz: number): SurfaceVertex => ({
    ...rr.world(a, b),
    z: zz,
    u: 0,
    v: 0,
  });
  const zb = z - FASCIA_M;
  out.quad(
    v(ea, eb0, zb),
    v(ea, eb1, zb),
    v(ea, eb1, z),
    v(ea, eb0, z),
    [outward.x, outward.y, 0],
    trim,
    -1,
  );
  if (Math.abs(ea - wa) > 1e-3) {
    out.quad(v(wa, eb0, zb), v(wa, eb1, zb), v(ea, eb1, zb), v(ea, eb0, zb), [0, 0, -1], trim, -1);
  }
}
