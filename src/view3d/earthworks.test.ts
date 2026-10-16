import { describe, expect, it } from 'vitest';
import { earthworkShape, sinkDepth, STANDING_FROM_LEVEL } from './earthworks';

// Fighting positions as drawn (docs/behavior-lab/force-on-force/09): from a
// scrape to a trench as a defence digs in.

describe('a fighting position', () => {
  it('a scrape the length of a man lying prone, its spoil growing; then a pit widening into a trench', () => {
    const scrape = earthworkShape(0.2);
    expect(scrape.holeAlong).toBeGreaterThan(1.5);
    expect(scrape.parados[0]).toBe(0);
    expect(earthworkShape(0.4).parapet[2]).toBeGreaterThan(earthworkShape(0.1).parapet[2]);
    const pit = earthworkShape(0.6);
    const trench = earthworkShape(1);
    expect(pit.holeAlong).toBeLessThan(scrape.holeAlong);
    expect(trench.holeAcross).toBeGreaterThan(pit.holeAcross);
    expect(trench.parapet[2]).toBeGreaterThan(pit.parapet[2]);
    // A parados behind only once it is a trench.
    expect(pit.parados[0]).toBe(0);
    expect(trench.parados[0]).toBeGreaterThan(0);
  });

  it('a soldier stands in it, sunk, from half dug in; deepest when fully dug in', () => {
    expect(sinkDepth(STANDING_FROM_LEVEL - 0.01)).toBe(0);
    expect(sinkDepth(STANDING_FROM_LEVEL)).toBeGreaterThan(0.4);
    expect(sinkDepth(1)).toBeGreaterThan(sinkDepth(0.75));
    expect(sinkDepth(1)).toBeLessThan(1.5);
  });
});
