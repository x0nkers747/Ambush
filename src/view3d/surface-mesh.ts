import type { MeshData, Rgb } from './drape';

// Textured triangle meshes for the 3D view's buildings (docs/adr/0035): flat
// shaded triangles with texture coordinates, a vertex colour (the tint
// multiplied into the texture) and a texture layer per vertex (an index into
// a texture array; negative for untextured trim). Built in map coordinates
// (x east, y north, z up) and stored in Three.js axes (x, z, −y), like every
// other generated mesh. Pure.

/** Mesh data with texture coordinates and texture layers. */
export interface SurfaceMeshData extends MeshData {
  readonly colors: Float32Array;
  readonly uvs: Float32Array;
  readonly layers: Float32Array;
}

/** A vertex in map coordinates with its texture coordinates. */
export interface SurfaceVertex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly u: number;
  readonly v: number;
}

/** A direction in map coordinates. */
export type Facing = readonly [number, number, number];

export interface SurfaceBuilder {
  /**
   * A triangle, wound so that its front faces `facing` (any direction on the
   * front side). Degenerate triangles are dropped. Returns whether it was kept.
   */
  triangle(
    a: SurfaceVertex,
    b: SurfaceVertex,
    c: SurfaceVertex,
    facing: Facing,
    color: Rgb,
    layer: number,
  ): boolean;
  /** A planar quad a–b–c–d (in order round its edge), as two triangles. */
  quad(
    a: SurfaceVertex,
    b: SurfaceVertex,
    c: SurfaceVertex,
    d: SurfaceVertex,
    facing: Facing,
    color: Rgb,
    layer: number,
  ): void;
  readonly triangleCount: number;
  finish(): SurfaceMeshData;
}

/** Twice a triangle's area below this (m²) counts as degenerate. */
const MIN_DOUBLE_AREA = 1e-6;

/** A Float32Array that grows as values are appended. */
function growable(width: number) {
  let data = new Float32Array(width * 3 * 1024);
  let length = 0;
  return {
    /** Room for one more vertex. */
    reserve() {
      if (length + width > data.length) {
        const next = new Float32Array(data.length * 2);
        next.set(data);
        data = next;
      }
      const at = length;
      length += width;
      return { data, at };
    },
    finish: () => data.slice(0, length),
  };
}

export function surfaceBuilder(): SurfaceBuilder {
  const positions = growable(3);
  const normals = growable(3);
  const colors = growable(3);
  const uvs = growable(2);
  const layers = growable(1);
  let count = 0;
  const push = (p: SurfaceVertex, n: Facing, c: Rgb, layer: number) => {
    let r = positions.reserve();
    r.data[r.at] = p.x;
    r.data[r.at + 1] = p.z;
    r.data[r.at + 2] = -p.y;
    r = normals.reserve();
    r.data[r.at] = n[0];
    r.data[r.at + 1] = n[2];
    r.data[r.at + 2] = -n[1];
    r = colors.reserve();
    r.data[r.at] = c[0];
    r.data[r.at + 1] = c[1];
    r.data[r.at + 2] = c[2];
    r = uvs.reserve();
    r.data[r.at] = p.u;
    r.data[r.at + 1] = p.v;
    r = layers.reserve();
    r.data[r.at] = layer;
  };
  const triangle: SurfaceBuilder['triangle'] = (a, b, c, facing, color, layer) => {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = c.x - a.x;
    const vy = c.y - a.y;
    const vz = c.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > MIN_DOUBLE_AREA)) return false;
    nx /= len;
    ny /= len;
    nz /= len;
    let second = b;
    let third = c;
    if (nx * facing[0] + ny * facing[1] + nz * facing[2] < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      second = c;
      third = b;
    }
    const n: Facing = [nx, ny, nz];
    push(a, n, color, layer);
    push(second, n, color, layer);
    push(third, n, color, layer);
    count += 1;
    return true;
  };
  return {
    triangle,
    quad(a, b, c, d, facing, color, layer) {
      triangle(a, b, c, facing, color, layer);
      triangle(a, c, d, facing, color, layer);
    },
    get triangleCount() {
      return count;
    },
    finish() {
      return {
        positions: positions.finish(),
        normals: normals.finish(),
        colors: colors.finish(),
        uvs: uvs.finish(),
        layers: layers.finish(),
        triangleCount: count,
      };
    },
  };
}
