import { describe, expect, it } from 'vitest';
import { hitProbabilityAt } from './hit-probability';

// A weapon's hit probability by range.

const TEST_RIFLE = {
  hitProbabilityByRange: [
    { rangeM: 0, probability: 0.5 },
    { rangeM: 100, probability: 0.3 },
    { rangeM: 300, probability: 0.1 },
  ],
  maxEngagementRangeM: 400,
};

describe('hitProbabilityAt', () => {
  it('interpolates linearly between control points', () => {
    expect(hitProbabilityAt(TEST_RIFLE, 50)).toBeCloseTo(0.4, 12);
    expect(hitProbabilityAt(TEST_RIFLE, 25)).toBeCloseTo(0.45, 12);
    expect(hitProbabilityAt(TEST_RIFLE, 200)).toBeCloseTo(0.2, 12);
    expect(hitProbabilityAt(TEST_RIFLE, 250)).toBeCloseTo(0.15, 12);
  });

  it('gives exactly the control point’s probability at its range', () => {
    expect(hitProbabilityAt(TEST_RIFLE, 0)).toBe(0.5);
    expect(hitProbabilityAt(TEST_RIFLE, 100)).toBe(0.3);
    expect(hitProbabilityAt(TEST_RIFLE, 300)).toBe(0.1);
  });

  it('holds the last point’s probability out to the maximum engagement range, and 0 beyond', () => {
    expect(hitProbabilityAt(TEST_RIFLE, 350)).toBe(0.1);
    expect(hitProbabilityAt(TEST_RIFLE, 400)).toBe(0.1);
    expect(hitProbabilityAt(TEST_RIFLE, 400.001)).toBe(0);
    expect(hitProbabilityAt(TEST_RIFLE, 5000)).toBe(0);
    expect(hitProbabilityAt(TEST_RIFLE, -1)).toBe(0);
  });

  it('falls monotonically along a falling curve', () => {
    let previous = Infinity;
    for (let range = 0; range <= 400; range += 7) {
      const p = hitProbabilityAt(TEST_RIFLE, range);
      expect(p).toBeLessThanOrEqual(previous);
      previous = p;
    }
  });

  it('handles a one-point curve', () => {
    const flat = { ...TEST_RIFLE, hitProbabilityByRange: [{ rangeM: 0, probability: 0.25 }] };
    expect(hitProbabilityAt(flat, 0)).toBe(0.25);
    expect(hitProbabilityAt(flat, 399)).toBe(0.25);
    expect(hitProbabilityAt(flat, 401)).toBe(0);
  });
});
