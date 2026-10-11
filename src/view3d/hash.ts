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
