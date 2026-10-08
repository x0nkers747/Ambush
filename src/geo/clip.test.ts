import { describe, expect, it } from 'vitest';
import { isSimplePolygon, polygonArea, type Vec2 } from '#sim';
import { clipPolygon, clipPolyline, clipSegment, dedupe } from './clip';

const R = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
const area = (rings: Vec2[][]) => rings.reduce((s, r) => s + polygonArea(r), 0);
const onOrInside = (p: Vec2) => p.x >= -10 && p.x <= 10 && p.y >= -10 && p.y <= 10;

describe('clipping to the battlefield', () => {
  it('clips segments (Liang–Barsky)', () => {
    expect(clipSegment({ x: -20, y: 0 }, { x: 20, y: 0 }, R)).toEqual([0.25, 0.75]);
    expect(clipSegment({ x: -20, y: 20 }, { x: -15, y: 25 }, R)).toBeNull();
    expect(clipSegment({ x: 0, y: 0 }, { x: 5, y: 5 }, R)).toEqual([0, 1]);
  });

  it('keeps a polygon inside, returns nothing for one outside, and the rectangle for one around it', () => {
    const inner = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 0, y: 2 },
    ];
    expect(clipPolygon(inner, R)).toEqual([inner]);
    expect(
      clipPolygon(
        inner.map((p) => ({ x: p.x + 50, y: p.y })),
        R,
      ),
    ).toEqual([]);
    const around = [
      { x: -50, y: -50 },
      { x: 50, y: -50 },
      { x: 50, y: 50 },
      { x: -50, y: 50 },
    ];
    expect(area(clipPolygon(around, R))).toBe(400);
  });

  it('clips a polygon crossing one edge, either orientation, to a counter-clockwise ring', () => {
    const half = [
      { x: 0, y: -5 },
      { x: 20, y: -5 },
      { x: 20, y: 5 },
      { x: 0, y: 5 },
    ];
    for (const ring of [half, [...half].reverse()]) {
      const [piece, ...rest] = clipPolygon(ring, R);
      expect(rest).toEqual([]);
      expect(piece && polygonArea(piece)).toBe(100);
      expect(piece?.every(onOrInside)).toBe(true);
    }
  });

  it('splits a U shape that leaves and re-enters into separate simple polygons', () => {
    // A U opening downward, its arms crossing the bottom edge twice: inside, two separate legs.
    const u = [
      { x: -8, y: -20 },
      { x: -4, y: -20 },
      { x: -4, y: 5 },
      { x: 4, y: 5 },
      { x: 4, y: -20 },
      { x: 8, y: -20 },
      { x: 8, y: 8 },
      { x: -8, y: 8 },
    ];
    // The bottom bar joining the legs lies outside: inside, it is one piece (the arch).
    const arch = clipPolygon(u, R);
    expect(arch).toHaveLength(1);
    expect(arch.every((p) => isSimplePolygon(p))).toBe(true);
    expect(area(arch)).toBeCloseTo(4 * 18 * 2 + 8 * 3, 9);
    // A comb crossing the top edge three times: three pieces, each simple.
    const comb = [
      { x: -9, y: 0 },
      { x: 9, y: 0 },
      { x: 9, y: 20 },
      { x: 6, y: 20 },
      { x: 6, y: 5 },
      { x: 3, y: 5 },
      { x: 3, y: 20 },
      { x: -3, y: 20 },
      { x: -3, y: 5 },
      { x: -6, y: 5 },
      { x: -6, y: 20 },
      { x: -9, y: 20 },
    ];
    const pieces = clipPolygon(comb, { minX: -10, minY: -10, maxX: 10, maxY: 10 });
    expect(pieces).toHaveLength(1); // joined below y = 5 inside the rectangle
    const teeth = clipPolygon(comb, { minX: -10, minY: 6, maxX: 10, maxY: 10 });
    expect(teeth).toHaveLength(3);
    expect(teeth.every((p) => isSimplePolygon(p))).toBe(true);
    // Teeth 3, 6 and 3 m wide, 4 m of each inside.
    expect(area(teeth)).toBeCloseTo((3 + 6 + 3) * 4, 9);
  });

  it('walks round corners of the rectangle when an outline wraps a corner', () => {
    // An L around the north-east corner, from outside to outside.
    const l = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    const [piece] = clipPolygon(l, R);
    expect(piece && polygonArea(piece)).toBe(100);
    expect(piece).toContainEqual({ x: 10, y: 10 });
  });

  it('clips polylines into pieces, snapping onto the edge', () => {
    const road = [
      { x: -20, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 30 },
      { x: 5, y: 30 },
      { x: 5, y: 0 },
    ];
    const pieces = clipPolyline(road, R);
    expect(pieces).toEqual([
      [
        { x: -10, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 10 },
      ],
      [
        { x: 5, y: 10 },
        { x: 5, y: 0 },
      ],
    ]);
    expect(
      clipPolyline(
        [
          { x: 20, y: 20 },
          { x: 30, y: 30 },
        ],
        R,
      ),
    ).toEqual([]);
  });

  it('dedupes repeats and the closing point of rings, but not of lines', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 0 },
    ];
    expect(dedupe(ring)).toHaveLength(3);
    expect(dedupe(ring, false)).toHaveLength(4);
  });
});
