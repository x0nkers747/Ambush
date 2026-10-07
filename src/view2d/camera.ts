import type { TerrainDataset, Vec2 } from '#sim';

// Map camera: converts between screen pixels and simulation map coordinates
// (X = East, Y = North, metres). North is always up; the map never rotates.
// Pure functions on plain values, independent of the DOM.

/** Size of the drawing area in CSS pixels. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface Camera {
  /** Map point shown at the centre of the viewport. */
  readonly centerX: number;
  readonly centerY: number;
  /** Map metres per CSS pixel, equal in X and Y so the map keeps its aspect ratio. */
  readonly metersPerPixel: number;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Closest zoom: 2 cm per pixel. */
export const MIN_METERS_PER_PIXEL = 0.02;
/** Farthest zoom: 20 m per pixel. */
export const MAX_METERS_PER_PIXEL = 20;

/** Screen position (pixels, origin top-left, y down) of a map point. */
export function worldToScreen(camera: Camera, viewport: Viewport, point: Vec2): Vec2 {
  return {
    x: viewport.width / 2 + (point.x - camera.centerX) / camera.metersPerPixel,
    y: viewport.height / 2 - (point.y - camera.centerY) / camera.metersPerPixel,
  };
}

/** Map point under a screen position. Inverse of `worldToScreen`. */
export function screenToWorld(camera: Camera, viewport: Viewport, screen: Vec2): Vec2 {
  return {
    x: camera.centerX + (screen.x - viewport.width / 2) * camera.metersPerPixel,
    y: camera.centerY - (screen.y - viewport.height / 2) * camera.metersPerPixel,
  };
}

/**
 * The 2D affine transform `[a, b, c, d, e, f]` (as for `CanvasRenderingContext2D.setTransform`)
 * that maps map coordinates to screen pixels.
 */
export function worldToScreenTransform(
  camera: Camera,
  viewport: Viewport,
): [number, number, number, number, number, number] {
  const s = 1 / camera.metersPerPixel;
  return [
    s,
    0,
    0,
    -s,
    viewport.width / 2 - camera.centerX * s,
    viewport.height / 2 + camera.centerY * s,
  ];
}

/**
 * Zooms by `factor` (> 1 zooms in) keeping the map point under `screen` fixed,
 * so zooming follows the cursor. The zoom is clamped to the allowed range.
 */
export function zoomAt(camera: Camera, viewport: Viewport, screen: Vec2, factor: number): Camera {
  const metersPerPixel = clamp(
    camera.metersPerPixel / factor,
    MIN_METERS_PER_PIXEL,
    MAX_METERS_PER_PIXEL,
  );
  const anchor = screenToWorld(camera, viewport, screen);
  return {
    metersPerPixel,
    centerX: anchor.x - (screen.x - viewport.width / 2) * metersPerPixel,
    centerY: anchor.y + (screen.y - viewport.height / 2) * metersPerPixel,
  };
}

/** Moves the map with a pointer drag of (dx, dy) screen pixels. */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return {
    ...camera,
    centerX: camera.centerX - dx * camera.metersPerPixel,
    centerY: camera.centerY + dy * camera.metersPerPixel,
  };
}

/** Shows all of `bounds`, centred, with at least `marginPx` pixels around it. */
export function fitBounds(bounds: Bounds, viewport: Viewport, marginPx = 24): Camera {
  const width = Math.max(viewport.width - 2 * marginPx, 1);
  const height = Math.max(viewport.height - 2 * marginPx, 1);
  const metersPerPixel = clamp(
    Math.max((bounds.maxX - bounds.minX) / width, (bounds.maxY - bounds.minY) / height),
    MIN_METERS_PER_PIXEL,
    MAX_METERS_PER_PIXEL,
  );
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    metersPerPixel,
  };
}

export function terrainBounds(terrain: TerrainDataset): Bounds {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  return {
    minX: originX,
    minY: originY,
    maxX: originX + (columns - 1) * cellSize,
    maxY: originY + (rows - 1) * cellSize,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
