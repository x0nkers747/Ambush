import {
  decodeTerrarium,
  type ElevationTile,
  type LatLon,
  type OverpassResponse,
  type TileId,
} from '#geo';
import type { ServiceConfig } from './config';
import {
  createRateLimiter,
  fetchWithRetry,
  ServiceError,
  sleep,
  type FetchLike,
  type RetryOptions,
  type Sleep,
} from './http';

// Clients for the three geographic services (docs/adr/0014): Overpass for
// OpenStreetMap features, the AWS Terrain Tiles for elevation, and Nominatim
// for place-name search.

export const OVERPASS = 'OpenStreetMap (Overpass API)';
export const TERRAIN_TILES = 'Elevation tiles (AWS Terrain Tiles)';
export const NOMINATIM = 'Place search (Nominatim)';

export interface ClientOptions {
  readonly fetch: FetchLike;
  readonly sleep?: Sleep;
  readonly signal?: AbortSignal;
  readonly onRetry?: RetryOptions['onRetry'];
}

/** Retry options for a service call made with these client options. */
export const retry = (
  service: string,
  o: ClientOptions,
  extra: Partial<RetryOptions> = {},
): RetryOptions => ({
  service,
  fetch: o.fetch,
  ...(o.sleep ? { sleep: o.sleep } : {}),
  ...(o.signal ? { signal: o.signal } : {}),
  ...(o.onRetry ? { onRetry: o.onRetry } : {}),
  ...extra,
});

// --- Overpass ------------------------------------------------------------------

/** The OSM data for a query, the endpoint that answered, and the response text as received. */
export interface OverpassResult {
  readonly response: OverpassResponse;
  readonly endpoint: string;
  readonly text: string;
}

/**
 * Runs an Overpass query against the configured endpoints in turn. Overpass
 * reports some failures (timeouts, memory limits) inside a 200 response as a
 * `remark`; those count as failures too.
 */
export async function fetchOverpass(
  query: string,
  config: ServiceConfig,
  o: ClientOptions,
): Promise<OverpassResult> {
  let last: unknown = null;
  const wait = o.sleep ?? sleep;
  for (const endpoint of config.overpassEndpoints) {
    // An error reported inside a 200 answer (usually a timeout under load) is retried once here.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await queryOverpass(endpoint, query, o);
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        last = error;
        if (!(error instanceof OverpassRemarkError) || attempt === 1) break;
        o.onRetry?.({ attempt: attempt + 1, waitMs: 5000, reason: error.message });
        await wait(5000, o.signal);
      }
    }
  }
  throw last instanceof Error ? last : new ServiceError(OVERPASS, `${OVERPASS} failed.`);
}

/** Overpass answered, but reported an error (e.g. a timeout) instead of data. */
class OverpassRemarkError extends ServiceError {}

async function queryOverpass(
  endpoint: string,
  query: string,
  o: ClientOptions,
): Promise<OverpassResult> {
  const response = await fetchWithRetry(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: `data=${encodeURIComponent(query)}`,
    },
    retry(OVERPASS, o),
  );
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ServiceError(OVERPASS, `${OVERPASS} failed: the answer was not JSON.`);
  }
  const d = data as { elements?: unknown; remark?: unknown };
  if (!Array.isArray(d.elements))
    throw new ServiceError(OVERPASS, `${OVERPASS} failed: the answer had no data.`);
  if (typeof d.remark === 'string' && /error/i.test(d.remark)) {
    throw new OverpassRemarkError(OVERPASS, `${OVERPASS} failed: ${d.remark.trim()}`);
  }
  return { response: data as OverpassResponse, endpoint, text };
}

// --- Terrain tiles ---------------------------------------------------------------

/** Decodes PNG bytes to RGBA pixels (in the browser: `createImageBitmap` and `OffscreenCanvas`). */
export type DecodePng = (
  png: Blob,
) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>;

/**
 * Browser PNG decoding that preserves the exact channel values the elevation
 * encoding depends on: no colour-space conversion, no premultiplied alpha.
 */
export const decodePngInBrowser: DecodePng = async (png) => {
  const bitmap = await createImageBitmap(png, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2D is not available');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: image.data, width: image.width, height: image.height };
};

/** A fetched tile: decoded elevations (`null` when the service has no such tile), the PNG and its sources. */
export interface FetchedTile extends ElevationTile {
  readonly sources: string;
  readonly png: Blob | null;
}

export const tileUrl = (template: string, t: TileId): string =>
  template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));

/** Fetches and decodes one Terrarium tile. A missing tile (404/403) is returned with no elevations. */
export async function fetchTerrainTile(
  tile: TileId,
  config: ServiceConfig,
  decode: DecodePng,
  o: ClientOptions,
): Promise<FetchedTile> {
  const response = await fetchWithRetry(
    tileUrl(config.terrainTileUrl, tile),
    {},
    retry(TERRAIN_TILES, o, { passStatuses: [403, 404] }),
  );
  if (!response.ok) return { ...tile, elevations: null, sources: '', png: null };
  const png = await response.blob();
  const sources = response.headers.get('x-amz-meta-x-imagery-sources') ?? '';
  let pixels;
  try {
    pixels = await decode(png);
  } catch {
    throw new ServiceError(
      TERRAIN_TILES,
      `${TERRAIN_TILES} failed: tile ${String(tile.z)}/${String(tile.x)}/${String(tile.y)} could not be decoded.`,
    );
  }
  return {
    ...tile,
    elevations: decodeTerrarium(pixels.data, pixels.width, pixels.height),
    sources,
    png,
  };
}

/** Decodes a tile stored earlier (for reprocessing without downloading again). */
export async function decodeStoredTile(
  tile: TileId & { readonly png: Blob | null; readonly sources: string },
  decode: DecodePng,
): Promise<FetchedTile> {
  if (!tile.png)
    return { z: tile.z, x: tile.x, y: tile.y, elevations: null, sources: tile.sources, png: null };
  const pixels = await decode(tile.png);
  return {
    z: tile.z,
    x: tile.x,
    y: tile.y,
    elevations: decodeTerrarium(pixels.data, pixels.width, pixels.height),
    sources: tile.sources,
    png: tile.png,
  };
}

// --- Nominatim ---------------------------------------------------------------------

export interface PlaceResult {
  readonly name: string;
  readonly position: LatLon;
}

/** Nominatim allows at most one request per second; shared by every search in this page. */
const nominatimLimiter = createRateLimiter(1100);

/**
 * Searches for a place name. Only on an explicit request (Nominatim forbids
 * search-as-you-type), at most once a second.
 */
export async function searchPlaces(
  query: string,
  config: ServiceConfig,
  o: ClientOptions & { readonly limiter?: ReturnType<typeof createRateLimiter> },
): Promise<PlaceResult[]> {
  const q = query.trim();
  if (q === '') return [];
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '5' });
  if (config.contactEmail.trim() !== '') params.set('email', config.contactEmail.trim());
  const url = `${config.nominatimEndpoint.replace(/\/$/, '')}/search?${params.toString()}`;
  const limiter = o.limiter ?? nominatimLimiter;
  const response = await limiter(
    () =>
      fetchWithRetry(
        url,
        { headers: { Accept: 'application/json' } },
        retry(NOMINATIM, o, { retries: 1 }),
      ),
    o.signal,
  );
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ServiceError(NOMINATIM, `${NOMINATIM} failed: the answer was not JSON.`);
  }
  if (!Array.isArray(data)) return [];
  return data.flatMap((item: unknown) => {
    const r = item as { display_name?: unknown; lat?: unknown; lon?: unknown };
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    return typeof r.display_name === 'string' && Number.isFinite(lat) && Number.isFinite(lon)
      ? [{ name: r.display_name, position: { lat, lon } }]
      : [];
  });
}
