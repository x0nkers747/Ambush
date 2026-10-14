// Seeded, stateless noise for personal variation (docs/behavior-lab/03 §6.4):
// a function of (task seed, slot, time) only. It draws nothing from the
// simulation's random numbers, holds no state, and gives the same value at
// every tick rate and in every replay.

/** A 32-bit integer hash of four integers (MurmurHash3's finaliser over a running mix). */
export function hash32(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a ^ 0x9e37_79b9, 0x85eb_ca6b);
  h = mix(h, b);
  h = mix(h, c);
  h = mix(h, d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85eb_ca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2_ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function mix(h: number, v: number): number {
  const k = Math.imul(h ^ (v | 0), 0xcc9e_2d51);
  return Math.imul((k << 15) | (k >>> 17), 0x1b87_3593);
}

/** A value in [−1, 1] for knot `k` of channel `channel`. */
function knot(seed: number, slot: number, k: number, channel: number): number {
  return (hash32(seed, slot, k, channel) / 0xffff_ffff) * 2 - 1;
}

/**
 * Smooth noise in [−1, 1]: knots every `period` seconds, joined by
 * smoothstep (continuous, with zero slope at each knot). Channel 0 and 1
 * are independent.
 */
export function smoothNoise(
  seed: number,
  slot: number,
  channel: number,
  t: number,
  period: number,
): number {
  const x = t / period;
  const k = Math.floor(x);
  const u = x - k;
  const s = u * u * (3 - 2 * u);
  const a = knot(seed, slot, k, channel);
  const b = knot(seed, slot, k + 1, channel);
  return a + (b - a) * s;
}
