import { ShapeUtils, Vector2 } from 'three';
import { refinementIndex, type TerrainDataset, type Vec2 } from '#sim';

// Draping flat map shapes on the simulated ground (docs/adr/0030). A shape is
// cut along the terrain's own triangles (the 10 m cells, each split along its
// south-west to north-east diagonal, as `heightAt` interpolates, and in
// refined cells the fine cells, docs/adr/0032), so every
// piece lies inside one terrain triangle, where the ground is a plane. Each
// piece's corners take that plane's elevation plus a small offset, so the
// piece lies exactly on the drawn (and simulated) surface: it can neither
// float above a ridge nor sink into a hollow, however rough the ground.
// Normals are the terrain's own, interpolated, so a road is lit like the
// ground it lies on. Pure (Three.js maths only), so it can run in a worker.

/** Growable, non-indexed triangle buffers in Three.js axes. */
export interface MeshBuffers {
  readonly positions: number[];
  readonly normals: number[];
  /** Linear RGB per vertex, when the mesh is coloured per vertex. */
  readonly colors: number[] | null;
}

/** Finished mesh data: three vertices per triangle, in Three.js axes. */
export interface MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array | null;
  readonly triangleCount: number;
}

export function meshBuffers(colored = false): MeshBuffers {
  return { positions: [], normals: [], colors: colored ? [] : null };
}

export function finishMesh(b: MeshBuffers): MeshData {
  return {
    positions: Float32Array.from(b.positions),
    normals: Float32Array.from(b.normals),
    colors: b.colors ? Float32Array.from(b.colors) : null,
    triangleCount: b.positions.length / 9,
  };
}

/** A linear RGB colour (0–1 per channel). */
export type Rgb = readonly [number, number, number];

export interface Draper {
  readonly terrain: TerrainDataset;
  /**
   * Drapes a convex polygon, given as flat map coordinates [x0, y0, x1, y1, …]
   * in either winding, `offset` metres above the ground. Whatever lies off the
   * terrain is cut away.
   */
  convex(points: readonly number[], offset: number, out: MeshBuffers, color?: Rgb): void;
  /** Drapes a simple polygon with holes (triangulated first). */
  polygon(
    boundary: readonly Vec2[],
    holes: readonly (readonly Vec2[])[],
    offset: number,
    out: MeshBuffers,
    color?: Rgb,
  ): void;
}

/** Keeps the part of a polygon where a·x + b·y + c ≥ 0 (Sutherland–Hodgman, one edge). */
function clip(poly: readonly number[], a: number, b: number, c: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const px = poly[2 * i] ?? 0;
    const py = poly[2 * i + 1] ?? 0;
    const qx = poly[2 * j] ?? 0;
    const qy = poly[2 * j + 1] ?? 0;
    const dp = a * px + b * py + c;
    const dq = a * qx + b * qy + c;
    if (dp >= 0) out.push(px, py);
    if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
      const t = dp / (dp - dq);
      out.push(px + t * (qx - px), py + t * (qy - py));
    }
  }
  return out;
}

function signedArea(poly: readonly number[]): number {
  let area = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    area +=
      (poly[2 * i] ?? 0) * (poly[2 * j + 1] ?? 0) - (poly[2 * j] ?? 0) * (poly[2 * i + 1] ?? 0);
  }
  return area / 2;
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

/** Pieces smaller than this (m²) are dropped: slivers left by cutting along cell edges. */
const MIN_PIECE_AREA = 1e-6;

export function createDraper(
  terrain: TerrainDataset,
  normals: Float32Array = terrainNormals(terrain),
): Draper {
  const { originX: ox, originY: oy, cellSize: cs, columns, rows, elevations } = terrain.heightfield;
  const maxX = ox + (columns - 1) * cs;
  const maxY = oy + (rows - 1) * cs;
  const elevation = (i: number) => elevations[i] ?? 0;

  const ref = refinementIndex(terrain);
  const k = ref?.factor ?? 1;
  const n1 = k + 1;
  const fineSize = cs / k;
  const fineSample = (slot: number, i: number, j: number) =>
    ref?.samples[slot * n1 * n1 + j * n1 + i] ?? 0;

  /**
   * Emits a convex piece lying in one triangle, given the corner elevations
   * of its square (side `size`, south-west corner (x0, y0)) and a normal for
   * each local position (u, v).
   */
  const emitPiece = (
    piece: readonly number[],
    x0: number,
    y0: number,
    size: number,
    corners: readonly [number, number, number, number],
    lower: boolean,
    normalAt: (u: number, v: number) => [number, number, number],
    offset: number,
    out: MeshBuffers,
    color: Rgb | undefined,
  ) => {
    if (piece.length < 6) return;
    const area = signedArea(piece);
    if (Math.abs(area) < MIN_PIECE_AREA) return;
    const [zsw, zse, znw, zne] = corners;
    const n = piece.length / 2;
    const vx: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const x = piece[2 * i] ?? 0;
      const y = piece[2 * i + 1] ?? 0;
      const u = (x - x0) / size;
      const v = (y - y0) / size;
      // The plane of this triangle, exactly as `heightAt` evaluates it.
      const z = lower
        ? zsw + u * (zse - zsw) + v * (zne - zse)
        : zsw + v * (znw - zsw) + u * (zne - znw);
      const [nx, ny, nz] = normalAt(u, v);
      vx.push(x, z + offset, -y, nx, ny, nz);
    }
    // Fan triangles, counter-clockwise seen from above (which stays
    // counter-clockwise seen from +Y in Three.js axes: see axes.ts).
    const order = area > 0 ? (q: number) => q : (q: number) => n - 1 - q;
    for (let q = 1; q < n - 1; q += 1) {
      const tri = [order(0), order(q), order(q + 1)];
      const [i0 = 0, i1 = 0, i2 = 0] = tri;
      const ax = piece[2 * i0] ?? 0;
      const ay = piece[2 * i0 + 1] ?? 0;
      const twice =
        ((piece[2 * i1] ?? 0) - ax) * ((piece[2 * i2 + 1] ?? 0) - ay) -
        ((piece[2 * i2] ?? 0) - ax) * ((piece[2 * i1 + 1] ?? 0) - ay);
      // Cutting can repeat a corner, or leave a sliver thinner than a float32
      // position can tell apart across a 5 km battlefield (0.5 mm); such a
      // triangle is left out.
      const longest = Math.max(
        Math.hypot((piece[2 * i1] ?? 0) - ax, (piece[2 * i1 + 1] ?? 0) - ay),
        Math.hypot((piece[2 * i2] ?? 0) - ax, (piece[2 * i2 + 1] ?? 0) - ay),
        Math.hypot(
          (piece[2 * i2] ?? 0) - (piece[2 * i1] ?? 0),
          (piece[2 * i2 + 1] ?? 0) - (piece[2 * i1 + 1] ?? 0),
        ),
      );
      if (twice <= 1e-9 || twice / longest < 5e-4) continue;
      for (const idx of tri) {
        const b = idx * 6;
        out.positions.push(vx[b] ?? 0, vx[b + 1] ?? 0, vx[b + 2] ?? 0);
        out.normals.push(vx[b + 3] ?? 0, vx[b + 4] ?? 0, vx[b + 5] ?? 0);
        if (out.colors && color) out.colors.push(color[0], color[1], color[2]);
      }
    }
  };

  /** A coarse cell's piece: normals interpolated from the terrain's smooth normals. */
  const emitCoarse = (
    piece: readonly number[],
    c: number,
    r: number,
    lower: boolean,
    offset: number,
    out: MeshBuffers,
    color: Rgb | undefined,
  ) => {
    const sw = r * columns + c;
    const se = sw + 1;
    const nw = sw + columns;
    const ne = nw + 1;
    const blend = (u: number, v: number): [number, number, number] => {
      // Barycentric weights of the corners of this triangle.
      const weights: [number, number][] = lower
        ? [
            [1 - u, sw],
            [u - v, se],
            [v, ne],
          ]
        : [
            [1 - v, sw],
            [u, ne],
            [v - u, nw],
          ];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (const [w, q] of weights) {
        nx += w * (normals[q * 3] ?? 0);
        ny += w * (normals[q * 3 + 1] ?? 1);
        nz += w * (normals[q * 3 + 2] ?? 0);
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      return [nx / len, ny / len, nz / len];
    };
    emitPiece(
      piece,
      ox + c * cs,
      oy + r * cs,
      cs,
      [elevation(sw), elevation(se), elevation(nw), elevation(ne)],
      lower,
      blend,
      offset,
      out,
      color,
    );
  };

  /** A refined cell's part: cut along its fine cells and their diagonals (docs/adr/0032). */
  const emitRefined = (
    cell: readonly number[],
    c: number,
    r: number,
    slot: number,
    offset: number,
    out: MeshBuffers,
    color: Rgb | undefined,
  ) => {
    let xMin = Infinity;
    let xMax = -Infinity;
    for (let i = 0; i < cell.length; i += 2) {
      xMin = Math.min(xMin, cell[i] ?? 0);
      xMax = Math.max(xMax, cell[i] ?? 0);
    }
    const cx0 = ox + c * cs;
    const cy0 = oy + r * cs;
    const i0 = Math.max(0, Math.floor((xMin - cx0) / fineSize));
    const i1 = Math.min(k - 1, Math.floor((xMax - cx0) / fineSize));
    for (let i = i0; i <= i1; i += 1) {
      const x0 = cx0 + i * fineSize;
      const strip = clip(clip(cell, 1, 0, -x0), -1, 0, x0 + fineSize);
      if (strip.length < 6) continue;
      let yMin = Infinity;
      let yMax = -Infinity;
      for (let q = 1; q < strip.length; q += 2) {
        yMin = Math.min(yMin, strip[q] ?? 0);
        yMax = Math.max(yMax, strip[q] ?? 0);
      }
      const j0 = Math.max(0, Math.floor((yMin - cy0) / fineSize));
      const j1 = Math.min(k - 1, Math.floor((yMax - cy0) / fineSize));
      for (let j = j0; j <= j1; j += 1) {
        const y0 = cy0 + j * fineSize;
        const square = clip(clip(strip, 0, 1, -y0), 0, -1, y0 + fineSize);
        if (square.length < 6) continue;
        const corners: [number, number, number, number] = [
          fineSample(slot, i, j),
          fineSample(slot, i + 1, j),
          fineSample(slot, i, j + 1),
          fineSample(slot, i + 1, j + 1),
        ];
        const [zsw, zse, znw, zne] = corners;
        // Each fine triangle is a plane: its own normal (Three.js axes).
        const face = (lower: boolean) => {
          const dzdx = (lower ? zse - zsw : zne - znw) / fineSize;
          const dzdy = (lower ? zne - zse : znw - zsw) / fineSize;
          const len = Math.hypot(dzdx, dzdy, 1);
          const nrm: [number, number, number] = [-dzdx / len, 1 / len, dzdy / len];
          return () => nrm;
        };
        emitPiece(
          clip(square, 1, -1, y0 - x0),
          x0,
          y0,
          fineSize,
          corners,
          true,
          face(true),
          offset,
          out,
          color,
        );
        emitPiece(
          clip(square, -1, 1, x0 - y0),
          x0,
          y0,
          fineSize,
          corners,
          false,
          face(false),
          offset,
          out,
          color,
        );
      }
    }
  };

  const convex: Draper['convex'] = (points, offset, out, color) => {
    let poly = clip(points, 1, 0, -ox);
    poly = clip(poly, -1, 0, maxX);
    poly = clip(poly, 0, 1, -oy);
    poly = clip(poly, 0, -1, maxY);
    if (poly.length < 6) return;
    let xMin = Infinity;
    let xMax = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      xMin = Math.min(xMin, poly[i] ?? 0);
      xMax = Math.max(xMax, poly[i] ?? 0);
    }
    const c0 = Math.max(0, Math.floor((xMin - ox) / cs));
    const c1 = Math.min(columns - 2, Math.floor((xMax - ox) / cs));
    for (let c = c0; c <= c1; c += 1) {
      const x0 = ox + c * cs;
      const strip = clip(clip(poly, 1, 0, -x0), -1, 0, x0 + cs);
      if (strip.length < 6) continue;
      let yMin = Infinity;
      let yMax = -Infinity;
      for (let i = 1; i < strip.length; i += 2) {
        yMin = Math.min(yMin, strip[i] ?? 0);
        yMax = Math.max(yMax, strip[i] ?? 0);
      }
      const r0 = Math.max(0, Math.floor((yMin - oy) / cs));
      const r1 = Math.min(rows - 2, Math.floor((yMax - oy) / cs));
      for (let r = r0; r <= r1; r += 1) {
        const y0 = oy + r * cs;
        const cell = clip(clip(strip, 0, 1, -y0), 0, -1, y0 + cs);
        if (cell.length < 6) continue;
        const slot = ref ? (ref.slot[r * (columns - 1) + c] ?? -1) : -1;
        if (slot >= 0) {
          emitRefined(cell, c, r, slot, offset, out, color);
          continue;
        }
        // South-east triangle (SW, SE, NE): (x − x0) ≥ (y − y0); north-west: the rest.
        emitCoarse(clip(cell, 1, -1, y0 - x0), c, r, true, offset, out, color);
        emitCoarse(clip(cell, -1, 1, x0 - y0), c, r, false, offset, out, color);
      }
    }
  };

  const polygon: Draper['polygon'] = (boundary, holes, offset, out, color) => {
    const contour = boundary.map((p) => new Vector2(p.x, p.y));
    const holePoints = holes.map((h) => h.map((p) => new Vector2(p.x, p.y)));
    // Triangulation drops a repeated closing point from each ring, so the
    // vertex list is assembled afterwards.
    const faces = ShapeUtils.triangulateShape(contour, holePoints);
    const all = [...contour, ...holePoints.flat()];
    for (const [a, b, c] of faces) {
      const pa = all[a ?? 0];
      const pb = all[b ?? 0];
      const pc = all[c ?? 0];
      if (!pa || !pb || !pc) continue;
      convex([pa.x, pa.y, pb.x, pb.y, pc.x, pc.y], offset, out, color);
    }
  };

  return { terrain, convex, polygon };
}
