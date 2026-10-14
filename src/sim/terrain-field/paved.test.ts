import { describe, expect, it } from 'vitest';
import { NO_FEATURES } from '../environment';
import { pavedAreas, pavedDistance } from './paved';

// Mapped paved areas' exact outlines (docs/adr/0048): straight edges, not the
// land cover raster's 2 m steps.

describe('paved areas', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  const [area] = pavedAreas({
    ...NO_FEATURES,
    landUse: [
      { id: 'car-park', kind: 'paved', boundary: rect(0, 0, 40, 20), holes: [rect(10, 5, 20, 15)] },
      { id: 'field', kind: 'meadow', boundary: rect(50, 0, 60, 10) },
    ],
  });

  it('keeps only paved land use', () => {
    expect(area).toBeDefined();
    expect(pavedAreas({ ...NO_FEATURES, landUse: [] })).toEqual([]);
  });

  it('gives the signed distance to the outline: negative inside, holes outside', () => {
    if (!area) throw new Error('no area');
    expect(pavedDistance(area, 35, 10)).toBeCloseTo(-5, 9);
    expect(pavedDistance(area, 30, 23)).toBeCloseTo(3, 9);
    expect(pavedDistance(area, 15, 10)).toBeCloseTo(5, 9);
    // Straight along an edge: the same distance anywhere along it.
    for (const x of [25.3, 31.7, 38.1]) expect(pavedDistance(area, x, -0.4)).toBeCloseTo(0.4, 9);
  });
});
