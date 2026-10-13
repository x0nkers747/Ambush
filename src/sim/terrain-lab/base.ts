import type { Heightfield } from '../terrain';

// The broad shape of the ground (research §5.3): the cleaned DEM, interpolated
// smoothly. Catmull–Rom bicubic, clamped to the four samples of the cell it is
// in, so it never overshoots the DEM (no invented ridges or pits) while the
// slope no longer creases at every 10 m grid line, as linear triangles do.

export interface BaseSurface {
  /** Elevation at (x, y); outside the grid, at the nearest edge. */
  at(x: number, y: number): number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));

export function baseSurface(hf: Heightfield): BaseSurface {
  const { originX, originY, cellSize, columns, rows } = hf;
  const z = Float64Array.from(hf.elevations);
  const maxX = originX + (columns - 1) * cellSize;
  const maxY = originY + (rows - 1) * cellSize;
  const at = (c: number, r: number) => {
    const cc = c < 0 ? 0 : c >= columns ? columns - 1 : c;
    const rr = r < 0 ? 0 : r >= rows ? rows - 1 : r;
    return z[rr * columns + cc] ?? 0;
  };
  return {
    minX: originX,
    minY: originY,
    maxX,
    maxY,
    at(x, y) {
      const gx = ((x < originX ? originX : x > maxX ? maxX : x) - originX) / cellSize;
      const gy = ((y < originY ? originY : y > maxY ? maxY : y) - originY) / cellSize;
      let c = Math.floor(gx);
      let r = Math.floor(gy);
      if (c >= columns - 1) c = columns - 2;
      if (r >= rows - 1) r = rows - 2;
      const tx = gx - c;
      const ty = gy - r;
      const row = (rr: number) => cr(at(c - 1, rr), at(c, rr), at(c + 1, rr), at(c + 2, rr), tx);
      const v = cr(row(r - 1), row(r), row(r + 1), row(r + 2), ty);
      const a = at(c, r);
      const b = at(c + 1, r);
      const d = at(c, r + 1);
      const e = at(c + 1, r + 1);
      const lo = Math.min(a, b, d, e);
      const hi = Math.max(a, b, d, e);
      return v < lo ? lo : v > hi ? hi : v;
    },
  };
}
