import { describe, expect, it } from 'vitest';
import { clonePlainData } from './plain-data';
import { createRngState, MAX_SEED, nextFloat, nextUint32, type RngState } from './rng';

function draw(rng: RngState, count: number): number[] {
  return Array.from({ length: count }, () => nextUint32(rng));
}

describe('xoshiro128**', () => {
  it('matches the reference implementation from state (1, 2, 3, 4)', () => {
    // First outputs of the reference C implementation (prng.di.unimi.it).
    const rng = { s0: 1, s1: 2, s2: 3, s3: 4 };
    expect(draw(rng, 10)).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597,
      4258142804,
    ]);
  });

  it('produces the same sequence for the same seed', () => {
    expect(draw(createRngState(42), 1000)).toEqual(draw(createRngState(42), 1000));
  });

  it('pins the seeded sequence (changing it invalidates recorded seeds)', () => {
    expect(draw(createRngState(0), 4)).toEqual(PINNED_SEED_0);
    expect(draw(createRngState(MAX_SEED), 4)).toEqual(PINNED_SEED_MAX);
  });

  it('produces different sequences for different seeds, including adjacent ones', () => {
    const sequences = [0, 1, 2, 3, 12345, MAX_SEED].map((seed) =>
      draw(createRngState(seed), 8).join(','),
    );
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('resumes identically from a copied state', () => {
    const rng = createRngState(7);
    draw(rng, 100);
    const copy = clonePlainData(rng);
    expect(draw(copy, 100)).toEqual(draw(rng, 100));
  });

  it('keeps state as four unsigned 32-bit integers', () => {
    const rng = createRngState(99);
    for (let i = 0; i < 1000; i += 1) {
      nextUint32(rng);
      for (const word of [rng.s0, rng.s1, rng.s2, rng.s3]) {
        expect(Number.isInteger(word) && word >= 0 && word <= MAX_SEED).toBe(true);
      }
    }
  });

  it('returns floats in [0, 1) with a plausible mean', () => {
    const rng = createRngState(2024);
    let sum = 0;
    for (let i = 0; i < 100_000; i += 1) {
      const f = nextFloat(rng);
      expect(f >= 0 && f < 1).toBe(true);
      sum += f;
    }
    expect(sum / 100_000).toBeCloseTo(0.5, 2);
  });

  it.each([-1, 0.5, MAX_SEED + 1, Number.NaN])('rejects seed %s', (seed) => {
    expect(() => createRngState(seed)).toThrow(RangeError);
  });
});

const PINNED_SEED_0 = [3809008728, 1133695204, 53579671, 2891528803];
const PINNED_SEED_MAX = [835879718, 1921286648, 2356205009, 1885780724];
