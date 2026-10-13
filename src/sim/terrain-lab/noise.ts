// Deterministic noise for the terrain lab (docs/ground-level-terrain-architecture-research.md §5.2).
//
// Only integer hashing (Math.imul, shifts) and + − × ÷, Math.floor: operations
// IEEE 754 and ECMAScript define exactly, so every engine gives the same bits.
// No Math.sin, cos, exp or pow, whose results each engine may approximate.

/** A 32-bit hash of two integers and a seed. */
export function hash2(ix: number, iy: number, seed: number): number {
  let h =
    Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A hash in [0, 1). */
export function hash01(ix: number, iy: number, seed: number): number {
  return hash2(ix, iy, seed) / 4294967296;
}

/** The 8 gradient directions, unit length (diagonals are 1/√2 exactly as stored doubles). */
const D = Math.SQRT1_2;
const GX = [1, D, 0, -D, -1, -D, 0, D];
const GY = [0, D, 1, D, 0, -D, -1, -D];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function corner(ix: number, iy: number, seed: number, dx: number, dy: number): number {
  const g = hash2(ix, iy, seed) & 7;
  return (GX[g] ?? 0) * dx + (GY[g] ?? 0) * dy;
}

/** Gradient noise at (x, y) in units of its wavelength: about [−1, 1], 0 at integer points. */
export function gradientNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fade(fx);
  const v = fade(fy);
  const n00 = corner(ix, iy, seed, fx, fy);
  const n10 = corner(ix + 1, iy, seed, fx - 1, fy);
  const n01 = corner(ix, iy + 1, seed, fx, fy - 1);
  const n11 = corner(ix + 1, iy + 1, seed, fx - 1, fy - 1);
  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  // Scaled so the extremes come near ±1.
  return 1.4142 * (a + v * (b - a));
}

/** Smooth step from 0 at `a` to 1 at `b` (a < b). */
export function smoothstep(a: number, b: number, x: number): number {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth minimum: like Math.min, rounded over `k` (≥ 0). */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const d = a - b;
  const h = k - (d < 0 ? -d : d);
  const m = a < b ? a : b;
  if (h <= 0) return m;
  const q = h / k;
  return m - q * q * k * 0.25;
}

/** Polynomial smooth maximum. */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}
