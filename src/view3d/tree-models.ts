import { Cell, cellUv, rng } from './foliage-atlas';

// Trees and shrubs (docs/adr/0049, research §5.5): procedural models of the
// species of the Quantico area, built from a trunk and limbs (bark) and
// crowns of leaf-cluster cards (foliage-atlas.ts). Broadleaf crowns are
// clumps on limbs; loblolly pines carry tufts on whorled branches high on a
// clean trunk; Virginia pines are crooked and sparse; red cedar and holly are
// dense cones; dogwood spreads in flat tiers; shrubs are low clumps; ferns
// are crossed fronds. Card normals point out of the crown (so it is shaded
// as a mass, not card by card), and colours darken into the crown and
// towards the ground. Three levels of detail each: fewer, larger cards
// further out. Model space: metres, y up, the foot at the origin.

export type Form =
  | 'round'
  | 'oval'
  | 'column'
  | 'pine'
  | 'scrubPine'
  | 'cone'
  | 'tiered'
  | 'snag'
  | 'shrub'
  | 'fern';

export interface Species {
  readonly name: string;
  readonly form: Form;
  /** Typical height to the crown's top, and the crown's radius, metres. */
  readonly height: number;
  readonly crown: number;
  /** Where the crown starts, as a share of the height. */
  readonly crownBase: number;
  readonly leaf: Cell;
  readonly bark: Cell;
  /** Card size (width), metres, and cards at the near level. */
  readonly card: number;
  readonly cards: number;
  /** Trunk radius at the foot, metres. */
  readonly trunk: number;
  /** Colour multipliers (linear) of the foliage and the bark. */
  readonly leafTint: readonly [number, number, number];
  readonly barkTint: readonly [number, number, number];
  /** Distances at which it changes level scale by this (small plants switch sooner). */
  readonly lodScale: number;
}

export const SPECIES = {
  whiteOak: {
    name: 'white oak',
    form: 'round',
    height: 22,
    crown: 9.5,
    crownBase: 0.33,
    leaf: Cell.oakWhite,
    bark: Cell.barkRough,
    card: 2.3,
    cards: 190,
    trunk: 0.4,
    leafTint: [1, 1, 1],
    barkTint: [1.15, 1.12, 1.08],
    lodScale: 1,
  },
  redOak: {
    name: 'red oak',
    form: 'oval',
    height: 24,
    crown: 8.8,
    crownBase: 0.4,
    leaf: Cell.oakRed,
    bark: Cell.barkRough,
    card: 2.3,
    cards: 180,
    trunk: 0.38,
    leafTint: [1, 1, 1],
    barkTint: [0.85, 0.85, 0.85],
    lodScale: 1,
  },
  chestnutOak: {
    name: 'chestnut oak',
    form: 'round',
    height: 20,
    crown: 8,
    crownBase: 0.4,
    leaf: Cell.beech,
    bark: Cell.barkRough,
    card: 2.1,
    cards: 160,
    trunk: 0.36,
    leafTint: [0.82, 0.9, 0.82],
    barkTint: [0.75, 0.72, 0.7],
    lodScale: 1,
  },
  tulipPoplar: {
    name: 'tulip poplar',
    form: 'column',
    height: 30,
    crown: 6.5,
    crownBase: 0.52,
    leaf: Cell.poplar,
    bark: Cell.barkRough,
    card: 2.3,
    cards: 170,
    trunk: 0.42,
    leafTint: [1, 1, 1],
    barkTint: [1.25, 1.25, 1.2],
    lodScale: 1,
  },
  redMaple: {
    name: 'red maple',
    form: 'oval',
    height: 18,
    crown: 6.8,
    crownBase: 0.33,
    leaf: Cell.maple,
    bark: Cell.barkSmooth,
    card: 1.9,
    cards: 160,
    trunk: 0.28,
    leafTint: [1, 1, 1],
    barkTint: [0.95, 0.95, 0.97],
    lodScale: 1,
  },
  sweetgum: {
    name: 'sweetgum',
    form: 'column',
    height: 22,
    crown: 6.2,
    crownBase: 0.35,
    leaf: Cell.sweetgum,
    bark: Cell.barkRough,
    card: 2,
    cards: 160,
    trunk: 0.32,
    leafTint: [1, 1, 1],
    barkTint: [0.95, 0.9, 0.85],
    lodScale: 1,
  },
  beech: {
    name: 'American beech',
    form: 'round',
    height: 20,
    crown: 8.8,
    crownBase: 0.22,
    leaf: Cell.beech,
    bark: Cell.barkSmooth,
    card: 2.1,
    cards: 190,
    trunk: 0.36,
    leafTint: [1, 1, 1],
    barkTint: [1.15, 1.15, 1.18],
    lodScale: 1,
  },
  hickory: {
    name: 'mockernut hickory',
    form: 'oval',
    height: 24,
    crown: 7.5,
    crownBase: 0.45,
    leaf: Cell.hickory,
    bark: Cell.barkRough,
    card: 2.2,
    cards: 160,
    trunk: 0.34,
    leafTint: [1, 1, 1],
    barkTint: [1.05, 1.02, 1],
    lodScale: 1,
  },
  loblolly: {
    name: 'loblolly pine',
    form: 'pine',
    height: 27,
    crown: 5.6,
    crownBase: 0.62,
    leaf: Cell.needles,
    bark: Cell.barkPine,
    card: 1.9,
    cards: 120,
    trunk: 0.38,
    leafTint: [1, 1, 1],
    barkTint: [1, 1, 1],
    lodScale: 1,
  },
  virginiaPine: {
    name: 'Virginia pine',
    form: 'scrubPine',
    height: 14,
    crown: 4.6,
    crownBase: 0.28,
    leaf: Cell.needles,
    bark: Cell.barkPine,
    card: 1.6,
    cards: 120,
    trunk: 0.24,
    leafTint: [0.85, 0.92, 0.8],
    barkTint: [0.8, 0.75, 0.75],
    lodScale: 1,
  },
  redCedar: {
    name: 'eastern red cedar',
    form: 'cone',
    height: 11,
    crown: 2.3,
    crownBase: 0.03,
    leaf: Cell.cedar,
    bark: Cell.barkRough,
    card: 1.15,
    cards: 190,
    trunk: 0.22,
    leafTint: [1, 1, 1],
    barkTint: [1.1, 0.8, 0.7],
    lodScale: 0.9,
  },
  snag: {
    name: 'dead tree',
    form: 'snag',
    height: 13,
    crown: 3.2,
    crownBase: 0.45,
    leaf: Cell.twigs,
    bark: Cell.barkRough,
    card: 1.8,
    cards: 18,
    trunk: 0.3,
    leafTint: [1, 1, 1],
    barkTint: [0.85, 0.85, 0.85],
    lodScale: 0.8,
  },
  dogwood: {
    name: 'flowering dogwood',
    form: 'tiered',
    height: 6.5,
    crown: 3.2,
    crownBase: 0.3,
    leaf: Cell.beech,
    bark: Cell.barkRough,
    card: 1.3,
    cards: 100,
    trunk: 0.12,
    leafTint: [0.88, 0.95, 0.85],
    barkTint: [0.75, 0.7, 0.68],
    lodScale: 0.7,
  },
  holly: {
    name: 'American holly',
    form: 'cone',
    height: 7,
    crown: 2.3,
    crownBase: 0.08,
    leaf: Cell.holly,
    bark: Cell.barkSmooth,
    card: 1.1,
    cards: 130,
    trunk: 0.13,
    leafTint: [1, 1, 1],
    barkTint: [1, 1, 1],
    lodScale: 0.7,
  },
  laurel: {
    name: 'mountain laurel',
    form: 'shrub',
    height: 1.9,
    crown: 1.7,
    crownBase: 0.05,
    leaf: Cell.laurel,
    bark: Cell.barkSmooth,
    card: 0.95,
    cards: 50,
    trunk: 0.04,
    leafTint: [1, 1, 1],
    barkTint: [0.7, 0.6, 0.55],
    lodScale: 0.45,
  },
  spicebush: {
    name: 'spicebush',
    form: 'shrub',
    height: 2.4,
    crown: 1.5,
    crownBase: 0.15,
    leaf: Cell.beech,
    bark: Cell.barkSmooth,
    card: 0.9,
    cards: 42,
    trunk: 0.03,
    leafTint: [1.08, 1.08, 0.95],
    barkTint: [0.7, 0.7, 0.7],
    lodScale: 0.45,
  },
  blueberry: {
    name: 'highbush blueberry',
    form: 'shrub',
    height: 1.4,
    crown: 1.1,
    crownBase: 0.1,
    leaf: Cell.beech,
    bark: Cell.barkSmooth,
    card: 0.7,
    cards: 36,
    trunk: 0.025,
    leafTint: [0.85, 0.92, 0.95],
    barkTint: [0.9, 0.6, 0.55],
    lodScale: 0.4,
  },
  greenbrier: {
    name: 'greenbrier tangle',
    form: 'shrub',
    height: 1.1,
    crown: 1.7,
    crownBase: 0.05,
    leaf: Cell.holly,
    bark: Cell.barkSmooth,
    card: 0.85,
    cards: 40,
    trunk: 0.02,
    leafTint: [1.25, 1.35, 1.05],
    barkTint: [0.6, 0.7, 0.5],
    lodScale: 0.4,
  },
  fern: {
    name: 'Christmas fern',
    form: 'fern',
    height: 0.7,
    crown: 0.55,
    crownBase: 0,
    leaf: Cell.fern,
    bark: Cell.barkSmooth,
    card: 1,
    cards: 3,
    trunk: 0,
    leafTint: [1, 1, 1],
    barkTint: [1, 1, 1],
    lodScale: 0.25,
  },
} as const satisfies Record<string, Species>;

export type SpeciesName = keyof typeof SPECIES;
export const SPECIES_NAMES = Object.keys(SPECIES) as SpeciesName[];
/** Shape variants per species. */
export const VARIANTS = 2;

/** One level of detail: non-indexed triangles. */
export interface TreeGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly colors: Float32Array;
  /** How much each vertex sways in the wind (0 at the trunk's foot). */
  readonly sway: Float32Array;
  readonly triangles: number;
}

export interface TreeModel {
  readonly species: SpeciesName;
  readonly variant: number;
  readonly spec: Species;
  readonly lods: readonly [TreeGeometry, TreeGeometry, TreeGeometry];
}

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

class Builder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly sw: number[] = [];
  readonly height: number;
  constructor(height: number) {
    this.height = height;
  }
  vertex(p: V3, n: V3, uv: [number, number], c: V3, sway: number) {
    this.pos.push(...p);
    this.nrm.push(...norm(n));
    this.uv.push(...uv);
    this.col.push(...c);
    this.sw.push(sway);
  }
  /** A tapered cylinder of bark from a to b, `rings` segments each covering the bark cell once. */
  limb(a: V3, b: V3, r0: number, r1: number, sides: number, bark: Cell, tint: V3, sway: number) {
    const axis = sub(b, a);
    const len = Math.hypot(...axis);
    if (len <= 0 || sides < 3) return;
    const d = norm(axis);
    const ref: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(d, ref));
    const w = cross(d, u);
    // Far models (three sides) in one piece.
    const segs = sides <= 3 ? 1 : Math.max(1, Math.round(len / 3));
    const ring = (t: number): V3[] => {
      const c = add(a, mul(axis, t));
      const r = r0 + (r1 - r0) * t;
      return Array.from({ length: sides + 1 }, (_, k) => {
        const ang = (k / sides) * Math.PI * 2;
        return add(c, add(mul(u, Math.cos(ang) * r), mul(w, Math.sin(ang) * r)));
      });
    };
    for (let s = 0; s < segs; s += 1) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const lo = ring(t0);
      const hi = ring(t1);
      const y0 = a[1] + axis[1] * t0;
      const y1 = a[1] + axis[1] * t1;
      const shade = (y: number) => 0.7 + 0.3 * Math.min(1, Math.max(0, y / (this.height * 0.4)));
      for (let k = 0; k < sides; k += 1) {
        const pts = [lo[k], lo[k + 1], hi[k + 1], hi[k]];
        const us = [k / sides, (k + 1) / sides, (k + 1) / sides, k / sides];
        const vs = [0, 0, 1, 1];
        const ys = [y0, y0, y1, y1];
        const order = [0, 1, 2, 0, 2, 3];
        for (const i of order) {
          const p = pts[i];
          if (!p) continue;
          const c = add(a, mul(axis, i < 2 ? t0 : t1));
          const n = sub(p, c);
          const sh = shade(ys[i] ?? 0);
          this.vertex(
            p,
            n,
            cellUv(bark, us[i] ?? 0, vs[i] ?? 0),
            mul(tint, sh),
            (sway * (ys[i] ?? 0)) / this.height,
          );
        }
      }
    }
  }
  /**
   * A leaf card centred at `c`, spanned by unit vectors `a` (width) and `b`
   * (height), `size` wide; its corners' normals are `n` (the crown's outward
   * direction). `turn` turns the picture by quarter turns.
   */
  card(
    c: V3,
    a: V3,
    b: V3,
    size: number,
    n: V3,
    cell: Cell,
    colour: V3,
    sway: number,
    turn: number,
    foot = false,
  ) {
    const h = size / 2;
    const corners: V3[] = foot
      ? [
          add(c, mul(a, -h)),
          add(c, mul(a, h)),
          add(add(c, mul(a, h)), mul(b, size)),
          add(add(c, mul(a, -h)), mul(b, size)),
        ]
      : [
          add(add(c, mul(a, -h)), mul(b, -h)),
          add(add(c, mul(a, h)), mul(b, -h)),
          add(add(c, mul(a, h)), mul(b, h)),
          add(add(c, mul(a, -h)), mul(b, h)),
        ];
    const uvs: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = corners[i];
      const q = uvs[(i + turn) % 4];
      if (!p || !q) continue;
      const lift = foot ? (i >= 2 ? 1 : 0) : 1;
      this.vertex(p, n, cellUv(cell, q[0], q[1]), colour, sway * lift);
    }
  }
  build(): TreeGeometry {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      uvs: new Float32Array(this.uv),
      colors: new Float32Array(this.col),
      sway: new Float32Array(this.sw),
      triangles: this.pos.length / 9,
    };
  }
}

/** Two unit vectors spanning a card at a random orientation, roughly facing `out`. */
function cardAxes(out: V3, r: () => number): [V3, V3] {
  const n = norm(add(out, [(r() - 0.5) * 1.6, (r() - 0.5) * 1.2, (r() - 0.5) * 1.6]));
  const ref: V3 = Math.abs(n[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  let a = norm(cross(ref, n));
  let b = cross(n, a);
  const t = r() * Math.PI * 2;
  const ca = Math.cos(t);
  const sa = Math.sin(t);
  [a, b] = [add(mul(a, ca), mul(b, sa)), add(mul(a, -sa), mul(b, ca))];
  return [a, b];
}

/** Level of detail: share of cards, card scale, trunk sides, limbs drawn. */
const LODS = [
  { cards: 0.65, size: 1.22, sides: 7, limbs: true },
  { cards: 0.34, size: 1.8, sides: 5, limbs: false },
  { cards: 0.045, size: 4.4, sides: 3, limbs: false },
] as const;

function buildLevel(spec: Species, seed: number, lod: number): TreeGeometry {
  const L = LODS[lod] ?? LODS[0];
  const r = rng(seed);
  const H = spec.height;
  const R = spec.crown;
  const b = new Builder(H);
  const bark = spec.barkTint as V3;
  const leafTint = spec.leafTint as V3;
  const nCards = Math.max(
    spec.form === 'fern' ? 3 : lod === 2 ? 4 : 6,
    Math.round(spec.cards * L.cards),
  );
  const size = spec.card * L.size;
  // Card colour: darker into the crown and towards the ground; a little variety.
  const leafColour = (inner: number, t: number): V3 => {
    const ao = 0.64 + 0.36 * Math.min(1, 0.55 * inner + 0.45 * t);
    const v = 0.9 + 0.2 * r();
    return mul(
      [leafTint[0] * (0.96 + 0.08 * r()), leafTint[1], leafTint[2] * (0.94 + 0.1 * r())],
      ao * v,
    );
  };
  const base = spec.crownBase * H;
  const lean: V3 = [(r() - 0.5) * 0.06 * H, 0, (r() - 0.5) * 0.06 * H];

  if (spec.form === 'fern') {
    for (let k = 0; k < 3; k += 1) {
      const ang = (k / 3) * Math.PI + r() * 0.4;
      const a: V3 = [Math.cos(ang), 0, Math.sin(ang)];
      const tilt = 0.25;
      const up = norm([-a[2] * tilt, 1, a[0] * tilt]);
      b.card([0, 0, 0], a, up, H * 1.5, [0, 1, 0], spec.leaf, leafColour(0.8, 0.6), 0.6, 0, true);
    }
    return b.build();
  }

  // Trunk (and its lean).
  const trunkTop: V3 =
    spec.form === 'pine'
      ? [lean[0], H * 0.95, lean[2]]
      : spec.form === 'cone'
        ? [lean[0] * 0.3, H * 0.85, lean[2] * 0.3]
        : spec.form === 'shrub'
          ? [0, H * 0.5, 0]
          : spec.form === 'snag'
            ? [lean[0], H * 0.9, lean[2]]
            : [lean[0] * 0.6, base + (H - base) * 0.35, lean[2] * 0.6];
  if (spec.form === 'shrub') {
    if (L.limbs)
      for (let k = 0; k < 4; k += 1) {
        const ang = r() * Math.PI * 2;
        const top: V3 = [Math.cos(ang) * R * 0.5, H * (0.5 + 0.3 * r()), Math.sin(ang) * R * 0.5];
        b.limb([0, 0, 0], top, spec.trunk, spec.trunk * 0.4, 4, spec.bark, bark, 0.2);
      }
  } else if (spec.form === 'scrubPine') {
    // A crooked trunk in three bends.
    let p: V3 = [0, 0, 0];
    for (let s = 0; s < 3; s += 1) {
      const q: V3 = [
        p[0] + (r() - 0.5) * 1.2,
        H * (0.33 * (s + 1)) * 0.95,
        p[2] + (r() - 0.5) * 1.2,
      ];
      b.limb(
        p,
        q,
        spec.trunk * (1 - s * 0.3),
        spec.trunk * (1 - (s + 1) * 0.3),
        L.sides,
        spec.bark,
        bark,
        0.1,
      );
      p = q;
    }
  } else {
    b.limb(
      [0, 0, 0],
      trunkTop,
      spec.trunk,
      spec.trunk * (spec.form === 'pine' ? 0.35 : 0.6),
      L.sides,
      spec.bark,
      bark,
      0.05,
    );
  }

  const crownCentre: V3 = [lean[0], (base + H) / 2, lean[2]];
  const emit = (p: V3, out: V3, inner: number, t: number, s = size, sway = 0.6 + 0.4 * t) => {
    const [ax, bx] = cardAxes(out, r);
    const n = norm(add(norm(sub(p, crownCentre)), add(mul(out, 0.6), [0, 0.35, 0])));
    b.card(
      p,
      ax,
      bx,
      s * (0.75 + 0.5 * r()),
      n,
      spec.leaf,
      leafColour(inner, t),
      sway,
      Math.floor(r() * 4),
    );
  };

  switch (spec.form) {
    case 'round':
    case 'oval':
    case 'column': {
      // Clumps on limbs from the top of the trunk.
      const clumps = spec.form === 'column' ? 11 : 9 + Math.floor(r() * 4);
      // The trunk carries on through the crown as a leader, tapering away.
      const lr = rng(seed ^ 0x5eed);
      const leader: V3 = [
        lean[0] * 0.7,
        base + (H - base) * (spec.form === 'round' ? 0.5 : 0.75),
        lean[2] * 0.7,
      ];
      if (L.limbs)
        b.limb(trunkTop, leader, spec.trunk * 0.55, spec.trunk * 0.22, 5, spec.bark, bark, 0.15);
      const centres: { c: V3; rad: number }[] = [];
      for (let k = 0; k < clumps; k += 1) {
        const t = spec.form === 'column' ? 0.1 + 0.85 * (k / clumps) : 0.15 + 0.75 * r();
        const env =
          spec.form === 'round'
            ? Math.sqrt(Math.max(0.05, 1 - Math.pow(2 * t - 1.1, 2)))
            : spec.form === 'oval'
              ? Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.8)
              : 0.6 + 0.4 * Math.sin(Math.PI * t);
        const ang = (k / clumps) * Math.PI * 2 * 2.39 + r() * 0.8;
        const rr = R * env * (0.5 + 0.3 * r());
        const c: V3 = [
          crownCentre[0] + Math.cos(ang) * rr,
          base + t * (H - base) * 0.92,
          crownCentre[2] + Math.sin(ang) * rr,
        ];
        const rad =
          R * (spec.form === 'column' ? 0.46 : 0.5) * (0.75 + 0.4 * r()) * (0.6 + 0.4 * env);
        centres.push({ c, rad });
        if (L.limbs) {
          // A limb leaves the trunk below its clump (higher limbs higher up),
          // bends upward on its way and ends inside the clump, forking into
          // thinner branches. Its own random numbers, so the cards are the
          // same at every level.
          const y0 = Math.min(
            leader[1] - 0.6,
            Math.max(base * 0.85, c[1] - (H - base) * (0.25 + 0.2 * lr())),
          );
          const k0 = y0 / leader[1];
          const from: V3 = [leader[0] * k0, y0, leader[2] * k0];
          const end = add(from, mul(sub(c, from), 0.72 + 0.12 * lr()));
          const mid = add(add(from, mul(sub(end, from), 0.5)), [
            (lr() - 0.5) * 0.9,
            0.5 + 0.9 * lr(),
            (lr() - 0.5) * 0.9,
          ]);
          const r0 = spec.trunk * (0.3 + 0.1 * lr());
          b.limb(from, mid, r0, r0 * 0.6, 5, spec.bark, bark, 0.25);
          b.limb(mid, end, r0 * 0.6, r0 * 0.25, 4, spec.bark, bark, 0.3);
          const forks = 2 + Math.floor(lr() * 2);
          for (let f = 0; f < forks; f += 1) {
            const at = add(mid, mul(sub(end, mid), 0.3 + 0.7 * lr()));
            const dir = norm(
              add(norm(sub(end, from)), [
                (lr() - 0.5) * 1.4,
                0.25 + 0.5 * lr(),
                (lr() - 0.5) * 1.4,
              ]),
            );
            b.limb(
              at,
              add(at, mul(dir, rad * (0.55 + 0.4 * lr()))),
              r0 * 0.22,
              r0 * 0.06,
              3,
              spec.bark,
              bark,
              0.4,
            );
          }
        }
      }
      // A top clump.
      centres.push({ c: [crownCentre[0], H - R * 0.35, crownCentre[2]], rad: R * 0.4 });
      for (let i = 0; i < nCards; i += 1) {
        const cl = centres[i % centres.length];
        if (!cl) continue;
        const d = norm([r() - 0.5, (r() - 0.35) * 0.9, r() - 0.5]);
        const depth = 0.55 + 0.45 * Math.sqrt(r());
        const p = add(cl.c, mul(d, cl.rad * depth));
        const inner =
          Math.min(1, Math.hypot(p[0] - crownCentre[0], p[2] - crownCentre[2]) / R) * 0.6 +
          depth * 0.4;
        emit(
          p,
          norm(add(d, mul(norm(sub(p, crownCentre)), 0.8))),
          inner,
          (p[1] - base) / (H - base),
        );
      }
      break;
    }
    case 'pine':
    case 'scrubPine': {
      const branches = spec.form === 'pine' ? 14 : 18;
      const top: V3 = spec.form === 'pine' ? trunkTop : [lean[0] * 0.5, H * 0.95, lean[2] * 0.5];
      const tips: { c: V3; out: V3; t: number }[] = [];
      for (let k = 0; k < branches; k += 1) {
        const t = spec.form === 'pine' ? k / branches : r();
        const y = base + t * (H - base) * 0.9;
        const ang = k * 2.39996 + r() * 0.5;
        const len = R * (0.45 + 0.55 * r()) * (spec.form === 'pine' ? 1 - 0.55 * t : 1 - 0.3 * t);
        const rise = spec.form === 'pine' ? 0.15 + 0.35 * r() : (r() - 0.3) * 0.6;
        const from: V3 = [top[0] * (y / H), y, top[2] * (y / H)];
        const dir = norm([Math.cos(ang), rise, Math.sin(ang)]);
        const to = add(from, mul(dir, len));
        if (L.limbs)
          b.limb(from, to, spec.trunk * 0.22, spec.trunk * 0.06, 3, spec.bark, bark, 0.3);
        tips.push({ c: to, out: dir, t });
      }
      tips.push({ c: [top[0], H * 0.97, top[2]], out: [0, 1, 0], t: 1 });
      for (let i = 0; i < nCards; i += 1) {
        const tip = tips[i % tips.length];
        if (!tip) continue;
        // Tufts along the branch's outer half, mostly at its end.
        const back = r() * 0.45;
        const p = add(sub(tip.c, mul(tip.out, back * R * 0.5)), [
          (r() - 0.5) * 0.6,
          (r() - 0.3) * 0.5,
          (r() - 0.5) * 0.6,
        ]);
        emit(p, add(tip.out, [0, 0.6, 0]), 0.5 + 0.5 * (1 - back), tip.t);
      }
      break;
    }
    case 'cone': {
      for (let i = 0; i < nCards; i += 1) {
        const t = Math.pow(r(), 0.85);
        const y = base + t * (H - base);
        const env = Math.pow(1 - t, 0.85) * 0.95 + 0.05;
        const ang = r() * Math.PI * 2;
        const depth = 0.55 + 0.45 * Math.sqrt(r());
        const rr = R * env * depth;
        const out: V3 = [Math.cos(ang), 0.35, Math.sin(ang)];
        const p: V3 = [
          lean[0] * 0.3 * t + Math.cos(ang) * rr,
          y,
          lean[2] * 0.3 * t + Math.sin(ang) * rr,
        ];
        emit(p, out, depth, t, size * (1.15 - 0.4 * t));
      }
      break;
    }
    case 'tiered': {
      const tiers = 3 + Math.floor(r() * 2);
      for (let i = 0; i < nCards; i += 1) {
        const k = i % tiers;
        const t = (k + 0.5) / tiers;
        const y = base + t * (H - base);
        const ang = r() * Math.PI * 2;
        const rr = R * (1 - 0.45 * t) * Math.sqrt(r());
        const p: V3 = [Math.cos(ang) * rr, y + (r() - 0.5) * 0.5, Math.sin(ang) * rr];
        emit(p, [Math.cos(ang) * 0.4, 1, Math.sin(ang) * 0.4], Math.min(1, rr / R + 0.3), t);
      }
      if (L.limbs)
        for (let k = 0; k < tiers * 3; k += 1) {
          const t = (Math.floor(k / 3) + 0.5) / tiers;
          const y = base + t * (H - base);
          const ang = r() * Math.PI * 2;
          const from: V3 = [0, Math.max(0.5, y - 0.6), 0];
          b.limb(
            from,
            [Math.cos(ang) * R * 0.6, y, Math.sin(ang) * R * 0.6],
            spec.trunk * 0.5,
            spec.trunk * 0.15,
            3,
            spec.bark,
            bark,
            0.4,
          );
        }
      break;
    }
    case 'snag': {
      const limbs = 5 + Math.floor(r() * 3);
      for (let k = 0; k < limbs; k += 1) {
        const y = base + r() * (H * 0.9 - base);
        const ang = r() * Math.PI * 2;
        const from: V3 = [lean[0] * (y / H), y, lean[2] * (y / H)];
        const to = add(from, [
          Math.cos(ang) * R * (0.5 + 0.5 * r()),
          R * (0.3 + 0.6 * r()),
          Math.sin(ang) * R * (0.5 + 0.5 * r()),
        ]);
        b.limb(
          from,
          to,
          spec.trunk * 0.35,
          spec.trunk * 0.06,
          L.sides > 3 ? 4 : 3,
          spec.bark,
          bark,
          0.2,
        );
        if (k < nCards) emit(to, norm(sub(to, from)), 0.8, (y - base) / (H - base), size, 0.4);
      }
      break;
    }
    case 'shrub': {
      for (let i = 0; i < nCards; i += 1) {
        const ang = r() * Math.PI * 2;
        const t = Math.sqrt(r());
        const y = base + t * (H - base) * 0.85;
        const env = Math.sqrt(Math.max(0.1, 1 - Math.pow((y / H - 0.45) / 0.6, 2)));
        const depth = 0.5 + 0.5 * Math.sqrt(r());
        const rr = R * env * depth * 0.8;
        const p: V3 = [Math.cos(ang) * rr, y, Math.sin(ang) * rr];
        emit(p, [Math.cos(ang), 0.5, Math.sin(ang)], depth, t, size, 0.5 * t);
      }
      break;
    }
    default:
      break;
  }
  return b.build();
}

/** Every species' models: `VARIANTS` shapes each, three levels each. */
export function treeModels(): TreeModel[] {
  const out: TreeModel[] = [];
  SPECIES_NAMES.forEach((name, si) => {
    const spec: Species = SPECIES[name];
    const variants = spec.form === 'fern' ? 1 : VARIANTS;
    for (let v = 0; v < variants; v += 1) {
      const seed = 0x51f15e + si * 131 + v * 977;
      out.push({
        species: name,
        variant: v,
        spec,
        lods: [buildLevel(spec, seed, 0), buildLevel(spec, seed, 1), buildLevel(spec, seed, 2)],
      });
    }
  });
  return out;
}
