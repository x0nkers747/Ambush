import { describe, expect, it } from 'vitest';
import {
  battlefieldRequest,
  encodeTerrarium,
  planBattlefield,
  TILE_SIZE,
  type BattlefieldPackage,
} from '#geo';
import { QUANTICO_OSM as quantico } from '#geo/fixtures';
import { DEFAULT_SERVICES, loadServiceConfig, type ServiceConfig } from './config';
import { generateBattlefield, OsmUnavailableError, type GenerationProgress } from './generate';
import {
  CancelledError,
  createRateLimiter,
  fetchWithRetry,
  mapWithConcurrency,
  ServiceError,
  type FetchLike,
  type Sleep,
} from './http';
import { fetchOverpass, fetchTerrainTile, searchPlaces, tileUrl, type DecodePng } from './services';
import { createMemoryStore } from './store';

/** Records waits instead of waiting. */
function fakeSleep(): { sleep: Sleep; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms, signal) => {
      waits.push(ms);
      return signal?.aborted ? Promise.reject(new CancelledError()) : Promise.resolve();
    },
  };
}

/** A fake network: each call takes the next scripted response for a URL pattern. */
function fakeFetch(
  script: [RegExp, (() => Response | Promise<Response>)[]][],
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (url: string) => {
    calls.push(url);
    const entry = script.find(([re]) => re.test(url));
    const next = entry?.[1].length === 1 ? entry[1][0] : entry?.[1].shift();
    if (!next) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(next());
  };
  return Object.assign(fn, { calls });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchWithRetry', () => {
  it('retries gateway errors and network failures with backoff, then succeeds', async () => {
    const { sleep, waits } = fakeSleep();
    const fetch = fakeFetch([
      [
        /x/,
        [
          () => new Response('', { status: 504 }),
          () => Promise.reject(new TypeError('net')),
          () => json({ ok: 1 }),
        ],
      ],
    ]);
    const retries: string[] = [];
    const r = await fetchWithRetry(
      'https://x',
      {},
      { service: 'X', fetch, sleep, onRetry: (i) => retries.push(i.reason) },
    );
    expect(r.status).toBe(200);
    expect(waits).toEqual([2000, 5000]);
    expect(retries).toEqual([
      'the service answered HTTP 504',
      'the service could not be reached (network error)',
    ]);
  });

  it('waits 30 s after rate limiting, or as long as Retry-After says', async () => {
    const { sleep, waits } = fakeSleep();
    const fetch = fakeFetch([
      [/a/, [() => new Response('', { status: 429 }), () => json({})]],
      [
        /b/,
        [() => new Response('', { status: 503, headers: { 'retry-after': '7' } }), () => json({})],
      ],
    ]);
    await fetchWithRetry('https://a', {}, { service: 'A', fetch, sleep });
    await fetchWithRetry('https://b', {}, { service: 'B', fetch, sleep });
    expect(waits).toEqual([30000, 7000]);
  });

  it('gives up with a ServiceError that names the service', async () => {
    const { sleep } = fakeSleep();
    const fetch = fakeFetch([[/x/, [() => new Response('', { status: 502 })]]]);
    await expect(
      fetchWithRetry('https://x', {}, { service: 'Overpass', fetch, sleep, retries: 2 }),
    ).rejects.toThrow('Overpass failed after 3 attempts: the service answered HTTP 502.');
    const bad = fakeFetch([[/x/, [() => new Response('', { status: 400 })]]]);
    await expect(
      fetchWithRetry('https://x', {}, { service: 'Overpass', fetch: bad, sleep }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(bad.calls).toHaveLength(1); // 400 is not retried
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = fakeFetch([[/x/, [() => json({})]]]);
    await expect(
      fetchWithRetry('https://x', {}, { service: 'X', fetch, signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(fetch.calls).toEqual([]);
  });

  it('passes "not found" through when asked to (missing tiles)', async () => {
    const fetch = fakeFetch([[/x/, [() => new Response('', { status: 404 })]]]);
    const r = await fetchWithRetry('https://x', {}, { service: 'X', fetch, passStatuses: [404] });
    expect(r.status).toBe(404);
  });
});

describe('rate limiting and concurrency', () => {
  it('spaces calls at least the minimum interval apart', async () => {
    let t = 0;
    const waits: number[] = [];
    const limiter = createRateLimiter(
      1000,
      () => t,
      (ms) => {
        waits.push(ms);
        t += ms;
        return Promise.resolve();
      },
    );
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => limiter(() => Promise.resolve(order.push(n)))));
    expect(order).toEqual([1, 2, 3]);
    expect(waits).toEqual([1000, 1000]);
  });

  it('keeps results in order with limited concurrency', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('service configuration', () => {
  it('uses the defaults, overridden field by field by valid stored values', () => {
    expect(loadServiceConfig(null)).toEqual({ config: DEFAULT_SERVICES, problems: [] });
    const store = (text: string) => ({ getItem: () => text });
    const { config, problems } = loadServiceConfig(
      store(
        JSON.stringify({
          overpassEndpoints: ['https://my.overpass/api/interpreter'],
          terrainTileUrl: 'no',
          tileConcurrency: 2,
        }),
      ),
    );
    expect(config.overpassEndpoints).toEqual(['https://my.overpass/api/interpreter']);
    expect(config.terrainTileUrl).toBe(DEFAULT_SERVICES.terrainTileUrl);
    expect(config.tileConcurrency).toBe(2);
    expect(problems).toEqual(['terrainTileUrl must be an http(s) URL containing {z}, {x} and {y}']);
    expect(loadServiceConfig(store('{')).problems).toEqual(['ambush.services is not valid JSON']);
  });
});

describe('service clients', () => {
  const config: ServiceConfig = {
    ...DEFAULT_SERVICES,
    overpassEndpoints: ['https://one/i', 'https://two/i'],
  };

  it('falls back to the next Overpass endpoint, and treats error remarks as failures', async () => {
    const { sleep } = fakeSleep();
    const fetch = fakeFetch([
      [/one/, [() => new Response('', { status: 504 })]],
      [
        /two/,
        [
          () =>
            json({
              elements: [],
              remark: 'runtime error: Query timed out in "query" at line 3 after 91 seconds.',
            }),
          () => json({ elements: [{ type: 'node', id: 1 }] }),
        ],
      ],
    ]);
    const result = await fetchOverpass('[out:json];', config, { fetch, sleep });
    expect(result.endpoint).toBe('https://two/i');
    expect(result.response.elements).toHaveLength(1);
  });

  it('reports Overpass failure when every endpoint fails', async () => {
    const { sleep } = fakeSleep();
    const fetch = fakeFetch([[/./, [() => new Response('', { status: 504 })]]]);
    await expect(fetchOverpass('q', config, { fetch, sleep })).rejects.toThrow(
      /OpenStreetMap \(Overpass API\) failed after 4 attempts/,
    );
  });

  it('fetches and decodes a tile with its sources; a missing tile has no elevations', async () => {
    const pixels = encodeTerrarium(new Array<number>(TILE_SIZE * TILE_SIZE).fill(123.5));
    const decode: DecodePng = () =>
      Promise.resolve({ data: pixels, width: TILE_SIZE, height: TILE_SIZE });
    const fetch = fakeFetch([
      [
        /15\/1\/2\.png/,
        [
          () =>
            new Response(new Blob(['png']), {
              headers: { 'x-amz-meta-x-imagery-sources': 'srtm/N38W078.tif' },
            }),
        ],
      ],
      [/15\/9\/9\.png/, [() => new Response('', { status: 404 })]],
    ]);
    const tile = await fetchTerrainTile({ z: 15, x: 1, y: 2 }, DEFAULT_SERVICES, decode, { fetch });
    expect(tile.sources).toBe('srtm/N38W078.tif');
    expect(tile.elevations?.[0]).toBe(123.5);
    const missing = await fetchTerrainTile({ z: 15, x: 9, y: 9 }, DEFAULT_SERVICES, decode, {
      fetch,
    });
    expect(missing.elevations).toBeNull();
    expect(tileUrl('https://t/{z}/{x}/{y}.png', { z: 1, x: 2, y: 3 })).toBe('https://t/1/2/3.png');
  });

  it('searches places with Nominatim, rate limited, ignoring malformed results', async () => {
    const fetch = fakeFetch([
      [
        /search\?q=Quantico&format=jsonv2&limit=5/,
        [
          () =>
            json([
              { display_name: 'Quantico, Virginia', lat: '38.52', lon: '-77.29' },
              { display_name: 'bad' },
            ]),
        ],
      ],
    ]);
    const limiter = createRateLimiter(0);
    const results = await searchPlaces('  Quantico ', DEFAULT_SERVICES, { fetch, limiter });
    expect(results).toEqual([
      { name: 'Quantico, Virginia', position: { lat: 38.52, lon: -77.29 } },
    ]);
    expect(await searchPlaces('   ', DEFAULT_SERVICES, { fetch, limiter })).toEqual([]);
  });
});

describe('generating a battlefield', () => {
  // These tests script OpenStreetMap and the elevation tiles only; buildings from
  // Overture Maps (docs/adr/0023) are tested in overture.test.ts.
  const OSM_ONLY: ServiceConfig = { ...DEFAULT_SERVICES, buildingSource: 'openstreetmap' };
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
  const tileResponse = () =>
    new Response(new Blob(['png']), {
      headers: { 'x-amz-meta-x-imagery-sources': 'ned13/USGS_NED_13_n39w078_IMG.tif' },
    });

  it('downloads, builds and saves, reporting progress; the saved battlefield loads unchanged', async () => {
    const store = createMemoryStore();
    const fetch = fakeFetch([
      [/elevation-tiles-prod/, [tileResponse]],
      [/overpass/, [() => json(quantico)]],
    ]);
    const progress: GenerationProgress[] = [];
    const pkg = await generateBattlefield(request, {
      config: OSM_ONLY,
      store,
      fetch,
      decodePng: decode,
      onProgress: (p) => progress.push(p),
      now: () => new Date('2026-10-08T12:00:00Z'),
    });
    expect(pkg.terrain.heightfield.columns).toBe(101);
    expect(pkg.processing.counts.buildings).toBeGreaterThan(100);
    expect(pkg.elevation.finestResolutionM).toBe(10);
    expect(progress.map((p) => p.step)).toContain('osm');
    expect(progress.at(-1)?.step).toBe('saving');
    const tiles = planBattlefield(request).tiles.length;
    expect(progress.filter((p) => p.step === 'elevation').at(-1)).toMatchObject({
      done: tiles,
      total: tiles,
    });
    // Offline: the saved copy loads without the network and is identical.
    expect(await store.get(pkg.id)).toEqual(pkg);
    expect((await store.list()).map((s) => s.name)).toEqual(['Quantico']);
    const sources = await store.getSources(pkg.id);
    expect(sources?.tiles).toHaveLength(tiles);
    expect(sources?.overpassText).toContain('"elements"');
  });

  it('fails with an OSM-specific error, and can continue with terrain only', async () => {
    const { sleep } = fakeSleep();
    const store = createMemoryStore();
    const fetch = fakeFetch([
      [/elevation-tiles-prod/, [tileResponse]],
      [/overpass/, [() => new Response('', { status: 504 })]],
    ]);
    const options = { config: OSM_ONLY, store, fetch, decodePng: decode, sleep };
    await expect(generateBattlefield(request, options)).rejects.toBeInstanceOf(OsmUnavailableError);
    const pkg: BattlefieldPackage = await generateBattlefield(request, {
      ...options,
      allowMissingOsm: true,
    });
    expect(pkg.osm.available).toBe(false);
    expect(pkg.terrain.features.roads).toEqual([]);
  });

  it('fails clearly when the elevation service is unreachable, and saves nothing', async () => {
    const { sleep } = fakeSleep();
    const store = createMemoryStore();
    const fetch = fakeFetch([]);
    await expect(
      generateBattlefield(request, {
        config: OSM_ONLY,
        store,
        fetch,
        decodePng: decode,
        sleep,
      }),
    ).rejects.toThrow(
      /Elevation tiles \(AWS Terrain Tiles\) failed after 4 attempts: the service could not be reached/,
    );
    expect(await store.list()).toEqual([]);
  });

  it('can be cancelled, and saves nothing', async () => {
    const store = createMemoryStore();
    const controller = new AbortController();
    const fetch = fakeFetch([
      [/elevation-tiles-prod/, [() => (controller.abort(), tileResponse())]],
      [/overpass/, [() => json(quantico)]],
    ]);
    await expect(
      generateBattlefield(request, {
        config: OSM_ONLY,
        store,
        fetch,
        decodePng: decode,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(await store.list()).toEqual([]);
  });

  it('reports a damaged saved battlefield instead of loading it', async () => {
    const store = createMemoryStore();
    const fetch = fakeFetch([
      [/elevation-tiles-prod/, [tileResponse]],
      [/overpass/, [() => json(quantico)]],
    ]);
    const pkg = await generateBattlefield(request, {
      config: OSM_ONLY,
      store,
      fetch,
      decodePng: decode,
    });
    await store.put(
      {
        ...pkg,
        name: 'Renamed but id kept',
        terrain: { ...pkg.terrain, heightfield: { ...pkg.terrain.heightfield, elevations: [] } },
      },
      { overpassText: null, overpassEndpoint: '', tiles: [] },
    );
    await expect(store.get(pkg.id)).rejects.toThrow(/terrain is invalid/);
  });
});

describe('saved scenarios', () => {
  it('are kept per battlefield, apart from the package, and deleted with it', async () => {
    const store = createMemoryStore();
    await store.putScenario('bf-a', 'bf-a/1', { name: 'one', route: [1, 2] });
    await store.putScenario('bf-b', 'bf-b/1', { name: 'other' });
    await store.putScenario('bf-a', 'bf-a/1', { name: 'one, edited', route: [1, 2, 3] });
    expect(await store.listScenarios('bf-a')).toEqual([{ name: 'one, edited', route: [1, 2, 3] }]);
    expect(await store.listScenarios('bf-c')).toEqual([]);
    await store.delete('bf-a');
    expect(await store.listScenarios('bf-a')).toEqual([]);
    expect(await store.listScenarios('bf-b')).toEqual([{ name: 'other' }]);
  });
});
