import { describe, expect, it } from 'vitest';
import { heightAt, isOnTerrain } from '#sim';
import { encodeMvt } from '#geo/fixtures';
import { toGeo } from './frame';
import type { OverpassResponse } from './osm';
import {
  BattlefieldPackageError,
  battlefieldRequest,
  buildBattlefield,
  formatCoordinates,
  OSM_ATTRIBUTION,
  parseBattlefieldPackage,
  planBattlefield,
  type BattlefieldInputs,
  type BattlefieldPackage,
} from './package';
import { OVERTURE_ATTRIBUTION, type OvertureTile } from './overture';
import { battlefieldGrid, type ElevationTile } from './terrarium';
import quantico from './test-data/quantico-va.overpass.json';
import { TILE_SIZE } from './tiles';

// The recorded OSM fixtures cover 1 km, so these tests use 1 km rather than the default size.
const REQUEST = battlefieldRequest(
  { lat: 38.5223, lon: -77.2934 },
  { name: 'Quantico', widthM: 1000 },
);

/** Tiles of a plane rising 1 m per pixel eastward, with US sources. */
function tiles(
  missing: (i: number) => boolean = () => false,
): (ElevationTile & { sources: string })[] {
  return planBattlefield(REQUEST).tiles.map((t, i) => {
    const e = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let j = 0; j < TILE_SIZE; j += 1) {
      for (let k = 0; k < TILE_SIZE; k += 1)
        e[j * TILE_SIZE + k] = 20 + ((t.x * TILE_SIZE + k) % 1000) * 0.05;
    }
    return {
      ...t,
      elevations: missing(i) ? null : e,
      sources:
        'ned/ned19_n38x75_w077x50_va_ninenortherncos_2011.tif, ned13/USGS_NED_13_n39w078_IMG.tif, srtm/N38W078.tif',
    };
  });
}

const inputs = (over: Partial<BattlefieldInputs> = {}): BattlefieldInputs => ({
  request: REQUEST,
  tiles: tiles(),
  elevationUrlTemplate: 'https://example.test/terrarium/{z}/{x}/{y}.png',
  osm: quantico as OverpassResponse,
  osmEndpoint: 'https://overpass.example.test/api/interpreter',
  createdAt: '2026-10-08T12:00:00Z',
  ...over,
});

/**
 * Overture building tiles for the request: three buildings near the centre
 * (two from OpenStreetMap, one machine-learned), in the centre tile; the
 * other tiles have none.
 */
function overtureTiles(): OvertureTile[] {
  const z = 14;
  const extent = 4096;
  const world = extent * 2 ** z;
  const { lat, lon } = REQUEST.centre;
  const gx = Math.round(((lon + 180) / 360) * world);
  const phi = (lat * Math.PI) / 180;
  const gy = Math.round(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * world);
  const cx = Math.floor(gx / extent);
  const cy = Math.floor(gy / extent);
  const square = (dx: number, dy: number): [number, number][] => [
    [gx - cx * extent + dx, gy - cy * extent + dy],
    [gx - cx * extent + dx + 20, gy - cy * extent + dy],
    [gx - cx * extent + dx + 20, gy - cy * extent + dy + 20],
    [gx - cx * extent + dx, gy - cy * extent + dy + 20],
  ];
  const sources = (dataset: string) => JSON.stringify([{ dataset }]);
  const data = encodeMvt([
    {
      name: 'building',
      features: [
        {
          type: 3,
          properties: {
            id: 'a',
            height: 9,
            '@geometry_source': 'OpenStreetMap',
            sources: sources('OpenStreetMap'),
          },
          geometry: [square(-100, 0)],
        },
        {
          type: 3,
          properties: {
            id: 'b',
            '@geometry_source': 'OpenStreetMap',
            sources: sources('OpenStreetMap'),
          },
          geometry: [square(0, 0)],
        },
        {
          type: 3,
          properties: {
            id: 'c',
            height: 4,
            '@geometry_source': 'Microsoft ML Buildings',
            sources: sources('Microsoft ML Buildings'),
          },
          geometry: [square(100, 0)],
        },
      ],
    },
  ]);
  return planBattlefield(REQUEST).buildingTiles.map((t) => ({
    ...t,
    data: t.x === cx && t.y === cy ? data : null,
  }));
}
const OVERTURE = {
  release: '2026-09-23.1',
  url: 'https://overture.example.test/tiles/2026-09-23.1/buildings.pmtiles',
};

describe('battlefield packages', () => {
  it('plans a 1 km battlefield: 10 m grid, Terrarium zoom 15 at this latitude, a few tiles', () => {
    const plan = planBattlefield(REQUEST);
    expect([REQUEST.widthM, REQUEST.heightM, REQUEST.cellSizeM]).toEqual([1000, 1000, 10]);
    expect(plan.zoom).toBe(15);
    expect(plan.tiles.length).toBeGreaterThanOrEqual(4);
    expect(plan.tiles.length).toBeLessThanOrEqual(9);
    expect(plan.osmQuery).toContain('out geom;');
  });

  it('plans 5 km battlefields by default: 501 × 501 samples at 10 m', () => {
    const request = battlefieldRequest({ lat: 38.5223, lon: -77.2934 });
    expect([request.widthM, request.heightM, request.cellSizeM]).toEqual([5000, 5000, 10]);
    expect(battlefieldGrid(planBattlefield(request).frame, request.cellSizeM)).toMatchObject({
      columns: 501,
      rows: 501,
      originX: -2500,
      originY: -2500,
    });
  });

  it('builds a georeferenced 101 × 101 terrain with OSM features, sources and attribution', () => {
    const pkg = buildBattlefield(inputs());
    const { heightfield } = pkg.terrain;
    expect([
      heightfield.columns,
      heightfield.rows,
      heightfield.cellSize,
      heightfield.originX,
    ]).toEqual([101, 101, 10, -500]);
    expect(pkg.terrain.formatVersion).toBe(3);
    expect(pkg.terrain.georef).toMatchObject({
      crs: 'EPSG:32618',
      falseEasting: 300070,
      falseNorthing: 4266261,
    });
    expect(pkg.terrain.metadata).toEqual({ elevationResolutionM: 3, surfaceModel: 'mixed' });
    expect(pkg.processing.counts.buildings).toBeGreaterThan(100);
    expect(pkg.osm.timestampOsmBase).toMatch(/^2026-10-08/);
    expect(pkg.attribution[0]).toBe(OSM_ATTRIBUTION);
    expect(pkg.attribution).toContain('Elevation data courtesy of the U.S. Geological Survey');
    expect(pkg.name).toBe('Quantico');
    expect(pkg.elevation.minM).toBeLessThan(pkg.elevation.maxM);
    // The terrain is the simulation's own: heightAt works across it.
    expect(isOnTerrain(pkg.terrain, 500, -500)).toBe(true);
    expect(Number.isFinite(heightAt(pkg.terrain, 0, 0))).toBe(true);
  });

  it('is deterministic: the same inputs give the same package and id', () => {
    const a = buildBattlefield(inputs());
    const b = buildBattlefield(inputs({ createdAt: '2027-01-01T00:00:00Z' }));
    expect(b.id).toBe(a.id);
    expect({ ...b, createdAt: a.createdAt }).toEqual(a);
  });

  it('survives JSON round trips, and refuses damaged or incompatible data', () => {
    const pkg = buildBattlefield(inputs());
    const copy = JSON.parse(JSON.stringify(pkg)) as BattlefieldPackage;
    expect(parseBattlefieldPackage(copy)).toEqual(pkg);
    expect(() => parseBattlefieldPackage({ ...copy, schemaVersion: 2 })).toThrow(
      /schema version 2 is not supported/,
    );
    expect(() => parseBattlefieldPackage({ ...copy, schema: 'x' })).toThrow(
      BattlefieldPackageError,
    );
    const tampered = JSON.parse(JSON.stringify(pkg)) as {
      terrain: { heightfield: { elevations: number[] } };
    };
    tampered.terrain.heightfield.elevations[0] = 9999;
    expect(() => parseBattlefieldPackage(tampered)).toThrow(/does not match its id/);
    const broken = JSON.parse(JSON.stringify(pkg)) as {
      terrain: { heightfield: { elevations: number[] } };
    };
    broken.terrain.heightfield.elevations.pop();
    expect(() => parseBattlefieldPackage(broken)).toThrow(/terrain is invalid/);
    expect(() => parseBattlefieldPackage('nonsense')).toThrow(/not an object/);
  });

  it('builds terrain only when OSM is unavailable, and says so', () => {
    const pkg = buildBattlefield(inputs({ osm: null }));
    expect(pkg.terrain.features.buildings).toEqual([]);
    expect(pkg.osm.available).toBe(false);
    expect(pkg.attribution).not.toContain(OSM_ATTRIBUTION);
    expect(pkg.processing.warnings).toContain(
      'OpenStreetMap data could not be fetched: the battlefield has terrain only.',
    );
  });

  // Buildings from Overture Maps (docs/adr/0023).
  it('takes the buildings from Overture when given, and everything else from OSM', () => {
    const osmOnly = buildBattlefield(inputs());
    const pkg = buildBattlefield(inputs({ overture: { ...OVERTURE, tiles: overtureTiles() } }));
    expect(pkg.terrain.features.buildings.map((b) => [b.id, b.heightMeters])).toEqual([
      ['ovt-a', 9],
      ['ovt-b', 6],
      ['ovt-c', 4],
    ]);
    expect(pkg.processing.counts.buildings).toBe(3);
    // OSM's own buildings are not used; the rest of OSM is.
    expect({ ...pkg.terrain.features, buildings: [] }).toEqual({
      ...osmOnly.terrain.features,
      buildings: [],
    });
    expect(pkg.osm.query).toBe(planBattlefield(REQUEST).osmQueryWithoutBuildings);
    expect(pkg.osm.query).not.toMatch(/building/);
    expect(osmOnly.osm.query).toMatch(/way\["building"\]/);
    expect(pkg.buildings).toEqual({
      source: 'overture',
      overture: {
        ...OVERTURE,
        zoom: 14,
        tiles: planBattlefield(REQUEST).buildingTiles.map((t) => ({
          z: t.z,
          x: t.x,
          y: t.y,
          missing: !overtureTiles().find((o) => o.x === t.x && o.y === t.y)?.data,
        })),
        bySource: { OpenStreetMap: 2, 'Microsoft ML Buildings': 1 },
        datasets: ['Microsoft ML Buildings', 'OpenStreetMap'],
        merged: 0,
        heights: { data: 2, floors: 0, defaulted: 1 },
      },
    });
    expect(pkg.attribution.slice(0, 3)).toEqual([
      OSM_ATTRIBUTION,
      OVERTURE_ATTRIBUTION,
      'Global ML Building Footprints, licensed by Microsoft under the ODbL',
    ]);
    expect(osmOnly.buildings).toEqual({ source: 'openstreetmap', overture: null });
    // Deterministic, and survives a JSON round trip.
    const again = buildBattlefield(inputs({ overture: { ...OVERTURE, tiles: overtureTiles() } }));
    expect(again).toEqual(pkg);
    expect(parseBattlefieldPackage(JSON.parse(JSON.stringify(pkg)))).toEqual(pkg);
  });

  it('says why when the buildings had to come from OSM', () => {
    const pkg = buildBattlefield(
      inputs({
        overture: null,
        overtureProblem: 'Buildings (Overture Maps) failed: network error',
      }),
    );
    expect(pkg.buildings?.source).toBe('openstreetmap');
    expect(pkg.processing.counts.buildings).toBeGreaterThan(100);
    expect(pkg.processing.warnings).toContain(
      'Buildings are from OpenStreetMap: Overture Maps could not be used (Buildings (Overture Maps) failed: network error).',
    );
  });

  it('keeps Overture buildings when OSM is unavailable, crediting OSM for those drawn from it', () => {
    const pkg = buildBattlefield(
      inputs({ osm: null, overture: { ...OVERTURE, tiles: overtureTiles() } }),
    );
    expect(pkg.terrain.features.buildings).toHaveLength(3);
    expect(pkg.terrain.features.roads).toEqual([]);
    expect(pkg.osm.available).toBe(false);
    expect(pkg.attribution[0]).toBe(OSM_ATTRIBUTION);
    expect(pkg.processing.warnings).toContain(
      'OpenStreetMap data could not be fetched: the battlefield has terrain and buildings only (no roads, vegetation or water).',
    );
  });

  it('reads packages made before buildings were recorded (importer 1.0)', () => {
    const old = JSON.parse(JSON.stringify(buildBattlefield(inputs()))) as Record<string, unknown>;
    delete old['buildings'];
    expect(parseBattlefieldPackage(old)).toEqual(old);
  });

  it('handles incomplete elevation data: fills small gaps, refuses large ones', () => {
    // A patch of no-data pixels in the middle of the battlefield.
    const plan = planBattlefield(REQUEST);
    const centre = plan.tiles.length > 0 ? toGeo(plan.frame, { x: 0, y: 0 }) : REQUEST.centre;
    const holed = tiles().map((t) => {
      if (!t.elevations) return t;
      const e = Float32Array.from(t.elevations);
      const world = TILE_SIZE * 2 ** t.z;
      const px = ((centre.lon + 180) / 360) * world - t.x * TILE_SIZE;
      const phi = (centre.lat * Math.PI) / 180;
      const py =
        ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * world - t.y * TILE_SIZE;
      for (let j = Math.floor(py) - 4; j <= Math.floor(py) + 4; j += 1) {
        for (let i = Math.floor(px) - 4; i <= Math.floor(px) + 4; i += 1) {
          if (i >= 0 && j >= 0 && i < TILE_SIZE && j < TILE_SIZE) e[j * TILE_SIZE + i] = Number.NaN;
        }
      }
      return { ...t, elevations: e };
    });
    const patched = buildBattlefield(inputs({ tiles: holed }));
    expect(patched.elevation.filledSamples).toBeGreaterThan(0);
    expect(patched.terrain.heightfield.elevations.every(Number.isFinite)).toBe(true);
    expect(
      patched.processing.warnings.some((w) => w.includes('filled from their neighbours')),
    ).toBe(true);
    // A whole missing tile is about a quarter or more of a 1 km battlefield: refused, not invented.
    expect(() => buildBattlefield(inputs({ tiles: tiles((i) => i === 0) }))).toThrow(
      /Elevation data unavailable: elevation data is missing for \d+% of the battlefield/,
    );
    expect(() => buildBattlefield(inputs({ tiles: tiles(() => true) }))).toThrow(
      /missing for 100%/,
    );
  });

  it('formats coordinates and names unnamed battlefields by them', () => {
    expect(formatCoordinates({ lat: -33.86, lon: 151.2 })).toBe('33.86000° S, 151.20000° E');
    const unnamed = buildBattlefield(
      inputs({ request: battlefieldRequest({ lat: 38.5223, lon: -77.2934 }, { widthM: 1000 }) }),
    );
    expect(unnamed.name).toBe('38.52230° N, 77.29340° W');
    expect(() => battlefieldRequest({ lat: 86, lon: 0 })).toThrow(/outside the supported range/);
  });

  it('keeps OSM features where they belong: a feature’s centre maps back near its source', () => {
    const pkg = buildBattlefield(inputs());
    const plan = planBattlefield(REQUEST);
    const b = pkg.terrain.features.buildings[0];
    if (!b) throw new Error('no buildings');
    const c = b.footprint.reduce(
      (s, p) => ({ x: s.x + p.x / b.footprint.length, y: s.y + p.y / b.footprint.length }),
      { x: 0, y: 0 },
    );
    const g = toGeo(plan.frame, c);
    expect(Math.abs(g.lat - 38.5223)).toBeLessThan(0.006);
    expect(Math.abs(g.lon + 77.2934)).toBeLessThan(0.007);
  });
});
