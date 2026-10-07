/**
 * Deterministic pseudo-random number generator for the simulation
 * (docs/adr/0007).
 *
 * Algorithm: xoshiro128** (Blackman & Vigna, 2018), 128 bits of state held as
 * four unsigned 32-bit integers, seeded by expanding a 32-bit seed with
 * SplitMix32. It passes the standard statistical test batteries, has a period
 * of 2^128 − 1, needs only 32-bit integer operations (exact in JavaScript via
 * `Math.imul` and `>>> 0`), and its state is four plain numbers, so it
 * snapshots, clones and hashes like any other simulation data.
 * It is not cryptographically secure, and need not be.
 *
 * The state lives in `SimState.rng`; these functions advance it in place.
 */
export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

export const MAX_SEED = 0xffff_ffff;

/** Throws a RangeError unless `seed` is an integer in [0, 2^32 − 1]. */
export function validateSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new RangeError(
      `seed must be an integer in [0, ${String(MAX_SEED)}], got ${String(seed)}`,
    );
  }
}

export function createRngState(seed: number): RngState {
  validateSeed(seed);
  // SplitMix32: golden-ratio increments through the MurmurHash3 finalizer.
  // Spreads similar seeds (0, 1, 2, …) into unrelated, non-zero states.
  let x = seed;
  const next = (): number => {
    x = (x + 0x9e37_79b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85eb_ca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2_ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  const state = { s0: next(), s1: next(), s2: next(), s3: next() };
  // xoshiro must not start from the all-zero state; SplitMix32 cannot produce
  // four consecutive zeros, but guard against it explicitly.
  if ((state.s0 | state.s1 | state.s2 | state.s3) === 0) state.s0 = 1;
  return state;
}

/** Returns the next value as an unsigned 32-bit integer and advances `rng`. */
export function nextUint32(rng: RngState): number {
  const result = Math.imul(rotl(Math.imul(rng.s1, 5), 7), 9) >>> 0;
  const t = (rng.s1 << 9) >>> 0;
  rng.s2 = (rng.s2 ^ rng.s0) >>> 0;
  rng.s3 = (rng.s3 ^ rng.s1) >>> 0;
  rng.s1 = (rng.s1 ^ rng.s2) >>> 0;
  rng.s0 = (rng.s0 ^ rng.s3) >>> 0;
  rng.s2 = (rng.s2 ^ t) >>> 0;
  rng.s3 = rotl(rng.s3, 11);
  return result;
}

/** Returns a float uniformly distributed in [0, 1) and advances `rng`. */
export function nextFloat(rng: RngState): number {
  return nextUint32(rng) / 0x1_0000_0000;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
