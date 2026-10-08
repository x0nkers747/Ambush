import { describe, expect, it } from 'vitest';
import { summarizeElevationSources } from './elevation-sources';
import { createFrame, geographicBounds, gridConvergenceDeg, toGeo, toLocal } from './frame';
import {
  battlefieldGrid,
  decodeTerrarium,
  encodeTerrarium,
  fillMissing,
  resampleToGrid,
  tilesForGrid,
  type ElevationTile,
} from './terrarium';
import {
  groundResolution,
  mercatorPixel,
  TILE_SIZE,
  tilesForPixelRange,
  wrapTileX,
  zoomForCellSize,
} from './tiles';
import { normalizeLon } from './utm';

describe('battlefield frame', () => {
  it('puts the local origin at the centre, rounded to the metre, x east and y north', () => {
    const frame = createFrame({ lat: 38.5223, lon: -77.2934 }, 1000);
    expect([frame.zone, frame.hemisphere, frame.epsg]).toEqual([18, 'N', 32618]);
    expect([frame.falseEasting, frame.falseNorthing]).toEqual([300070, 4266261]);
    const c = toLocal(frame, frame.centre);
    expect(Math.abs(c.x)).toBeLessThan(0.6);
    expect(Math.abs(c.y)).toBeLessThan(0.6);
    // 0.001° north is about 111 m north; 0.001° east about 87 m east at this latitude.
    const n = toLocal(frame, { lat: frame.centre.lat + 0.001, lon: frame.centre.lon });
    expect(n.y - c.y).toBeGreaterThan(110);
    const e = toLocal(frame, { lat: frame.centre.lat, lon: frame.centre.lon + 0.001 });
    expect(e.x - c.x).toBeGreaterThan(86);
    expect(Math.abs(e.y - c.y)).toBeLessThan(3);
  });

  it('round-trips local metres and WGS84', () => {
    for (const centre of [
      { lat: 49.717, lon: 11.906 },
      { lat: -33.86, lon: 151.2 },
      { lat: 0.001, lon: 179.9995 },
    ]) {
      const frame = createFrame(centre, 1000);
      for (const p of [
        { x: -500, y: -500 },
        { x: 500, y: 500 },
        { x: 123.4, y: -321.9 },
      ]) {
        const back = toLocal(frame, toGeo(frame, p));
        expect(Math.abs(back.x - p.x)).toBeLessThan(1e-6);
        expect(Math.abs(back.y - p.y)).toBeLessThan(1e-6);
      }
    }
  });

  it('bounds the battlefield plus margin in WGS84, splitting across the antimeridian', () => {
    const frame = createFrame({ lat: 38.5223, lon: -77.2934 }, 1000);
    const [box, ...rest] = geographicBounds(frame, 100);
    expect(rest).toEqual([]);
    if (!box) throw new Error('no box');
    // 600 m each way: about 0.0054° of latitude.
    expect(box.north - box.south).toBeCloseTo(1200 / 111000, 3);
    expect(box.south).toBeLessThan(38.5223);
    expect(box.north).toBeGreaterThan(38.5223);
    const dateline = createFrame({ lat: -16, lon: 179.999 }, 1000);
    const boxes = geographicBounds(dateline, 50);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.east).toBe(180);
    expect(boxes[1]?.west).toBe(-180);
    expect(boxes[1]?.east).toBeLessThan(-179.99);
  });

  it('reports grid convergence: zero on the central meridian, east of it positive in the north', () => {
    expect(Math.abs(gridConvergenceDeg(createFrame({ lat: 45, lon: -75 }, 1000)))).toBeLessThan(
      1e-6,
    );
    expect(gridConvergenceDeg(createFrame({ lat: 45, lon: -73 }, 1000))).toBeLessThan(0);
    expect(gridConvergenceDeg(createFrame({ lat: 45, lon: -77 }, 1000))).toBeGreaterThan(0);
  });

  it('refuses positions outside UTM and bad sizes', () => {
    expect(() => createFrame({ lat: 85, lon: 0 }, 1000)).toThrow(/outside the supported range/);
    expect(() => createFrame({ lat: 0, lon: 0 }, 0)).toThrow(/width/);
  });
});

describe('web mercator tiles', () => {
  it('addresses pixels like the slippy-map convention', () => {
    expect(mercatorPixel({ lat: 0, lon: 0 }, 0)).toEqual({ x: 128, y: 128 });
    const p = mercatorPixel({ lat: 38.5223, lon: -77.2934 }, 15);
    // The tile the Quantico header was read from: 15/9348/12579.
    expect(Math.floor(p.x / TILE_SIZE)).toBe(9348);
    expect(Math.floor(p.y / TILE_SIZE)).toBe(12579);
  });

  it('chooses the lowest zoom whose pixels are at most half a cell', () => {
    expect(groundResolution(0, 15)).toBeCloseTo(4.777, 3);
    expect(zoomForCellSize(0, 10)).toBe(15);
    expect(zoomForCellSize(60, 10)).toBe(14);
    expect(zoomForCellSize(0, 2)).toBe(15); // capped at the published maximum
  });

  it('wraps tile columns round the antimeridian', () => {
    expect(wrapTileX(-1, 2)).toBe(3);
    expect(wrapTileX(4, 2)).toBe(0);
    expect(tilesForPixelRange(2, -10, 300, 10, 310).map((t) => t.x)).toEqual([3, 0]);
  });
});

describe('Terrarium elevation', () => {
  it('decodes R·256 + G + B/256 − 32768 and round-trips the encoding', () => {
    expect(decodeTerrarium([128, 0, 0, 255], 1, 1)[0]).toBe(0);
    expect(decodeTerrarium([128, 100, 128, 255], 1, 1)[0]).toBe(100.5);
    expect(decodeTerrarium([127, 255, 0, 255], 1, 1)[0]).toBe(-1);
    const values = [0, 12.25, -400.5, 8848.75, 101.00390625];
    expect(Array.from(decodeTerrarium(encodeTerrarium(values), 5, 1))).toEqual(values);
    expect(() => decodeTerrarium([1, 2, 3], 1, 1)).toThrow(/RGBA bytes/);
  });

  /** Tiles whose elevation is a known function of global pixel position. */
  const syntheticTiles = (
    frame: ReturnType<typeof createFrame>,
    zoom: number,
    f: (gx: number, gy: number) => number,
    missing: (x: number, y: number) => boolean = () => false,
  ): ElevationTile[] =>
    tilesForGrid(frame, battlefieldGrid(frame, 10), zoom).map((t) => {
      if (missing(t.x, t.y)) return { ...t, elevations: null };
      const e = new Float32Array(TILE_SIZE * TILE_SIZE);
      for (let j = 0; j < TILE_SIZE; j += 1) {
        for (let i = 0; i < TILE_SIZE; i += 1) {
          // Value at the pixel centre.
          e[j * TILE_SIZE + i] = f(t.x * TILE_SIZE + i + 0.5, t.y * TILE_SIZE + j + 0.5);
        }
      }
      return { ...t, elevations: e };
    });

  it('resamples a 1 km battlefield onto a 101 × 101 grid at 10 m, exactly for a linear surface', () => {
    const frame = createFrame({ lat: 49.717, lon: 11.906 }, 1000);
    const grid = battlefieldGrid(frame, 10);
    expect([grid.columns, grid.rows, grid.originX, grid.originY]).toEqual([101, 101, -500, -500]);
    const zoom = zoomForCellSize(frame.centre.lat, 10);
    const f = (gx: number, gy: number) => 400 + 0.01 * (gx % 100000) - 0.02 * (gy % 100000);
    const tiles = syntheticTiles(frame, zoom, f);
    const { elevations, filled } = resampleToGrid(frame, grid, zoom, tiles);
    expect(filled).toBe(0);
    expect(elevations).toHaveLength(101 * 101);
    for (const [c, r] of [
      [0, 0],
      [50, 50],
      [100, 100],
      [17, 83],
    ] as const) {
      const g = toGeo(frame, { x: grid.originX + c * 10, y: grid.originY + r * 10 });
      const p = mercatorPixel(g, zoom);
      expect(Math.abs((elevations[r * 101 + c] ?? 0) - f(p.x, p.y))).toBeLessThan(0.02);
    }
  });

  it('fills samples in a missing tile from their neighbours, and refuses mostly missing data', () => {
    const frame = createFrame({ lat: 49.717, lon: 11.906 }, 1000);
    const grid = battlefieldGrid(frame, 10);
    const zoom = 15;
    const tiles = syntheticTiles(frame, zoom, () => 300);
    const first = tiles[0];
    if (!first) throw new Error('no tiles');
    const holed = syntheticTiles(
      frame,
      zoom,
      () => 300,
      (x, y) => x === first.x && y === first.y,
    );
    const result = resampleToGrid(frame, grid, zoom, holed, 0.9);
    expect(result.filled).toBeGreaterThan(0);
    expect(result.elevations.every((e) => e === 300)).toBe(true);
    expect(() =>
      resampleToGrid(
        frame,
        grid,
        zoom,
        holed.map((t) => ({ ...t, elevations: null })),
      ),
    ).toThrow(/missing for 100%/);
  });

  it('fills deterministically from neighbours', () => {
    const v = Float64Array.from([
      1,
      Number.NaN,
      3,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      7,
      Number.NaN,
      9,
    ]);
    expect(fillMissing(v, 3, 3)).toBe(5);
    expect(Array.from(v).every(Number.isFinite)).toBe(true);
    expect(v[4]).toBeCloseTo((1 + 2 + 3 + 4 + 6 + 7 + 8 + 9) / 8 - 0, 0);
  });

  it('handles a battlefield across the antimeridian', () => {
    const frame = createFrame({ lat: -16.5, lon: 179.9995 }, 1000);
    const zoom = 15;
    const tiles = tilesForGrid(frame, battlefieldGrid(frame, 10), zoom);
    const xs = new Set(tiles.map((t) => t.x));
    expect(xs.has(0)).toBe(true);
    expect(xs.has(2 ** zoom - 1)).toBe(true);
    const flat = tiles.map((t) => ({
      ...t,
      elevations: new Float32Array(TILE_SIZE * TILE_SIZE).fill(5),
    }));
    expect(
      resampleToGrid(frame, battlefieldGrid(frame, 10), zoom, flat).elevations.every(
        (e) => e === 5,
      ),
    ).toBe(true);
    expect(normalizeLon(frame.centre.lon)).toBeCloseTo(179.9995, 9);
  });
});

describe('elevation sources', () => {
  it('summarises resolution, surface model and attribution from tile headers', () => {
    const us = summarizeElevationSources([
      'ned/ned19_n38x75_w077x50_va_ninenortherncos_2011.tif, ned13/USGS_NED_13_n39w078_IMG.tif, srtm/N38W078.tif, gmted/30N090W_20101117_gmted_mea075.tif',
    ]);
    expect(us.finestResolutionM).toBe(3);
    expect(us.coarsestResolutionM).toBe(30);
    expect(us.surfaceModel).toBe('mixed');
    expect(us.attribution).toEqual(['Elevation data courtesy of the U.S. Geological Survey']);
    const de = summarizeElevationSources(['eudem/eudem_dem_5deg_n45e010.tif']);
    expect([de.finestResolutionM, de.surfaceModel]).toEqual([25, 'DSM']);
    const uk = summarizeElevationSources(['uk_lidar/LIDAR-DTM-2M-TQ37.tif']);
    expect([uk.finestResolutionM, uk.surfaceModel]).toEqual([2, 'DTM']);
    const tokyo = summarizeElevationSources(['srtm/N35E139.tif']);
    expect([tokyo.finestResolutionM, tokyo.surfaceModel]).toEqual([30, 'DSM']);
    const unknown = summarizeElevationSources(['mystery/x.tif']);
    expect([unknown.finestResolutionM, unknown.surfaceModel, unknown.unrecognised]).toEqual([
      null,
      'unknown',
      ['mystery/x.tif'],
    ]);
    // Only a background fill: its resolution is reported.
    expect(summarizeElevationSources(['gmted/x.tif']).finestResolutionM).toBe(225);
  });
});
