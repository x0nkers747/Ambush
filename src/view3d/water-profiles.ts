import type { TerrainDataset, Vec2, WaterClass } from '#sim';

// How water looks in 3D (docs/adr/0046): a few visual profiles, each a colour
// and whether its shores are natural (shallows and earth banks) or built
// (quays: no shallows, brick edges). The profile comes from the kind of water
// the grading classified (sim/water-grading.ts) and from how built-up its
// shore is: Amsterdam's canals are mapped as plain `natural=water`, so a
// standing water lined with buildings is drawn as an urban canal, while the
// same tag in open country stays a lake. Display only: nothing here reaches
// the simulation.

export type WaterProfileName = 'urbanCanal' | 'river' | 'lake' | 'reservoir' | 'ocean' | 'pond';

export interface WaterProfile {
  /** The water's colour (sRGB), lit by the sun and sky like everything else. */
  readonly color: number;
  /** Natural shores: lighter shallows near them, earth banks; else quays. */
  readonly natural: boolean;
}

/**
 * The profiles (configurable). Dark and desaturated: the water is drawn
 * opaque (the bed under it is not shown), so these are the colours of the
 * water itself, not of the ground seen through it.
 */
export const WATER_PROFILES: Readonly<Record<WaterProfileName, WaterProfile>> = {
  urbanCanal: { color: 0x34433b, natural: false },
  river: { color: 0x384b45, natural: true },
  lake: { color: 0x354a52, natural: true },
  reservoir: { color: 0x334853, natural: true },
  ocean: { color: 0x2d4b5a, natural: true },
  pond: { color: 0x39473c, natural: true },
};

/** Water that is not levelled (draped on the ground): small ponds and streams. */
export const DRAPED_PROFILE: WaterProfileName = 'pond';

/** A shore at least this built-up (share of it with buildings near) is urban. */
export const URBAN_SHORE_SHARE = 0.5;
/** Canals count as urban sooner: they are built waterways. */
export const URBAN_CANAL_SHARE = 0.25;

/** The profile for a levelled water of class `cls` whose shore is `urbanShare` built-up (0–1). */
export function waterProfileFor(cls: WaterClass, urbanShare: number): WaterProfileName {
  switch (cls) {
    case 'sea':
      return 'ocean';
    case 'lake':
      return 'lake';
    case 'reservoir':
      return 'reservoir';
    case 'river':
      return 'river';
    case 'canal':
      return urbanShare >= URBAN_CANAL_SHARE ? 'urbanCanal' : 'river';
    case 'pond':
      return urbanShare >= URBAN_SHORE_SHARE ? 'urbanCanal' : 'pond';
    case 'basin':
    case 'other':
      return urbanShare >= URBAN_SHORE_SHARE ? 'urbanCanal' : 'lake';
  }
}

/** Buildings this close make a point of a shore urban, metres. */
export const URBAN_REACH_M = 20;
const URBAN_CELL_M = 8;

/** Where buildings stand near: a coarse grid of the battlefield, built once per terrain. */
export interface UrbanGrid {
  /** Whether a building stands within about `URBAN_REACH_M` of (x, y). */
  at(x: number, y: number): boolean;
}

const grids = new WeakMap<TerrainDataset, UrbanGrid>();

export function urbanGrid(terrain: TerrainDataset): UrbanGrid {
  const cached = grids.get(terrain);
  if (cached) return cached;
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const cols = Math.max(1, Math.ceil(((columns - 1) * cellSize) / URBAN_CELL_M) + 1);
  const rws = Math.max(1, Math.ceil(((rows - 1) * cellSize) / URBAN_CELL_M) + 1);
  const cells = new Uint8Array(cols * rws);
  for (const b of terrain.features.buildings) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of b.footprint) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    // Every cell within reach of the footprint's box (a little generous at its corners).
    const c0 = Math.max(0, Math.floor((minX - URBAN_REACH_M - originX) / URBAN_CELL_M));
    const c1 = Math.min(cols - 1, Math.floor((maxX + URBAN_REACH_M - originX) / URBAN_CELL_M));
    const r0 = Math.max(0, Math.floor((minY - URBAN_REACH_M - originY) / URBAN_CELL_M));
    const r1 = Math.min(rws - 1, Math.floor((maxY + URBAN_REACH_M - originY) / URBAN_CELL_M));
    for (let r = r0; r <= r1; r += 1) cells.fill(1, r * cols + c0, r * cols + c1 + 1);
  }
  const grid: UrbanGrid = {
    at(x, y) {
      const c = Math.floor((x - originX) / URBAN_CELL_M);
      const r = Math.floor((y - originY) / URBAN_CELL_M);
      if (c < 0 || r < 0 || c >= cols || r >= rws) return false;
      return cells[r * cols + c] === 1;
    },
  };
  grids.set(terrain, grid);
  return grid;
}

/** The share of a ring's length (sampled every 10 m) that is urban, 0–1. */
export function urbanShare(ring: readonly Vec2[], urban: UrbanGrid): number {
  let total = 0;
  let built = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length] ?? a;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 10));
    for (let k = 0; k < n; k += 1) {
      const t = (k + 0.5) / n;
      total += 1;
      if (urban.at(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y))) built += 1;
    }
  });
  return total > 0 ? built / total : 0;
}
