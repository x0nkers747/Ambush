import { describe, expect, it } from 'vitest';
import { NO_FEATURES, type EnvironmentFeatures, type Vec2 } from '#sim';
import { encodeTiff, QUANTICO_CENTRE } from '#geo/fixtures';
import {
  canopyGrid,
  canopyOnGrid,
  mercatorMetres,
  parseTiffHeader,
  planCanopy,
  quadkey,
  TiffTruncatedError,
  treeCoverFromCanopy,
  type CanopyRaster,
} from './canopy';
import { createFrame, toLocal } from './frame';
import type { WoodGrid } from './woods';

// Tree cover from canopy heights (docs/adr/0050).

const R = 6378137;
const fromMercator = (x: number, y: number) => ({
  lat: ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI,
  lon: (x / R) * (180 / Math.PI),
});
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe('the canopy map’s tiles', () => {
  it('names tiles by quadkey and finds the one under Quantico', () => {
    expect(quadkey(0, 0, 1)).toBe('0');
    expect(quadkey(1, 1, 1)).toBe('3');
    expect(quadkey(3, 5, 3)).toBe('213');
    const plan = planCanopy(createFrame(QUANTICO_CENTRE, 5000));
    expect(plan.tiles.map((t) => t.quadkey)).toEqual(['0320102102']);
    const [tile] = plan.tiles;
    if (!tile) throw new Error('no tile');
    expect(plan.box.minX).toBeGreaterThan(tile.box.minX);
    expect(plan.box.maxY).toBeLessThan(tile.box.maxY);
    // The battlefield and its margin: a little over 5 km at this latitude's scale (1.28).
    expect(plan.box.maxX - plan.box.minX).toBeGreaterThan(5000 * 1.27);
  });

  it('reads a tiled GeoTIFF’s header, and asks for more bytes when it is cut short', () => {
    const blocks = [0, 1, 2, 3].map((b) => new Uint8Array(16 * 16).fill(b + 1));
    const bytes = encodeTiff({
      width: 32,
      height: 32,
      block: 16,
      blocks,
      compression: 1,
      west: 1000,
      north: 2000,
      resolution: 1.5,
    });
    const [image] = parseTiffHeader(bytes);
    expect(image).toMatchObject({
      width: 32,
      height: 32,
      tileWidth: 16,
      bitsPerSample: 8,
      compression: 1,
      tileByteCounts: [256, 256, 256, 256],
      pixelScale: [1.5, 1.5, 0],
      tiepoint: [0, 0, 0, 1000, 2000, 0],
    });
    expect(() => parseTiffHeader(bytes.subarray(0, 100))).toThrow(TiffTruncatedError);
  });
});

describe('canopy heights on the battlefield’s grid', () => {
  it('puts each height at its place in the battlefield’s frame', () => {
    const frame = createFrame(QUANTICO_CENTRE, 400);
    const plan = planCanopy(frame);
    // A raster over the plan: 20 m tall over the local square ±50 m, open ground elsewhere.
    const res = 1.2;
    const width = Math.ceil((plan.box.maxX - plan.box.minX) / res);
    const height = Math.ceil((plan.box.maxY - plan.box.minY) / res);
    const heights = new Uint8Array(width * height);
    for (let r = 0; r < height; r += 1)
      for (let c = 0; c < width; c += 1) {
        const g = fromMercator(plan.box.minX + (c + 0.5) * res, plan.box.maxY - (r + 0.5) * res);
        const p = toLocal(frame, g);
        if (Math.abs(p.x) < 50 && Math.abs(p.y) < 50) heights[r * width + c] = 20;
      }
    const raster: CanopyRaster = {
      quadkey: 'x',
      west: plan.box.minX,
      north: plan.box.maxY,
      resolution: res,
      width,
      height,
      heights,
    };
    const grid = canopyGrid(frame);
    expect(grid).toEqual({ x0: -200, y0: -200, width: 400, height: 400 });
    const out = canopyOnGrid(frame, grid, [raster]);
    const at = (x: number, y: number) => out[(y - grid.y0) * grid.width + (x - grid.x0)];
    expect(at(0, 0)).toBe(20);
    expect(at(45, -45)).toBe(20);
    expect(at(100, 100)).toBe(0);
    // The edge is where it should be, to within a pixel.
    expect(at(-53, 0)).toBe(0);
    expect(at(-47, 0)).toBe(20);
    // A sanity check of the Mercator conversion used.
    const m = mercatorMetres(QUANTICO_CENTRE.lat, QUANTICO_CENTRE.lon);
    const back = fromMercator(m.x, m.y);
    expect(back.lat).toBeCloseTo(QUANTICO_CENTRE.lat, 9);
  });
});

describe('woods from canopy heights', () => {
  const grid: WoodGrid = { x0: -300, y0: -300, width: 600, height: 600 };
  /** Heights with the canopy map 6 m east and 8 m south of the true places, as satellite maps are. */
  const heightsFor = (shapes: { box: [number, number, number, number]; m: number }[]) => {
    const h = new Uint8Array(grid.width * grid.height);
    for (const { box, m } of shapes) {
      const [x0, y0, x1, y1] = box;
      for (let y = y0 - 8; y < y1 - 8; y += 1)
        for (let x = x0 + 6; x < x1 + 6; x += 1) h[(y - grid.y0) * grid.width + (x - grid.x0)] = m;
    }
    return h;
  };
  const mappedWood = {
    id: 'mapped',
    kind: 'woodland' as const,
    boundary: rect(-250, -250, -50, -50),
    canopyHeightMeters: 20,
    seeThroughMeters: 40,
  };
  const features: EnvironmentFeatures = {
    ...NO_FEATURES,
    vegetation: [mappedWood],
    roads: [
      {
        id: 'road',
        roadClass: 'paved',
        widthMeters: 6,
        centerline: [
          { x: 0, y: -300 },
          { x: 0, y: 300 },
        ],
      },
    ],
  };
  const heights = heightsFor([
    { box: [-250, -250, -50, -50], m: 25 }, // the mapped wood
    { box: [100, 100, 160, 140], m: 18 }, // a wood OSM does not map
    { box: [-200, 200, -100, 201], m: 12 }, // a line of masts (one cell wide)
    { box: [-2, 50, 2, 80], m: 15 }, // trees over the road
  ]);

  it('lines the map up with the mapped woods and adds only the unmapped wood', () => {
    const { areas, report } = treeCoverFromCanopy(heights, grid, features);
    expect(report.aligned).toBe(true);
    expect(report.shiftM).toEqual([6, -8]);
    expect(report.mappedWoodsFound).toBeGreaterThan(0.95);
    expect(areas).toHaveLength(1);
    const [wood] = areas;
    if (!wood) throw new Error('no wood');
    expect(wood).toMatchObject({
      id: 'canopy-1',
      kind: 'woodland',
      canopyHeightMeters: 18,
      source: { ref: 'meta-chm-v2' },
    });
    // At its true place (within the 1 m cells' edges).
    const xs = wood.boundary.map((p) => p.x);
    const ys = wood.boundary.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(100, 0);
    expect(Math.max(...xs)).toBeCloseTo(160, 0);
    expect(Math.min(...ys)).toBeCloseTo(100, 0);
    expect(Math.max(...ys)).toBeCloseTo(140, 0);
    expect(report.woods).toBe(1);
    expect(report.areaM2).toBe(60 * 40);
  });

  it('uses the map as published where there are too few mapped woods to line it up with', () => {
    const { areas, report } = treeCoverFromCanopy(heights, grid, {
      ...features,
      vegetation: [],
    });
    expect(report.aligned).toBe(false);
    expect(report.shiftM).toEqual([0, 0]);
    // The (unmapped) big wood, the small one and the trees over the road, now beside it:
    // 6 m east and 8 m south of their places.
    expect(areas).toHaveLength(3);
    const small = areas.find((a) => a.canopyHeightMeters === 18);
    expect(Math.min(...(small?.boundary ?? []).map((p) => p.x))).toBeCloseTo(106, 0);
  });

  it('is deterministic', () => {
    const a = treeCoverFromCanopy(heights, grid, features);
    const b = treeCoverFromCanopy(heights, grid, features);
    expect(b).toEqual(a);
  });
});
