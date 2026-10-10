import { describe, expect, it } from 'vitest';
import { battlefieldRequest, encodeTerrarium, planBattlefield, TILE_SIZE } from '#geo';
import { encodeMvt, encodePmtiles, QUANTICO_OSM } from '#geo/fixtures';
import { DEFAULT_SERVICES, loadServiceConfig, type ServiceConfig } from './config';
import { generateBattlefield, type GenerationProgress } from './generate';
import { CancelledError, ServiceError, type FetchLike, type Sleep } from './http';
import {
  compareReleases,
  fetchOvertureBuildings,
  latestReleaseIn,
  OVERTURE,
  overtureRelease,
} from './overture';
import type { DecodePng } from './services';
import { createMemoryStore } from './store';

// Overture Maps buildings (docs/adr/0023): release discovery, reading tiles
// from a PMTiles archive by byte ranges, and generation with OpenStreetMap as
// the fallback. The network is faked; the archives are built in memory.

const noSleep: Sleep = (_ms, signal) =>
  signal?.aborted ? Promise.reject(new CancelledError()) : Promise.resolve();

const BASE = 'https://overture.example.test/tiles/';
const CONFIG: ServiceConfig = { ...DEFAULT_SERVICES, overtureTilesUrl: BASE };
const LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Prefix>tiles/</Prefix>
<CommonPrefixes><Prefix>tiles/2026-08-19.0/</Prefix></CommonPrefixes>
<CommonPrefixes><Prefix>tiles/2026-09-23.9/</Prefix></CommonPrefixes>
<CommonPrefixes><Prefix>tiles/2026-09-23.10/</Prefix></CommonPrefixes>
<CommonPrefixes><Prefix>tiles/scratch/</Prefix></CommonPrefixes>
</ListBucketResult>`;

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer(),
  );

/**
 * A fake network serving PMTiles archives by URL (with byte ranges, unless
 * `ignoreRange`), the bucket listing, and scripted responses for anything else.
 */
function network(
  archives: Record<string, Uint8Array>,
  other: (url: string) => Response | Promise<Response> = () => new Response('', { status: 404 }),
  { ignoreRange = false }: { ignoreRange?: boolean } = {},
): FetchLike & { calls: { url: string; range: string | null }[] } {
  const calls: { url: string; range: string | null }[] = [];
  const fn: FetchLike = (url, init) => {
    const range = new Headers(init?.headers).get('range');
    calls.push({ url, range });
    if (url.startsWith('https://overture.example.test/?list-type=2')) {
      return Promise.resolve(
        new Response(LISTING, { headers: { 'content-type': 'application/xml' } }),
      );
    }
    const archive = archives[url];
    if (!archive) return Promise.resolve(other(url));
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m || ignoreRange)
      return Promise.resolve(new Response(archive as BlobPart, { status: 200 }));
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), archive.length - 1);
    return Promise.resolve(
      new Response(archive.slice(start, end + 1) as BlobPart, {
        status: 206,
        headers: {
          'content-range': `bytes ${String(start)}-${String(end)}/${String(archive.length)}`,
        },
      }),
    );
  };
  return Object.assign(fn, { calls });
}

/** A 1 km battlefield at Quantico, and a building tile with one building at its centre. */
const request = battlefieldRequest(
  { lat: 38.5223, lon: -77.2934 },
  { name: 'Quantico', widthM: 1000 },
);
const plan = planBattlefield(request);
const centreTile = (() => {
  const extent = 4096;
  const world = extent * 2 ** 14;
  const { lat, lon } = request.centre;
  const gx = Math.round(((lon + 180) / 360) * world);
  const phi = (lat * Math.PI) / 180;
  const gy = Math.round(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * world);
  const x = Math.floor(gx / extent);
  const y = Math.floor(gy / extent);
  const lx = gx - x * extent;
  const ly = gy - y * extent;
  const data = encodeMvt([
    {
      name: 'building',
      features: [
        {
          type: 3,
          properties: {
            id: 'centre',
            height: 8,
            '@geometry_source': 'OpenStreetMap',
            sources: JSON.stringify([{ dataset: 'OpenStreetMap' }]),
          },
          geometry: [
            [
              [lx, ly],
              [lx + 30, ly],
              [lx + 30, ly + 30],
              [lx, ly + 30],
            ],
          ],
        },
      ],
    },
  ]);
  return { z: 14, x, y, data };
})();
const RELEASE = '2026-09-23.10';
const URL_ = `${BASE}${RELEASE}/buildings.pmtiles`;

describe('Overture releases', () => {
  it('are ordered by date, then by number', () => {
    expect(['2026-09-23.10', '2026-09-23.9', '2026-08-19.0'].sort(compareReleases)).toEqual([
      '2026-08-19.0',
      '2026-09-23.9',
      '2026-09-23.10',
    ]);
  });

  it('are found in the bucket listing, the newest chosen', async () => {
    expect(latestReleaseIn(LISTING, 'tiles/')).toBe('2026-09-23.10');
    expect(latestReleaseIn('<ListBucketResult/>', 'tiles/')).toBeNull();
    const fetch = network({});
    expect(await overtureRelease(CONFIG, { fetch })).toBe('2026-09-23.10');
    expect(fetch.calls[0]?.url).toBe(
      'https://overture.example.test/?list-type=2&delimiter=%2F&prefix=tiles%2F',
    );
  });

  it('can be pinned in the configuration, with no listing', async () => {
    const fetch = network({});
    expect(await overtureRelease({ ...CONFIG, overtureRelease: '2026-08-19.0' }, { fetch })).toBe(
      '2026-08-19.0',
    );
    expect(fetch.calls).toEqual([]);
  });
});

describe('fetchOvertureBuildings', () => {
  const others = plan.buildingTiles.filter((t) => t.x !== centreTile.x || t.y !== centreTile.y);

  it('reads the tiles a battlefield needs by byte ranges; tiles the archive lacks are empty', async () => {
    const archive = await encodePmtiles([centreTile]);
    const fetch = network({ [URL_]: archive });
    const progress: number[] = [];
    const result = await fetchOvertureBuildings(plan.buildingTiles, CONFIG, {
      fetch,
      onTile: (done) => progress.push(done),
    });
    expect(result.release).toBe(RELEASE);
    expect(result.url).toBe(URL_);
    expect(result.tiles.map((t) => [t.x, t.y, t.data !== null])).toEqual(
      plan.buildingTiles.map((t) => [t.x, t.y, t.x === centreTile.x && t.y === centreTile.y]),
    );
    expect(result.tiles.find((t) => t.data)?.data).toEqual(centreTile.data);
    expect(progress).toEqual(plan.buildingTiles.map((_, i) => i + 1));
    // The listing, the header with the root directory, and one range per tile present.
    expect(fetch.calls.map((c) => c.range)).toEqual([
      null,
      'bytes=0-16383',
      expect.stringMatching(/^bytes=\d+-\d+$/),
    ]);
    expect(others.length).toBeGreaterThan(0);
  });

  it('reads gzip-compressed archives with leaf directories', async () => {
    const tiles = [
      centreTile,
      ...others.map((t, i) => ({
        ...t,
        data: encodeMvt([{ name: 'building', features: [{ type: 1, geometry: [[[i, i]]] }] }]),
      })),
      { z: 14, x: 1, y: 1, data: encodeMvt([]) },
      { z: 14, x: 2, y: 9, data: encodeMvt([]) },
    ];
    const archive = await encodePmtiles(tiles, { leafSize: 2, compress: gzip });
    const result = await fetchOvertureBuildings(plan.buildingTiles, CONFIG, {
      fetch: network({ [URL_]: archive }),
    });
    for (const t of result.tiles) {
      expect(t.data).toEqual(tiles.find((s) => s.x === t.x && s.y === t.y)?.data);
    }
  });

  it('refuses a server that ignores byte ranges, rather than downloading the whole archive', async () => {
    const archive = await encodePmtiles([centreTile]);
    await expect(
      fetchOvertureBuildings(plan.buildingTiles, CONFIG, {
        fetch: network({ [URL_]: archive }, undefined, { ignoreRange: true }),
      }),
    ).rejects.toThrow(/does not support reading part of the archive/);
  });

  it('fails with an error naming Overture for archives it cannot use', async () => {
    const fail = async (archive: Uint8Array, pattern: RegExp) => {
      const error = await fetchOvertureBuildings(plan.buildingTiles, CONFIG, {
        fetch: network({ [URL_]: archive }),
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as ServiceError).service).toBe(OVERTURE);
      expect((error as Error).message).toMatch(pattern);
    };
    const archive = await encodePmtiles([centreTile]);
    const png = archive.slice();
    png[99] = 2;
    await fail(png, /does not hold vector tiles/);
    await fail(
      await encodePmtiles([{ ...centreTile, z: 12, x: 1, y: 1 }]),
      /has no tiles at zoom 14/,
    );
    await fail(new Uint8Array(200), /not a PMTiles archive/);
    // Directories marked gzip that are not.
    const bad = archive.slice();
    bad[97] = 2;
    await fail(bad, /could not be read/);
    // A release with no buildings archive at all (404).
    const missing = await fetchOvertureBuildings(plan.buildingTiles, CONFIG, {
      fetch: network({}),
    }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ServiceError);
    expect((missing as Error).message).toMatch(/Buildings \(Overture Maps\) failed: .*404/);
  });
});

describe('generating a battlefield with Overture buildings', () => {
  const pixels = encodeTerrarium(new Array<number>(TILE_SIZE * TILE_SIZE).fill(40));
  const decode: DecodePng = () =>
    Promise.resolve({ data: pixels, width: TILE_SIZE, height: TILE_SIZE });
  /** Overture (when an archive is given), elevation tiles and Overpass. */
  const services = (archive: Uint8Array | null) =>
    network(archive ? { [URL_]: archive } : {}, (url) => {
      if (url.includes('elevation-tiles-prod')) return new Response(new Blob(['png']));
      if (url.includes('overpass')) return new Response(JSON.stringify(QUANTICO_OSM));
      return new Response('', { status: 404 });
    });

  /** Wraps a fetch to record Overpass query bodies. */
  const recording =
    (inner: FetchLike, bodies: string[]): FetchLike =>
    (url, init) => {
      if (url.includes('overpass') && typeof init?.body === 'string')
        bodies.push(decodeURIComponent(init.body.slice(5)));
      return inner(url, init);
    };

  it('takes the buildings from Overture and asks OpenStreetMap for everything else', async () => {
    const store = createMemoryStore();
    const bodies: string[] = [];
    const progress: GenerationProgress[] = [];
    const pkg = await generateBattlefield(request, {
      config: CONFIG,
      store,
      fetch: recording(services(await encodePmtiles([centreTile])), bodies),
      decodePng: decode,
      sleep: noSleep,
      onProgress: (p) => progress.push(p),
    });
    expect(pkg.buildings?.source).toBe('overture');
    expect(pkg.buildings?.overture?.release).toBe(RELEASE);
    expect(pkg.terrain.features.buildings.map((b) => b.id)).toEqual(['ovt-centre']);
    expect(pkg.terrain.features.roads.length).toBeGreaterThan(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/building/);
    expect(pkg.osm.query).toBe(bodies[0]);
    expect(progress.map((p) => p.step)).toContain('buildings');
    expect(progress.filter((p) => p.step === 'buildings').at(-1)).toMatchObject({
      done: plan.buildingTiles.length,
      total: plan.buildingTiles.length,
    });
    // The tiles are saved with the other sources, so the battlefield can be rebuilt offline.
    const sources = await store.getSources(pkg.id);
    expect(sources?.overture?.release).toBe(RELEASE);
    expect(sources?.overture?.tiles.find((t) => t.data)?.data).toEqual(centreTile.data);
  });

  it('falls back to OpenStreetMap buildings when Overture cannot be reached, and says why', async () => {
    const store = createMemoryStore();
    const bodies: string[] = [];
    const progress: GenerationProgress[] = [];
    const pkg = await generateBattlefield(request, {
      config: CONFIG,
      store,
      fetch: recording(services(null), bodies),
      decodePng: decode,
      sleep: noSleep,
      onProgress: (p) => progress.push(p),
    });
    expect(pkg.buildings?.source).toBe('openstreetmap');
    expect(pkg.processing.counts.buildings).toBeGreaterThan(100);
    expect(bodies[0]).toMatch(/way\["building"\]/);
    expect(pkg.processing.warnings).toContainEqual(
      expect.stringMatching(
        /^Buildings are from OpenStreetMap: Overture Maps could not be used \(Buildings \(Overture Maps\) failed: .*404/,
      ),
    );
    expect(progress.map((p) => p.message)).toContain(
      'Overture Maps could not be reached: buildings will come from OpenStreetMap.',
    );
    expect((await store.getSources(pkg.id))?.overture).toBeNull();
  });

  it('does not contact Overture when OpenStreetMap is the configured building source', async () => {
    const fetch = services(await encodePmtiles([centreTile]));
    const pkg = await generateBattlefield(request, {
      config: { ...CONFIG, buildingSource: 'openstreetmap' },
      store: createMemoryStore(),
      fetch,
      decodePng: decode,
      sleep: noSleep,
    });
    expect(pkg.buildings?.source).toBe('openstreetmap');
    expect(fetch.calls.some((c) => c.url.includes('overture'))).toBe(false);
  });

  it('can be cancelled while the buildings download', async () => {
    const controller = new AbortController();
    const archive = await encodePmtiles([centreTile]);
    const inner = services(archive);
    const fetch: FetchLike = (url, init) => {
      if (url.includes('overture')) controller.abort();
      return inner(url, init);
    };
    const store = createMemoryStore();
    await expect(
      generateBattlefield(request, {
        config: CONFIG,
        store,
        fetch,
        decodePng: decode,
        sleep: noSleep,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(await store.list()).toEqual([]);
  });
});

describe('Overture settings', () => {
  it('can be changed, and invalid values are ignored and reported', () => {
    const store = (text: string) => ({ getItem: () => text });
    expect(
      loadServiceConfig(
        store(
          JSON.stringify({
            buildingSource: 'openstreetmap',
            overtureTilesUrl: 'https://mirror.example.test/tiles/',
            overtureRelease: '2026-08-19.0',
          }),
        ),
      ).config,
    ).toMatchObject({
      buildingSource: 'openstreetmap',
      overtureTilesUrl: 'https://mirror.example.test/tiles/',
      overtureRelease: '2026-08-19.0',
    });
    const { config, problems } = loadServiceConfig(
      store(
        JSON.stringify({
          buildingSource: 'google',
          overtureTilesUrl: 'ftp://x',
          overtureRelease: 'latest',
        }),
      ),
    );
    expect(config).toEqual(DEFAULT_SERVICES);
    expect(problems).toEqual([
      'buildingSource must be "overture" or "openstreetmap"',
      'overtureTilesUrl must be an http(s) URL',
      'overtureRelease must be empty or a release name such as "2026-09-23.1"',
    ]);
  });
});
