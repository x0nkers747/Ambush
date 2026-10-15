import { describe, expect, it } from 'vitest';
import { contourBatches, MAX_CONTOUR_SEGMENTS_PER_STROKE, type ContourTile } from './render';

// Contours are stroked in batches of bounded size: Chrome silently drops a
// stroke of about a million segments, and everything drawn after it.

const tile = (minorSegments: number, indexSegments = 0): ContourTile => ({
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  minor: null,
  index: null,
  minorSegments,
  indexSegments,
});

describe('contour batches', () => {
  it('are one batch while the view holds few contours', () => {
    const tiles = [tile(10, 2), tile(20), tile(30, 4)];
    expect(contourBatches(tiles, 'minor')).toEqual([{ tiles, segments: 60 }]);
    expect(contourBatches(tiles, 'index')).toEqual([{ tiles: [tiles[0], tiles[2]], segments: 6 }]);
  });

  it('never hold more than the most segments per stroke, keeping tile order', () => {
    const third = Math.floor(MAX_CONTOUR_SEGMENTS_PER_STROKE / 3);
    const tiles = Array.from({ length: 10 }, () => tile(third));
    const batches = contourBatches(tiles, 'minor');
    expect(batches.map((b) => b.tiles.length)).toEqual([3, 3, 3, 1]);
    expect(batches.flatMap((b) => b.tiles)).toEqual(tiles);
    for (const b of batches)
      expect(b.segments).toBeLessThanOrEqual(MAX_CONTOUR_SEGMENTS_PER_STROKE);
  });

  it('skip tiles without contours of the weight', () => {
    expect(contourBatches([tile(0), tile(0)], 'minor')).toEqual([]);
  });
});
