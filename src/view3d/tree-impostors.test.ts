import { describe, expect, it } from 'vitest';
import { IMPOSTOR_GRID, impostorDirection } from './tree-impostors';

// Distant trees' photographs (docs/adr/0051): the hemi-octahedral grid of directions.

describe('impostor directions', () => {
  it('looks straight down at the middle of the grid and level round its edge', () => {
    const top = impostorDirection(0.5, 0.5);
    expect(top.y).toBeCloseTo(1, 6);
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0.5, 0],
      [0, 0.5],
    ] as const)
      expect(impostorDirection(u, v).y).toBeCloseTo(0, 6);
  });

  it('gives unit directions over the upper half, all different', () => {
    const seen = new Set<string>();
    for (let j = 0; j < IMPOSTOR_GRID; j += 1)
      for (let i = 0; i < IMPOSTOR_GRID; i += 1) {
        const d = impostorDirection(i / (IMPOSTOR_GRID - 1), j / (IMPOSTOR_GRID - 1));
        expect(d.length()).toBeCloseTo(1, 6);
        expect(d.y).toBeGreaterThanOrEqual(0);
        seen.add(
          d
            .toArray()
            .map((x) => x.toFixed(3))
            .join(','),
        );
      }
    expect(seen.size).toBe(IMPOSTOR_GRID * IMPOSTOR_GRID);
  });
});
