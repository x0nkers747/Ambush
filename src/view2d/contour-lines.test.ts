import { describe, expect, it } from 'vitest';
import { joinSegments, simplifyLine } from './contour-lines';

// Contours for drawing: traced segments joined into lines, and the lines
// simplified for coarser zooms (render.ts draws the level the scale needs).

/** The points of a flat line as pairs. */
const pairs = (line: readonly number[]) =>
  Array.from({ length: line.length / 2 }, (_, k) => [line[2 * k] ?? 0, line[2 * k + 1] ?? 0]);
/** Distance from (x, y) to a flat polyline. */
function distanceTo(x: number, y: number, line: readonly number[]): number {
  let best = Infinity;
  for (let k = 0; k + 3 < line.length; k += 2) {
    const ax = line[k] ?? 0;
    const ay = line[k + 1] ?? 0;
    const dx = (line[k + 2] ?? 0) - ax;
    const dy = (line[k + 3] ?? 0) - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

describe('joinSegments', () => {
  it('joins segments that share endpoints, in any order and direction, into one line', () => {
    // A path (0,0)-(1,0)-(2,1)-(3,1)-(4,0), its segments shuffled, one reversed, ends off by < 1 mm.
    const segments = [2, 1, 3, 1, 0, 0, 1, 0, 4, 0, 3.0004, 1, 1, 0.0003, 2, 1];
    const lines = joinSegments(segments);
    expect(lines).toHaveLength(1);
    const points = pairs(lines[0] ?? []);
    expect(points).toHaveLength(5);
    const xs = points.map(([x]) => Math.round(x ?? 0));
    expect(xs).toEqual(xs[0] === 0 ? [0, 1, 2, 3, 4] : [4, 3, 2, 1, 0]);
  });

  it('closes rings, keeps separate lines apart, and uses every segment once', () => {
    const ring = [0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0];
    const apart = [10, 10, 11, 10];
    const lines = joinSegments([...ring, ...apart]);
    expect(lines).toHaveLength(2);
    const closed = lines.find((l) => l.length === 10) ?? [];
    expect(closed.slice(0, 2)).toEqual(closed.slice(-2));
    const segmentsIn = lines.reduce((n, l) => n + l.length / 2 - 1, 0);
    expect(segmentsIn).toBe(5);
  });
});

describe('simplifyLine', () => {
  // A wiggly line: 200 points along a slow curve with 0.2 m of ripple.
  const line = Array.from({ length: 200 }, (_, k) => [
    k * 2,
    30 * Math.sin(k / 40) + 0.2 * Math.sin(k * 1.7),
  ]).flat();

  it('keeps every point of the original within the tolerance, with far fewer points', () => {
    for (const tolerance of [1, 2.5, 6]) {
      const simple = simplifyLine(line, tolerance);
      expect(simple.length).toBeLessThan(line.length / 4);
      for (const [x, y] of pairs(line))
        expect(distanceTo(x ?? 0, y ?? 0, simple)).toBeLessThanOrEqual(tolerance + 1e-9);
      // Its ends are kept.
      expect(simple.slice(0, 2)).toEqual(line.slice(0, 2));
      expect(simple.slice(-2)).toEqual(line.slice(-2));
    }
  });

  it('keeps the line as it is at tolerance 0, and a straight line is its two ends', () => {
    expect(simplifyLine(line, 0)).toEqual(line);
    expect(simplifyLine([0, 0, 1, 1, 2, 2, 3, 3], 0.01)).toEqual([0, 0, 3, 3]);
  });
});
