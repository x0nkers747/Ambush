import { describe, expect, it } from 'vitest';
import { createSyntheticTerrain } from '#sim';
import { treeCoverAreas, treeCoverUrl, withTreeCover, type TreeCoverData } from './tree-cover';

// Tree cover from imagery (docs/adr/0049): switched off, and when given a
// file, its woods in the battlefield's frame, clipped to it.

const terrain = createSyntheticTerrain(
  { originX: -100, originY: -100, cellSize: 10, columns: 21, rows: 21 },
  () => 10,
);
const frame = { epsg: 32618, falseEasting: 300_000, falseNorthing: 4_266_000 };
const pkg = { frame, terrain } as unknown as Parameters<typeof treeCoverAreas>[1];
const square = (e: number, n: number, s: number): [number, number][] => [
  [e, n],
  [e + s, n],
  [e + s, n + s],
  [e, n + s],
];

describe('tree cover from imagery', () => {
  it('is switched off: no battlefield has a file', () => {
    expect(treeCoverUrl('any')).toBeNull();
  });

  it('adds woods in the battlefield frame, clipped to it, with clearings where wholly on it', () => {
    const data: TreeCoverData = {
      source: 'test',
      epsg: 32618,
      areas: [
        {
          id: 'inside',
          ring: square(299_950, 4_265_950, 40),
          holes: [square(299_960, 4_265_960, 10)],
        },
        { id: 'across', ring: square(300_080, 4_266_080, 50) },
      ],
    };
    const areas = treeCoverAreas(data, pkg);
    expect(areas.map((a) => a.id)).toEqual(['inside-0', 'across-0']);
    expect(areas[0]?.boundary[0]).toEqual({ x: -50, y: -50 });
    expect(areas[0]?.holes).toHaveLength(1);
    expect(areas[1]?.holes).toBeUndefined();
    for (const p of areas[1]?.boundary ?? []) {
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeLessThanOrEqual(100);
    }
    expect(areas.every((a) => a.kind === 'woodland')).toBe(true);
    const added = withTreeCover(terrain, areas);
    expect(added.features.vegetation).toHaveLength(terrain.features.vegetation.length + 2);
    expect(withTreeCover(terrain, [])).toBe(terrain);
  });

  it('ignores a file in another coordinate system', () => {
    expect(treeCoverAreas({ source: 'test', epsg: 32633, areas: [] }, pkg)).toEqual([]);
  });
});
