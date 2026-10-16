import type { Vec2, Viewshed } from '#sim';

// A viewshed drawn over the map (docs/adr/0011): the ground that can be seen,
// light purple and see-through, its edge a deeper purple. The same pixels
// drape the 3D view's ground (its `setGroundOverlay`).

const VISIBLE_ALPHA = 125;
const VISIBLE_EDGE_ALPHA = 200;

/**
 * The viewshed as RGBA pixels, one per cell, row 0 the northernmost:
 * visible cells light purple, those at the edge of what is visible deeper.
 */
export function viewshedPixels(viewshed: Viewshed): Uint8ClampedArray {
  const { grid, visible } = viewshed;
  const { columns, rows } = grid;
  const data = new Uint8ClampedArray(columns * rows * 4);
  const at = (c: number, r: number) =>
    c < 0 || r < 0 || c >= columns || r >= rows ? 1 : (visible[r * columns + c] ?? 0);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      if (!at(c, r)) continue;
      const edge = !at(c - 1, r) || !at(c + 1, r) || !at(c, r - 1) || !at(c, r + 1);
      // Image row 0 is the northernmost grid row.
      const i = ((rows - 1 - r) * columns + c) * 4;
      data[i] = edge ? 120 : 175;
      data[i + 1] = edge ? 45 : 110;
      data[i + 2] = edge ? 215 : 255;
      data[i + 3] = edge ? VISIBLE_EDGE_ALPHA : VISIBLE_ALPHA;
    }
  }
  return data;
}

const images = new WeakMap<Viewshed, HTMLCanvasElement>();

/** The viewshed's pixels as an image (made once per viewshed). */
function imageOf(viewshed: Viewshed): HTMLCanvasElement {
  let canvas = images.get(viewshed);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = viewshed.grid.columns;
    canvas.height = viewshed.grid.rows;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      pixels.data.set(viewshedPixels(viewshed));
      ctx.putImageData(pixels, 0, 0);
    }
    images.set(viewshed, canvas);
  }
  return canvas;
}

/** Draws the viewshed on the 2D map (`toScreen`: map metres to the canvas, north up). */
export function drawViewshed(
  ctx: CanvasRenderingContext2D,
  viewshed: Viewshed,
  toScreen: (p: Vec2) => Vec2,
): void {
  const { grid } = viewshed;
  const nw = toScreen({ x: grid.originX, y: grid.originY + grid.rows * grid.cellSize });
  const se = toScreen({ x: grid.originX + grid.columns * grid.cellSize, y: grid.originY });
  ctx.save();
  // Cells stay cells when zoomed in.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(imageOf(viewshed), nw.x, nw.y, se.x - nw.x, se.y - nw.y);
  ctx.restore();
}
