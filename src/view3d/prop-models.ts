import type { MeshData } from './drape';
import { srgbToLinear } from './srgb';

// Procedural models of roadside and settlement details (docs/adr/0036):
// street lamps, utility poles and pylons, fence, wall and hedge segments,
// guard rails, signs and street furniture. Built once, in three levels of
// detail, and drawn instanced through the vegetation layer (one shared
// vertex-coloured material), so a whole battlefield of them costs a few draw
// calls. Simple, believable shapes with few triangles: prisms and boxes in
// restrained colours. Metres, Three.js axes (y up); the foot is at the
// origin and posts reach half a metre below it, so nothing stands on air on
// a slope. Models that face a direction (lamp arms, signs, segments) are
// built along +x: an instance's yaw turns +x to where it should point.
// Colours that vary per instance (paint) are built white or light grey and
// tinted per instance.

type V3 = [number, number, number];
type C = V3;

const rgb = (hex: number): C => [
  srgbToLinear((hex >> 16) & 255),
  srgbToLinear((hex >> 8) & 255),
  srgbToLinear(hex & 255),
];

/** Below-ground depth of posts and footings. */
const FOOT = 0.5;

class PropBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];

  tri(a: V3, b: V3, c: V3, col: C) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return;
    for (const p of [a, b, c]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(nx / len, ny / len, nz / len);
      this.colors.push(col[0], col[1], col[2]);
    }
  }

  /** A quad a–b–c–d, counter-clockwise seen from its front. */
  quad(a: V3, b: V3, c: V3, d: V3, col: C) {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }

  /** Both faces of a quad (thin plates: signs, wire). */
  plate(a: V3, b: V3, c: V3, d: V3, front: C, back: C = front) {
    this.quad(a, b, c, d, front);
    this.quad(a, d, c, b, back);
  }

  /** An axis-aligned box from (x0, y0, z0) to (x1, y1, z1), without its bottom. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: C, top = col) {
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col); // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], col); // −z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], col); // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col); // −x
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top); // +y
  }

  /**
   * A tapered tube with `sides` faces from point a (radius ra) to b (radius
   * rb), capped at b.
   */
  tube(a: V3, b: V3, ra: number, rb: number, sides: number, col: C, cap = true) {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    const w: V3 = [d[0] / len, d[1] / len, d[2] / len];
    // Two axes perpendicular to the tube.
    const ref: V3 = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u0: V3 = [
      w[1] * ref[2] - w[2] * ref[1],
      w[2] * ref[0] - w[0] * ref[2],
      w[0] * ref[1] - w[1] * ref[0],
    ];
    const ul = Math.hypot(u0[0], u0[1], u0[2]);
    const u: V3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];
    const v: V3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
    const ring = (c: V3, r: number, k: number): V3 => {
      const t = (2 * Math.PI * k) / sides + Math.PI / sides;
      const cu = Math.cos(t) * r;
      const sv = Math.sin(t) * r;
      return [
        c[0] + u[0] * cu + v[0] * sv,
        c[1] + u[1] * cu + v[1] * sv,
        c[2] + u[2] * cu + v[2] * sv,
      ];
    };
    for (let k = 0; k < sides; k += 1) {
      const p0 = ring(a, ra, k);
      const p1 = ring(a, ra, k + 1);
      const q0 = ring(b, rb, k);
      const q1 = ring(b, rb, k + 1);
      this.quad(p0, p1, q1, q0, col);
      if (cap && rb > 0) this.tri(b, q0, q1, col);
    }
  }

  finish(): MeshData {
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      colors: Float32Array.from(this.colors),
      triangleCount: this.positions.length / 9,
    };
  }
}

type Lods = [MeshData, MeshData, MeshData];
/** Builds a model at three levels of detail: `detail` is 2 (near), 1 (medium) or 0 (far). */
const lods = (build: (b: PropBuilder, detail: number) => void): Lods =>
  [2, 1, 0].map((detail) => {
    const b = new PropBuilder();
    build(b, detail);
    return b.finish();
  }) as Lods;

const GALVANISED = rgb(0x9a9c9a);
const DARK_METAL = rgb(0x3a3f3c);
const LAMP_GLASS = rgb(0xf3ecd2);
const TIMBER = rgb(0x6e5a44);
const CONCRETE = rgb(0xa9a69f);
const WHITE = rgb(0xe8e8e4);
const STEEL_GREY = rgb(0x7d8180);

const sidesOf = (detail: number) => (detail === 2 ? 8 : detail === 1 ? 6 : 4);

/** A residential lamp (North America): a 7.5 m pole with a short arm and a cobra head. */
function lampResidential(b: PropBuilder, d: number) {
  const s = sidesOf(d);
  b.tube([0, -FOOT, 0], [0, 7.4, 0], 0.11, 0.07, s, GALVANISED);
  b.tube([0, 7.1, 0], [1.5, 7.45, 0], 0.045, 0.04, Math.max(4, s - 2), GALVANISED);
  b.box(1.3, 7.3, -0.16, 2.0, 7.48, 0.16, GALVANISED);
  if (d > 0) b.box(1.35, 7.27, -0.12, 1.95, 7.3, 0.12, LAMP_GLASS);
}

/** A village lamp (central Europe): a slim dark 4.5 m post with a lantern. */
function lampVillage(b: PropBuilder, d: number) {
  const s = sidesOf(d);
  b.tube([0, -FOOT, 0], [0, 3.9, 0], 0.09, 0.05, s, DARK_METAL);
  if (d > 0) b.tube([0, 3.85, 0], [0, 4.0, 0], 0.12, 0.12, s, DARK_METAL, false);
  // The lantern: glass in a dark frame, under a hood.
  b.tube([0, 4.0, 0], [0, 4.45, 0], 0.16, 0.2, 4, LAMP_GLASS, false);
  b.tube([0, 4.45, 0], [0, 4.7, 0], 0.3, 0.02, 4, DARK_METAL);
}

/** A modern road lamp: a 9 m galvanised pole curving into a long arm. */
function lampModern(b: PropBuilder, d: number) {
  const s = sidesOf(d);
  b.tube([0, -FOOT, 0], [0, 8.2, 0], 0.13, 0.08, s, GALVANISED);
  // The curve, in a few straight pieces.
  const pts: V3[] = [
    [0, 8.2, 0],
    [0.25, 8.75, 0],
    [0.7, 9.05, 0],
    [1.5, 9.15, 0],
    [2.0, 9.12, 0],
  ];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const p = pts[i];
    const q = pts[i + 1];
    if (p && q) b.tube(p, q, 0.075, 0.07, Math.max(4, s - 2), GALVANISED, false);
  }
  b.box(1.8, 8.95, -0.2, 2.6, 9.15, 0.2, GALVANISED);
  if (d > 0) b.box(1.85, 8.92, -0.15, 2.55, 8.95, 0.15, LAMP_GLASS);
}

/** An industrial lamp: a 10 m pole with a floodlight box. */
function lampIndustrial(b: PropBuilder, d: number) {
  const s = sidesOf(d);
  b.tube([0, -FOOT, 0], [0, 10, 0], 0.14, 0.09, s, GALVANISED);
  b.box(-0.1, 9.75, -0.3, 0.6, 10.05, 0.3, STEEL_GREY);
  if (d > 0) b.box(-0.05, 9.72, -0.25, 0.55, 9.75, 0.25, LAMP_GLASS);
}

/** Crossarm with three insulators at height h, along z (across the line, which runs along x). */
function crossarm(b: PropBuilder, h: number, half: number, wood: C, d: number) {
  b.box(-0.06, h - 0.1, -half, 0.06, h, half, wood);
  if (d === 0) return;
  for (const z of [-half + 0.15, 0, half - 0.15]) {
    b.tube([0, h, z], [0, h + 0.22, z], 0.05, 0.04, 4, rgb(0x5d6b70));
  }
}

/** A timber distribution pole (North America): 10 m, one crossarm. Lines run along +x. */
function poleTimber(b: PropBuilder, d: number) {
  b.tube([0, -1.2, 0], [0, 9.8, 0], 0.16, 0.11, sidesOf(d), TIMBER);
  crossarm(b, 9.2, 1.2, TIMBER, d);
  if (d === 2) b.box(-0.3, 7.6, 0.14, 0.3, 8.3, 0.6, rgb(0x6d706c)); // a transformer can, on some
}

/** A concrete distribution pole (central Europe): 9 m, tapered, with a small steel crossarm. */
function poleConcrete(b: PropBuilder, d: number) {
  b.tube([0, -1.2, 0], [0, 9, 0], 0.17, 0.1, d === 0 ? 4 : 6, CONCRETE);
  crossarm(b, 8.6, 0.9, STEEL_GREY, d);
}

/** A transmission pylon: a tapered lattice tower, about 30 m. Lines run along +x. */
function pylon(b: PropBuilder, d: number) {
  const col = rgb(0x8d918f);
  const legs: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const r = d === 0 ? 0.25 : 0.12;
  const base = 3.2;
  const top = 0.9;
  for (const [sx, sz] of legs) {
    b.tube([sx * base, -FOOT, sz * base], [sx * top, 28, sz * top], r, r * 0.7, 4, col, false);
  }
  if (d > 0) {
    // Bracing: a few horizontal rings and diagonals.
    for (const y of [6, 12, 18, 24]) {
      const w = base + ((top - base) * y) / 28;
      for (let k = 0; k < 4; k += 1) {
        const [ax, az] = legs[k] ?? [0, 0];
        const [bx, bz] = legs[(k + 1) % 4] ?? [0, 0];
        b.tube([ax * w, y, az * w], [bx * w, y, bz * w], 0.06, 0.06, 4, col, false);
        if (d === 2) {
          const y2 = y - 6;
          const w2 = base + ((top - base) * y2) / 28;
          b.tube([ax * w2, y2, az * w2], [bx * w, y, bz * w], 0.05, 0.05, 4, col, false);
        }
      }
    }
  }
  // Crossarms across the line, for the conductors.
  for (const [y, half] of [
    [22, 6],
    [27, 4.5],
  ] as const) {
    b.box(-0.35, y, -half, 0.35, y + 0.5, half, col);
  }
  b.tube([0, 28, 0], [0, 30, 0], 0.15, 0.05, 4, col);
}

/** A segment of wooden board fence, 2.4 m long along +x, centred on the origin. */
function fenceWood(b: PropBuilder, d: number) {
  const wood = rgb(0x8a7458);
  const dark = rgb(0x6b5843);
  b.box(-1.2, -FOOT, -0.05, -1.1, 1.3, 0.05, dark);
  if (d === 0) {
    b.box(-1.2, 0.05, -0.02, 1.2, 1.2, 0.02, wood);
    return;
  }
  b.box(-1.2, 0.35, -0.06, 1.2, 0.43, -0.03, dark);
  b.box(-1.2, 0.95, -0.06, 1.2, 1.03, -0.03, dark);
  const boards = d === 2 ? 16 : 8;
  const w = 2.4 / boards;
  for (let i = 0; i < boards; i += 1) {
    const x0 = -1.2 + i * w + 0.01;
    b.box(x0, 0.05, -0.03, x0 + w - 0.02, 1.2 + (i % 2) * 0.03, 0.0, wood);
  }
}

/** A segment of chain-link fence: posts, rails and fine wire, 2.4 m. */
function fenceChain(b: PropBuilder, d: number) {
  b.tube([-1.2, -FOOT, 0], [-1.2, 1.85, 0], 0.035, 0.035, 6, GALVANISED);
  b.tube([-1.2, 1.8, 0], [1.2, 1.8, 0], 0.02, 0.02, 4, GALVANISED, false);
  if (d === 0) return;
  b.tube([-1.2, 0.08, 0], [1.2, 0.08, 0], 0.01, 0.01, 3, GALVANISED, false);
  // The mesh, as a few diamond wires: reads as chain link without transparency.
  const n = d === 2 ? 8 : 4;
  for (let i = 0; i < n; i += 1) {
    const x = -1.2 + (2.4 * i) / n;
    const step = 2.4 / n;
    b.tube([x, 0.08, 0], [x + step, 1.8, 0], 0.006, 0.006, 3, STEEL_GREY, false);
    b.tube([x + step, 0.08, 0], [x, 1.8, 0], 0.006, 0.006, 3, STEEL_GREY, false);
  }
}

/** A segment of metal bar fence (central Europe), 1.2 m high, 2.4 m. */
function fenceMetal(b: PropBuilder, d: number) {
  const col = rgb(0x4b524e);
  b.box(-1.23, -FOOT, -0.03, -1.17, 1.25, 0.03, col);
  b.box(-1.2, 0.15, -0.015, 1.2, 0.2, 0.015, col);
  b.box(-1.2, 1.05, -0.015, 1.2, 1.1, 0.015, col);
  if (d === 0) return;
  const bars = d === 2 ? 18 : 9;
  for (let i = 1; i < bars; i += 1) {
    const x = -1.2 + (2.4 * i) / bars;
    b.box(x - 0.008, 0.08, -0.008, x + 0.008, 1.18, 0.008, col);
  }
}

/** A segment of stone wall with a cap: 2.4 m long, 1 m high, with a footing below ground. */
function wallStone(b: PropBuilder, d: number) {
  const stone = rgb(0xb3aa98);
  const cap = rgb(0x9b9384);
  b.box(-1.21, -FOOT, -0.22, 1.21, 0.9, 0.22, stone, cap);
  if (d > 0) b.box(-1.21, 0.9, -0.26, 1.21, 1.0, 0.26, cap);
}

/** A segment of concrete wall, 2.4 m long, 1.8 m high. */
function wallConcrete(b: PropBuilder, d: number) {
  const col = rgb(0xb2b0aa);
  b.box(-1.21, -FOOT, -0.1, 1.21, 1.8, 0.1, col, rgb(0x9e9c96));
  if (d === 2) b.box(-1.21, 1.8, -0.13, 1.21, 1.86, 0.13, rgb(0x9e9c96));
}

/** A segment of trimmed hedge, 2.4 m long, about 1.3 m high, a little irregular. */
function hedge(b: PropBuilder, d: number) {
  const side = rgb(0x4f6a33);
  const top = rgb(0x67823f);
  if (d === 0) {
    b.box(-1.25, -0.2, -0.45, 1.25, 1.3, 0.45, side, top);
    return;
  }
  // Two overlapping blocks of slightly different height and depth.
  b.box(-1.25, -0.2, -0.42, 0.15, 1.27, 0.42, side, top);
  b.box(-0.1, -0.2, -0.47, 1.25, 1.33, 0.47, side, top);
}

/** A steel W-beam guard rail on posts, 2.4 m. */
function guardRail(b: PropBuilder, d: number) {
  b.box(-1.24, -FOOT, -0.05, -1.16, 0.7, 0.05, STEEL_GREY);
  b.box(-1.2, 0.45, 0.05, 1.2, 0.75, 0.09, GALVANISED);
  if (d > 0) b.box(-1.2, 0.56, 0.09, 1.2, 0.64, 0.11, rgb(0x8a8d8b));
}

/** A sign post with a plate facing +x; `shape` sets the plate. */
function sign(b: PropBuilder, d: number, shape: 'octagon' | 'triangle' | 'rectangle') {
  b.tube([0, -FOOT, 0], [0, 2.3, 0], 0.035, 0.035, d === 0 ? 4 : 6, GALVANISED);
  const face = shape === 'rectangle' ? rgb(0x2f5f9e) : rgb(0xb3302a);
  const back = rgb(0x8f918f);
  const x = 0.05;
  const y = 2.15;
  if (shape === 'rectangle') {
    b.plate(
      [x, y - 0.35, 0.3],
      [x, y - 0.35, -0.3],
      [x, y + 0.35, -0.3],
      [x, y + 0.35, 0.3],
      face,
      back,
    );
    if (d > 0) {
      // A white border.
      b.plate(
        [x + 0.005, y - 0.3, 0.25],
        [x + 0.005, y - 0.3, -0.25],
        [x + 0.005, y + 0.3, -0.25],
        [x + 0.005, y + 0.3, 0.25],
        face,
        back,
      );
    }
    return;
  }
  const n = shape === 'octagon' ? 8 : 3;
  const r = shape === 'octagon' ? 0.38 : 0.45;
  const start = shape === 'octagon' ? Math.PI / 8 : -Math.PI / 2;
  const pts: V3[] = Array.from({ length: n }, (_, k) => {
    const t = start + (2 * Math.PI * k) / n;
    return [x, y + Math.sin(t) * r * (shape === 'triangle' ? -1 : 1), Math.cos(t) * r];
  });
  const centre: V3 = [x, y, 0];
  for (let k = 0; k < n; k += 1) {
    const p = pts[k];
    const q = pts[(k + 1) % n];
    if (!p || !q) continue;
    b.tri(centre, q, p, face);
    b.tri(centre, p, q, back);
  }
  if (d > 0 && shape === 'triangle') {
    // White inner field of a give-way sign.
    const inner = pts.map((p): V3 => [x + 0.005, y + (p[1] - y) * 0.62, p[2] * 0.62]);
    const c: V3 = [x + 0.005, y, 0];
    for (let k = 0; k < inner.length; k += 1) {
      const p = inner[k];
      const q = inner[(k + 1) % inner.length];
      if (p && q) b.tri(c, q, p, WHITE);
    }
  }
}

/** A roadside mailbox on a post (North America), facing +x (the road). */
function mailbox(b: PropBuilder, d: number) {
  b.box(-0.05, -FOOT, -0.05, 0.05, 1.0, 0.05, rgb(0x8a7a62));
  b.box(-0.25, 1.0, -0.11, 0.25, 1.22, 0.11, WHITE);
  if (d > 0) b.box(0.0, 1.22, -0.08, 0.2, 1.27, 0.08, WHITE);
}

/** A park bench, 1.8 m, facing +x. */
function bench(b: PropBuilder, d: number) {
  const wood = rgb(0x8a6e4e);
  const metal = DARK_METAL;
  for (const z of [-0.8, 0.8]) b.box(-0.25, -0.2, z - 0.04, 0.25, 0.45, z + 0.04, metal);
  b.box(-0.25, 0.42, -0.9, 0.22, 0.47, 0.9, wood);
  if (d > 0) b.box(-0.3, 0.55, -0.9, -0.25, 0.9, 0.9, wood);
}

/** A litter bin on a post. */
function bin(b: PropBuilder, d: number) {
  b.tube([0, -0.3, 0], [0, 0.9, 0], 0.2, 0.22, sidesOf(d), rgb(0x55605a));
}

/** A bollard. */
function bollard(b: PropBuilder, d: number) {
  b.tube([0, -0.3, 0], [0, 0.9, 0], 0.08, 0.08, sidesOf(d), rgb(0x5a5f5c));
  if (d > 0) b.tube([0, 0.7, 0], [0, 0.8, 0], 0.085, 0.085, sidesOf(d), WHITE, false);
}

/** A post box, painted per instance (built white). */
function postBox(b: PropBuilder, d: number) {
  b.box(-0.2, -0.3, -0.2, 0.2, 1.1, 0.2, WHITE);
  if (d > 0) b.tube([0, 1.1, 0], [0, 1.2, 0], 0.22, 0.02, 4, WHITE);
}

export type PropName =
  | 'lampResidential'
  | 'lampVillage'
  | 'lampModern'
  | 'lampIndustrial'
  | 'poleTimber'
  | 'poleConcrete'
  | 'pylon'
  | 'fenceWood'
  | 'fenceChain'
  | 'fenceMetal'
  | 'wallStone'
  | 'wallConcrete'
  | 'hedge'
  | 'guardRail'
  | 'signStop'
  | 'signGiveWay'
  | 'signGeneric'
  | 'mailbox'
  | 'bench'
  | 'bin'
  | 'bollard'
  | 'postBox';

const BUILDERS: Readonly<Record<PropName, (b: PropBuilder, d: number) => void>> = {
  lampResidential,
  lampVillage,
  lampModern,
  lampIndustrial,
  poleTimber,
  poleConcrete,
  pylon,
  fenceWood,
  fenceChain,
  fenceMetal,
  wallStone,
  wallConcrete,
  hedge,
  guardRail,
  signStop: (b, d) => {
    sign(b, d, 'octagon');
  },
  signGiveWay: (b, d) => {
    sign(b, d, 'triangle');
  },
  signGeneric: (b, d) => {
    sign(b, d, 'rectangle');
  },
  mailbox,
  bench,
  bin,
  bollard,
  postBox,
};

/** A prop's three levels of detail. */
export function propLods(name: PropName): Lods {
  return lods(BUILDERS[name]);
}

/** Top and widest horizontal extent of a mesh (for its spec). */
export function meshExtent(m: MeshData): { height: number; radius: number } {
  let height = 0;
  let radius = 0;
  for (let i = 0; i < m.positions.length; i += 3) {
    height = Math.max(height, m.positions[i + 1] ?? 0);
    radius = Math.max(radius, Math.hypot(m.positions[i] ?? 0, m.positions[i + 2] ?? 0));
  }
  return { height, radius };
}
