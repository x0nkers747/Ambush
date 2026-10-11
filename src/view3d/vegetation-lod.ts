import { LOD_LEVELS, PLANTS } from './plant-models';
import type { VegetationInstances } from './vegetation-placement';

// Choosing what to draw of the vegetation (docs/adr/0031). Each plant is
// drawn near, medium or far by its distance from the camera; beyond the far
// band it is not drawn at all, and the ground's woodland colour stands for the
// forest. In the far band plants are thinned progressively, by a fixed rank
// per plant, and the ones kept are drawn with wider crowns, so a distant
// forest keeps its cover as it thins and nothing pops in or out in bulk.
// Whole 100 m tiles are skipped when out of view or out of range, so the work
// is proportional to what is visible. Pure: it writes instance matrices and
// colours into buffers the renderer owns. Run when the camera has moved, not
// every frame.

export interface LodSettings {
  /** Ends of the near and medium bands, and the farthest plant drawn, metres. */
  readonly near: number;
  readonly medium: number;
  readonly far: number;
  /** Thinning starts here and keeps `minFraction` of the plants at `far`. */
  readonly thinStart: number;
  readonly minFraction: number;
}

/** The band a plant at `distance` is drawn in (0 near, 1 medium, 2 far), or −1 for none. */
export function lodBand(distance: number, s: LodSettings, lodScale = 1): number {
  if (distance < s.near * lodScale) return 0;
  if (distance < s.medium * lodScale) return 1;
  if (distance < s.far * lodScale) return 2;
  return -1;
}

/** The share of plants kept at `distance` in the far band: 1 up to `thinStart`, then falling to `minFraction`. */
export function keepFraction(distance: number, s: LodSettings, lodScale = 1): number {
  const start = s.thinStart * lodScale;
  const end = s.far * lodScale;
  if (distance <= start) return 1;
  if (distance >= end) return s.minFraction;
  return 1 - ((distance - start) / (end - start)) * (1 - s.minFraction);
}

/** Crowns of thinned plants widen by up to this factor, so cover is kept. */
const MAX_WIDEN = 1.8;

/** Output buffers for one plant in one band. */
export interface LodTarget {
  /** 16 floats per instance: column-major matrices in Three.js axes. */
  readonly matrices: Float32Array;
  /** Three floats per instance. */
  readonly colors: Float32Array;
  /** How many instances fit. */
  readonly capacity: number;
  /** Set by `selectVegetation`: how many were written. */
  count: number;
}

export interface Viewpoint {
  /** Camera position, battlefield metres. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Writes the plants to draw into `targets[plant][band]`. `tileVisible` tells
 * whether a tile can be seen (e.g. a frustum test); it is asked once per tile
 * that is in range.
 */
export function selectVegetation(
  inst: VegetationInstances,
  view: Viewpoint,
  s: LodSettings,
  tileVisible: (tile: number) => boolean,
  targets: readonly (readonly LodTarget[])[],
): { tilesInRange: number; tilesDrawn: number; considered: number } {
  for (const row of targets) for (const t of row) t.count = 0;
  const { tiles } = inst;
  const tileCount = tiles.columns * tiles.rows;
  const maxScale = Math.max(...PLANTS.map((p) => p.lodScale));
  let tilesInRange = 0;
  let tilesDrawn = 0;
  let considered = 0;
  for (let t = 0; t < tileCount; t += 1) {
    const zMin = tiles.zMin[t] ?? Infinity;
    if (zMin === Infinity) continue; // no plants
    const zMax = tiles.zMax[t] ?? zMin;
    const x0 = tiles.originX + (t % tiles.columns) * tiles.size;
    const y0 = tiles.originY + Math.floor(t / tiles.columns) * tiles.size;
    const dx = Math.max(x0 - view.x, 0, view.x - (x0 + tiles.size));
    const dy = Math.max(y0 - view.y, 0, view.y - (y0 + tiles.size));
    const dz = Math.max(zMin - view.z, 0, view.z - zMax);
    const nearest = Math.hypot(dx, dy, dz);
    if (nearest >= s.far * maxScale) continue;
    tilesInRange += 1;
    if (!tileVisible(t)) continue;
    tilesDrawn += 1;
    for (let p = 0; p < PLANTS.length; p += 1) {
      const scale = PLANTS[p]?.lodScale ?? 1;
      if (nearest >= s.far * scale) continue;
      const row = targets[p];
      if (!row) continue;
      // Plants are in rank order: the tile's thinning bounds the run.
      const bound = keepFraction(nearest, s, scale);
      const a = tiles.starts[p * tileCount + t] ?? 0;
      const b = tiles.starts[p * tileCount + t + 1] ?? 0;
      for (let i = a; i < b; i += 1) {
        const rank = inst.rank[i] ?? 0;
        if (rank >= bound) break;
        considered += 1;
        const x = inst.position[i * 3] ?? 0;
        const y = inst.position[i * 3 + 1] ?? 0;
        const z = inst.position[i * 3 + 2] ?? 0;
        const h = (inst.scale[i * 2 + 1] ?? 1) * (PLANTS[p]?.height ?? 1);
        const d = Math.hypot(x - view.x, y - view.y, z + h / 2 - view.z);
        const band = lodBand(d, s, scale);
        if (band < 0) continue;
        let widen = 1;
        if (band === LOD_LEVELS - 1) {
          const keep = keepFraction(d, s, scale);
          if (rank >= keep) continue;
          widen = Math.min(MAX_WIDEN, 1 / Math.sqrt(keep));
        }
        const target = row[band];
        if (!target || target.count >= target.capacity) continue;
        const k = target.count;
        target.count += 1;
        const yaw = inst.yaw[i] ?? 0;
        const c = Math.cos(yaw);
        const sn = Math.sin(yaw);
        const sw = (inst.scale[i * 2] ?? 1) * widen;
        const sh = inst.scale[i * 2 + 1] ?? 1;
        const m = target.matrices;
        const o = k * 16;
        // Scale, then turn about the vertical, then move to (x, z, −y).
        m[o] = c * sw;
        m[o + 1] = 0;
        m[o + 2] = -sn * sw;
        m[o + 3] = 0;
        m[o + 4] = 0;
        m[o + 5] = sh;
        m[o + 6] = 0;
        m[o + 7] = 0;
        m[o + 8] = sn * sw;
        m[o + 9] = 0;
        m[o + 10] = c * sw;
        m[o + 11] = 0;
        m[o + 12] = x;
        m[o + 13] = z;
        m[o + 14] = -y;
        m[o + 15] = 1;
        target.colors[k * 3] = inst.tint[i * 3] ?? 1;
        target.colors[k * 3 + 1] = inst.tint[i * 3 + 1] ?? 1;
        target.colors[k * 3 + 2] = inst.tint[i * 3 + 2] ?? 1;
      }
    }
  }
  return { tilesInRange, tilesDrawn, considered };
}
