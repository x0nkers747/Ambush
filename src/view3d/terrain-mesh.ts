import { heightAt, surfaceMesh, type TerrainDataset } from '#sim';

// The 3D terrain mesh (docs/adr/0006, 0008, 0029, 0032): exactly the
// simulated ground. Its vertices and triangles are the surface's own
// (`surfaceMesh`): the heightfield's samples and, where the terrain is
// refined, the fine samples, on the same triangles `heightAt` interpolates
// on, so the drawn surface and the simulated one are the same
// piecewise-linear surface. Normals and colours only shade it; they never move
// it. Pure (no Three.js), so it can move to a worker or be cut into tiles later.

export interface TerrainMeshData {
  /** Three.js positions (x, elevation, −y), three per vertex: the samples, then refined cells' extra vertices. */
  readonly positions: Float32Array;
  /** Smooth unit normals for shading, in Three.js axes. */
  readonly normals: Float32Array;
  /** Linear-sRGB colours (0–1), three per vertex, when tints were given. */
  readonly colors: Float32Array | null;
  /** The surface's triangles (`surfaceMesh`): the heightfield's cells, and refined cells' fine cells. */
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Extent in battlefield metres. */
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
}

/** sRGB (0–255) to linear (0–1), as Three.js expects for vertex colours. */
export function srgbToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Smooth unit normals for shading, one per sample in heightfield order, in
 * Three.js axes: central differences (one-sided at the edges) give the surface
 * normal (−dz/dx, −dz/dy, 1), normalised, then turned into Three.js axes.
 */
export function terrainNormals(terrain: TerrainDataset): Float32Array {
  const { cellSize, columns, rows, elevations } = terrain.heightfield;
  const normals = new Float32Array(columns * rows * 3);
  const at = (c: number, r: number) =>
    elevations[
      Math.min(Math.max(r, 0), rows - 1) * columns + Math.min(Math.max(c, 0), columns - 1)
    ] ?? 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      const dzdx =
        (at(c + 1, r) - at(c - 1, r)) /
        ((Math.min(c + 1, columns - 1) - Math.max(c - 1, 0)) * cellSize);
      const dzdy =
        (at(c, r + 1) - at(c, r - 1)) /
        ((Math.min(r + 1, rows - 1) - Math.max(r - 1, 0)) * cellSize);
      const length = Math.hypot(dzdx, dzdy, 1);
      normals[i * 3] = -dzdx / length;
      normals[i * 3 + 1] = 1 / length;
      normals[i * 3 + 2] = dzdy / length;
    }
  }
  return normals;
}

/**
 * The terrain as mesh data: the surface's own triangulation (`surfaceMesh`),
 * so the mesh is exactly the ground every system uses, refined cells
 * included (docs/adr/0032). `tints`, if given, is an sRGB colour per sample
 * in heightfield order (row-major from the south-west corner), three or four
 * bytes per sample (`channels`); vertices of refined cells take the colour
 * interpolated from their cell's corners.
 */
export function terrainMesh(
  terrain: TerrainDataset,
  tints?: { readonly data: ArrayLike<number>; readonly channels: 3 | 4 },
): TerrainMeshData {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const surface = surfaceMesh(terrain);
  const count = surface.vertexCount;
  const base = columns * rows;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = tints ? new Float32Array(count * 3) : null;
  const baseNormals = terrainNormals(terrain);
  normals.set(baseNormals.subarray(0, base * 3));
  const maxX = originX + (columns - 1) * cellSize;
  const maxY = originY + (rows - 1) * cellSize;
  const fineStep = cellSize / (terrain.refinement?.factor ?? 1);
  const clampX = (x: number) => Math.min(Math.max(x, originX), maxX);
  const clampY = (y: number) => Math.min(Math.max(y, originY), maxY);
  const tint = (i: number, ch: number) => srgbToLinear(tints?.data[i * tints.channels + ch] ?? 0);
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < count; v += 1) {
    const x = surface.positions[v * 3] ?? 0;
    const y = surface.positions[v * 3 + 1] ?? 0;
    const z = surface.positions[v * 3 + 2] ?? 0;
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    // (x, y, z) → Three.js (x, z, −y); see axes.ts.
    positions[v * 3] = x;
    positions[v * 3 + 1] = z;
    positions[v * 3 + 2] = -y;
    if (v >= base) {
      // A refined cell's vertex: its normal from the surface round it.
      const dzdx =
        (heightAt(terrain, clampX(x + fineStep), y) - heightAt(terrain, clampX(x - fineStep), y)) /
        (clampX(x + fineStep) - clampX(x - fineStep));
      const dzdy =
        (heightAt(terrain, x, clampY(y + fineStep)) - heightAt(terrain, x, clampY(y - fineStep))) /
        (clampY(y + fineStep) - clampY(y - fineStep));
      const length = Math.hypot(dzdx, dzdy, 1);
      normals[v * 3] = -dzdx / length;
      normals[v * 3 + 1] = 1 / length;
      normals[v * 3 + 2] = dzdy / length;
    }
    if (colors && tints) {
      if (v < base) {
        for (let ch = 0; ch < 3; ch += 1) colors[v * 3 + ch] = tint(v, ch);
      } else {
        // Bilinear between the cell's corner tints.
        const gx = (x - originX) / cellSize;
        const gy = (y - originY) / cellSize;
        const c = Math.min(Math.floor(gx), columns - 2);
        const r = Math.min(Math.floor(gy), rows - 2);
        const u = gx - c;
        const w = gy - r;
        const i = r * columns + c;
        for (let ch = 0; ch < 3; ch += 1) {
          const bottom = tint(i, ch) + u * (tint(i + 1, ch) - tint(i, ch));
          const top =
            tint(i + columns, ch) + u * (tint(i + columns + 1, ch) - tint(i + columns, ch));
          colors[v * 3 + ch] = bottom + w * (top - bottom);
        }
      }
    }
  }
  return {
    positions,
    normals,
    colors,
    indices: surface.indices,
    vertexCount: count,
    triangleCount: surface.indices.length / 3,
    bounds: {
      minX: originX,
      maxX,
      minY: originY,
      maxY,
      minZ,
      maxZ,
    },
  };
}

/**
 * The battlefield's surroundings: the elevation of a plain "apron" around the
 * battlefield, a little below most of its ground (the 1st percentile, minus a
 * margin), so the battlefield reads as a raised table with clear edges and a
 * low camera never looks into empty space. Decoration only: it is not ground
 * the simulation knows.
 */
export function apronElevation(terrain: TerrainDataset): number {
  const sorted = Float64Array.from(terrain.heightfield.elevations).sort();
  const low = sorted[Math.floor(0.01 * (sorted.length - 1))] ?? 0;
  const { cellSize, columns, rows } = terrain.heightfield;
  const span = Math.max(columns - 1, rows - 1) * cellSize;
  return low - Math.max(2, 0.004 * span);
}

/**
 * Walls from the battlefield's edge down to `baseZ`, closing the gap between
 * the terrain and the apron. Their top vertices are the surface's own
 * outline (fine samples included where cells are refined), so there are no
 * cracks. Two triangles per outline segment, drawn from both sides.
 */
export function skirtMesh(
  terrain: TerrainDataset,
  baseZ: number,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const surface = surfaceMesh(terrain);
  const outline = Array.from(surface.boundary);
  const p = surface.positions;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let e = 0; e < outline.length; e += 1) {
    const a = outline[e] ?? 0;
    const b = outline[(e + 1) % outline.length] ?? 0;
    const ax = p[a * 3] ?? 0;
    const ay = p[a * 3 + 1] ?? 0;
    const bx = p[b * 3] ?? 0;
    const by = p[b * 3 + 1] ?? 0;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    // Outward, to the right of a counter-clockwise outline: (dy, −dx), in Three.js axes.
    const n = [(by - ay) / len, 0, (bx - ax) / len];
    const first = positions.length / 3;
    positions.push(
      ax,
      p[a * 3 + 2] ?? 0,
      -ay,
      ax,
      baseZ,
      -ay,
      bx,
      p[b * 3 + 2] ?? 0,
      -by,
      bx,
      baseZ,
      -by,
    );
    for (let k = 0; k < 4; k += 1) normals.push(...n);
    indices.push(first, first + 1, first + 2, first + 2, first + 1, first + 3);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
  };
}
