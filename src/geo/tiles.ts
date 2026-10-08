import type { LatLon } from './utm';

// Web Mercator ("slippy map") tile addressing, as used by the AWS Terrain
// Tiles (docs/adr/0014). Pixel coordinates are global at a zoom level: the
// world is 256 · 2^z pixels across, x eastward from −180°, y southward from
// about 85.05° N.

export const TILE_SIZE = 256;
/** The highest zoom the Terrarium tiles are published at. */
export const TERRARIUM_MAX_ZOOM = 15;
/** Ground metres per pixel at the equator at zoom 0. */
const EQUATOR_M_PER_PX = 156543.03392804097;

export interface TileId {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export const tileKey = ({ z, x, y }: TileId): string => `${String(z)}/${String(x)}/${String(y)}`;

/** Ground size of one pixel, in metres, at a latitude and zoom. */
export function groundResolution(lat: number, zoom: number): number {
  return (EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * The lowest zoom whose pixels are at most half the target cell size, so a
 * grid of that cell size is sampled from at least two pixels per cell; the
 * maximum zoom when none is that fine.
 */
export function zoomForCellSize(
  lat: number,
  cellSizeM: number,
  maxZoom = TERRARIUM_MAX_ZOOM,
): number {
  for (let z = 0; z <= maxZoom; z += 1) {
    if (groundResolution(lat, z) <= cellSizeM / 2) return z;
  }
  return maxZoom;
}

/** Global pixel coordinates of a position at a zoom (x not wrapped). */
export function mercatorPixel(p: LatLon, zoom: number): { x: number; y: number } {
  const world = TILE_SIZE * 2 ** zoom;
  const lat = Math.max(-85.05112878, Math.min(85.05112878, p.lat));
  const phi = (lat * Math.PI) / 180;
  return {
    x: ((p.lon + 180) / 360) * world,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * world,
  };
}

/** Tile column for a global pixel x, wrapped round the world. */
export function wrapTileX(x: number, zoom: number): number {
  const n = 2 ** zoom;
  return ((x % n) + n) % n;
}

/**
 * The tiles covering a range of global pixels (inclusive), in row-major order
 * from the north-west. Columns wrap round the antimeridian; the range must be
 * less than a world wide.
 */
export function tilesForPixelRange(
  zoom: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): TileId[] {
  const n = 2 ** zoom;
  const tx0 = Math.floor(minX / TILE_SIZE);
  const tx1 = Math.floor(maxX / TILE_SIZE);
  const ty0 = Math.max(0, Math.floor(minY / TILE_SIZE));
  const ty1 = Math.min(n - 1, Math.floor(maxY / TILE_SIZE));
  const tiles: TileId[] = [];
  for (let y = ty0; y <= ty1; y += 1) {
    for (let x = tx0; x <= tx1; x += 1) tiles.push({ z: zoom, x: wrapTileX(x, zoom), y });
  }
  return tiles;
}
