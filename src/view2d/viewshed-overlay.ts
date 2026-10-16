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

/** Which side a viewshed is: BLUEFOR's is drawn light blue, OPFOR's light red. */
export type ViewshedSide = 'blue' | 'red';

/** Several viewsheds composed on one grid: the pixels to draw, row 0 the northernmost. */
export interface ViewshedOverlay {
  readonly grid: Viewshed['grid'];
  readonly pixels: Uint8ClampedArray;
}

/** Side colours: inside, and the deeper edge (RGBA). Ground both sides see is purple. */
const SIDE_COLOURS: Readonly<Record<'blue' | 'red' | 'both', readonly [number[], number[]]>> = {
  blue: [
    [120, 190, 255, 120],
    [35, 120, 235, 210],
  ],
  red: [
    [255, 135, 125, 120],
    [225, 55, 45, 210],
  ],
  both: [
    [190, 130, 255, 140],
    [125, 45, 215, 220],
  ],
};

/**
 * The viewsheds of several squads (or waypoints) on `grid` (the finest they
 * are computed on): where BLUEFOR sees, light blue; OPFOR, light red; both,
 * purple. Each side's viewsheds are joined (seen by any of them), and each
 * has a deeper edge. Viewsheds on coarser grids are read at each cell's
 * centre. Only the rows and columns `bounds` covers are composed.
 */
export function composeViewsheds(
  grid: Viewshed['grid'],
  layers: readonly { readonly viewshed: Viewshed; readonly side: ViewshedSide }[],
  bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  },
): ViewshedOverlay {
  const { columns, rows, cellSize, originX, originY } = grid;
  const c0 = Math.max(0, Math.floor((bounds.minX - originX) / cellSize));
  const c1 = Math.min(columns - 1, Math.ceil((bounds.maxX - originX) / cellSize));
  const r0 = Math.max(0, Math.floor((bounds.minY - originY) / cellSize));
  const r1 = Math.min(rows - 1, Math.ceil((bounds.maxY - originY) / cellSize));
  // Bit 1: BLUEFOR sees the cell; bit 2: OPFOR does.
  const seen = new Uint8Array(columns * rows);
  for (const { viewshed, side } of layers) {
    const bit = side === 'blue' ? 1 : 2;
    const from = viewshed.grid;
    const ratio = from.cellSize / cellSize;
    for (let r = r0; r <= r1; r += 1) {
      const fr = Math.floor((originY + (r + 0.5) * cellSize - from.originY) / from.cellSize);
      if (fr < 0 || fr >= from.rows) continue;
      for (let c = c0; c <= c1; c += 1) {
        const fc =
          ratio === 1
            ? c
            : Math.floor((originX + (c + 0.5) * cellSize - from.originX) / from.cellSize);
        if (fc < 0 || fc >= from.columns) continue;
        const i = r * columns + c;
        if (viewshed.visible[fr * from.columns + fc] === 1) seen[i] = (seen[i] ?? 0) | bit;
      }
    }
  }
  const pixels = new Uint8ClampedArray(columns * rows * 4);
  const at = (c: number, r: number) =>
    c < 0 || r < 0 || c >= columns || r >= rows ? 0 : (seen[r * columns + c] ?? 0);
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const v = at(c, r);
      if (v === 0) continue;
      // On the edge of either side's ground: a neighbour lacks one of its sides.
      const edge =
        (at(c - 1, r) & v) !== v ||
        (at(c + 1, r) & v) !== v ||
        (at(c, r - 1) & v) !== v ||
        (at(c, r + 1) & v) !== v;
      const colour = SIDE_COLOURS[v === 3 ? 'both' : v === 1 ? 'blue' : 'red'][edge ? 1 : 0];
      const i = ((rows - 1 - r) * columns + c) * 4;
      pixels[i] = colour[0] ?? 0;
      pixels[i + 1] = colour[1] ?? 0;
      pixels[i + 2] = colour[2] ?? 0;
      pixels[i + 3] = colour[3] ?? 0;
    }
  }
  return { grid, pixels };
}

const overlayImages = new WeakMap<Uint8ClampedArray, HTMLCanvasElement>();

/** Draws composed viewsheds on the 2D map (`toScreen`: map metres to the canvas, north up). */
export function drawViewshedOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: ViewshedOverlay,
  toScreen: (p: Vec2) => Vec2,
): void {
  const { grid, pixels } = overlay;
  let canvas = overlayImages.get(pixels);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = grid.columns;
    canvas.height = grid.rows;
    const c = canvas.getContext('2d');
    if (c) {
      const image = c.createImageData(grid.columns, grid.rows);
      image.data.set(pixels);
      c.putImageData(image, 0, 0);
    }
    overlayImages.set(pixels, canvas);
  }
  const nw = toScreen({ x: grid.originX, y: grid.originY + grid.rows * grid.cellSize });
  const se = toScreen({ x: grid.originX + grid.columns * grid.cellSize, y: grid.originY });
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
  ctx.restore();
}
