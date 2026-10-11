import { terrainTriangleIndices, type TerrainDataset } from '#sim';

// The 3D terrain mesh (docs/adr/0006, docs/adr/0008, docs/adr/0029): exactly
// the simulated ground. Its vertices are the heightfield's samples, unchanged,
// and its triangles are `terrainTriangleIndices`, the same triangles `heightAt`
// interpolates on, so the drawn surface and the simulated one are the same
// piecewise-linear surface. Normals and colours only shade it; they never move
// it. Pure (no Three.js), so it can move to a worker or be cut into tiles later.

export interface TerrainMeshData {
  /** Three.js positions (x, elevation, −y), three per vertex, one vertex per sample. */
  readonly positions: Float32Array;
  /** Smooth unit normals for shading, in Three.js axes. */
  readonly normals: Float32Array;
  /** Linear-sRGB colours (0–1), three per vertex, when tints were given. */
  readonly colors: Float32Array | null;
  /** `terrainTriangleIndices`, unchanged. */
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
function srgbToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The terrain as mesh data. `tints`, if given, is an sRGB colour per sample in
 * heightfield order (row-major from the south-west corner), three or four
 * bytes per sample (`channels`).
 */
export function terrainMesh(
  terrain: TerrainDataset,
  tints?: { readonly data: ArrayLike<number>; readonly channels: 3 | 4 },
): TerrainMeshData {
  const { originX, originY, cellSize, columns, rows, elevations } = terrain.heightfield;
  const count = columns * rows;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = tints ? new Float32Array(count * 3) : null;
  const at = (c: number, r: number) =>
    elevations[
      Math.min(Math.max(r, 0), rows - 1) * columns + Math.min(Math.max(c, 0), columns - 1)
    ] ?? 0;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const i = r * columns + c;
      const z = elevations[i] ?? 0;
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      // (x, y, z) → Three.js (x, z, −y); see axes.ts.
      positions[i * 3] = originX + c * cellSize;
      positions[i * 3 + 1] = z;
      positions[i * 3 + 2] = -(originY + r * cellSize);
      // Central differences (one-sided at the edges): the surface normal
      // (−dz/dx, −dz/dy, 1), normalised, then into Three.js axes.
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
      if (colors && tints) {
        const t = i * tints.channels;
        colors[i * 3] = srgbToLinear(tints.data[t] ?? 0);
        colors[i * 3 + 1] = srgbToLinear(tints.data[t + 1] ?? 0);
        colors[i * 3 + 2] = srgbToLinear(tints.data[t + 2] ?? 0);
      }
    }
  }
  const indices = Uint32Array.from(terrainTriangleIndices(terrain));
  return {
    positions,
    normals,
    colors,
    indices,
    vertexCount: count,
    triangleCount: indices.length / 3,
    bounds: {
      minX: originX,
      maxX: originX + (columns - 1) * cellSize,
      minY: originY,
      maxY: originY + (rows - 1) * cellSize,
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
 * the terrain and the apron. Their top vertices are the terrain's own edge
 * vertices, so there are no cracks. Two triangles per edge cell, drawn from
 * both sides.
 */
export function skirtMesh(
  terrain: TerrainDataset,
  baseZ: number,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const { originX, originY, cellSize, columns, rows, elevations } = terrain.heightfield;
  /** The boundary walked counter-clockwise from the south-west corner, with each side's outward normal. */
  const sides: { cells: [number, number][]; normal: [number, number, number] }[] = [
    { cells: Array.from({ length: columns }, (_, c) => [c, 0]), normal: [0, 0, 1] },
    { cells: Array.from({ length: rows }, (_, r) => [columns - 1, r]), normal: [1, 0, 0] },
    {
      cells: Array.from({ length: columns }, (_, c) => [columns - 1 - c, rows - 1]),
      normal: [0, 0, -1],
    },
    { cells: Array.from({ length: rows }, (_, r) => [0, rows - 1 - r]), normal: [-1, 0, 0] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const { cells, normal } of sides) {
    const first = positions.length / 3;
    for (const [c, r] of cells) {
      const x = originX + c * cellSize;
      const z = -(originY + r * cellSize);
      positions.push(x, elevations[r * columns + c] ?? 0, z, x, baseZ, z);
      normals.push(...normal, ...normal);
    }
    for (let k = 0; k < cells.length - 1; k += 1) {
      const top = first + 2 * k;
      indices.push(top, top + 1, top + 2, top + 2, top + 1, top + 3);
    }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
  };
}
