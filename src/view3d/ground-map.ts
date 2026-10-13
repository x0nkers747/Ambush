import {
  heightAt,
  waterQuery,
  type Road,
  type TerrainDataset,
  type Vec2,
  type WaterClass,
} from '#sim';
import { hashString, NoiseField, unit } from './hash';
import { rasterizeLandCover, type LandCoverClass, type RasterGrid } from './landcover';
import { CONIFER_NOISE, coniferShare } from './vegetation-placement';
import { urbanGrid } from './water-profiles';

// What the ground is made of, for the terrain material (docs/adr/0038): a
// map in battlefield metres giving, at every point, the weights of eleven
// ground layers (grass, rough grass, leaf litter, needle litter, field soil,
// bare earth, gravel, rock, sand, shingle, mud) and four surface parameters (wetness, dryness,
// and the direction and strength of field furrows). The terrain shader reads
// it by world position, so it does not depend on the mesh: refined tiles,
// their edges and the camera change nothing.
//
// It comes from the land cover the 2D map and the vegetation already use
// (`rasterizeLandCover`), and only from what the data says: a wood's floor
// is leaf or needle litter as its trees are (the same stand noise), a field
// is soil, a wetland damp earth. Where the data says nothing about a
// surface's state (a field ploughed or harvested), a stable hash of the
// feature picks a look, as for buildings; that is appearance, not data.
//
// - Natural edges (wood to meadow, scrub to grass) are irregular and soft:
//   the class is looked up at a noise-displaced point, then weights are
//   blurred over natural neighbours only.
// - Man-made edges (fields, settlements, anything next to them) stay sharp.
// - Slopes: bare earth then rock on steep natural ground; graded earthworks
//   (cuttings, embankments, pad edges) show earth and sparse grass sooner.
// - Road and track shoulders are worn: gravel or earth beside the surface.
// - Shores (docs/adr/0040): along levelled water, a band of sand, shingle,
//   mud or rock, as mapped (`natural=beach`, `shingle`, `bare_rock`, `mud`)
//   or else from the kind of water, the slope and the land cover, varying
//   in width along the shore, with a damp band at the waterline; the bed
//   under the water is sand, shingle or mud likewise. Built-up shores have
//   none (docs/adr/0046): they end in a quay wall, not a beach.
//
// Pure and deterministic: hashes of positions and feature ids, no random
// numbers, no dependence on load order. Display only: the simulation never
// reads it, and no vertex moves.

/** Bump when the map's rules change: it changes how the ground looks, nothing else. */
export const GROUND_MATERIAL_VERSION = 3;

/** The ground layers, in texture-array order. */
export const GROUND_LAYERS = [
  'grass',
  'meadow',
  'leaves',
  'needles',
  'soil',
  'earth',
  'gravel',
  'rock',
  'sand',
  'shingle',
  'mud',
] as const;
export type GroundLayer = (typeof GROUND_LAYERS)[number];
const L = Object.fromEntries(GROUND_LAYERS.map((l, i) => [l, i])) as Record<GroundLayer, number>;
const LAYERS = GROUND_LAYERS.length;

/** Map resolution: as fine as this, metres… */
export const MIN_TEXEL_M = 2.5;
/** …with at most this many points along a side. */
export const MAX_TEXELS = 1280;

/**
 * How a field looks; OSM does not record it, so a hash of the field picks one.
 * Small "fields" are farmyards (the importer files `landuse=farmyard` under
 * farmland): compacted earth and gravel round the farm buildings.
 */
export type FieldLook = 'ploughed' | 'tilled' | 'stubble' | 'pasture' | 'yard';
/** Farmland smaller than this, m², is a farmyard. */
export const YARD_MAX_M2 = 4000;
const FIELD_LOOKS: readonly { look: FieldLook; share: number }[] = [
  { look: 'ploughed', share: 0.3 },
  { look: 'tilled', share: 0.2 },
  { look: 'stubble', share: 0.25 },
  { look: 'pasture', share: 0.25 },
];

export interface GroundMap {
  readonly version: number;
  readonly grid: RasterGrid;
  /** Layers 0–3 as RGBA bytes, per point, row by row from the south-west corner. */
  readonly weights0: Uint8Array;
  /** Layers 4–7. */
  readonly weights1: Uint8Array;
  /** Layers 8–10, and 0. Each point's weights sum to 255. */
  readonly weights2: Uint8Array;
  /** Wetness, dryness, furrow direction (0–255 for 0–180° from east), furrow strength. */
  readonly params: Uint8Array;
  readonly stats: {
    readonly points: number;
    /** Points with land cover. */
    readonly classified: number;
    /** Each layer's share of the battlefield, 0–1. */
    readonly layers: Readonly<Record<GroundLayer, number>>;
    /** Points softened as natural edges, steepened, and road shoulders. */
    readonly natural: number;
    readonly steep: number;
    readonly shoulders: number;
    /** Points on a shore band or a levelled water's bed. */
    readonly shores: number;
  };
}

type Weights = Partial<Record<GroundLayer, number>>;

interface Recipe {
  readonly weights: Weights;
  /** 0–1. */
  readonly wet?: number;
  readonly dry?: number;
}

/** Whether a class's edges are natural (soft) rather than man-made (sharp). */
const NATURAL: Readonly<Record<LandCoverClass | 'none', boolean>> = {
  none: true,
  meadow: true,
  military: true,
  woodland: true,
  treeLine: true,
  scrub: true,
  wetland: true,
  water: true,
  farmland: false,
  orchard: false,
  residential: false,
  commercial: false,
  industrial: false,
  cemetery: false,
  recreation: false,
  other: false,
  beach: true,
  shingle: true,
  bareRock: true,
  mud: true,
};

/** The ground of each class, before variation. */
const RECIPES: Readonly<Record<Exclude<LandCoverClass, 'farmland' | 'woodland'> | 'none', Recipe>> =
  {
    // No land cover: rough grassland, as most unmapped open ground is.
    none: { weights: { grass: 0.55, meadow: 0.45 }, dry: 0.12 },
    meadow: { weights: { grass: 0.6, meadow: 0.4 }, dry: 0.08 },
    // Training areas: rough grass, worn in patches (see `variation`).
    military: { weights: { grass: 0.45, meadow: 0.55 }, dry: 0.25 },
    orchard: { weights: { grass: 0.8, meadow: 0.2 }, dry: 0.05 },
    residential: { weights: { grass: 0.85, meadow: 0.1, soil: 0.05 } },
    commercial: { weights: { gravel: 0.45, meadow: 0.35, earth: 0.2 }, dry: 0.5 },
    industrial: { weights: { gravel: 0.55, earth: 0.25, meadow: 0.2 }, dry: 0.5 },
    cemetery: { weights: { grass: 0.9, meadow: 0.1 } },
    recreation: { weights: { grass: 0.9, meadow: 0.1 } },
    other: { weights: { meadow: 0.5, earth: 0.3, gravel: 0.2 }, dry: 0.5 },
    treeLine: { weights: { leaves: 0.45, grass: 0.35, meadow: 0.2 } },
    // Sparse grass over soil.
    scrub: { weights: { meadow: 0.5, grass: 0.25, earth: 0.25 }, dry: 0.3 },
    wetland: { weights: { earth: 0.5, grass: 0.5 }, wet: 0.7 },
    // The bed under open water (levelled water's bed is set by `shores`).
    water: { weights: { earth: 1 }, wet: 1 },
    // Mapped shores and bare ground (docs/adr/0040).
    beach: { weights: { sand: 0.9, shingle: 0.1 }, dry: 0.3 },
    shingle: { weights: { shingle: 0.8, sand: 0.2 } },
    bareRock: { weights: { rock: 0.8, gravel: 0.2 } },
    mud: { weights: { mud: 0.85, earth: 0.15 }, wet: 0.5 },
  };

const FIELD_RECIPES: Readonly<Record<FieldLook, Recipe & { furrows: number }>> = {
  ploughed: { weights: { soil: 1 }, furrows: 1 },
  tilled: { weights: { soil: 0.85, meadow: 0.15 }, furrows: 0.55, dry: 0.1 },
  stubble: { weights: { meadow: 1 }, furrows: 0.35, dry: 0.9 },
  pasture: { weights: { grass: 0.75, meadow: 0.25 }, furrows: 0.12, dry: 0.15 },
  yard: { weights: { earth: 0.35, gravel: 0.3, meadow: 0.35 }, furrows: 0, dry: 0.4 },
};

/** Worn shoulders beside each road class: width beyond the edge (m) and ground. */
const SHOULDERS: Readonly<Record<Road['roadClass'], { width: number; weights: Weights }>> = {
  major: { width: 1.6, weights: { gravel: 0.6, earth: 0.4 } },
  paved: { width: 1.3, weights: { gravel: 0.55, earth: 0.45 } },
  unpaved: { width: 1.2, weights: { earth: 0.65, gravel: 0.35 } },
  track: { width: 1.1, weights: { earth: 0.7, meadow: 0.3 } },
  path: { width: 0.8, weights: { earth: 0.6, meadow: 0.4 } },
};

/** Slopes (rise over run) where bare ground starts showing. */
const STEEP_EARTH = [0.6, 0.95] as const;
const STEEP_ROCK = [0.95, 1.4] as const;
/** On graded ground (cuttings, embankments), earlier. */
const EARTHWORK = [0.35, 0.7] as const;
/** Natural edges: displacement of the class lookup, in points. */
const WARP_POINTS = 1.6;
const SEED = 0x38;

/** The grid the map is baked on for a terrain: the heightfield's extent, square-ish points. */
export function groundGrid(terrain: TerrainDataset): RasterGrid {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const width = (columns - 1) * cellSize;
  const height = (rows - 1) * cellSize;
  const step = Math.max(MIN_TEXEL_M, Math.max(width, height) / (MAX_TEXELS - 1));
  const cx = Math.max(2, Math.min(MAX_TEXELS, Math.ceil(width / step) + 1));
  const cy = Math.max(2, Math.min(MAX_TEXELS, Math.ceil(height / step) + 1));
  return {
    originX,
    originY,
    stepX: width / (cx - 1),
    stepY: height / (cy - 1),
    columns: cx,
    rows: cy,
  };
}

/** A field's look and furrow direction (radians from east, 0–π, along its long axis). */
export function fieldLook(id: string, ring: readonly Vec2[]): { look: FieldLook; angle: number } {
  const u = unit(hashString(`field:${id}`));
  let acc = 0;
  let look: FieldLook = 'pasture';
  for (const f of FIELD_LOOKS) {
    acc += f.share;
    if (u < acc) {
      look = f.look;
      break;
    }
  }
  let twice = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length] ?? a;
    twice += a.x * b.y - b.x * a.y;
  });
  if (Math.abs(twice) / 2 < YARD_MAX_M2) look = 'yard';
  // Long axis from the boundary's second moments, each edge weighted by its length.
  let sx = 0;
  let sy = 0;
  let sw = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length] ?? a;
    const w = Math.hypot(b.x - a.x, b.y - a.y);
    sx += ((a.x + b.x) / 2) * w;
    sy += ((a.y + b.y) / 2) * w;
    sw += w;
  });
  const mx = sw > 0 ? sx / sw : 0;
  const my = sw > 0 ? sy / sw : 0;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length] ?? a;
    const w = Math.hypot(b.x - a.x, b.y - a.y);
    // The edge as a uniform segment: its own spread plus its midpoint's.
    const dx = (a.x + b.x) / 2 - mx;
    const dy = (a.y + b.y) / 2 - my;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    xx += w * (dx * dx + (ex * ex) / 12);
    yy += w * (dy * dy + (ey * ey) / 12);
    xy += w * (dx * dy + (ex * ey) / 12);
  });
  let angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  if (angle < 0) angle += Math.PI;
  if (angle >= Math.PI) angle -= Math.PI;
  return { look, angle };
}

type Noise = NoiseField;

/** The slow noise fields the map varies with, each hashed once over the battlefield. */
interface Noises {
  readonly warpX: Noise;
  readonly warpY: Noise;
  readonly green: Noise;
  readonly worn: Noise;
  readonly dry: Noise;
  readonly conifer: Noise;
  readonly shoulder: Noise;
  readonly shoreWidth: Noise;
  readonly shoreMix: Noise;
  readonly layers: readonly Noise[];
}

function noises(grid: RasterGrid): Noises {
  const { originX, originY, stepX, stepY, columns, rows } = grid;
  const maxX = originX + (columns - 1) * stepX;
  const maxY = originY + (rows - 1) * stepY;
  const field = (scale: number, seed: number) =>
    new NoiseField(originX, originY, maxX, maxY, scale, seed);
  return {
    warpX: field(28, SEED + 1),
    warpY: field(28, SEED + 2),
    green: field(40, SEED + 3),
    worn: field(60, SEED + 4),
    dry: field(120, SEED + 5),
    shoulder: field(9, SEED + 6),
    shoreWidth: field(55, SEED + 7),
    shoreMix: field(18, SEED + 8),
    conifer: field(CONIFER_NOISE.scale, CONIFER_NOISE.seed),
    layers: GROUND_LAYERS.map((_, l) => field(46, SEED + 10 + l)),
  };
}

/** Recipe weights as a vector in layer order. */
function vector(weights: Weights): Float32Array {
  const v = new Float32Array(LAYERS);
  for (const [layer, share] of Object.entries(weights) as [GroundLayer, number][]) {
    v[L[layer]] = share;
  }
  return v;
}
const RECIPE_VECTORS = Object.fromEntries(
  Object.entries(RECIPES).map(([cls, r]) => [cls, vector(r.weights)]),
) as Record<keyof typeof RECIPES, Float32Array>;
const FIELD_VECTORS = Object.fromEntries(
  Object.entries(FIELD_RECIPES).map(([look, r]) => [look, vector(r.weights)]),
) as Record<FieldLook, Float32Array>;
const SHOULDER_VECTORS = Object.fromEntries(
  Object.entries(SHOULDERS).map(([cls, r]) => [cls, vector(r.weights)]),
) as Record<Road['roadClass'], Float32Array>;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Bakes the ground map of a terrain. Pure: the same terrain gives the same bytes. */
export function bakeGroundMap(terrain: TerrainDataset): GroundMap {
  const grid = groundGrid(terrain);
  const { originX, originY, stepX, stepY, columns, rows } = grid;
  const n = columns * rows;
  const raster = rasterizeLandCover(terrain, grid);
  const classOf = (k: number): LandCoverClass | 'none' =>
    k > 0 ? (raster.classes[k - 1] ?? 'none') : 'none';
  const naturalClass = raster.classes.map((c) => NATURAL[c]);
  const isNatural = (k: number) => (k > 0 ? (naturalClass[k - 1] ?? true) : true);

  // Fields' looks, once per field.
  const fields = new Map<number, { look: FieldLook; angle: number }>();
  const fieldOf = (a: number) => {
    let f = fields.get(a);
    if (!f) {
      const area = raster.areas[a];
      f = area ? fieldLook(area.id, area.rings[0] ?? []) : { look: 'pasture', angle: 0 };
      fields.set(a, f);
    }
    return f;
  };

  const w = new Float32Array(n * LAYERS);
  const p = new Float32Array(n * 4);
  const natural = new Uint8Array(n);
  const noise = noises(grid);
  let classified = 0;
  let naturalCount = 0;

  for (let r = 0; r < rows; r += 1) {
    const y = originY + r * stepY;
    for (let c = 0; c < columns; c += 1) {
      const x = originX + c * stepX;
      const i = r * columns + c;
      let k = raster.index[i] ?? 0;
      let a = raster.area[i] ?? -1;
      if (k > 0) classified += 1;
      if (isNatural(k)) {
        natural[i] = 1;
        naturalCount += 1;
        // Natural edges wander: take the class at a displaced point, if that is natural too.
        const wc = Math.round(c + WARP_POINTS * noise.warpX.at(x, y));
        const wr = Math.round(r + WARP_POINTS * noise.warpY.at(x, y));
        if (wc >= 0 && wc < columns && wr >= 0 && wr < rows) {
          const j = wr * columns + wc;
          const kk = raster.index[j] ?? 0;
          if (isNatural(kk)) {
            k = kk;
            a = raster.area[j] ?? -1;
          }
        }
      }
      recipe(classOf(k), a, x, y, w, i * LAYERS, p, i * 4, fieldOf, noise);
    }
  }

  blurNatural(w, p, natural, columns, rows);
  const slope = slopeMap(terrain, grid);
  const steep = slopes(terrain, grid, slope, w, raster.index, raster.classes);
  const shoreCount = shores(terrain, grid, slope, w, p, classOf, raster.index, noise);
  const shoulders = roadShoulders(terrain, grid, w, noise.shoulder);

  // Quantised: each point's weights sum to exactly 255.
  const weights0 = new Uint8Array(n * 4);
  const weights1 = new Uint8Array(n * 4);
  const weights2 = new Uint8Array(n * 4);
  const params = new Uint8Array(n * 4);
  const totals = new Float64Array(LAYERS);
  const q = new Array<number>(LAYERS);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let l = 0; l < LAYERS; l += 1) sum += w[i * LAYERS + l] ?? 0;
    if (!(sum > 0)) {
      w[i * LAYERS + L.grass] = 1;
      sum = 1;
    }
    let used = 0;
    let top = 0;
    for (let l = 0; l < LAYERS; l += 1) {
      const v = Math.floor((255 * (w[i * LAYERS + l] ?? 0)) / sum);
      q[l] = v;
      used += v;
      if (v > (q[top] ?? 0)) top = l;
    }
    q[top] = (q[top] ?? 0) + 255 - used;
    for (let l = 0; l < LAYERS; l += 1) {
      const v = q[l] ?? 0;
      totals[l] = (totals[l] ?? 0) + v / 255;
      if (l < 4) weights0[i * 4 + l] = v;
      else if (l < 8) weights1[i * 4 + l - 4] = v;
      else weights2[i * 4 + l - 8] = v;
    }
    for (let ch = 0; ch < 4; ch += 1) {
      params[i * 4 + ch] = Math.round(255 * Math.min(1, Math.max(0, p[i * 4 + ch] ?? 0)));
    }
  }
  const layers = Object.fromEntries(
    GROUND_LAYERS.map((l, i) => [l, (totals[i] ?? 0) / n]),
  ) as Record<GroundLayer, number>;
  return {
    version: GROUND_MATERIAL_VERSION,
    grid,
    weights0,
    weights1,
    weights2,
    params,
    stats: {
      points: n,
      classified,
      layers,
      natural: naturalCount,
      steep,
      shoulders,
      shores: shoreCount,
    },
  };
}

/** Writes the ground of one point: its class's recipe, varied by slow noise. */
function recipe(
  cls: LandCoverClass | 'none',
  area: number,
  x: number,
  y: number,
  w: Float32Array,
  o: number,
  p: Float32Array,
  po: number,
  fieldOf: (area: number) => { look: FieldLook; angle: number },
  noise: Noises,
): void {
  let wet = 0;
  let dry = 0;
  if (cls === 'farmland' && area >= 0) {
    const f = fieldOf(area);
    const r = FIELD_RECIPES[f.look];
    w.set(FIELD_VECTORS[f.look], o);
    dry = r.dry ?? 0;
    p[po + 2] = f.angle / Math.PI;
    p[po + 3] = r.furrows;
  } else if (cls === 'woodland') {
    // The floor of the stand the trees stand in: needles under conifers,
    // leaf litter under broadleaf trees, darker soil, some green undergrowth.
    const needles = smoothstep(0.3, 0.7, coniferShare(noise.conifer.at(x, y)));
    const green = 0.08 + 0.12 * Math.max(0, noise.green.at(x, y));
    w[o + L.needles] = (0.78 - green) * needles;
    w[o + L.leaves] = (0.78 - green) * (1 - needles);
    w[o + L.earth] = 0.14;
    w[o + L.grass] = green;
    w[o + L.meadow] = 0.08;
  } else {
    const key = cls === 'farmland' ? 'none' : cls;
    const r = RECIPES[key];
    w.set(RECIPE_VECTORS[key], o);
    wet = r.wet ?? 0;
    dry = r.dry ?? 0;
  }
  // Variation within an area: each layer's share drifts with slow noise, so
  // a meadow has greener and drier patches; training areas are worn in places.
  for (let l = 0; l < LAYERS; l += 1) {
    const v = w[o + l] ?? 0;
    if (v > 0) w[o + l] = v * (1 + 0.55 * (noise.layers[l]?.at(x, y) ?? 0));
  }
  if (cls === 'military' || cls === 'none') {
    const worn = smoothstep(0.45, 0.8, noise.worn.at(x, y));
    w[o + L.earth] = (w[o + L.earth] ?? 0) + 0.35 * worn;
  }
  p[po] = wet;
  p[po + 1] = Math.min(1, Math.max(0, dry + 0.2 * noise.dry.at(x, y)));
}

/** Blurs natural points' weights over their natural neighbours (3 × 3), so natural edges are soft. */
function blurNatural(
  w: Float32Array,
  p: Float32Array,
  natural: Uint8Array,
  columns: number,
  rows: number,
): void {
  // Wetness and dryness blur with the weights; furrows belong to fields only.
  // In place, a row at a time: along each row, then down the columns.
  const C = LAYERS + 2;
  const load = (row: Float32Array, r: number) => {
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      for (let l = 0; l < LAYERS; l += 1) row[c * C + l] = w[i * LAYERS + l] ?? 0;
      row[c * C + LAYERS] = p[i * 4] ?? 0;
      row[c * C + LAYERS + 1] = p[i * 4 + 1] ?? 0;
    }
  };
  const store = (i: number, ch: number, v: number) => {
    if (ch < LAYERS) w[i * LAYERS + ch] = v;
    else p[i * 4 + ch - LAYERS] = v;
  };
  const row = new Float32Array(columns * C);
  for (let r = 0; r < rows; r += 1) {
    load(row, r);
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      if (!natural[i]) continue;
      const prev = c > 0 && natural[i - 1] === 1;
      const next = c < columns - 1 && natural[i + 1] === 1;
      const count = 1 + (prev ? 1 : 0) + (next ? 1 : 0);
      for (let ch = 0; ch < C; ch += 1) {
        let v = row[c * C + ch] ?? 0;
        if (prev) v += row[(c - 1) * C + ch] ?? 0;
        if (next) v += row[(c + 1) * C + ch] ?? 0;
        store(i, ch, v / count);
      }
    }
  }
  let above = new Float32Array(columns * C);
  let here = new Float32Array(columns * C);
  const below = new Float32Array(columns * C);
  load(here, 0);
  for (let r = 0; r < rows; r += 1) {
    if (r + 1 < rows) load(below, r + 1);
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      if (!natural[i]) continue;
      const prev = r > 0 && natural[i - columns] === 1;
      const next = r < rows - 1 && natural[i + columns] === 1;
      const count = 1 + (prev ? 1 : 0) + (next ? 1 : 0);
      for (let ch = 0; ch < C; ch += 1) {
        let v = here[c * C + ch] ?? 0;
        if (prev) v += above[c * C + ch] ?? 0;
        if (next) v += below[c * C + ch] ?? 0;
        store(i, ch, v / count);
      }
    }
    // The rows as they were before this pass changed them.
    const spare = above;
    above = here;
    here = spare;
    here.set(below);
  }
}

/** The ground's slope (rise over run) at every map point. */
function slopeMap(terrain: TerrainDataset, grid: RasterGrid): Float32Array {
  const { originX, originY, stepX, stepY, columns, rows } = grid;
  const hf = terrain.heightfield;
  const maxX = hf.originX + (hf.columns - 1) * hf.cellSize;
  const maxY = hf.originY + (hf.rows - 1) * hf.cellSize;
  const z = new Float32Array(columns * rows);
  for (let r = 0; r < rows; r += 1) {
    const y = Math.min(originY + r * stepY, maxY);
    for (let c = 0; c < columns; c += 1) {
      z[r * columns + c] = heightAt(terrain, Math.min(originX + c * stepX, maxX), y);
    }
  }
  const slope = new Float32Array(columns * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const c0 = Math.max(c - 1, 0);
      const c1 = Math.min(c + 1, columns - 1);
      const r0 = Math.max(r - 1, 0);
      const r1 = Math.min(r + 1, rows - 1);
      const dzdx = ((z[r * columns + c1] ?? 0) - (z[r * columns + c0] ?? 0)) / ((c1 - c0) * stepX);
      const dzdy = ((z[r1 * columns + c] ?? 0) - (z[r0 * columns + c] ?? 0)) / ((r1 - r0) * stepY);
      slope[r * columns + c] = Math.hypot(dzdx, dzdy);
    }
  }
  return slope;
}

/** Bare earth and rock on steep ground; earth and sparse grass on graded slopes. Returns points changed. */
function slopes(
  terrain: TerrainDataset,
  grid: RasterGrid,
  slope: Float32Array,
  w: Float32Array,
  classIndex: Uint8Array,
  classes: readonly LandCoverClass[],
): number {
  const { originX, originY, stepX, stepY, columns, rows } = grid;
  const hf = terrain.heightfield;
  // Graded cells: where the ground was shaped for a road or a building pad.
  const graded = new Uint8Array((hf.columns - 1) * (hf.rows - 1));
  for (const cell of terrain.refinement?.cells ?? []) graded[cell] = 1;
  const water = classes.indexOf('water') + 1;
  let changed = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      if (water > 0 && classIndex[i] === water) continue;
      const s = slope[i] ?? 0;
      const x = originX + c * stepX;
      const y = originY + r * stepY;
      const gc = Math.min(Math.floor((x - hf.originX) / hf.cellSize), hf.columns - 2);
      const gr = Math.min(Math.floor((y - hf.originY) / hf.cellSize), hf.rows - 2);
      const isGraded = graded[gr * (hf.columns - 1) + gc] === 1;
      const earth = Math.max(
        smoothstep(STEEP_EARTH[0], STEEP_EARTH[1], s),
        isGraded ? smoothstep(EARTHWORK[0], EARTHWORK[1], s) : 0,
      );
      const rock = smoothstep(STEEP_ROCK[0], STEEP_ROCK[1], s);
      if (earth <= 0 && rock <= 0) continue;
      changed += 1;
      const o = i * LAYERS;
      let sum = 0;
      for (let l = 0; l < LAYERS; l += 1) sum += w[o + l] ?? 0;
      const keep = (1 - 0.75 * earth) * (1 - 0.8 * rock);
      for (let l = 0; l < LAYERS; l += 1) w[o + l] = (w[o + l] ?? 0) * keep;
      const bare = sum * (1 - keep);
      // Graded slopes are earth with some grass coming through; natural ones earth, then rock.
      const rockShare = rock > 0 ? (0.8 * rock) / (0.75 * earth + 0.8 * rock) : 0;
      w[o + L.rock] = (w[o + L.rock] ?? 0) + bare * rockShare;
      w[o + L.earth] = (w[o + L.earth] ?? 0) + bare * (1 - rockShare) * 0.55;
      w[o + L.meadow] = (w[o + L.meadow] ?? 0) + bare * (1 - rockShare) * 0.45;
    }
  }
  return changed;
}

/** Worn shoulders along roads and tracks. Returns points changed. */
function roadShoulders(
  terrain: TerrainDataset,
  grid: RasterGrid,
  w: Float32Array,
  noise: Noise,
): number {
  const { originX, originY, stepX, stepY, columns, rows } = grid;
  // The strongest shoulder at each point, so crossing roads do not add up.
  const strength = new Float32Array(columns * rows);
  const kind = new Int8Array(columns * rows).fill(-1);
  const classes = Object.keys(SHOULDERS) as Road['roadClass'][];
  const texel = Math.max(stepX, stepY);
  for (const road of terrain.features.roads) {
    const spec = SHOULDERS[road.roadClass];
    const half = road.widthMeters / 2;
    const reach = half + spec.width + texel;
    const line = road.centerline;
    for (let s = 0; s + 1 < line.length; s += 1) {
      const a = line[s];
      const b = line[s + 1];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const c0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - originX) / stepX));
      const c1 = Math.min(columns - 1, Math.ceil((Math.max(a.x, b.x) + reach - originX) / stepX));
      const r0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - reach - originY) / stepY));
      const r1 = Math.min(rows - 1, Math.ceil((Math.max(a.y, b.y) + reach - originY) / stepY));
      for (let r = r0; r <= r1; r += 1) {
        const y = originY + r * stepY;
        for (let c = c0; c <= c1; c += 1) {
          const x = originX + c * stepX;
          const t =
            len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
          const d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
          if (d > reach) continue;
          // Full under the road and across the shoulder, fading over a point beyond it.
          const v =
            (1 - smoothstep(half + 0.5 * spec.width, half + spec.width + texel, d)) *
            (0.7 + 0.3 * noise.at(x, y));
          const i = r * columns + c;
          if (v > (strength[i] ?? 0)) {
            strength[i] = v;
            kind[i] = classes.indexOf(road.roadClass);
          }
        }
      }
    }
  }
  let changed = 0;
  for (let i = 0; i < columns * rows; i += 1) {
    const k = kind[i] ?? -1;
    if (k < 0) continue;
    const v = 0.85 * (strength[i] ?? 0);
    if (v <= 0) continue;
    changed += 1;
    const o = i * LAYERS;
    let sum = 0;
    for (let l = 0; l < LAYERS; l += 1) {
      sum += w[o + l] ?? 0;
      w[o + l] = (w[o + l] ?? 0) * (1 - v);
    }
    const shoulder = SHOULDER_VECTORS[classes[k] ?? 'path'];
    for (let l = 0; l < LAYERS; l += 1) w[o + l] = (w[o + l] ?? 0) + sum * v * (shoulder[l] ?? 0);
  }
  return changed;
}

/** The ground layers' weights (0–1) at map point (x, y), from the nearest map point. For checks. */
export function groundWeightsAt(map: GroundMap, x: number, y: number): Record<GroundLayer, number> {
  const { originX, originY, stepX, stepY, columns, rows } = map.grid;
  const c = Math.min(columns - 1, Math.max(0, Math.round((x - originX) / stepX)));
  const r = Math.min(rows - 1, Math.max(0, Math.round((y - originY) / stepY)));
  const i = (r * columns + c) * 4;
  return Object.fromEntries(
    GROUND_LAYERS.map((l, k) => [
      l,
      (k < 4
        ? (map.weights0[i + k] ?? 0)
        : k < 8
          ? (map.weights1[i + k - 4] ?? 0)
          : (map.weights2[i + k - 8] ?? 0)) / 255,
    ]),
  ) as Record<GroundLayer, number>;
}

/** The surface parameters at map point (x, y), nearest map point. For checks. */
export function groundParamsAt(
  map: GroundMap,
  x: number,
  y: number,
): { wet: number; dry: number; furrowAngle: number; furrows: number } {
  const { originX, originY, stepX, stepY, columns, rows } = map.grid;
  const c = Math.min(columns - 1, Math.max(0, Math.round((x - originX) / stepX)));
  const r = Math.min(rows - 1, Math.max(0, Math.round((y - originY) / stepY)));
  const i = (r * columns + c) * 4;
  return {
    wet: (map.params[i] ?? 0) / 255,
    dry: (map.params[i + 1] ?? 0) / 255,
    furrowAngle: ((map.params[i + 2] ?? 0) / 255) * Math.PI,
    furrows: (map.params[i + 3] ?? 0) / 255,
  };
}

/** The map's buffers, to transfer them from a worker. */
export function groundMapBuffers(map: GroundMap): ArrayBuffer[] {
  return [map.weights0, map.weights1, map.weights2, map.params].map((a) => a.buffer as ArrayBuffer);
}

/** How each kind of water's shore and bed look (docs/adr/0040). */
interface ShoreLook {
  /** Width of the shore band from the waterline, metres (varies along the shore). */
  readonly width: readonly [number, number];
  /** Width of the damp band at the waterline, metres. */
  readonly wet: readonly [number, number];
  /** The shore's ground, and a second mix it drifts towards in patches. */
  readonly shore: Weights;
  readonly mixed: Weights;
  /** The bed under the water. */
  readonly bed: Weights;
}

const SAND_SHORE: ShoreLook = {
  width: [5, 30],
  wet: [2.5, 6],
  shore: { sand: 1 },
  mixed: { sand: 0.6, shingle: 0.4 },
  bed: { sand: 0.85, shingle: 0.15 },
};
const LAKE_SHORE: ShoreLook = {
  width: [2, 12],
  wet: [1, 2.5],
  shore: { sand: 0.55, earth: 0.25, shingle: 0.2 },
  mixed: { shingle: 0.5, gravel: 0.2, earth: 0.3 },
  bed: { mud: 0.6, sand: 0.4 },
};
const RIVER_SHORE: ShoreLook = {
  width: [1, 6],
  wet: [0.6, 1.5],
  shore: { shingle: 0.55, sand: 0.25, mud: 0.2 },
  mixed: { mud: 0.6, earth: 0.4 },
  bed: { shingle: 0.5, mud: 0.5 },
};
const POND_SHORE: ShoreLook = {
  width: [1, 3],
  wet: [0.5, 1.2],
  shore: { mud: 0.6, earth: 0.4 },
  mixed: { mud: 0.4, earth: 0.3, meadow: 0.3 },
  bed: { mud: 1 },
};
export const SHORE_LOOKS: Readonly<Record<WaterClass, ShoreLook>> = {
  sea: SAND_SHORE,
  lake: LAKE_SHORE,
  reservoir: LAKE_SHORE,
  river: RIVER_SHORE,
  canal: RIVER_SHORE,
  pond: POND_SHORE,
  basin: POND_SHORE,
  other: POND_SHORE,
};
const SHORE_VECTORS = Object.fromEntries(
  Object.entries(SHORE_LOOKS).map(([cls, look]) => [
    cls,
    { shore: vector(look.shore), mixed: vector(look.mixed), bed: vector(look.bed) },
  ]),
) as Record<WaterClass, { shore: Float32Array; mixed: Float32Array; bed: Float32Array }>;
const ROCKY_SHORE = vector({ rock: 0.65, shingle: 0.35 });
/** Shores on slopes steeper than this (rise over run) narrow to nothing; steeper still, they are rock. */
const SHORE_SLOPE = [0.2, 0.55] as const;
const ROCKY_SLOPE = [0.45, 0.9] as const;
/** Land cover that keeps a shore narrow: built-up waterfronts, fields, woods. */
const SHORE_CAP: Partial<Record<LandCoverClass, number>> = {
  residential: 1.5,
  commercial: 1,
  industrial: 1,
  cemetery: 1.5,
  farmland: 2,
  orchard: 2,
  woodland: 3,
  treeLine: 2,
  wetland: 2,
};
/** Mapped shores: their own ground, never an inferred one. */
const MAPPED_SHORE = new Set<LandCoverClass>(['beach', 'shingle', 'bareRock', 'mud']);
/**
 * Shores are looked for this far from the waterline, metres: the widest band
 * (30 m) plus the size of the blocks the search skips by.
 */
const SHORE_REACH_M = 48;

/**
 * Shore bands along levelled water and the beds under it (docs/adr/0040).
 * Returns the points changed.
 */
function shores(
  terrain: TerrainDataset,
  grid: RasterGrid,
  slope: Float32Array,
  w: Float32Array,
  p: Float32Array,
  classOf: (k: number) => LandCoverClass | 'none',
  classIndex: Uint8Array,
  noise: Noises,
): number {
  const surfaces = terrain.grading?.water;
  if (!surfaces) return 0;
  const hf = terrain.heightfield;
  const query = waterQuery(
    terrain.features,
    surfaces,
    {
      originX: hf.originX,
      originY: hf.originY,
      maxX: hf.originX + (hf.columns - 1) * hf.cellSize,
      maxY: hf.originY + (hf.rows - 1) * hf.cellSize,
    },
    SHORE_REACH_M,
  );
  if (!query.any) return 0;
  const urban = urbanGrid(terrain);
  const { originX, originY, stepX, stepY, columns, rows } = grid;
  const shore = new Float32Array(LAYERS);
  let changed = 0;
  // Blocks of points whose corners have no water near are skipped, and blocks
  // deep in water take the bed alone: few points need the full query.
  const B = 4;
  for (let r0 = 0; r0 < rows; r0 += B) {
    for (let c0 = 0; c0 < columns; c0 += B) {
      const r1 = Math.min(rows - 1, r0 + B);
      const c1 = Math.min(columns - 1, c0 + B);
      const corners = [
        query.at(originX + c0 * stepX, originY + r0 * stepY),
        query.at(originX + c1 * stepX, originY + r0 * stepY),
        query.at(originX + c0 * stepX, originY + r1 * stepY),
        query.at(originX + c1 * stepX, originY + r1 * stepY),
      ];
      // Nothing within reach of any corner: nothing within a band's width of any point.
      if (corners.every((a) => a === null)) continue;
      const first = corners[0];
      if (
        first &&
        corners.every(
          (a) => a?.inWater && a.shoreDistance >= query.reach && a.waterClass === first.waterClass,
        )
      ) {
        // Deep in one water: its bed.
        const bed = SHORE_VECTORS[first.waterClass].bed;
        for (let r = r0; r < Math.min(rows, r0 + B); r += 1) {
          for (let c = c0; c < Math.min(columns, c0 + B); c += 1) {
            const i = r * columns + c;
            let sum = 0;
            for (let l = 0; l < LAYERS; l += 1) sum += w[i * LAYERS + l] ?? 0;
            for (let l = 0; l < LAYERS; l += 1) w[i * LAYERS + l] = sum * (bed[l] ?? 0);
            p[i * 4] = 1;
            changed += 1;
          }
        }
        continue;
      }
      for (let r = r0; r < Math.min(rows, r0 + B); r += 1) {
        const y = originY + r * stepY;
        for (let c = c0; c < Math.min(columns, c0 + B); c += 1) {
          const x = originX + c * stepX;
          const at = query.at(x, y);
          if (!at) continue;
          const i = r * columns + c;
          const o = i * LAYERS;
          const vectors = SHORE_VECTORS[at.waterClass];
          const look = SHORE_LOOKS[at.waterClass];
          const mix = smoothstep(-0.25, 0.45, noise.shoreMix.at(x, y));
          const d = at.shoreDistance;
          let sum = 0;
          for (let l = 0; l < LAYERS; l += 1) sum += w[o + l] ?? 0;
          if (at.inWater) {
            // The bed, seen through the water.
            for (let l = 0; l < LAYERS; l += 1) w[o + l] = sum * (vectors.bed[l] ?? 0);
            p[i * 4] = 1;
            changed += 1;
            continue;
          }
          // A built-up shore is a quay (docs/adr/0046): the ground keeps its own look.
          if (urban.at(x, y)) continue;
          const cls = classOf(classIndex[i] ?? 0);
          // The damp band at the waterline, wider and narrower along the shore.
          const u = 0.5 + 0.5 * noise.shoreWidth.at(x, y);
          const wetW = look.wet[0] + u * (look.wet[1] - look.wet[0]);
          const damp = (1 - smoothstep(0.4 * wetW, wetW, d)) * (0.65 + 0.35 * mix);
          if (damp > 0) p[i * 4] = Math.max(p[i * 4] ?? 0, damp);
          if (cls !== 'none' && MAPPED_SHORE.has(cls)) {
            if (damp > 0) changed += 1;
            continue;
          }
          const s = slope[i] ?? 0;
          let width = look.width[0] + u * u * (look.width[1] - look.width[0]);
          width *= 1 - smoothstep(SHORE_SLOPE[0], SHORE_SLOPE[1], s);
          const cap = cls === 'none' ? undefined : SHORE_CAP[cls];
          if (cap !== undefined) width = Math.min(width, cap);
          const rocky = smoothstep(ROCKY_SLOPE[0], ROCKY_SLOPE[1], s);
          const rockW = 1.5 + 2.5 * rocky;
          const tShore = width > 0.2 ? 1 - smoothstep(0.55 * width, width, d) : 0;
          const tRock = rocky * (1 - smoothstep(0.5 * rockW, rockW, d));
          const t = Math.max(tShore, tRock);
          if (t <= 0) {
            if (damp > 0) changed += 1;
            continue;
          }
          changed += 1;
          for (let l = 0; l < LAYERS; l += 1) {
            const v =
              tRock >= tShore
                ? (ROCKY_SHORE[l] ?? 0)
                : (vectors.shore[l] ?? 0) * (1 - mix) + (vectors.mixed[l] ?? 0) * mix;
            shore[l] = v;
          }
          for (let l = 0; l < LAYERS; l += 1) {
            w[o + l] = (w[o + l] ?? 0) * (1 - t) + sum * t * (shore[l] ?? 0);
          }
          // Sand on the dry part of a beach is pale and dry.
          if (tShore > 0) p[i * 4 + 1] = Math.max(p[i * 4 + 1] ?? 0, 0.3 * tShore * (1 - damp));
        }
      }
    }
  }
  return changed;
}
