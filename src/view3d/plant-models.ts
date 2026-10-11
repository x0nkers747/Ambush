import type { MeshData } from './drape';
import { meshExtent, propLods, type PropName } from './prop-models';
import { hashInts, unit } from './hash';
import { srgbToLinear } from './terrain-mesh';

// Procedural plant models (docs/adr/0031): a small library of trees and
// shrubs, each built once in three levels of detail and shared by every
// instance. Stylised realism: a trunk and limbs that read as wood, crowns made
// of a few irregular foliage masses (broadleaf) or tiers of jagged skirts
// (spruce), natural proportions, restrained colours, and few triangles.
//
// Crowns are shaded as one soft volume: each foliage vertex's normal leans
// towards the outward direction from the crown's centre, and its colour is
// darker low in the crown and in its hollows, a cheap self-shadowing. Models
// are in metres, Three.js axes (y up), with the trunk's foot at the origin;
// trunks reach a metre below it, so a tree on a slope never stands on air.
// Every model is scaled to exactly its reference height and crown radius, at
// every level of detail, so switching level never changes a tree's size.

export type PlantKind =
  | 'broadleaf'
  | 'conifer'
  | 'pine'
  | 'smallTree'
  | 'deadTree'
  | 'shrub'
  /** Roadside and settlement details (docs/adr/0036): lamps, poles, fences, signs. */
  | 'prop';

export interface PlantSpec {
  readonly name: string;
  readonly kind: PlantKind;
  /** Height from the ground to the crown's top, metres. */
  readonly height: number;
  /** Largest horizontal radius of the crown, metres. */
  readonly crown: number;
  /** Distances at which this plant changes level are scaled by this (small plants switch sooner). */
  readonly lodScale: number;
  /** For props: which model (prop-models.ts). */
  readonly prop?: PropName;
}

/** The library, in a fixed order: placement refers to plants by index. */
export const PLANTS: readonly PlantSpec[] = [
  { name: 'oak', kind: 'broadleaf', height: 15, crown: 5.3, lodScale: 1 },
  { name: 'beech', kind: 'broadleaf', height: 16, crown: 4.9, lodScale: 1 },
  { name: 'lime', kind: 'broadleaf', height: 14, crown: 5.1, lodScale: 1 },
  { name: 'spruce', kind: 'conifer', height: 18, crown: 3.8, lodScale: 1 },
  { name: 'pine', kind: 'pine', height: 17, crown: 4.2, lodScale: 1 },
  { name: 'sapling', kind: 'smallTree', height: 7, crown: 2.8, lodScale: 0.75 },
  { name: 'snag', kind: 'deadTree', height: 12, crown: 2.6, lodScale: 0.75 },
  { name: 'bush', kind: 'shrub', height: 2, crown: 1.4, lodScale: 0.5 },
  { name: 'thicket', kind: 'shrub', height: 2.4, crown: 1.9, lodScale: 0.5 },
  // Props (docs/adr/0036): height and reach are measured from each model's near level.
  ...(
    [
      ['lampResidential', 0.45],
      ['lampVillage', 0.35],
      ['lampModern', 0.5],
      ['lampIndustrial', 0.5],
      ['poleTimber', 0.6],
      ['poleConcrete', 0.6],
      ['pylon', 1.2],
      ['fenceWood', 0.25],
      ['fenceChain', 0.25],
      ['fenceMetal', 0.25],
      ['wallStone', 0.3],
      ['wallConcrete', 0.3],
      ['hedge', 0.3],
      ['guardRail', 0.25],
      ['signStop', 0.2],
      ['signGiveWay', 0.2],
      ['signGeneric', 0.2],
      ['mailbox', 0.15],
      ['bench', 0.15],
      ['bin', 0.15],
      ['bollard', 0.15],
      ['postBox', 0.15],
    ] as const
  ).map(([prop, lodScale]): PlantSpec => {
    const { height, radius } = meshExtent(propLods(prop)[0]);
    return { name: prop, kind: 'prop', height, crown: radius, lodScale, prop };
  }),
];

/** Indices into `PLANTS` by kind. */
export const PLANTS_BY_KIND: Readonly<Record<PlantKind, readonly number[]>> = {
  broadleaf: [0, 1, 2],
  conifer: [3],
  pine: [4],
  smallTree: [5],
  deadTree: [6],
  shrub: [7, 8],
  prop: PLANTS.flatMap((p, i) => (p.kind === 'prop' ? [i] : [])),
};

/** The index of a prop in `PLANTS`. */
export function propIndex(name: PropName): number {
  const i = PLANTS.findIndex((p) => p.prop === name);
  if (i < 0) throw new RangeError(`no prop ${name}`);
  return i;
}

export const LOD_LEVELS = 3;

export interface PlantModel {
  readonly spec: PlantSpec;
  /** Near, medium and far meshes, with vertex colours. */
  readonly lods: readonly [MeshData, MeshData, MeshData];
}

type V3 = [number, number, number];

/** Vertex colours, linear RGB, from sRGB hex. */
function rgb(hex: number, shade = 1): V3 {
  return [
    srgbToLinear(Math.min(255, ((hex >> 16) & 255) * shade)),
    srgbToLinear(Math.min(255, ((hex >> 8) & 255) * shade)),
    srgbToLinear(Math.min(255, (hex & 255) * shade)),
  ];
}

class Builder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  vertex(p: V3, n: V3, c: V3) {
    this.positions.push(p[0], p[1], p[2]);
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    this.normals.push(n[0] / len, n[1] / len, n[2] / len);
    this.colors.push(c[0], c[1], c[2]);
  }
  /** Scales the model so its top is at `height` and its widest point `radius` from the axis. */
  finish(height: number, radius: number): MeshData {
    let top = -Infinity;
    let wide = 0;
    for (let i = 0; i < this.positions.length; i += 3) {
      top = Math.max(top, this.positions[i + 1] ?? 0);
      wide = Math.max(wide, Math.hypot(this.positions[i] ?? 0, this.positions[i + 2] ?? 0));
    }
    const sy = height / top;
    const sxz = radius / (wide || 1);
    const positions = Float32Array.from(this.positions, (v, i) => (i % 3 === 1 ? v * sy : v * sxz));
    // Normals transform by the inverse scale.
    const normals = Float32Array.from(this.normals);
    for (let i = 0; i < normals.length; i += 3) {
      const nx = (normals[i] ?? 0) / sxz;
      const ny = (normals[i + 1] ?? 0) / sy;
      const nz = (normals[i + 2] ?? 0) / sxz;
      const len = Math.hypot(nx, ny, nz) || 1;
      normals[i] = nx / len;
      normals[i + 1] = ny / len;
      normals[i + 2] = nz / len;
    }
    return {
      positions,
      normals,
      colors: Float32Array.from(this.colors),
      triangleCount: this.positions.length / 9,
    };
  }
}

// --- Icospheres ----------------------------------------------------------------

const T = (1 + Math.sqrt(5)) / 2;
const ICO_VERTS: V3[] = [
  [-1, T, 0],
  [1, T, 0],
  [-1, -T, 0],
  [1, -T, 0],
  [0, -1, T],
  [0, 1, T],
  [0, -1, -T],
  [0, 1, -T],
  [T, 0, -1],
  [T, 0, 1],
  [-T, 0, -1],
  [-T, 0, 1],
].map(([x, y, z]) => {
  const l = Math.hypot(x ?? 0, y ?? 0, z ?? 0);
  return [(x ?? 0) / l, (y ?? 0) / l, (z ?? 0) / l] as V3;
});
const ICO_FACES: V3[] = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
];

/** Unit icosphere triangles (outward, counter-clockwise), subdivided `level` times. */
function icosphere(level: number): V3[][] {
  let tris: V3[][] = ICO_FACES.map((f) => f.map((i): V3 => ICO_VERTS[i] ?? [0, 1, 0]));
  const mid = (a: V3, b: V3): V3 => {
    const m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const l = Math.hypot(...m);
    return [m[0] / l, m[1] / l, m[2] / l];
  };
  for (let k = 0; k < level; k += 1) {
    const next: V3[][] = [];
    for (const tri of tris) {
      const [a, b, c] = tri as [V3, V3, V3];
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    tris = next;
  }
  return tris;
}
const SPHERES = [icosphere(0), icosphere(1)];

/** A deterministic value in [−1, 1] for a direction and a seed. */
function bump(v: V3, seed: number): number {
  return (
    unit(
      hashInts(
        Math.round(v[0] * 1000) * 7 + Math.round(v[2] * 1000),
        Math.round(v[1] * 1000),
        seed,
      ),
    ) *
      2 -
    1
  );
}

interface Crown {
  readonly centre: V3;
  /** Bottom and top of the crown, for shading. */
  readonly bottom: number;
  readonly top: number;
  readonly color: number;
}

/**
 * A foliage mass: an icosphere at `c` with radii `r`, its surface roughened,
 * shaded as part of the crown.
 */
function blob(b: Builder, c: V3, r: V3, level: number, seed: number, crown: Crown, rough = 0.16) {
  for (const tri of SPHERES[level] ?? []) {
    for (const v of tri) {
      const k = 1 + rough * bump(v, seed);
      const p: V3 = [c[0] + v[0] * r[0] * k, c[1] + v[1] * r[1] * k, c[2] + v[2] * r[2] * k];
      const out: V3 = [p[0] - crown.centre[0], p[1] - crown.centre[1], p[2] - crown.centre[2]];
      const ol = Math.hypot(...out) || 1;
      const vl = Math.hypot(v[0] / r[0], v[1] / r[1], v[2] / r[2]) || 1;
      // Lean the normal outwards from the crown: one soft volume, not lumps.
      const n: V3 = [
        0.35 * (v[0] / r[0] / vl) + 0.65 * (out[0] / ol),
        0.35 * (v[1] / r[1] / vl) + 0.65 * (out[1] / ol),
        0.35 * (v[2] / r[2] / vl) + 0.65 * (out[2] / ol),
      ];
      // Darker low in the crown and in hollows facing inwards.
      const h = Math.min(1, Math.max(0, (p[1] - crown.bottom) / (crown.top - crown.bottom)));
      const facing = (n[0] * out[0] + n[1] * out[1] + n[2] * out[2]) / ol;
      const shade = (0.6 + 0.4 * h) * (0.86 + 0.14 * facing) * (1 + 0.07 * bump(v, seed + 1));
      b.vertex(p, n, rgb(crown.color, shade));
    }
  }
}

/** A tapered prism from `a` to `b` (radii `ra`, `rb`), with `sides` faces and no caps. */
function limb(b: Builder, a: V3, bTop: V3, ra: number, rb: number, sides: number, color: number) {
  const d: V3 = [bTop[0] - a[0], bTop[1] - a[1], bTop[2] - a[2]];
  const len = Math.hypot(...d);
  const w: V3 = [d[0] / len, d[1] / len, d[2] / len];
  // Two axes across the limb.
  const ref: V3 = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: V3 = [
    w[1] * ref[2] - w[2] * ref[1],
    w[2] * ref[0] - w[0] * ref[2],
    w[0] * ref[1] - w[1] * ref[0],
  ];
  const ul = Math.hypot(...u);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const ring = (centre: V3, r: number, k: number): { p: V3; n: V3 } => {
    const t = (2 * Math.PI * k) / sides;
    const n: V3 = [
      Math.cos(t) * u[0] + Math.sin(t) * v[0],
      Math.cos(t) * u[1] + Math.sin(t) * v[1],
      Math.cos(t) * u[2] + Math.sin(t) * v[2],
    ];
    return { p: [centre[0] + n[0] * r, centre[1] + n[1] * r, centre[2] + n[2] * r], n };
  };
  const dark = rgb(color, 0.7);
  const light = rgb(color, 1);
  for (let k = 0; k < sides; k += 1) {
    const a0 = ring(a, ra, k);
    const a1 = ring(a, ra, k + 1);
    const b0 = ring(bTop, rb, k);
    const b1 = ring(bTop, rb, k + 1);
    b.vertex(a0.p, a0.n, dark);
    b.vertex(b1.p, b1.n, light);
    b.vertex(b0.p, b0.n, light);
    b.vertex(a0.p, a0.n, dark);
    b.vertex(a1.p, a1.n, dark);
    b.vertex(b1.p, b1.n, light);
  }
}

/** A seeded random sequence for shaping one model. */
function seeded(seed: number) {
  let i = 0;
  return () => unit(hashInts(seed, (i += 1), 0x51));
}

const BARK = 0x5b4a3b;
const DEAD_WOOD = 0x7d7266;

/** Broadleaf crowns: masses arranged within an ellipsoid envelope. */
function broadleaf(spec: PlantSpec, seed: number, color: number, masses: number): MeshData[] {
  const H = spec.height;
  const rand = seeded(seed);
  const trunkTop = 0.62 * H;
  const crown: Crown = { centre: [0, 0.66 * H, 0], bottom: 0.38 * H, top: H, color };
  const lean: V3 = [(rand() - 0.5) * 0.06 * H, 0, (rand() - 0.5) * 0.06 * H];
  // Foliage masses: one on top, the rest round the upper trunk.
  const lobes: { c: V3; r: V3 }[] = [];
  for (let k = 0; k < masses; k += 1) {
    const a = (2 * Math.PI * k) / masses + rand() * 0.9;
    const top = k === 0;
    const out = top ? 0.1 : 0.42 + 0.15 * rand();
    const y = top ? 0.74 : 0.52 + 0.18 * rand();
    const size = top ? 0.34 : 0.27 + 0.07 * rand();
    lobes.push({
      c: [lean[0] + Math.cos(a) * out * 0.3 * H, y * H, lean[2] + Math.sin(a) * out * 0.3 * H],
      r: [size * H * 0.95, size * H * 0.8, size * H * 0.95],
    });
  }
  const near = new Builder();
  limb(near, [0, -1, 0], [lean[0], trunkTop, lean[2]], 0.035 * H, 0.014 * H, 7, BARK);
  for (const lobe of lobes.slice(1, 4)) {
    limb(near, [lean[0] * 0.5, 0.42 * H, lean[2] * 0.5], lobe.c, 0.012 * H, 0.005 * H, 4, BARK);
  }
  lobes.forEach((lobe, k) => {
    blob(near, lobe.c, lobe.r, 1, seed * 31 + k, crown);
  });

  const medium = new Builder();
  limb(medium, [0, -1, 0], [lean[0], trunkTop, lean[2]], 0.035 * H, 0.016 * H, 5, BARK);
  // Fewer, larger masses covering the same envelope.
  const lumps = [lobes[0], lobes[1], lobes[Math.ceil(masses / 2)]].filter((l) => l !== undefined);
  lumps.forEach((lobe, k) => {
    blob(
      medium,
      lobe.c,
      [lobe.r[0] * 1.25, lobe.r[1] * 1.15, lobe.r[2] * 1.25],
      0,
      seed * 31 + k,
      crown,
      0.1,
    );
  });

  const far = new Builder();
  limb(far, [0, -1, 0], [0, 0.5 * H, 0], 0.035 * H, 0.02 * H, 3, BARK);
  blob(far, [lean[0], 0.66 * H, lean[2]], [0.3 * H, 0.3 * H, 0.3 * H], 0, seed, crown, 0.08);

  return [near, medium, far].map((b) => b.finish(H, spec.crown));
}

/** Spruce: a straight trunk under tiers of jagged, drooping skirts. */
function spruce(spec: PlantSpec, seed: number, color: number): MeshData[] {
  const H = spec.height;
  const rand = seeded(seed);
  const build = (tiers: number, points: number, trunkSides: number) => {
    const b = new Builder();
    limb(b, [0, -1, 0], [0, 0.55 * H, 0], 0.03 * H, 0.008 * H, trunkSides, BARK);
    const base = 0.12 * H;
    for (let t = 0; t < tiers; t += 1) {
      const f = t / tiers;
      const yBase = base + f * (H - base) * 0.82;
      const yTop = yBase + ((H - base) / tiers) * (t === tiers - 1 ? 1.9 : 1.75);
      const R = 0.24 * H * (1 - 0.82 * f) * (0.92 + 0.16 * rand());
      const twist = rand() * Math.PI * 2;
      const ring: V3[] = [];
      for (let k = 0; k < points; k += 1) {
        const a = twist + (2 * Math.PI * k) / points;
        const r = R * (k % 2 === 0 ? 1 : 0.72) * (0.9 + 0.2 * rand());
        ring.push([Math.cos(a) * r, yBase - (k % 2 === 0 ? 0.12 : 0.03) * R, Math.sin(a) * r]);
      }
      const apex: V3 = [0, Math.min(yTop, H), 0];
      const under: V3 = [0, yBase + 0.3 * R, 0];
      const shadeTop = 0.85 + 0.25 * f;
      for (let k = 0; k < points; k += 1) {
        const p = ring[k] ?? [0, 0, 0];
        const q = ring[(k + 1) % points] ?? [0, 0, 0];
        const np: V3 = [p[0], R * 0.9, p[2]];
        const nq: V3 = [q[0], R * 0.9, q[2]];
        // Skirt, seen from outside and above.
        b.vertex(apex, [0, 1, 0], rgb(color, 1.05 * shadeTop));
        b.vertex(q, nq, rgb(color, 0.72 * shadeTop));
        b.vertex(p, np, rgb(color, 0.72 * shadeTop));
        // Underside, dark.
        b.vertex(under, [0, -1, 0], rgb(color, 0.42));
        b.vertex(p, [p[0], -R, p[2]], rgb(color, 0.5));
        b.vertex(q, [q[0], -R, q[2]], rgb(color, 0.5));
      }
    }
    return b.finish(H, spec.crown);
  };
  return [build(6, 10, 6), build(3, 8, 4), build(2, 6, 3)];
}

/** Pine: a long bare trunk and a high, flattened, irregular crown. */
function pine(spec: PlantSpec, seed: number, color: number): MeshData[] {
  const H = spec.height;
  const rand = seeded(seed);
  const crown: Crown = { centre: [0, 0.8 * H, 0], bottom: 0.62 * H, top: H, color };
  const masses: { c: V3; r: V3 }[] = [];
  for (let k = 0; k < 4; k += 1) {
    const a = (2 * Math.PI * k) / 4 + rand();
    const out = k === 0 ? 0 : 0.11 * H;
    masses.push({
      c: [Math.cos(a) * out, (k === 0 ? 0.86 : 0.76 + 0.05 * rand()) * H, Math.sin(a) * out],
      r: [0.13 * H, 0.08 * H, 0.13 * H],
    });
  }
  const near = new Builder();
  limb(near, [0, -1, 0], [0.02 * H, 0.84 * H, 0], 0.028 * H, 0.012 * H, 6, 0x6b5240);
  masses.slice(1).forEach((m) => {
    limb(near, [0.01 * H, 0.66 * H, 0], m.c, 0.008 * H, 0.004 * H, 3, 0x6b5240);
  });
  masses.forEach((m, k) => {
    blob(near, m.c, m.r, 1, seed * 17 + k, crown, 0.22);
  });
  const medium = new Builder();
  limb(medium, [0, -1, 0], [0.02 * H, 0.8 * H, 0], 0.028 * H, 0.014 * H, 4, 0x6b5240);
  [masses[0], masses[2]].forEach((m, k) => {
    if (m)
      blob(
        medium,
        m.c,
        [m.r[0] * 1.45, m.r[1] * 1.3, m.r[2] * 1.45],
        0,
        seed * 17 + k,
        crown,
        0.12,
      );
  });
  const far = new Builder();
  limb(far, [0, -1, 0], [0, 0.75 * H, 0], 0.028 * H, 0.016 * H, 3, 0x6b5240);
  blob(far, [0, 0.82 * H, 0], [0.2 * H, 0.11 * H, 0.2 * H], 0, seed, crown, 0.06);
  return [near, medium, far].map((b) => b.finish(H, spec.crown));
}

/** A standing dead tree: trunk and a few bare limbs. */
function snag(spec: PlantSpec, seed: number): MeshData[] {
  const H = spec.height;
  const rand = seeded(seed);
  const limbs: V3[][] = [];
  for (let k = 0; k < 5; k += 1) {
    const a = (2 * Math.PI * k) / 5 + rand();
    const y = (0.45 + 0.1 * k) * H;
    const l = (0.28 - 0.035 * k) * H;
    limbs.push([
      [0, y, 0],
      [Math.cos(a) * l * 0.8, y + l * 0.6, Math.sin(a) * l * 0.8],
    ]);
  }
  const build = (trunkSides: number, limbCount: number, limbSides: number) => {
    const b = new Builder();
    limb(b, [0, -1, 0], [0.02 * H, H * 0.97, 0], 0.03 * H, 0.006 * H, trunkSides, DEAD_WOOD);
    for (const [a, e] of limbs.slice(0, limbCount)) {
      if (a && e) limb(b, a, e, 0.01 * H, 0.003 * H, limbSides, DEAD_WOOD);
    }
    return b.finish(H, spec.crown);
  };
  return [build(6, 5, 4), build(4, 3, 3), build(3, 0, 3)];
}

/** A shrub: a few low foliage masses from the ground, no visible stem. */
function shrub(spec: PlantSpec, seed: number, color: number): MeshData[] {
  const H = spec.height;
  const rand = seeded(seed);
  const crown: Crown = { centre: [0, 0.35 * H, 0], bottom: -0.2 * H, top: H, color };
  const masses: { c: V3; r: V3 }[] = [];
  for (let k = 0; k < 4; k += 1) {
    const a = (2 * Math.PI * k) / 4 + rand();
    const out = k === 0 ? 0 : 0.32 * H;
    masses.push({
      // The lower masses reach a little below the ground, for slopes.
      c: [Math.cos(a) * out, (k === 0 ? 0.42 : 0.22 + 0.1 * rand()) * H, Math.sin(a) * out],
      r: [0.4 * H, (k === 0 ? 0.48 : 0.36) * H, 0.4 * H],
    });
  }
  const near = new Builder();
  masses.forEach((m, k) => {
    blob(near, m.c, m.r, 1, seed * 13 + k, crown, 0.2);
  });
  const medium = new Builder();
  [masses[0], masses[2]].forEach((m, k) => {
    if (m) blob(medium, m.c, [m.r[0] * 1.3, m.r[1], m.r[2] * 1.3], 0, seed * 13 + k, crown, 0.12);
  });
  const far = new Builder();
  blob(far, [0, 0.36 * H, 0], [0.55 * H, 0.5 * H, 0.55 * H], 0, seed, crown, 0.08);
  return [near, medium, far].map((b) => b.finish(H, spec.crown));
}

/** Foliage colours (sRGB): muted, a little different per species. */
const FOLIAGE: Readonly<Record<string, number>> = {
  oak: 0x617f35,
  beech: 0x6b8a3a,
  lime: 0x597937,
  spruce: 0x355436,
  pine: 0x436038,
  sapling: 0x749342,
  bush: 0x6a7a3f,
  thicket: 0x607342,
};

/** Builds the whole library (a few milliseconds); the same every time. */
export function plantModels(): PlantModel[] {
  return PLANTS.map((spec, i) => {
    const color = FOLIAGE[spec.name] ?? 0x56702f;
    const seed = 1000 + i;
    let lods: MeshData[];
    switch (spec.kind) {
      case 'broadleaf':
        lods = broadleaf(spec, seed, color, 5);
        break;
      case 'smallTree':
        lods = broadleaf(spec, seed, color, 4);
        break;
      case 'conifer':
        lods = spruce(spec, seed, color);
        break;
      case 'pine':
        lods = pine(spec, seed, color);
        break;
      case 'deadTree':
        lods = snag(spec, seed);
        break;
      case 'shrub':
        lods = shrub(spec, seed, color);
        break;
      case 'prop':
        lods = propLods(spec.prop ?? 'bollard');
        break;
    }
    const [near, medium, far] = lods as [MeshData, MeshData, MeshData];
    return { spec, lods: [near, medium, far] };
  });
}
