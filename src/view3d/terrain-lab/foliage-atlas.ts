import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';

// The lab's vegetation texture (research §5.5): one atlas, drawn in the
// browser at start-up (no files), of leaf clusters, needle tufts and sprays,
// fern fronds, dead twigs and barks for the trees and shrubs of the Quantico
// area (northern Virginia: oaks, tulip poplar, red maple, sweetgum, beech,
// hickory, loblolly and Virginia pine, eastern red cedar; holly, dogwood,
// mountain laurel, spicebush, blueberry, ferns). Each cell is a card's
// picture: a cluster drawn on a twig framework, leaves shaded by depth.
// Transparent texels take their cell's mean colour so mipmaps do not darken
// the leaves' edges.

export const ATLAS_PX = 2048;
export const ATLAS_CELLS = 4;
const CELL = ATLAS_PX / ATLAS_CELLS;
/** Content keeps this share of a cell clear at its edges (no bleeding between cells in mipmaps). */
export const CELL_MARGIN = 0.03;

export const Cell = {
  oakWhite: 0,
  oakRed: 1,
  maple: 2,
  poplar: 3,
  sweetgum: 4,
  beech: 5,
  hickory: 6,
  needles: 7,
  cedar: 8,
  holly: 9,
  laurel: 10,
  fern: 11,
  twigs: 12,
  barkRough: 13,
  barkSmooth: 14,
  barkPine: 15,
} as const;
export type Cell = (typeof Cell)[keyof typeof Cell];

/** Texture coordinates of a point (u, v in 0–1, v up) in a cell. */
export function cellUv(cell: Cell, u: number, v: number): [number, number] {
  const col = cell % ATLAS_CELLS;
  const row = Math.floor(cell / ATLAS_CELLS);
  const m = CELL_MARGIN;
  const uu = m + u * (1 - 2 * m);
  const vv = m + v * (1 - 2 * m);
  // Rows are drawn top-down; the texture is flipped, so its v runs up the image.
  return [(col + uu) / ATLAS_CELLS, (ATLAS_CELLS - 1 - row + vv) / ATLAS_CELLS];
}

/** A small deterministic generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = OffscreenCanvasRenderingContext2D;
type Shape = 'ovate' | 'lance' | 'oakRound' | 'oakPointed' | 'maple' | 'star' | 'tulip' | 'holly';

interface Look {
  readonly shape: Shape;
  /** Base colour, HSL. */
  readonly h: number;
  readonly s: number;
  readonly l: number;
  /** Leaf length as a share of the cell. */
  readonly size: number;
  /** Leaves per cell. */
  readonly count: number;
  /** Width over length. */
  readonly aspect: number;
  /** Leaves in pairs along a stalk (compound leaves, as hickory). */
  readonly compound?: boolean;
}

const LOOKS: Partial<Record<Cell, Look>> = {
  [Cell.oakWhite]: { shape: 'oakRound', h: 95, s: 32, l: 40, size: 0.11, count: 334, aspect: 0.55 },
  [Cell.oakRed]: { shape: 'oakPointed', h: 98, s: 38, l: 35, size: 0.12, count: 319, aspect: 0.6 },
  [Cell.maple]: { shape: 'maple', h: 92, s: 40, l: 41, size: 0.085, count: 377, aspect: 1 },
  [Cell.poplar]: { shape: 'tulip', h: 86, s: 44, l: 44, size: 0.1, count: 334, aspect: 1 },
  [Cell.sweetgum]: { shape: 'star', h: 100, s: 38, l: 37, size: 0.095, count: 348, aspect: 1 },
  [Cell.beech]: { shape: 'ovate', h: 84, s: 42, l: 45, size: 0.075, count: 479, aspect: 0.5 },
  [Cell.hickory]: {
    shape: 'lance',
    h: 88,
    s: 38,
    l: 41,
    size: 0.07,
    count: 479,
    aspect: 0.32,
    compound: true,
  },
  [Cell.holly]: { shape: 'holly', h: 110, s: 40, l: 27, size: 0.07, count: 435, aspect: 0.55 },
  [Cell.laurel]: { shape: 'lance', h: 105, s: 34, l: 31, size: 0.085, count: 377, aspect: 0.33 },
};

const hsl = (h: number, s: number, l: number, a = 1) =>
  `hsla(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%, ${a.toFixed(2)})`;

/** A leaf from (0, 0) (stalk) to (len, 0) (tip). */
function leafPath(ctx: Ctx, shape: Shape, len: number, wid: number, r: () => number) {
  ctx.beginPath();
  const lobed = (lobes: number, depth: number, pointed: boolean) => {
    const n = 48;
    const pts: [number, number][] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i <= n; i += 1) {
        const t = side < 0 ? i / n : 1 - i / n;
        const env = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.8);
        const phase = t * lobes * Math.PI;
        const wave = pointed ? Math.pow(Math.abs(Math.sin(phase)), 0.5) : Math.abs(Math.sin(phase));
        const w = wid * env * (1 - depth + depth * wave);
        pts.push([t * len, side * w]);
      }
    }
    const [first, ...rest] = pts;
    if (!first) return;
    ctx.moveTo(first[0], first[1]);
    for (const [x, y] of rest) ctx.lineTo(x, y);
  };
  const star = (points: number, spread: number, valley: number, teeth: boolean) => {
    const n = points * 2;
    for (let i = 0; i <= n; i += 1) {
      const a = -spread / 2 + (spread * i) / n;
      const tip = i % 2 === 1;
      let rr = tip ? len : len * valley;
      if (teeth && !tip) rr *= 1 + 0.08 * (r() - 0.5);
      const x = rr * Math.cos(a) * 0.5 + len * 0.45;
      const y = rr * Math.sin(a) * 0.5;
      if (i === 0) ctx.moveTo(len * 0.05, 0);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(len * 0.05, 0);
  };
  switch (shape) {
    case 'ovate':
    case 'lance':
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(len * 0.25, -wid * 1.1, len * 0.75, -wid, len, 0);
      ctx.bezierCurveTo(len * 0.75, wid, len * 0.25, wid * 1.1, 0, 0);
      break;
    case 'holly': {
      const spines = 5;
      ctx.moveTo(0, 0);
      for (const side of [-1, 1]) {
        for (let i = 1; i <= spines * 2; i += 1) {
          const t = side < 0 ? i / (spines * 2) : 1 - i / (spines * 2);
          const env = Math.sin(Math.PI * t);
          const w = wid * env * (i % 2 === 0 ? 1.15 : 0.75);
          ctx.lineTo(t * len, side * w);
        }
      }
      ctx.closePath();
      break;
    }
    case 'oakRound':
      lobed(3.5, 0.45, false);
      break;
    case 'oakPointed':
      lobed(3.5, 0.55, true);
      break;
    case 'maple':
      star(3, 2.2, 0.45, true);
      break;
    case 'star':
      star(5, 3.6, 0.35, false);
      break;
    case 'tulip':
      ctx.moveTo(0, 0);
      ctx.lineTo(len * 0.25, -wid * 0.55);
      ctx.lineTo(len * 0.55, -wid * 0.5);
      ctx.lineTo(len * 0.6, -wid * 0.3);
      ctx.lineTo(len * 0.95, -wid * 0.45);
      ctx.lineTo(len * 0.85, 0);
      ctx.lineTo(len * 0.95, wid * 0.45);
      ctx.lineTo(len * 0.6, wid * 0.3);
      ctx.lineTo(len * 0.55, wid * 0.5);
      ctx.lineTo(len * 0.25, wid * 0.55);
      ctx.closePath();
      break;
  }
}

/** A leaf cluster: twigs from the centre, leaves along them, back ones darker. */
function drawCluster(ctx: Ctx, look: Look, r: () => number) {
  const c = CELL / 2;
  const reach = CELL * 0.44;
  interface Leaf {
    x: number;
    y: number;
    a: number;
    len: number;
    depth: number;
  }
  const leaves: Leaf[] = [];
  const twigs = 12 + Math.floor(r() * 5);
  ctx.lineCap = 'round';
  for (let k = 0; k < twigs; k += 1) {
    const a0 = (k / twigs) * Math.PI * 2 + r() * 0.6;
    const len = reach * (0.55 + 0.45 * r());
    // A gently curving twig, drawn as segments.
    let x = c + (r() - 0.5) * CELL * 0.08;
    let y = c + (r() - 0.5) * CELL * 0.08;
    let a = a0;
    const steps = 10;
    ctx.strokeStyle = hsl(25, 25, 22);
    for (let s = 0; s < steps; s += 1) {
      const nx = x + (Math.cos(a) * len) / steps;
      const ny = y + (Math.sin(a) * len) / steps;
      ctx.lineWidth = Math.max(1, 4.5 * (1 - s / steps));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      x = nx;
      y = ny;
      a += (r() - 0.5) * 0.25;
      const t = (s + 1) / steps;
      const per = Math.max(1, Math.round((look.count / twigs / steps) * (0.6 + t)));
      for (let q = 0; q < per; q += 1) {
        const side = q % 2 === 0 ? 1 : -1;
        const la = a + side * (0.5 + r() * 0.6);
        leaves.push({
          x: x + (r() - 0.5) * 6,
          y: y + (r() - 0.5) * 6,
          a: la,
          len: CELL * look.size * (0.75 + 0.5 * r()) * (0.75 + 0.35 * t),
          depth: r(),
        });
      }
    }
  }
  leaves.sort((p, q) => p.depth - q.depth);
  for (const leaf of leaves) {
    const shade = 0.7 + 0.45 * leaf.depth;
    const l = look.l * shade * (0.92 + 0.16 * r());
    const h = look.h + (r() - 0.5) * 10;
    const s = look.s * (0.85 + 0.3 * r());
    const pieces: [number, number, number][] = look.compound
      ? [0.35, 0.6, 0.85].flatMap((t) => [
          [t, 0.9, 1] as [number, number, number],
          [t, -0.9, 1] as [number, number, number],
        ])
      : [[0, 0, 1]];
    if (look.compound) pieces.push([1, 0, 1.2]);
    for (const [t, side, sz] of pieces) {
      ctx.save();
      ctx.translate(leaf.x, leaf.y);
      ctx.rotate(leaf.a);
      const len = leaf.len * (look.compound ? 0.55 : 1) * sz;
      if (look.compound) {
        ctx.translate(leaf.len * t * 0.9, 0);
        ctx.rotate(side * 0.9);
      }
      leafPath(ctx, look.shape, len, len * look.aspect * 0.5, r);
      const g = ctx.createLinearGradient(0, -len * 0.3, 0, len * 0.3);
      g.addColorStop(0, hsl(h, s, l * 1.12));
      g.addColorStop(1, hsl(h, s, l * 0.85));
      ctx.fillStyle = g;
      ctx.fill();
      // Midrib.
      ctx.strokeStyle = hsl(h - 10, s * 0.6, Math.min(70, l * 1.4), 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(len * 0.05, 0);
      ctx.lineTo(len * 0.85, 0);
      ctx.stroke();
      ctx.restore();
    }
  }
}

/** Pine needle tufts at the ends of twigs. */
function drawNeedles(ctx: Ctx, r: () => number) {
  const c = CELL / 2;
  const tufts = 15;
  ctx.lineCap = 'round';
  for (let k = 0; k < tufts; k += 1) {
    const a = (k / tufts) * Math.PI * 2 + r() * 0.5;
    const d = k === 0 ? 0 : CELL * (0.06 + 0.24 * r());
    const bx = c + Math.cos(a) * d;
    const by = c + Math.sin(a) * d;
    ctx.strokeStyle = hsl(22, 30, 26);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(bx, by);
    ctx.stroke();
    const needles = 70;
    for (let n = 0; n < needles; n += 1) {
      const na = a + (r() - 0.5) * 2.4;
      const len = CELL * (0.12 + 0.12 * r());
      const shade = 0.7 + 0.5 * r();
      ctx.strokeStyle = hsl(95 + r() * 15, 35, 24 * shade);
      ctx.lineWidth = 1.6 + r();
      ctx.beginPath();
      const sx = bx + (r() - 0.5) * 8;
      const sy = by + (r() - 0.5) * 8;
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(
        sx + Math.cos(na) * len * 0.5,
        sy + Math.sin(na) * len * 0.5 - 4,
        sx + Math.cos(na) * len,
        sy + Math.sin(na) * len,
      );
      ctx.stroke();
    }
  }
}

/** Eastern red cedar: dense sprays of scale leaves. */
function drawCedar(ctx: Ctx, r: () => number) {
  ctx.lineCap = 'round';
  const spray = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    if (depth > 4 || len < 6) return;
    const ex = x + Math.cos(a) * len;
    const ey = y + Math.sin(a) * len;
    ctx.strokeStyle = hsl(120 + r() * 20, 30, 18 + 10 * r() + depth * 2);
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    const kids = 2 + Math.floor(r() * 3);
    for (let k = 0; k < kids; k += 1) {
      const t = 0.3 + 0.7 * r();
      spray(
        x + (ex - x) * t,
        y + (ey - y) * t,
        a + (r() - 0.5) * 1.6,
        len * (0.45 + 0.25 * r()),
        Math.max(2, w * 0.7),
        depth + 1,
      );
    }
  };
  const c = CELL / 2;
  for (let k = 0; k < 10; k += 1) spray(c, c, (k / 10) * Math.PI * 2 + r(), CELL * 0.3, 9, 0);
}

/** Ferns: fronds rising from the bottom centre (the card's foot). */
function drawFern(ctx: Ctx, r: () => number) {
  const bx = CELL / 2;
  const by = CELL * 0.97;
  const fronds = 9;
  for (let k = 0; k < fronds; k += 1) {
    const a = -Math.PI / 2 + ((k / (fronds - 1)) * 2 - 1) * 1.1 + (r() - 0.5) * 0.2;
    const len = CELL * (0.6 + 0.3 * r());
    const bend = (r() - 0.5) * 0.6 + (a > -Math.PI / 2 ? 0.4 : -0.4);
    const steps = 22;
    let x = bx;
    let y = by;
    let dir = a;
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const nx = x + (Math.cos(dir) * len) / steps;
      const ny = y + (Math.sin(dir) * len) / steps;
      ctx.strokeStyle = hsl(85, 40, 26);
      ctx.lineWidth = 3 * (1 - t) + 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      // Pinnae either side, shorter towards the tip.
      const pl = CELL * 0.11 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.1));
      for (const side of [-1, 1]) {
        const pa = dir + side * 1.25;
        ctx.save();
        ctx.translate(nx, ny);
        ctx.rotate(pa);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(pl * 0.5, -pl * 0.18, pl, 0);
        ctx.quadraticCurveTo(pl * 0.5, pl * 0.18, 0, 0);
        ctx.fillStyle = hsl(90 + r() * 10, 45, 30 + 8 * r());
        ctx.fill();
        ctx.restore();
      }
      x = nx;
      y = ny;
      dir += (bend / steps) * 2;
    }
  }
}

/** Bare twigs for dead trees. */
function drawTwigs(ctx: Ctx, r: () => number) {
  ctx.lineCap = 'round';
  const branch = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    if (depth > 5) return;
    const ex = x + Math.cos(a) * len;
    const ey = y + Math.sin(a) * len;
    ctx.strokeStyle = hsl(30, 12, 30 + 8 * r());
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    for (let k = 0; k < 2; k += 1)
      branch(ex, ey, a + (r() - 0.5) * 1.3, len * 0.68, Math.max(1, w * 0.65), depth + 1);
  };
  const c = CELL / 2;
  for (let k = 0; k < 5; k += 1) branch(c, c, (k / 5) * Math.PI * 2 + r(), CELL * 0.17, 6, 0);
}

/** Barks: opaque, in vertical strips (a trunk's height maps down the cell). */
function drawBark(ctx: Ctx, kind: 'rough' | 'smooth' | 'pine', r: () => number) {
  const base =
    kind === 'pine' ? hsl(18, 30, 30) : kind === 'smooth' ? hsl(40, 6, 52) : hsl(30, 10, 34);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, CELL, CELL);
  if (kind === 'rough') {
    // Ridges and deep furrows.
    for (let k = 0; k < 70; k += 1) {
      let x = r() * CELL;
      const dark = r() < 0.55;
      ctx.strokeStyle = dark ? hsl(25, 12, 16 + 8 * r()) : hsl(35, 8, 44 + 10 * r());
      ctx.lineWidth = dark ? 3 + 4 * r() : 2 + 3 * r();
      ctx.beginPath();
      ctx.moveTo(x, 0);
      for (let y = 0; y <= CELL; y += 16) {
        x += (r() - 0.5) * 9;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else if (kind === 'smooth') {
    for (let k = 0; k < 140; k += 1) {
      ctx.fillStyle = hsl(40, 6, 40 + 22 * r(), 0.35);
      ctx.beginPath();
      ctx.ellipse(r() * CELL, r() * CELL, 4 + 18 * r(), 2 + 4 * r(), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let k = 0; k < 60; k += 1) {
      ctx.strokeStyle = hsl(30, 8, 30, 0.5);
      ctx.lineWidth = 1.5;
      const y = r() * CELL;
      const x = r() * CELL;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 8 + 10 * r(), y + (r() - 0.5) * 2);
      ctx.stroke();
    }
  } else {
    // Plates separated by dark cracks.
    for (let k = 0; k < 90; k += 1) {
      const x = r() * CELL;
      const y = r() * CELL;
      const w = 18 + 30 * r();
      const h = 30 + 60 * r();
      ctx.fillStyle = hsl(16 + 8 * r(), 30, 28 + 14 * r());
      ctx.strokeStyle = hsl(15, 25, 12);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + (r() - 0.5) * 8);
      ctx.lineTo(x + w + (r() - 0.5) * 8, y + h);
      ctx.lineTo(x + (r() - 0.5) * 8, y + h + (r() - 0.5) * 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
}

/** Draws the atlas: RGBA bytes, rows top first. */
function drawAtlas(): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(ATLAS_PX, ATLAS_PX);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2D canvas');
  for (let cell = 0; cell < ATLAS_CELLS * ATLAS_CELLS; cell += 1) {
    const col = cell % ATLAS_CELLS;
    const row = Math.floor(cell / ATLAS_CELLS);
    const r = rng(0x9e3779b1 ^ (cell * 7919));
    ctx.save();
    ctx.translate(col * CELL, row * CELL);
    ctx.beginPath();
    ctx.rect(
      CELL * CELL_MARGIN,
      CELL * CELL_MARGIN,
      CELL * (1 - 2 * CELL_MARGIN),
      CELL * (1 - 2 * CELL_MARGIN),
    );
    ctx.clip();
    // Content is drawn for the inner square, scaled into it.
    const m = CELL * CELL_MARGIN;
    ctx.translate(m, m);
    ctx.scale(1 - 2 * CELL_MARGIN, 1 - 2 * CELL_MARGIN);
    const look = LOOKS[cell as Cell];
    if (look) drawCluster(ctx, look, r);
    else if (cell === Cell.needles) drawNeedles(ctx, r);
    else if (cell === Cell.cedar) drawCedar(ctx, r);
    else if (cell === Cell.fern) drawFern(ctx, r);
    else if (cell === Cell.twigs) drawTwigs(ctx, r);
    else if (cell === Cell.barkRough) drawBark(ctx, 'rough', r);
    else if (cell === Cell.barkSmooth) drawBark(ctx, 'smooth', r);
    else if (cell === Cell.barkPine) drawBark(ctx, 'pine', r);
    ctx.restore();
  }
  return ctx.getImageData(0, 0, ATLAS_PX, ATLAS_PX).data;
}

/**
 * The atlas as a mipmapped sRGB texture. Texels left transparent take their
 * cell's mean leaf colour (still transparent), so filtering at a distance
 * keeps leaves their colour instead of fading them to black.
 */
export function createFoliageAtlas(): DataTexture {
  const src = drawAtlas();
  const out = new Uint8Array(ATLAS_PX * ATLAS_PX * 4);
  for (let cell = 0; cell < ATLAS_CELLS * ATLAS_CELLS; cell += 1) {
    const x0 = (cell % ATLAS_CELLS) * CELL;
    const y0 = Math.floor(cell / ATLAS_CELLS) * CELL;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (let y = y0; y < y0 + CELL; y += 2)
      for (let x = x0; x < x0 + CELL; x += 2) {
        const o = (y * ATLAS_PX + x) * 4;
        if ((src[o + 3] ?? 0) < 128) continue;
        sr += src[o] ?? 0;
        sg += src[o + 1] ?? 0;
        sb += src[o + 2] ?? 0;
        n += 1;
      }
    const mr = n > 0 ? sr / n : 60;
    const mg = n > 0 ? sg / n : 80;
    const mb = n > 0 ? sb / n : 40;
    for (let y = y0; y < y0 + CELL; y += 1)
      for (let x = x0; x < x0 + CELL; x += 1) {
        const o = (y * ATLAS_PX + x) * 4;
        // Flipped: the texture's first row is the image's last.
        const t = ((ATLAS_PX - 1 - y) * ATLAS_PX + x) * 4;
        const a = src[o + 3] ?? 0;
        if (a < 8) {
          out[t] = mr;
          out[t + 1] = mg;
          out[t + 2] = mb;
          out[t + 3] = 0;
        } else {
          out[t] = src[o] ?? 0;
          out[t + 1] = src[o + 1] ?? 0;
          out[t + 2] = src[o + 2] ?? 0;
          out[t + 3] = a;
        }
      }
  }
  const tex = new DataTexture(out, ATLAS_PX, ATLAS_PX, RGBAFormat, UnsignedByteType);
  tex.mipmaps = coverageMipmaps(out);
  tex.colorSpace = SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** The alpha that cards are cut at (the material's `alphaTest`). */
export const ALPHA_CUT = 0.5;

/**
 * Mipmaps that keep each cell's leaf coverage: a plain box filter averages
 * leaves with the gaps between them, so at a distance most texels fall below
 * the alpha cut and crowns thin out to nothing. Each level's alpha is scaled
 * per cell so the share of texels above the cut matches the full-size
 * picture's (Castaño, "Computing alpha mipmaps", 2010).
 */
function coverageMipmaps(base: Uint8Array): { data: Uint8Array; width: number; height: number }[] {
  const cut = ALPHA_CUT * 255;
  const levels: { data: Uint8Array; width: number; height: number }[] = [
    { data: base, width: ATLAS_PX, height: ATLAS_PX },
  ];
  // Coverage of each cell at full size.
  const coverage = (data: Uint8Array, size: number, cell: number, scale: number): number => {
    const cs = size / ATLAS_CELLS;
    const x0 = (cell % ATLAS_CELLS) * cs;
    const y0 = Math.floor(cell / ATLAS_CELLS) * cs;
    let above = 0;
    for (let y = y0; y < y0 + cs; y += 1)
      for (let x = x0; x < x0 + cs; x += 1)
        if ((data[(y * size + x) * 4 + 3] ?? 0) * scale > cut) above += 1;
    return above / (cs * cs);
  };
  const cells = ATLAS_CELLS * ATLAS_CELLS;
  const target = Array.from({ length: cells }, (_, c) => coverage(base, ATLAS_PX, c, 1));
  let prev = base;
  let size = ATLAS_PX;
  while (size > 1) {
    const next = size / 2;
    const data = new Uint8Array(next * next * 4);
    for (let y = 0; y < next; y += 1)
      for (let x = 0; x < next; x += 1) {
        const o = (y * next + x) * 4;
        // Colour weighted by alpha (so gaps' colour does not leak in); alpha averaged.
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let w = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const i = ((2 * y + dy) * size + 2 * x + dx) * 4;
          const al = prev[i + 3] ?? 0;
          const wt = al + 1;
          r += (prev[i] ?? 0) * wt;
          g += (prev[i + 1] ?? 0) * wt;
          b += (prev[i + 2] ?? 0) * wt;
          w += wt;
          a += al;
        }
        data[o] = r / w;
        data[o + 1] = g / w;
        data[o + 2] = b / w;
        data[o + 3] = a / 4;
      }
    // Rescale each cell's alpha to keep its coverage (while cells are more than a few texels).
    if (next / ATLAS_CELLS >= 2)
      for (let c = 0; c < cells; c += 1) {
        const want = target[c] ?? 0;
        if (want >= 0.999) continue;
        let lo = 0.5;
        let hi = 8;
        for (let it = 0; it < 12; it += 1) {
          const mid = (lo + hi) / 2;
          if (coverage(data, next, c, mid) < want) lo = mid;
          else hi = mid;
        }
        const s = (lo + hi) / 2;
        const cs = next / ATLAS_CELLS;
        const x0 = (c % ATLAS_CELLS) * cs;
        const y0 = Math.floor(c / ATLAS_CELLS) * cs;
        for (let y = y0; y < y0 + cs; y += 1)
          for (let x = x0; x < x0 + cs; x += 1) {
            const i = (y * next + x) * 4 + 3;
            data[i] = Math.min(255, (data[i] ?? 0) * s);
          }
      }
    levels.push({ data, width: next, height: next });
    prev = data;
    size = next;
  }
  return levels;
}
