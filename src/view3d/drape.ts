import { ShapeUtils, Vector2 } from 'three';
import type { TerrainDataset, Vec2 } from '#sim';
import { terrainNormals } from './terrain-mesh';

// Draping flat map shapes on the simulated ground (docs/adr/0030). A shape is
// cut along the terrain's own triangles (the 10 m cells, each split along its
// south-west to north-east diagonal, as `heightAt` interpolates), so every
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

  /** Emits a convex piece lying in one terrain triangle of cell (c, r). */
  const emit = (
    piece: readonly number[],
    c: number,
    r: number,
    lower: boolean,
    offset: number,
    out: MeshBuffers,
    color: Rgb | undefined,
  ) => {
    if (piece.length < 6) return;
    const area = signedArea(piece);
    if (Math.abs(area) < MIN_PIECE_AREA) return;
    const sw = r * columns + c;
    const se = sw + 1;
    const nw = sw + columns;
    const ne = nw + 1;
    const zsw = elevation(sw);
    const zse = elevation(se);
    const znw = elevation(nw);
    const zne = elevation(ne);
    const x0 = ox + c * cs;
    const y0 = oy + r * cs;
    const n = piece.length / 2;
    const vx: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const x = piece[2 * i] ?? 0;
      const y = piece[2 * i + 1] ?? 0;
      const u = (x - x0) / cs;
      const v = (y - y0) / cs;
      // The plane of this triangle, exactly as `heightAt` evaluates it, and
      // barycentric weights for the corner normals.
      let z: number;
      let w0: number;
      let w1: number;
      let w2: number;
      let i1: number;
      let i2: number;
      if (lower) {
        z = zsw + u * (zse - zsw) + v * (zne - zse);
        w0 = 1 - u;
        w1 = u - v;
        w2 = v;
        i1 = se;
        i2 = ne;
      } else {
        z = zsw + v * (znw - zsw) + u * (zne - znw);
        w0 = 1 - v;
        w1 = u;
        w2 = v - u;
        i1 = ne;
        i2 = nw;
      }
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (const [w, k] of [
        [w0, sw],
        [w1, i1],
        [w2, i2],
      ] as const) {
        nx += w * (normals[k * 3] ?? 0);
        ny += w * (normals[k * 3 + 1] ?? 1);
        nz += w * (normals[k * 3 + 2] ?? 0);
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      vx.push(x, z + offset, -y, nx / len, ny / len, nz / len);
    }
    // Fan triangles, counter-clockwise seen from above (which stays
    // counter-clockwise seen from +Y in Three.js axes: see axes.ts).
    const order = area > 0 ? (k: number) => k : (k: number) => n - 1 - k;
    for (let k = 1; k < n - 1; k += 1) {
      const tri = [order(0), order(k), order(k + 1)];
      const [i0 = 0, i1 = 0, i2 = 0] = tri;
      const ax = piece[2 * i0] ?? 0;
      const ay = piece[2 * i0 + 1] ?? 0;
      const twice =
        ((piece[2 * i1] ?? 0) - ax) * ((piece[2 * i2 + 1] ?? 0) - ay) -
        ((piece[2 * i2] ?? 0) - ax) * ((piece[2 * i1 + 1] ?? 0) - ay);
      // Cutting can repeat a corner; such a triangle has no area and is left out.
      if (twice <= 1e-9) continue;
      for (const idx of tri) {
        const b = idx * 6;
        out.positions.push(vx[b] ?? 0, vx[b + 1] ?? 0, vx[b + 2] ?? 0);
        out.normals.push(vx[b + 3] ?? 0, vx[b + 4] ?? 0, vx[b + 5] ?? 0);
        if (out.colors && color) out.colors.push(color[0], color[1], color[2]);
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
        // South-east triangle (SW, SE, NE): (x − x0) ≥ (y − y0); north-west: the rest.
        emit(clip(cell, 1, -1, y0 - x0), c, r, true, offset, out, color);
        emit(clip(cell, -1, 1, x0 - y0), c, r, false, offset, out, color);
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
