import type { Heightfield, TerrainDataset, TerrainRefinement } from './terrain';

// The terrain surface (docs/adr/0032): the one piecewise-linear ground every
// system uses, simulation and display alike. It is the heightfield's cells,
// each split along its south-west to north-east diagonal, except where the
// terrain is refined: there a cell is a finer grid of its own, split the same
// way. Everything here is shared by `heightAt`, the sight tracers, the 3D
// mesh and the 2D contours, so no system computes the ground its own way.

/** Lookup structure for a refinement: which cells are refined, and where their samples are. */
export interface RefinementIndex {
  readonly factor: number;
  /** Per coarse cell (`r * (columns − 1) + c`): its slot in `samples`, or −1 when not refined. */
  readonly slot: Int32Array;
  readonly samples: ArrayLike<number>;
}

const indexes = new WeakMap<TerrainRefinement, RefinementIndex>();

/** The refinement's lookup structure (built once per refinement), or null when the terrain has none. */
export function refinementIndex(terrain: TerrainDataset): RefinementIndex | null {
  const ref = terrain.refinement;
  if (!ref) return null;
  let index = indexes.get(ref);
  if (!index) {
    const { columns, rows } = terrain.heightfield;
    const slot = new Int32Array((columns - 1) * (rows - 1)).fill(-1);
    ref.cells.forEach((cell, k) => {
      slot[cell] = k;
    });
    index = { factor: ref.factor, slot, samples: ref.samples };
    indexes.set(ref, index);
  }
  return index;
}

/**
 * The surface's elevation at (x, y), which must lie on the terrain: linear
 * on the cell's triangle, or on the fine triangle of a refined cell. The one
 * implementation of the surface; `heightAt` and the fast sight tracer both
 * call it (with the same values, possibly in a typed copy).
 */
export function sampleSurface(
  h: Pick<Heightfield, 'originX' | 'originY' | 'cellSize' | 'columns' | 'rows'>,
  elevations: ArrayLike<number>,
  ref: RefinementIndex | null,
  x: number,
  y: number,
): number {
  const { originX, originY, cellSize, columns, rows } = h;
  const gx = (x - originX) / cellSize;
  const gy = (y - originY) / cellSize;
  // The last row/column of samples belongs to the cell below/left of it.
  const c = Math.min(Math.floor(gx), columns - 2);
  const r = Math.min(Math.floor(gy), rows - 2);
  const u = gx - c;
  const v = gy - r;
  if (ref) {
    const slot = ref.slot[r * (columns - 1) + c] ?? -1;
    if (slot >= 0) {
      const k = ref.factor;
      const n1 = k + 1;
      const fu = u * k;
      const fv = v * k;
      const i = Math.min(Math.max(Math.floor(fu), 0), k - 1);
      const j = Math.min(Math.max(Math.floor(fv), 0), k - 1);
      const uu = fu - i;
      const vv = fv - j;
      const o = slot * n1 * n1 + j * n1 + i;
      const s = ref.samples;
      const sw = s[o] ?? Number.NaN;
      const se = s[o + 1] ?? Number.NaN;
      const nw = s[o + n1] ?? Number.NaN;
      const ne = s[o + n1 + 1] ?? Number.NaN;
      return uu >= vv ? sw + uu * (se - sw) + vv * (ne - se) : sw + vv * (nw - sw) + uu * (ne - nw);
    }
  }
  const o = r * columns + c;
  const sw = elevations[o] ?? Number.NaN;
  const se = elevations[o + 1] ?? Number.NaN;
  const nw = elevations[o + columns] ?? Number.NaN;
  const ne = elevations[o + columns + 1] ?? Number.NaN;
  return u >= v
    ? sw + u * (se - sw) + v * (ne - se) // south-east triangle: SW, SE, NE
    : sw + v * (nw - sw) + u * (ne - nw); // north-west triangle: SW, NE, NW
}

/** Whether the point lies in a refined cell (the cell `heightAt` would use). */
export function isRefinedAt(
  h: Pick<Heightfield, 'originX' | 'originY' | 'cellSize' | 'columns' | 'rows'>,
  ref: RefinementIndex,
  x: number,
  y: number,
): boolean {
  const c = Math.min(Math.floor((x - h.originX) / h.cellSize), h.columns - 2);
  const r = Math.min(Math.floor((y - h.originY) / h.cellSize), h.rows - 2);
  if (c < 0 || r < 0) return false;
  return (ref.slot[r * (h.columns - 1) + c] ?? -1) >= 0;
}

/**
 * A fast elevation function for one terrain, with the samples copied into
 * typed arrays: exactly `heightAt` (the same arithmetic on the same values),
 * without its checks. For callers that sample a great deal (sight tracers,
 * mesh builders); (x, y) must lie on the terrain.
 */
export function surfaceSampler(terrain: TerrainDataset): (x: number, y: number) => number {
  const h = terrain.heightfield;
  const elevations = Float64Array.from(h.elevations);
  const index = refinementIndex(terrain);
  const ref = index ? { ...index, samples: Float64Array.from(index.samples) } : null;
  return (x, y) => sampleSurface(h, elevations, ref, x, y);
}

/** The terrain surface as a triangle mesh, in battlefield coordinates. */
export interface SurfaceMesh {
  /** x, y, z per vertex. The first `columns × rows` are the heightfield's samples, in order. */
  readonly positions: Float64Array;
  /** Three vertex indices per triangle, counter-clockwise seen from above. */
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  /** The battlefield's outline, counter-clockwise from the south-west corner (vertex indices). */
  readonly boundary: Uint32Array;
}

/**
 * A growable typed array: values appended without a JavaScript array behind
 * them (on a large refined battlefield, millions of values: docs/adr/0045).
 */
class Growable<T extends Float64Array | Uint32Array> {
  length = 0;
  private data: T;
  private readonly make: (n: number) => T;
  constructor(initial: T, make: (n: number) => T) {
    this.data = initial;
    this.make = make;
  }
  private room(n: number): void {
    if (this.length + n <= this.data.length) return;
    const next = this.make(Math.max(this.data.length * 2, this.length + n));
    next.set(this.data);
    this.data = next;
  }
  push(a: number): void {
    this.room(1);
    this.data[this.length] = a;
    this.length += 1;
  }
  push3(a: number, b: number, c: number): void {
    this.room(3);
    const d = this.data;
    const i = this.length;
    d[i] = a;
    d[i + 1] = b;
    d[i + 2] = c;
    this.length = i + 3;
  }
  at(i: number): number | undefined {
    return i < this.length ? this.data[i] : undefined;
  }
  /** The values, in a typed array of their own length. */
  done(): T {
    return this.data.slice(0, this.length) as T;
  }
}

const meshes = new WeakMap<TerrainDataset, SurfaceMesh>();

/**
 * The exact triangulation of the surface: the coarse cells' two triangles,
 * and in refined cells the fine cells' two triangles each. An unrefined cell
 * next to a refined one has the fine samples along their shared edge as
 * vertices too (its triangle is fanned from its centre), so the mesh has no
 * cracks or T-junctions. Interpolating this mesh linearly gives `heightAt`.
 * Built once per terrain (the 2D map, the 3D mesh and its edge all use it;
 * on a large refined battlefield it has millions of vertices, docs/adr/0045).
 */
export function surfaceMesh(terrain: TerrainDataset): SurfaceMesh {
  let mesh = meshes.get(terrain);
  if (!mesh) {
    mesh = buildSurfaceMesh(terrain);
    meshes.set(terrain, mesh);
  }
  return mesh;
}

function buildSurfaceMesh(terrain: TerrainDataset): SurfaceMesh {
  const { originX, originY, cellSize, columns, rows, elevations } = terrain.heightfield;
  const ref = refinementIndex(terrain);
  const k = ref?.factor ?? 1;
  const n1 = k + 1;
  const fine = cellSize / k;
  const fineColumns = (columns - 1) * k + 1;
  const base = columns * rows;
  const positions = new Growable(
    new Float64Array(base * 3 * (ref ? 2 : 1)),
    (n) => new Float64Array(n),
  );
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      positions.push3(
        originX + c * cellSize,
        originY + r * cellSize,
        elevations[r * columns + c] ?? 0,
      );
    }
  }
  let count = columns * rows;
  // Fine vertices by fine node (+1, so 0 is none): only when refined.
  const fineVertices = new Int32Array(ref ? fineColumns * ((rows - 1) * k + 1) : 0);
  /** The vertex at fine node (fi, fj), with elevation z (new unless it is a coarse sample). */
  const vertex = (fi: number, fj: number, z: number): number => {
    if (fi % k === 0 && fj % k === 0) return (fj / k) * columns + fi / k;
    const key = fj * fineColumns + fi;
    const known = fineVertices[key] ?? 0;
    if (known > 0) return known - 1;
    const v = count;
    count += 1;
    positions.push3(originX + fi * fine, originY + fj * fine, z);
    fineVertices[key] = v + 1;
    return v;
  };
  const slotOf = (c: number, r: number) =>
    ref && c >= 0 && r >= 0 && c < columns - 1 && r < rows - 1
      ? (ref.slot[r * (columns - 1) + c] ?? -1)
      : -1;
  const sample = (slot: number, i: number, j: number) =>
    ref?.samples[slot * n1 * n1 + j * n1 + i] ?? 0;

  const indices = new Growable(new Uint32Array(base * 6), (n) => new Uint32Array(n));
  /** Fans a convex outline (counter-clockwise) from a new vertex at its triangle's centroid. */
  const fan = (outline: number[], a: number, b: number, c: number) => {
    const v = count;
    count += 1;
    for (let d = 0; d < 3; d += 1) {
      positions.push(
        ((positions.at(a * 3 + d) ?? 0) +
          (positions.at(b * 3 + d) ?? 0) +
          (positions.at(c * 3 + d) ?? 0)) /
          3,
      );
    }
    for (let e = 0; e < outline.length; e += 1) {
      indices.push3(v, outline[e] ?? 0, outline[(e + 1) % outline.length] ?? 0);
    }
  };

  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < columns - 1; c += 1) {
      const slot = slotOf(c, r);
      if (slot >= 0) {
        for (let j = 0; j < k; j += 1) {
          for (let i = 0; i < k; i += 1) {
            const fi = c * k + i;
            const fj = r * k + j;
            const sw = vertex(fi, fj, sample(slot, i, j));
            const se = vertex(fi + 1, fj, sample(slot, i + 1, j));
            const nw = vertex(fi, fj + 1, sample(slot, i, j + 1));
            const ne = vertex(fi + 1, fj + 1, sample(slot, i + 1, j + 1));
            indices.push3(sw, se, ne);
            indices.push3(sw, ne, nw);
          }
        }
        continue;
      }
      const sw = r * columns + c;
      const se = sw + 1;
      const nw = sw + columns;
      const ne = nw + 1;
      // Fine samples on the edges shared with refined neighbours, in order along each edge.
      const edge = (neighbour: number, nodes: (m: number) => [number, number, number, number]) => {
        const out: number[] = [];
        if (neighbour < 0) return out;
        for (let m = 1; m < k; m += 1) {
          const [fi, fj, i, j] = nodes(m);
          out.push(vertex(fi, fj, sample(neighbour, i, j)));
        }
        return out;
      };
      const south = edge(slotOf(c, r - 1), (m) => [c * k + m, r * k, m, k]);
      const east = edge(slotOf(c + 1, r), (m) => [(c + 1) * k, r * k + m, 0, m]);
      const north = edge(slotOf(c, r + 1), (m) => [c * k + k - m, (r + 1) * k, k - m, 0]);
      const west = edge(slotOf(c - 1, r), (m) => [c * k, r * k + k - m, k, k - m]);
      if (south.length + east.length === 0) indices.push3(sw, se, ne);
      else fan([sw, ...south, se, ...east, ne], sw, se, ne);
      if (north.length + west.length === 0) indices.push3(sw, ne, nw);
      else fan([sw, ne, ...north, nw, ...west], sw, ne, nw);
    }
  }

  // The outline: along the south edge, up the east, back along the north, down the west.
  const boundary: number[] = [];
  const along = (
    cells: [number, number][],
    fineNodes: (c: number, r: number, m: number) => [number, number, number, number],
    corner: (c: number, r: number) => number,
  ) => {
    for (const [c, r] of cells) {
      boundary.push(corner(c, r));
      const slot = slotOf(c, r);
      if (slot < 0) continue;
      for (let m = 1; m < k; m += 1) {
        const [fi, fj, i, j] = fineNodes(c, r, m);
        boundary.push(vertex(fi, fj, sample(slot, i, j)));
      }
    }
  };
  along(
    Array.from({ length: columns - 1 }, (_, c) => [c, 0]),
    (c, _r, m) => [c * k + m, 0, m, 0],
    (c) => c,
  );
  along(
    Array.from({ length: rows - 1 }, (_, r) => [columns - 2, r]),
    (c, r, m) => [(c + 1) * k, r * k + m, k, m],
    (_c, r) => r * columns + columns - 1,
  );
  along(
    Array.from({ length: columns - 1 }, (_, i) => [columns - 2 - i, rows - 2]),
    (c, r, m) => [(c + 1) * k - m, (r + 1) * k, k - m, k],
    (c, r) => (r + 1) * columns + c + 1,
  );
  along(
    Array.from({ length: rows - 1 }, (_, i) => [0, rows - 2 - i]),
    (_c, r, m) => [0, (r + 1) * k - m, 0, k - m],
    (_c, r) => (r + 1) * columns,
  );

  return {
    positions: positions.done(),
    indices: indices.done(),
    vertexCount: count,
    boundary: Uint32Array.from(boundary),
  };
}
