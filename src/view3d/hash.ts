// Stable hashes for the 3D view's deterministic variation (docs/adr/0030):
// building colours, ground texture noise. They depend only on their input
// (a feature id, a grid position), never on time, random numbers or the order
// in which features were loaded, so the same battlefield always looks the same.

/** 32-bit FNV-1a of a string's UTF-16 code units. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A well-mixed 32-bit hash of two integers and a seed (e.g. a grid column and row). */
export function hashInts(a: number, b: number, seed = 0): number {
  let h =
    Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A hash as a number in [0, 1). */
export function unit(hash: number): number {
  return hash / 4294967296;
}

/**
 * Smooth value noise in [−1, 1] at map point (x, y), varying over about
 * `scale` metres: hashed lattice values, smoothly interpolated.
 */
export function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const v00 = unit(hashInts(ix, iy, seed));
  const v10 = unit(hashInts(ix + 1, iy, seed));
  const v01 = unit(hashInts(ix, iy + 1, seed));
  const v11 = unit(hashInts(ix + 1, iy + 1, seed));
  const top = v00 + sx * (v10 - v00);
  const bottom = v01 + sx * (v11 - v01);
  return (top + sy * (bottom - top)) * 2 - 1;
}

/**
 * `valueNoise` for many points of one rectangle (min to max, metres): the
 * lattice values are hashed once, so each point costs only the interpolation.
 * The same values as `valueNoise`; points outside the rectangle fall back to it.
 */
export class NoiseField {
  private readonly ix0: number;
  private readonly iy0: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly lattice: Float64Array;
  private readonly scale: number;
  private readonly seed: number;

  constructor(minX: number, minY: number, maxX: number, maxY: number, scale: number, seed: number) {
    this.scale = scale;
    this.seed = seed;
    this.ix0 = Math.floor(minX / scale);
    this.iy0 = Math.floor(minY / scale);
    this.nx = Math.floor(maxX / scale) - this.ix0 + 2;
    this.ny = Math.floor(maxY / scale) - this.iy0 + 2;
    this.lattice = new Float64Array(this.nx * this.ny);
    for (let j = 0; j < this.ny; j += 1) {
      for (let i = 0; i < this.nx; i += 1) {
        this.lattice[j * this.nx + i] = unit(hashInts(this.ix0 + i, this.iy0 + j, seed));
      }
    }
  }

  at(x: number, y: number): number {
    const gx = x / this.scale;
    const gy = y / this.scale;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const i = ix - this.ix0;
    const j = iy - this.iy0;
    if (i < 0 || j < 0 || i + 1 >= this.nx || j + 1 >= this.ny) {
      return valueNoise(x, y, this.scale, this.seed);
    }
    const fx = gx - ix;
    const fy = gy - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const k = j * this.nx + i;
    const lattice = this.lattice;
    const v00 = lattice[k] ?? 0;
    const v10 = lattice[k + 1] ?? 0;
    const v01 = lattice[k + this.nx] ?? 0;
    const v11 = lattice[k + this.nx + 1] ?? 0;
    const top = v00 + sx * (v10 - v00);
    const bottom = v01 + sx * (v11 - v01);
    return (top + sy * (bottom - top)) * 2 - 1;
  }
}
