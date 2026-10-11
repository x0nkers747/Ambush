import type { LandUseKind, TerrainDataset, Vec2, VegetationKind } from '#sim';
import { hashInts, unit } from './hash';

// The ground's colours from land cover (docs/adr/0030): woods, scrub, fields,
// meadows, built-up land, water beds and wetland, each its own muted colour,
// given to the terrain's vertices. Colour only: no vertex moves, so the drawn
// ground stays exactly the simulated ground. Each sample takes the class of
// the land-cover area it lies in; where it lies in none, or the battlefield
// has no land-cover data, it keeps the fallback colour (the elevation tints).
// A little fixed, position-seeded variation breaks up large flat areas.

export type LandCoverClass = LandUseKind | VegetationKind | 'water' | 'wetland';

/** Muted ground colours (sRGB). */
export const LAND_COVER_COLORS: Readonly<Record<LandCoverClass, number>> = {
  farmland: 0xb2a873,
  meadow: 0x95a466,
  orchard: 0x83995a,
  residential: 0xa49e8f,
  commercial: 0xa29b92,
  industrial: 0x99958d,
  military: 0x9aa070,
  cemetery: 0x86996a,
  recreation: 0x8fa964,
  other: 0xa2a083,
  woodland: 0x485e34,
  treeLine: 0x5a7041,
  scrub: 0x7b8752,
  wetland: 0x77805f,
  // The bed under open water, seen through it.
  water: 0x4c5f63,
};

/** How much of the fallback colour (the elevation tints) shows through a land-cover colour. */
const FALLBACK_SHARE = 0.2;
/** Fine variation: ±4 % brightness per sample. */
const FINE_NOISE = 0.04;
/** Broad variation: ±6 % brightness over patches of about this size. */
const PATCH_M = 70;
const PATCH_NOISE = 0.06;
const SEED = 0x3d;
/** Land cover is classified on a grid this many times finer than the heightfield. */
const SUBDIVISION = 4;

export interface LandCover {
  /** sRGB bytes, three per sample, in heightfield order. */
  readonly data: Uint8ClampedArray;
  readonly channels: 3;
  /** Samples given a land-cover class. */
  readonly classified: number;
}

interface Area {
  readonly cls: LandCoverClass;
  readonly rings: readonly (readonly Vec2[])[];
  readonly area: number;
  readonly id: string;
}

/**
 * The land-cover class index of every point of a grid `subdivision` times
 * finer than the heightfield (0: none, else 1 + the index in `classes`), row by
 * row from the south-west corner; with `subdivision` 1, of every sample. Areas are painted largest first, so a smaller area lying in a
 * larger one (a meadow in a village) shows; vegetation is painted over land
 * use, and water over both. The order does not depend on the order the
 * features were loaded in.
 */
export function classifyLandCover(
  terrain: TerrainDataset,
  subdivision = 1,
): {
  classes: LandCoverClass[];
  index: Uint8Array;
  columns: number;
  rows: number;
} {
  const { features } = terrain;
  const { originX, originY } = terrain.heightfield;
  const cellSize = terrain.heightfield.cellSize / subdivision;
  const columns = (terrain.heightfield.columns - 1) * subdivision + 1;
  const rows = (terrain.heightfield.rows - 1) * subdivision + 1;
  const classes: LandCoverClass[] = [];
  const classIndex = (cls: LandCoverClass) => {
    let i = classes.indexOf(cls);
    if (i < 0) i = classes.push(cls) - 1;
    return i + 1;
  };
  const index = new Uint8Array(columns * rows);
  const byArea = (areas: Area[]) =>
    areas.sort((a, b) => b.area - a.area || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const area = (ring: readonly Vec2[]) => {
    let s = 0;
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length] ?? a;
      s += a.x * b.y - b.x * a.y;
    });
    return Math.abs(s) / 2;
  };
  const layers: Area[][] = [
    byArea(
      (features.landUse ?? []).map((l) => ({
        cls: l.kind,
        rings: [l.boundary, ...(l.holes ?? [])],
        area: area(l.boundary),
        id: l.id,
      })),
    ),
    byArea(
      features.vegetation.map((v) => ({
        cls: v.kind,
        rings: [v.boundary, ...(v.holes ?? [])],
        area: area(v.boundary),
        id: v.id,
      })),
    ),
    byArea(
      (features.water ?? []).map((w) => ({
        cls: w.kind,
        rings: [w.boundary, ...(w.holes ?? [])],
        area: area(w.boundary),
        id: w.id,
      })),
    ),
  ];
  for (const layer of layers) {
    for (const a of layer) {
      const value = classIndex(a.cls);
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of a.rings[0] ?? []) {
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      const r0 = Math.max(0, Math.ceil((minY - originY) / cellSize));
      const r1 = Math.min(rows - 1, Math.floor((maxY - originY) / cellSize));
      // Scanlines through the sample rows, even–odd over all the rings (holes too).
      for (let r = r0; r <= r1; r += 1) {
        const y = originY + r * cellSize;
        const xs: number[] = [];
        for (const ring of a.rings) {
          ring.forEach((p, i) => {
            const q = ring[(i + 1) % ring.length] ?? p;
            if (p.y > y !== q.y > y) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
          });
        }
        xs.sort((u, v) => u - v);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.ceil(((xs[k] ?? 0) - originX) / cellSize));
          const c1 = Math.min(columns - 1, Math.floor(((xs[k + 1] ?? 0) - originX) / cellSize));
          for (let c = c0; c <= c1; c += 1) index[r * columns + c] = value;
        }
      }
    }
  }
  return { classes, index, columns, rows };
}

/** Smooth value noise in [−1, 1] at a grid position, from hashed lattice points. */
function patchNoise(x: number, y: number): number {
  const gx = x / PATCH_M;
  const gy = y / PATCH_M;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const v = (i: number, j: number) => unit(hashInts(i, j, SEED + 1)) * 2 - 1;
  const top = v(ix, iy) + sx * (v(ix + 1, iy) - v(ix, iy));
  const bottom = v(ix, iy + 1) + sx * (v(ix + 1, iy + 1) - v(ix, iy + 1));
  return top + sy * (bottom - top);
}

/**
 * The ground's colours: each sample's land-cover colour, with a fifth of the
 * fallback showing through, or the fallback alone where there is no land
 * cover. `fallback` holds sRGB bytes per sample (three or four channels); with
 * none, unclassified ground is a plain grass colour.
 */
export function landCoverTints(
  terrain: TerrainDataset,
  fallback?: { readonly data: ArrayLike<number>; readonly channels: 3 | 4 },
): LandCover {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  // Classified on a finer grid, and each sample takes the mean colour of the
  // points within half a cell of it, so the edges of woods and fields are
  // soft rather than stepped along the 10 m grid.
  const fine = classifyLandCover(terrain, SUBDIVISION);
  const palette = fine.classes.map((cls) => {
    const c = LAND_COVER_COLORS[cls];
    return [(c >> 16) & 255, (c >> 8) & 255, c & 255] as const;
  });
  const data = new Uint8ClampedArray(columns * rows * 3);
  let classified = 0;
  const reach = SUBDIVISION / 2;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      const f = fallback ? i * fallback.channels : -1;
      const base: readonly number[] = fallback
        ? [fallback.data[f] ?? 0, fallback.data[f + 1] ?? 0, fallback.data[f + 2] ?? 0]
        : [0x9a, 0xa5, 0x72];
      let red = 0;
      let green = 0;
      let blue = 0;
      let n = 0;
      let covered = 0;
      for (let dr = -reach; dr <= reach; dr += 1) {
        const fr = r * SUBDIVISION + dr;
        if (fr < 0 || fr >= fine.rows) continue;
        for (let dc = -reach; dc <= reach; dc += 1) {
          const fc = c * SUBDIVISION + dc;
          if (fc < 0 || fc >= fine.columns) continue;
          const k = fine.index[fr * fine.columns + fc] ?? 0;
          const cover = k > 0 ? palette[k - 1] : undefined;
          n += 1;
          if (cover) {
            covered += 1;
            red += cover[0] + FALLBACK_SHARE * ((base[0] ?? 0) - cover[0]);
            green += cover[1] + FALLBACK_SHARE * ((base[1] ?? 0) - cover[1]);
            blue += cover[2] + FALLBACK_SHARE * ((base[2] ?? 0) - cover[2]);
          } else {
            red += base[0] ?? 0;
            green += base[1] ?? 0;
            blue += base[2] ?? 0;
          }
        }
      }
      const share = covered / n;
      if (fine.index[r * SUBDIVISION * fine.columns + c * SUBDIVISION]) classified += 1;
      // Land cover is varied more than bare fallback ground.
      const noise =
        FINE_NOISE * (0.5 + 0.5 * share) * (unit(hashInts(c, r, SEED)) * 2 - 1) +
        share * PATCH_NOISE * patchNoise(originX + c * cellSize, originY + r * cellSize);
      data[i * 3] = (red / n) * (1 + noise);
      data[i * 3 + 1] = (green / n) * (1 + noise);
      data[i * 3 + 2] = (blue / n) * (1 + noise);
    }
  }
  return { data, channels: 3, classified };
}
