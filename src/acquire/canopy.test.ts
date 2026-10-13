import { describe, expect, it } from 'vitest';
import {
  battlefieldRequest,
  CANOPY_ATTRIBUTION,
  encodeTerrarium,
  planBattlefield,
  planCanopy,
  TILE_SIZE,
  type CanopyPlan,
} from '#geo';
import { encodeTiff, QUANTICO_OSM as quantico } from '#geo/fixtures';
import { fetchCanopy, packCanopy, unpackCanopy } from './canopy';
import { DEFAULT_SERVICES, type ServiceConfig } from './config';
import { generateBattlefield } from './generate';
import { ServiceError, type FetchLike } from './http';
import type { DecodePng } from './services';
import { createMemoryStore } from './store';

// Canopy heights for tree cover (docs/adr/0050), read by byte ranges.

const deflate = async (bytes: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  );

/** A tiled canopy GeoTIFF of `size` × `size` pixels whose value is `value(column, row)`. */
async function canopyTiff(
  size: number,
  block: number,
  west: number,
  north: number,
  resolution: number,
  value: (c: number, r: number) => number,
): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  for (let by = 0; by < size / block; by += 1)
    for (let bx = 0; bx < size / block; bx += 1) {
      const pixels = new Uint8Array(block * block);
      for (let r = 0; r < block; r += 1)
        for (let c = 0; c < block; c += 1)
          pixels[r * block + c] = value(bx * block + c, by * block + r);
      blocks.push(await deflate(pixels));
    }
  return encodeTiff({
    width: size,
    height: size,
    block,
    blocks,
    compression: 8,
    west,
    north,
    resolution,
  });
}

/** A fake server of files by URL pattern, answering byte ranges; `null` files are missing. */
function rangeServer(
  files: [RegExp, Uint8Array | null][],
  extra: [RegExp, () => Response][] = [],
  ranges = true,
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (url: string, init?: RequestInit) => {
    calls.push(url);
    const other = extra.find(([re]) => re.test(url));
    if (other) return Promise.resolve(other[1]());
    const file = files.find(([re]) => re.test(url));
    if (!file) return Promise.reject(new TypeError('Failed to fetch'));
    const bytes = file[1];
    if (!bytes) return Promise.resolve(new Response('', { status: 404 }));
    const range = /bytes=(\d+)-(\d+)/.exec(
      (init?.headers as Record<string, string> | undefined)?.['Range'] ?? '',
    );
    if (!ranges || !range) return Promise.resolve(new Response(bytes as BlobPart));
    const start = Number(range[1]);
    const end = Math.min(bytes.length - 1, Number(range[2]));
    return Promise.resolve(new Response(bytes.slice(start, end + 1) as BlobPart, { status: 206 }));
  };
  return Object.assign(fn, { calls });
}

const client = (fetch: FetchLike) => ({ fetch, sleep: () => Promise.resolve() });

describe('reading canopy heights', () => {
  // A 64 × 64 tile in 16-pixel blocks, 2 m pixels; each pixel's value is (column + row) % 251.
  const value = (c: number, r: number) => (c + r) % 251;
  const plan: CanopyPlan = {
    // Columns 10 to 29, rows 20 to 39.
    box: { minX: 1020, maxX: 1060, maxY: 2000 - 40, minY: 2000 - 80 },
    tiles: [{ quadkey: 'q', box: { minX: 1000, maxX: 1128, minY: 1872, maxY: 2000 } }],
  };
  const config: ServiceConfig = { ...DEFAULT_SERVICES, canopyTilesUrl: 'https://canopy/chm/' };

  it('reads just the window over the battlefield, from the blocks it needs', async () => {
    const tif = await canopyTiff(64, 16, 1000, 2000, 2, value);
    const fetch = rangeServer([[/canopy\/chm\/q\.tif$/, tif]]);
    const source = await fetchCanopy(plan, config, client(fetch));
    expect(source.missing).toEqual([]);
    const [raster] = source.rasters;
    if (!raster) throw new Error('no raster');
    expect(raster).toMatchObject({ quadkey: 'q', west: 1020, north: 1960, resolution: 2 });
    expect([raster.width, raster.height]).toEqual([20, 20]);
    for (const [c, r] of [
      [0, 0],
      [19, 0],
      [7, 13],
      [19, 19],
    ] as const)
      expect(raster.heights[r * 20 + c]).toBe(value(10 + c, 20 + r));
    // The header, then the four blocks the window touches (read as one range: they are near).
    expect(fetch.calls.length).toBeLessThanOrEqual(3);
    // Stored compressed, and read back the same.
    const back = await unpackCanopy(await packCanopy(source));
    expect(back.rasters[0]?.heights).toEqual(raster.heights);
  });

  it('notes tiles the map does not have, and fails on a server that cannot read part of a file', async () => {
    const missing = await fetchCanopy(plan, config, client(rangeServer([[/q\.tif$/, null]])));
    expect(missing).toMatchObject({ rasters: [], missing: ['q'] });
    const tif = await canopyTiff(64, 16, 1000, 2000, 2, value);
    await expect(
      fetchCanopy(plan, config, client(rangeServer([[/q\.tif$/, tif]], [], false))),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('generating a battlefield with tree cover', () => {
  const request = battlefieldRequest(
    { lat: 38.5223, lon: -77.2934 },
    { name: 'Quantico', widthM: 1000 },
  );
  const pixels = (() => {
    const e = new Array<number>(TILE_SIZE * TILE_SIZE);
    for (let i = 0; i < e.length; i += 1) e[i] = 30 + (i % TILE_SIZE) * 0.1;
    return encodeTerrarium(e);
  })();
  const decode: DecodePng = () =>
    Promise.resolve({ data: pixels, width: TILE_SIZE, height: TILE_SIZE });
  const services: [RegExp, () => Response][] = [
    [/elevation-tiles-prod/, () => new Response(new Blob(['png']))],
    [/overpass/, () => new Response(JSON.stringify(quantico))],
  ];
  const config = (treeCover: 'canopy' | 'off'): ServiceConfig => ({
    ...DEFAULT_SERVICES,
    buildingSource: 'openstreetmap',
    treeCover,
    canopyTilesUrl: 'https://canopy/chm/',
  });

  it('reads no canopy when tree cover is off', async () => {
    const fetch = rangeServer([], services);
    const pkg = await generateBattlefield(request, {
      config: config('off'),
      store: createMemoryStore(),
      fetch,
      decodePng: decode,
    });
    expect(fetch.calls.some((u) => u.includes('canopy'))).toBe(false);
    expect(pkg.treeCover).toBeUndefined();
    expect(pkg.attribution).not.toContain(CANOPY_ATTRIBUTION);
  });

  it('adds the woods found, credits the map and keeps the heights with the sources', async () => {
    // Open ground everywhere: the step runs, adds nothing, and is recorded.
    const box = planCanopy(planBattlefield(request).frame).box;
    const res = 2;
    const size = 1024;
    const west = Math.floor(box.minX) - 10;
    const north = Math.ceil(box.maxY) + 10;
    const tif = await canopyTiff(size, 256, west, north, res, () => 0);
    const store = createMemoryStore();
    const progress: string[] = [];
    const pkg = await generateBattlefield(request, {
      config: config('canopy'),
      store,
      fetch: rangeServer([[/canopy\/chm\/\d+\.tif$/, tif]], services),
      decodePng: decode,
      onProgress: (p) => progress.push(p.step),
    });
    expect(progress).toContain('trees');
    expect(pkg.treeCover).toMatchObject({ source: 'meta-chm-v2', woods: 0, missingTiles: [] });
    expect(pkg.attribution).toContain(CANOPY_ATTRIBUTION);
    const sources = await store.getSources(pkg.id);
    expect(sources?.canopy?.rasters).toHaveLength(1);
  });

  it('builds the battlefield without them, and says so, when the canopy cannot be read', async () => {
    const pkg = await generateBattlefield(request, {
      config: config('canopy'),
      store: createMemoryStore(),
      fetch: rangeServer([[/canopy/, new Uint8Array(10)]], services, false),
      decodePng: decode,
      sleep: () => Promise.resolve(),
    });
    expect(pkg.treeCover).toBeUndefined();
    expect(pkg.processing.warnings.some((w) => w.startsWith('Woods were not added'))).toBe(true);
  });
});
