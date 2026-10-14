import type { Vec3 } from '../geometry';
import { emptySample, type Clock, type TerrainField } from './field';

// The sampled surface (research §5.5): the field sampled on a regular lattice
// in 64 m tiles, generated lazily and cached. Piecewise linear, each cell split
// along its south-west to north-east diagonal as the current terrain is
// (docs/adr/0008), so the exact tracer approach of docs/adr/0020 applies.
//
// Level 0 tiles (spacing s, 0.5 m or 1 m) are the simulation's surface.
// Coarser levels (spacing s·2^m, 64·2^m m) sample the same field at a subset
// of the same lattice points: the renderer's level of detail reads them, and
// every one of their samples equals the level 0 sample at that point.

export const TILE_M = 64;
/** Cells per block side for the min/max index. */
export const BLOCK_CELLS = 8;
/** Bytes of material per sample. */
export const MATERIAL_BYTES = 8;

export interface SurfaceTile {
  readonly level: number;
  readonly tx: number;
  readonly ty: number;
  /** Sample spacing, metres. */
  readonly spacing: number;
  /** Cells per side (64 m / spacing at level 0). */
  readonly cells: number;
  /** Samples per row including a one-sample border all round: cells + 3. */
  readonly stride: number;
  /** World position of sample (0, 0) (inside the border). */
  readonly x0: number;
  readonly y0: number;
  /** stride² heights, row-major from the south-west, border included. */
  readonly heights: Float32Array;
  /** stride² × 8 material bytes (see `encodeMaterial`). */
  readonly material: Uint8Array;
  readonly min: number;
  readonly max: number;
  /** Highest sample of each block of BLOCK_CELLS² cells (its edge samples included). */
  readonly blockMax: Float32Array;
  readonly blocks: number;
  /** Generation time, ms. */
  readonly ms: number;
}

export interface SurfaceOptions {
  /** Level 0 sample spacing, metres. */
  readonly spacing: number;
  /** Most tiles kept (least recently used dropped first). */
  readonly capacity?: number;
  /** For generation timings in `stats` (none by default). */
  readonly clock?: Clock;
}

export interface SurfaceStats {
  generated: number;
  generatedMs: number;
  hits: number;
  misses: number;
  evicted: number;
}

export interface TerrainSurface {
  readonly field: TerrainField;
  readonly spacing: number;
  readonly originX: number;
  readonly originY: number;
  /** Cells per tile side at any level. */
  readonly cells: number;
  /** The tile, generated if needed. */
  tile(level: number, tx: number, ty: number): SurfaceTile;
  /** The tile if cached, else null (no generation). */
  peek(level: number, tx: number, ty: number): SurfaceTile | null;
  /** Caches a tile made elsewhere (a worker) from the same field and spacing. */
  adopt(tile: SurfaceTile): void;
  /** Height on the level 0 surface. */
  heightAt(x: number, y: number): number;
  /**
   * The first point where segment a→b goes below the surface, as a fraction
   * t of the segment, or null when it stays above. Exact on the lattice.
   */
  traceSight(a: Vec3, b: Vec3): number | null;
  /** As `traceSight`, visiting every cell (no min/max skipping): the reference. */
  traceSightReference(a: Vec3, b: Vec3): number | null;
  readonly stats: SurfaceStats;
  /** Bytes held by cached tiles. */
  cachedBytes(): number;
  cachedCount(): number;
  clear(): void;
}

const enc = (v: number, lo: number, hi: number) => {
  const u = (v - lo) / (hi - lo);
  return u <= 0 ? 0 : u >= 1 ? 255 : Math.floor(u * 255 + 0.5);
};

/** Ranges of the encoded distances (metres). */
export const ROAD_EDGE_RANGE = [-4, 12] as const;
export const SHORE_RANGE = [-6, 10] as const;
export const BUILDING_RANGE = [0, 8] as const;
/** The surface code of mapped paved areas (after the road surfaces, 1–5). */
export const PAVED_AREA_SURFACE = 6;
/** Within this of a carriageway (metres) its edge, not a paved area's, is stored. */
export const ROAD_KEEP_M = 2;

/**
 * Generates one tile: every sample is `field.sample` at its lattice point.
 * Material bytes per sample: road edge distance, shore distance, building
 * distance, surface codes (road surface | shore kind << 3 | urban 64 | paved 128), grass, soil,
 * litter, wetness. More than `ROAD_KEEP_M` from a carriageway, a mapped paved
 * area nearer than the road edge takes the road edge's place, with surface
 * `PAVED_AREA_SURFACE` (its outline exact, as a road's). Nearer, the road's
 * edge is kept (exact too), and in a paved area the road counts as built-up
 * (paved shoulders) and the paved flag paves the rest.
 */
export function generateTile(
  field: TerrainField,
  spacing0: number,
  originX: number,
  originY: number,
  level: number,
  tx: number,
  ty: number,
  now: Clock = () => 0,
): SurfaceTile {
  const started = now();
  const spacing = spacing0 * 2 ** level;
  const cells = Math.round(TILE_M / spacing0);
  const size = cells * spacing;
  const stride = cells + 3;
  const x0 = originX + tx * size;
  const y0 = originY + ty * size;
  const heights = new Float32Array(stride * stride);
  const material = new Uint8Array(stride * stride * MATERIAL_BYTES);
  const s = emptySample();
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < stride; r += 1) {
    // Integer lattice index times spacing: the same coordinates at every level.
    const y = originY + (ty * cells + r - 1) * spacing;
    for (let c = 0; c < stride; c += 1) {
      const x = originX + (tx * cells + c - 1) * spacing;
      field.sample(x, y, s);
      const i = r * stride + c;
      const h = Math.fround(s.h);
      heights[i] = h;
      if (r >= 1 && c >= 1 && r <= cells + 1 && c <= cells + 1) {
        if (h < min) min = h;
        if (h > max) max = h;
      }
      const m = i * MATERIAL_BYTES;
      const area = s.roadEdge >= ROAD_KEEP_M && s.pavedEdge < s.roadEdge;
      material[m] = enc(area ? s.pavedEdge : s.roadEdge, ROAD_EDGE_RANGE[0], ROAD_EDGE_RANGE[1]);
      material[m + 1] = enc(s.shore, SHORE_RANGE[0], SHORE_RANGE[1]);
      material[m + 2] = enc(s.building, BUILDING_RANGE[0], BUILDING_RANGE[1]);
      material[m + 3] =
        (area ? PAVED_AREA_SURFACE : s.roadSurface) |
        (s.shoreKind << 3) |
        (s.urban > 0.5 || (!area && s.pavedEdge < 0) ? 64 : 0) |
        (s.paved > 0 && !area ? 128 : 0);
      material[m + 4] = enc(s.grass, 0, 1);
      material[m + 5] = enc(s.soil, 0, 1);
      material[m + 6] = enc(s.litter, 0, 1);
      material[m + 7] = enc(s.wet, 0, 1);
    }
  }
  const blocks = cells / BLOCK_CELLS;
  const blockMax = new Float32Array(blocks * blocks).fill(-Infinity);
  for (let br = 0; br < blocks; br += 1)
    for (let bc = 0; bc < blocks; bc += 1) {
      let m = -Infinity;
      for (let r = br * BLOCK_CELLS; r <= (br + 1) * BLOCK_CELLS; r += 1)
        for (let c = bc * BLOCK_CELLS; c <= (bc + 1) * BLOCK_CELLS; c += 1) {
          const h = heights[(r + 1) * stride + c + 1] ?? -Infinity;
          if (h > m) m = h;
        }
      blockMax[br * blocks + bc] = m;
    }
  return {
    level,
    tx,
    ty,
    spacing,
    cells,
    stride,
    x0,
    y0,
    heights,
    material,
    min,
    max,
    blockMax,
    blocks,
    ms: now() - started,
  };
}

/** FNV-1a (two 32-bit lanes) over a tile's height bits and material bytes. */
export function tileHash(tile: SurfaceTile): string {
  const words = new Uint32Array(tile.heights.buffer, tile.heights.byteOffset, tile.heights.length);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  const mix = (v: number) => {
    a = Math.imul(a ^ v, 0x01000193) >>> 0;
    b = Math.imul(b ^ ((v * 31) >>> 0), 0x01000193) >>> 0;
  };
  for (const w of words) {
    mix(w & 0xffff);
    mix(w >>> 16);
  }
  for (const m of tile.material) mix(m);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

export function createSurface(field: TerrainField, options: SurfaceOptions): TerrainSurface {
  const spacing = options.spacing;
  const capacity = options.capacity ?? 512;
  const cells = Math.round(TILE_M / spacing);
  if (cells % BLOCK_CELLS !== 0 || Math.abs(cells * spacing - TILE_M) > 1e-9)
    throw new RangeError(
      `spacing ${String(spacing)} must divide ${String(TILE_M)} m into blocks of ${String(BLOCK_CELLS)}`,
    );
  const originX = field.bounds.minX;
  const originY = field.bounds.minY;
  const cache = new Map<number, SurfaceTile>();
  const stats: SurfaceStats = { generated: 0, generatedMs: 0, hits: 0, misses: 0, evicted: 0 };
  let bytes = 0;
  // A number per tile (levels < 64, |tx|, |ty| < 2^20): faster than string keys.
  const key = (level: number, tx: number, ty: number) =>
    (level * 2 ** 21 + tx + 2 ** 20) * 2 ** 21 + ty + 2 ** 20;

  const tile = (level: number, tx: number, ty: number): SurfaceTile => {
    const k = key(level, tx, ty);
    const hit = cache.get(k);
    if (hit) {
      stats.hits += 1;
      cache.delete(k);
      cache.set(k, hit);
      return hit;
    }
    stats.misses += 1;
    const t = generateTile(field, spacing, originX, originY, level, tx, ty, options.clock);
    stats.generated += 1;
    stats.generatedMs += t.ms;
    store(k, t);
    return t;
  };

  const store = (k: number, t: SurfaceTile) => {
    const old0 = cache.get(k);
    if (old0) {
      cache.delete(k);
      bytes -= old0.heights.byteLength + old0.material.byteLength + old0.blockMax.byteLength;
    }
    cache.set(k, t);
    bytes += t.heights.byteLength + t.material.byteLength + t.blockMax.byteLength;
    while (cache.size > capacity) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      const old = cache.get(first);
      cache.delete(first);
      if (old) bytes -= old.heights.byteLength + old.material.byteLength + old.blockMax.byteLength;
      stats.evicted += 1;
    }
  };

  // The level 0 tile holding cell (I, J), cached for the last one used.
  let last: SurfaceTile | null = null;
  const tileOfCell = (I: number, J: number): SurfaceTile => {
    const tx = Math.floor(I / cells);
    const ty = Math.floor(J / cells);
    if (last?.tx === tx && last.ty === ty) return last;
    last = tile(0, tx, ty);
    return last;
  };
  /** Height of the plane of cell (I, J)'s triangle containing local (u, v) ∈ [0, 1]². */
  const cellHeight = (t: SurfaceTile, I: number, J: number, u: number, v: number): number => {
    const i = I - t.tx * cells + 1;
    const j = J - t.ty * cells + 1;
    const h = t.heights;
    const s = t.stride;
    const sw = h[j * s + i] ?? 0;
    const se = h[j * s + i + 1] ?? 0;
    const nw = h[(j + 1) * s + i] ?? 0;
    const ne = h[(j + 1) * s + i + 1] ?? 0;
    return u >= v ? sw + u * (se - sw) + v * (ne - se) : sw + v * (nw - sw) + u * (ne - nw);
  };

  /** Height of cell (I, J)'s upper (u ≥ v) or lower triangle's plane at local (u, v). */
  const plane = (
    t: SurfaceTile,
    I: number,
    J: number,
    u: number,
    v: number,
    upper: boolean,
  ): number => {
    const i = I - t.tx * cells + 1;
    const j = J - t.ty * cells + 1;
    const h = t.heights;
    const s = t.stride;
    const sw = h[j * s + i] ?? 0;
    if (upper)
      return (
        sw +
        u * ((h[j * s + i + 1] ?? 0) - sw) +
        v * ((h[(j + 1) * s + i + 1] ?? 0) - (h[j * s + i + 1] ?? 0))
      );
    return (
      sw +
      v * ((h[(j + 1) * s + i] ?? 0) - sw) +
      u * ((h[(j + 1) * s + i + 1] ?? 0) - (h[(j + 1) * s + i] ?? 0))
    );
  };

  const heightAt = (x: number, y: number): number => {
    const gx = (x - originX) / spacing;
    const gy = (y - originY) / spacing;
    const I = Math.floor(gx);
    const J = Math.floor(gy);
    return cellHeight(tileOfCell(I, J), I, J, gx - I, gy - J);
  };

  /**
   * Exact trace: the line is cut at every lattice line and cell diagonal it
   * crosses; on each piece both the line and the surface are linear, so the
   * sign of (line − ground) at the pieces' ends finds the first crossing.
   * With `prune`, tiles and blocks whose highest sample is below the line
   * over their whole stretch are skipped: the surface there is no higher.
   */
  const trace = (a: Vec3, b: Vec3, prune: boolean): number | null => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const zAt = (t: number) => a.z + t * dz;
    // Crossing parameters of the lattice lines K·spacing (K multiple of `step` cells) in (t0, t1).
    const cuts = (t0: number, t1: number, step: number): number[] => {
      const out: number[] = [];
      for (const [p0, d, o] of [
        [a.x, dx, originX],
        [a.y, dy, originY],
      ] as const) {
        if (d === 0) continue;
        const g0 = (p0 + t0 * d - o) / (spacing * step);
        const g1 = (p0 + t1 * d - o) / (spacing * step);
        const lo = Math.min(g0, g1);
        const hi = Math.max(g0, g1);
        for (let k = Math.floor(lo) + 1; k <= Math.ceil(hi) - 1; k += 1) {
          const t = (o + k * step * spacing - p0) / d;
          if (t > t0 && t < t1) out.push(t);
        }
      }
      out.sort((p, q) => p - q);
      return out;
    };
    /** Walks cells over [t0, t1]; returns the hit t or null. */
    const walkCells = (t0: number, t1: number): number | null => {
      const ts = [t0, ...cuts(t0, t1, 1), t1];
      for (let k = 0; k + 1 < ts.length; k += 1) {
        const ta = ts[k] ?? 0;
        const tb = ts[k + 1] ?? 0;
        if (tb <= ta) continue;
        const tm = (ta + tb) / 2;
        const I = Math.floor((a.x + tm * dx - originX) / spacing);
        const J = Math.floor((a.y + tm * dy - originY) / spacing);
        const t = tileOfCell(I, J);
        // The diagonal u = v of this cell splits the stretch in two pieces.
        const pieces = [ta];
        const den = dx - dy;
        if (den !== 0) {
          const td = (originX + I * spacing - (originY + J * spacing) - a.x + a.y) / den;
          if (td > ta && td < tb) pieces.push(td);
        }
        pieces.push(tb);
        for (let p = 0; p + 1 < pieces.length; p += 1) {
          const pa = pieces[p] ?? 0;
          const pb = pieces[p + 1] ?? 0;
          const pm = (pa + pb) / 2;
          const upper =
            (a.x + pm * dx - originX) / spacing - I >= (a.y + pm * dy - originY) / spacing - J;
          // Line minus ground, both linear on the piece, with the piece's own triangle.
          const f = (tt: number) =>
            zAt(tt) -
            plane(
              t,
              I,
              J,
              (a.x + tt * dx - originX) / spacing - I,
              (a.y + tt * dy - originY) / spacing - J,
              upper,
            );
          const fa = f(pa);
          if (fa < 0) return pa;
          const fb = f(pb);
          if (fb < 0) return pa + ((pb - pa) * fa) / (fa - fb);
        }
      }
      return null;
    };
    const walk = (t0: number, t1: number, step: number): number | null => {
      // step: cells per region side (cells for tiles, BLOCK_CELLS for blocks).
      const ts = [t0, ...cuts(t0, t1, step), t1];
      for (let k = 0; k + 1 < ts.length; k += 1) {
        const ta = ts[k] ?? 0;
        const tb = ts[k + 1] ?? 0;
        if (tb <= ta) continue;
        if (prune) {
          const tm = (ta + tb) / 2;
          const I = Math.floor((a.x + tm * dx - originX) / spacing);
          const J = Math.floor((a.y + tm * dy - originY) / spacing);
          const tl = tileOfCell(I, J);
          const top =
            step === cells
              ? tl.max
              : (tl.blockMax[
                  Math.floor((J - tl.ty * cells) / BLOCK_CELLS) * tl.blocks +
                    Math.floor((I - tl.tx * cells) / BLOCK_CELLS)
                ] ?? Infinity);
          if (Math.min(zAt(ta), zAt(tb)) > top) continue;
        }
        const hit = step === cells ? walk(ta, tb, BLOCK_CELLS) : walkCells(ta, tb);
        if (hit !== null) return hit;
      }
      return null;
    };
    return walk(0, 1, cells);
  };

  return {
    field,
    spacing,
    originX,
    originY,
    cells,
    tile,
    peek: (level, tx, ty) => cache.get(key(level, tx, ty)) ?? null,
    adopt(t) {
      store(key(t.level, t.tx, t.ty), t);
    },
    heightAt,
    traceSight: (a, b) => trace(a, b, true),
    traceSightReference: (a, b) => trace(a, b, false),
    stats,
    cachedBytes: () => bytes,
    cachedCount: () => cache.size,
    clear() {
      cache.clear();
      bytes = 0;
      last = null;
    },
  };
}
