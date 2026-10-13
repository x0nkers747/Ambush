import type { OverpassResponse } from '../osm';
import type { OvertureTile } from '../overture';
import grafenwoehr from './grafenwoehr-de.overpass.json';
import quanticoDem from './quantico-va.dem-excerpt.json';
import quanticoOverture from './quantico-va.overture-buildings.json';
import quantico from './quantico-va.overpass.json';

export { encodeMvt, encodePmtiles, type TestFeature } from './vector-tiles';
export { encodeTiff, type TestTiff } from './tiff';

// Recorded Overpass responses for tests in any layer (`#geo/fixtures`; see
// README.md here). Only tests import this entry point, so the application
// never bundles the fixtures.

/** 38.5223° N, 77.2934° W: Quantico, Virginia. */
export const QUANTICO_OSM = quantico as OverpassResponse;
export const QUANTICO_CENTRE = { lat: 38.5223, lon: -77.2934 } as const;

/**
 * Quantico's raw elevation round its known DEM fault (docs/adr/0033): 61 × 81
 * samples of the recorded 5 km battlefield's 10 m grid, in centimetres, and
 * 24 × 24 pixels of the source tile behind it (see README.md).
 */
export const QUANTICO_DEM_EXCERPT = quanticoDem as {
  readonly grid: {
    readonly originX: number;
    readonly originY: number;
    readonly cellSize: number;
    readonly columns: number;
    readonly rows: number;
    readonly firstColumn: number;
    readonly firstRow: number;
    readonly centimetres: readonly number[];
  };
  readonly tile: {
    readonly z: number;
    readonly x: number;
    readonly y: number;
    readonly firstPixelX: number;
    readonly firstPixelY: number;
    readonly size: number;
    readonly elevations: readonly number[];
  };
};

/** 49.7170° N, 11.9060° E: Grafenwöhr, Bavaria. */
export const GRAFENWOEHR_OSM = grafenwoehr as OverpassResponse;
export const GRAFENWOEHR_CENTRE = { lat: 49.717, lon: 11.906 } as const;

/** Base64 to bytes (this layer has no `atob`). */
function base64(text: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of clean) {
    value = (value << 6) | alphabet.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (value >> bits) & 0xff;
      o += 1;
    }
  }
  return out;
}

/**
 * Two neighbouring Overture building tiles at Quantico (zoom 14, columns 4674
 * and 4675, row 6288; release 2026-09-23.1), decompressed, as read from the
 * archive: six buildings cross the seam between them.
 */
export const QUANTICO_OVERTURE_RELEASE = quanticoOverture.release;
export const QUANTICO_OVERTURE_TILES: readonly OvertureTile[] = quanticoOverture.tiles.map((t) => ({
  z: t.z,
  x: t.x,
  y: t.y,
  column: t.x,
  data: base64(t.base64),
}));
