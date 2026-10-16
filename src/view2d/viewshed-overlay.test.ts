import { describe, expect, it } from 'vitest';
import type { Viewshed } from '#sim';
import { composeViewsheds } from './viewshed-overlay';

// Several squads' viewsheds at once (docs/adr/0055): BLUEFOR's light blue,
// OPFOR's light red, ground both see purple, each side's with its edge.

const grid = { originX: 0, originY: 0, cellSize: 4, columns: 10, rows: 10 };
/** A viewshed on `g` seeing the cells (column, row) `cells`. */
function seeing(cells: readonly [number, number][], g = grid): Viewshed {
  const visible = new Uint8Array(g.columns * g.rows);
  for (const [c, r] of cells) visible[r * g.columns + c] = 1;
  return { grid: g, observer: { x: 0, y: 0 }, visible };
}
/** Every cell of a block, inclusive. */
const block = (c0: number, r0: number, c1: number, r1: number) => {
  const out: [number, number][] = [];
  for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) out.push([c, r]);
  return out;
};
const everywhere = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
/** The pixel of cell (column, row): row 0 of the image is the northernmost. */
const pixel = (pixels: Uint8ClampedArray, c: number, r: number) =>
  Array.from(pixels.subarray(((9 - r) * 10 + c) * 4, ((9 - r) * 10 + c) * 4 + 4));

describe('composeViewsheds', () => {
  const blue = seeing(block(0, 0, 5, 9));
  const red = seeing(block(4, 0, 9, 9));
  const { pixels } = composeViewsheds(
    grid,
    [
      { viewshed: blue, side: 'blue' },
      { viewshed: red, side: 'red' },
    ],
    everywhere,
  );

  it('blue where only BLUEFOR sees, red where only OPFOR does, purple where both', () => {
    const [br, , bb] = pixel(pixels, 1, 5);
    const [rr, , rb] = pixel(pixels, 8, 5);
    expect(bb).toBeGreaterThan(br ?? 0);
    expect(rr).toBeGreaterThan(rb ?? 0);
    // Both (columns 4 and 5): purple, unlike either.
    expect(pixel(pixels, 4, 5)).not.toEqual(pixel(pixels, 1, 5));
    expect(pixel(pixels, 4, 5)).not.toEqual(pixel(pixels, 8, 5));
  });

  it('marks each side’s edge, and leaves unseen ground clear', () => {
    const alone = composeViewsheds(
      grid,
      [{ viewshed: seeing(block(2, 2, 6, 6)), side: 'red' }],
      everywhere,
    );
    expect(pixel(alone.pixels, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(alone.pixels, 4, 4)[3]).toBeLessThan(pixel(alone.pixels, 2, 4)[3] ?? 0);
  });

  it('reads a coarser viewshed at each cell’s centre, within the bounds only', () => {
    const coarse = { originX: 0, originY: 0, cellSize: 8, columns: 5, rows: 5 };
    const v = seeing([[0, 0]], coarse);
    const out = composeViewsheds(grid, [{ viewshed: v, side: 'blue' }], everywhere);
    for (const [c, r] of block(0, 0, 1, 1)) expect(pixel(out.pixels, c, r)[3]).toBeGreaterThan(0);
    expect(pixel(out.pixels, 2, 2)[3]).toBe(0);
    const clipped = composeViewsheds(grid, [{ viewshed: blue, side: 'blue' }], {
      minX: 0,
      minY: 0,
      maxX: 6,
      maxY: 40,
    });
    expect(pixel(clipped.pixels, 4, 5)[3]).toBe(0);
  });
});
