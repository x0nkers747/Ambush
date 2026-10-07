import { describe, expect, it } from 'vitest';
import {
  isOnPolygonBoundary,
  isSimplePolygon,
  pointInPolygon,
  polygonArea,
  segmentIntersectionParams,
  segmentPolygonEntries,
} from './polygon';

const p = (x: number, y: number) => ({ x, y });
/** 10 × 10 square, counter-clockwise. */
const SQUARE = [p(0, 0), p(10, 0), p(10, 10), p(0, 10)];
/** A "U": a 30 × 20 block with a 10 × 15 notch cut down from the top middle. */
const U = [p(0, 0), p(30, 0), p(30, 20), p(20, 20), p(20, 5), p(10, 5), p(10, 20), p(0, 20)];

describe('pointInPolygon (closed: the boundary is inside)', () => {
  it.each([
    [p(5, 5), true],
    [p(0.001, 9.999), true],
    [p(-0.001, 5), false],
    [p(10.001, 5), false],
    [p(5, 10.001), false],
    [p(50, 5), false],
  ])('square %o → %s', (point, inside) => {
    expect(pointInPolygon(point, SQUARE)).toBe(inside);
  });

  it('counts edges and vertices as inside', () => {
    for (const point of [p(0, 0), p(10, 10), p(5, 0), p(10, 3), p(0, 7.25)]) {
      expect(isOnPolygonBoundary(point, SQUARE)).toBe(true);
      expect(pointInPolygon(point, SQUARE)).toBe(true);
    }
  });

  it('handles concave polygons', () => {
    expect(pointInPolygon(p(5, 15), U)).toBe(true); // left arm
    expect(pointInPolygon(p(25, 15), U)).toBe(true); // right arm
    expect(pointInPolygon(p(15, 15), U)).toBe(false); // the notch
    expect(pointInPolygon(p(15, 2), U)).toBe(true); // the base
    expect(pointInPolygon(p(15, 5), U)).toBe(true); // bottom of the notch: boundary
  });

  it('is the same for either winding and any starting vertex', () => {
    const variants = [SQUARE, [...SQUARE].reverse(), [...SQUARE.slice(2), ...SQUARE.slice(0, 2)]];
    for (const point of [p(5, 5), p(0, 5), p(11, 5), p(10, 10), p(3, -1)]) {
      const results = variants.map((v) => pointInPolygon(point, v));
      expect(new Set(results).size).toBe(1);
    }
  });

  it('treats rays through vertices correctly', () => {
    const diamond = [p(0, 5), p(5, 0), p(10, 5), p(5, 10)];
    expect(pointInPolygon(p(1, 5), diamond)).toBe(true); // ray passes through vertex (10, 5)
    expect(pointInPolygon(p(-1, 5), diamond)).toBe(false); // ray passes through two vertices
    expect(pointInPolygon(p(5, 10.5), diamond)).toBe(false);
  });
});

describe('segmentPolygonEntries', () => {
  it('finds the exact entry of a path crossing into the area', () => {
    expect(segmentPolygonEntries(p(-10, 5), p(5, 5), SQUARE)).toEqual([10 / 15]);
  });

  it('finds an entry even when both ends are outside (passing straight through)', () => {
    expect(pointInPolygon(p(-5, 5), SQUARE) || pointInPolygon(p(15, 5), SQUARE)).toBe(false);
    expect(segmentPolygonEntries(p(-5, 5), p(15, 5), SQUARE)).toEqual([0.25]);
  });

  it('finds every entry of a path through a concave area', () => {
    // Along y = 15: left arm [0, 10], notch, right arm [20, 30].
    expect(segmentPolygonEntries(p(-10, 15), p(40, 15), U)).toEqual([0.2, 0.6]);
  });

  it('does not report a path that starts inside or on the boundary', () => {
    expect(segmentPolygonEntries(p(5, 5), p(20, 5), SQUARE)).toEqual([]);
    expect(segmentPolygonEntries(p(0, 5), p(-10, 5), SQUARE)).toEqual([]);
    expect(segmentPolygonEntries(p(0, 5), p(20, 5), SQUARE)).toEqual([]);
  });

  it('reports a path that ends exactly on the boundary at s = 1', () => {
    expect(segmentPolygonEntries(p(-10, 5), p(0, 5), SQUARE)).toEqual([1]);
  });

  it('counts touching a vertex or running along an edge as entering', () => {
    expect(segmentPolygonEntries(p(-5, 5), p(5, 15), SQUARE)).toEqual([0.5]); // grazes (0, 10)
    expect(segmentPolygonEntries(p(-10, 0), p(20, 0), SQUARE)).toEqual([1 / 3]); // along the bottom edge
  });

  it('reports nothing for a path that misses', () => {
    expect(segmentPolygonEntries(p(-5, 11), p(15, 11), SQUARE)).toEqual([]);
    expect(segmentPolygonEntries(p(-5, -5), p(-1, 20), SQUARE)).toEqual([]);
  });

  it('re-enters after leaving, but only counts each entry once at a shared vertex', () => {
    expect(segmentPolygonEntries(p(-5, -5), p(15, 15), SQUARE)).toEqual([0.25]); // through two corners
  });
});

describe('polygon validity', () => {
  it('accepts simple polygons, convex or not', () => {
    expect(isSimplePolygon(SQUARE)).toBe(true);
    expect(isSimplePolygon(U)).toBe(true);
    expect(isSimplePolygon([p(0, 0), p(5, 0), p(0, 5)])).toBe(true);
  });

  it.each([
    ['fewer than three vertices', [p(0, 0), p(5, 0)]],
    ['collinear vertices', [p(0, 0), p(5, 0), p(10, 0)]],
    ['a bow tie', [p(0, 0), p(10, 10), p(10, 0), p(0, 10)]],
    ['a repeated vertex', [p(0, 0), p(10, 0), p(10, 0), p(0, 10)]],
    ['an edge folding back', [p(0, 0), p(10, 0), p(5, 0), p(5, 5)]],
    ['a vertex touching another edge', [p(0, 0), p(10, 0), p(10, 10), p(5, 0), p(0, 10)]],
  ])('rejects %s', (_label, vertices) => {
    expect(isSimplePolygon(vertices)).toBe(false);
  });

  it('computes areas', () => {
    expect(polygonArea(SQUARE)).toBe(100);
    expect(polygonArea([...SQUARE].reverse())).toBe(100);
    expect(polygonArea(U)).toBe(30 * 20 - 10 * 15);
  });
});

describe('segmentIntersectionParams', () => {
  it('handles crossing, touching, parallel and collinear segments', () => {
    expect(segmentIntersectionParams(p(0, 0), p(10, 0), p(5, -5), p(5, 5))).toEqual([0.5]);
    expect(segmentIntersectionParams(p(0, 0), p(10, 0), p(10, 0), p(10, 5))).toEqual([1]);
    expect(segmentIntersectionParams(p(0, 0), p(10, 0), p(0, 1), p(10, 1))).toEqual([]);
    expect(segmentIntersectionParams(p(0, 0), p(10, 0), p(5, 0), p(20, 0))).toEqual([0.5, 1]);
    expect(segmentIntersectionParams(p(0, 0), p(10, 0), p(11, 0), p(20, 0))).toEqual([]);
  });
});
