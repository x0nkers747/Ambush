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
