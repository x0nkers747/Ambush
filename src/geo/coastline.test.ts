import { describe, expect, it } from 'vitest';
import { isSimplePolygon, pointInPolygon, polygonArea, validateFeatures, type Vec2 } from '#sim';
import type { Rect } from './clip';
import { joinCoastlines, seaFromCoastlines } from './coastline';
import { createFrame, toGeo } from './frame';
import { featuresFromOsm, overpassQuery, type OverpassResponse } from './osm';

// The sea from OpenStreetMap coastlines: drawn with the land on the left and
// the water on the right, closed along the battlefield's edge.

const R: Rect = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
const pt = (x: number, y: number): Vec2 => ({ x, y });
const area = (r: ReturnType<typeof seaFromCoastlines>) =>
  r.areas.reduce(
    (s, a) => s + polygonArea(a.boundary) - a.holes.reduce((h, p) => h + polygonArea(p), 0),
    0,
  );
const isSea = (r: ReturnType<typeof seaFromCoastlines>, p: Vec2) =>
  r.areas.some((a) => pointInPolygon(p, a.boundary) && !a.holes.some((h) => pointInPolygon(p, h)));

describe('the sea from coastlines', () => {
  it('puts the sea on the right of a coastline crossing the battlefield', () => {
    // Heading north along x = 0: land to the west, sea to the east.
    const north = seaFromCoastlines([[pt(0, -200), pt(0, 200)]], R);
    expect(north.problem).toBeNull();
    expect(area(north)).toBeCloseTo(20000);
    expect(isSea(north, pt(50, 0))).toBe(true);
    expect(isSea(north, pt(-50, 0))).toBe(false);
    // The same shore drawn southwards: the sea is to the west.
    const south = seaFromCoastlines([[pt(0, 200), pt(0, -200)]], R);
    expect(isSea(south, pt(-50, 0))).toBe(true);
    expect(isSea(south, pt(50, 0))).toBe(false);
  });

  it('handles a headland and a shore across a corner', () => {
    // A headland reaching up from the south edge, the land on the left: drawn
    // northwards on its east side and back south on its west side.
    const headland = seaFromCoastlines([[pt(20, -200), pt(20, 40), pt(-20, 40), pt(-20, -200)]], R);
    expect(isSea(headland, pt(0, 0))).toBe(false);
    expect(isSea(headland, pt(-60, -60))).toBe(true);
    expect(isSea(headland, pt(60, -60))).toBe(true);
    expect(isSea(headland, pt(0, 80))).toBe(true);
    expect(area(headland)).toBeCloseTo(40000 - 40 * 140);
    // Drawn the other way round, the same outline is an inlet of sea between land.
    const inlet = seaFromCoastlines([[pt(-20, -200), pt(-20, 40), pt(20, 40), pt(20, -200)]], R);
    expect(isSea(inlet, pt(0, 0))).toBe(true);
    expect(isSea(inlet, pt(-60, -60))).toBe(false);
    expect(area(inlet)).toBeCloseTo(40 * 140);
    // A shore heading north-east across the south-east corner: the sea is the corner.
    const corner = seaFromCoastlines([[pt(0, -150), pt(150, 0)]], R);
    expect(area(corner)).toBeCloseTo(1250);
    expect(isSea(corner, pt(90, -90))).toBe(true);
  });

  it('joins coastline ways that meet inside the battlefield, in drawing order', () => {
    const a = [
      { lat: 0, lon: 0 },
      { lat: 1, lon: 0 },
    ];
    const b = [
      { lat: 1, lon: 0 },
      { lat: 2, lon: 1 },
    ];
    const c = [
      { lat: -1, lon: 0 },
      { lat: 0, lon: 0 },
    ];
    expect(joinCoastlines([a, b, c])).toEqual([
      [
        { lat: -1, lon: 0 },
        { lat: 0, lon: 0 },
        { lat: 1, lon: 0 },
        { lat: 2, lon: 1 },
      ],
    ]);
    // In metres: one shore in two ways joined at the battlefield's centre gives one sea.
    const joined = seaFromCoastlines([[pt(0, -200), pt(0, 0), pt(0, 200)]], R);
    expect(joined.areas).toHaveLength(1);
    expect(area(joined)).toBeCloseTo(20000);
  });

  it('makes islands holes in the sea, and an island alone means sea all round it', () => {
    // An island drawn counter-clockwise (land inside, on the left), off a coast.
    const island = [pt(40, -10), pt(60, -10), pt(60, 10), pt(40, 10), pt(40, -10)];
    const withCoast = seaFromCoastlines([[pt(0, -200), pt(0, 200)], island], R);
    expect(withCoast.areas[0]?.holes).toHaveLength(1);
    expect(isSea(withCoast, pt(50, 0))).toBe(false);
    expect(isSea(withCoast, pt(80, 0))).toBe(true);
    expect(area(withCoast)).toBeCloseTo(20000 - 400);
    const alone = seaFromCoastlines([island], R);
    expect(area(alone)).toBeCloseTo(40000 - 400);
    expect(isSea(alone, pt(-80, 80))).toBe(true);
  });

  it('handles a large island crossing the edge whose outline starts inside', () => {
    // Land inside (counter-clockwise), starting at a corner inside the battlefield.
    const big = [pt(-50, -50), pt(300, -50), pt(300, 300), pt(-50, 300), pt(-50, -50)];
    const r = seaFromCoastlines([big], R);
    expect(r.problem).toBeNull();
    expect(area(r)).toBeCloseTo(40000 - 150 * 150);
    expect(isSea(r, pt(-80, -80))).toBe(true);
    expect(isSea(r, pt(50, 50))).toBe(false);
  });

  it('draws no sea from a coastline that ends inside the battlefield, and says so', () => {
    const r = seaFromCoastlines([[pt(0, -200), pt(0, 20)]], R);
    expect(r.areas).toEqual([]);
    expect(r.problem).toMatch(/incomplete data/);
  });

  it('leaves a battlefield with no coastline all land', () => {
    expect(seaFromCoastlines([], R)).toEqual({ areas: [], problem: null });
  });
});

describe('the sea in the OSM import', () => {
  const FRAME = createFrame({ lat: -30.110829, lon: 153.200007 }, 1000);

  it('asks Overpass for coastlines', () => {
    expect(overpassQuery([{ south: 0, west: 0, north: 1, east: 1 }])).toContain(
      'way["natural"="coastline"]',
    );
  });

  it('turns a coastline into a valid water area on the sea side', () => {
    // A shore heading north 100 m east of the centre: the sea lies east of it.
    const response: OverpassResponse = {
      elements: [
        {
          type: 'way',
          id: 7,
          tags: { natural: 'coastline' },
          geometry: [pt(100, -800), pt(100, 800)].map((p) => toGeo(FRAME, p)),
        },
      ],
    };
    const { features, report } = featuresFromOsm(response, FRAME);
    const sea = features.water.filter((w) => w.id.startsWith('osm-sea'));
    expect(sea).toHaveLength(1);
    const s = sea[0];
    expect(s?.source?.ref).toBe('osm:natural=coastline');
    expect(s && isSimplePolygon(s.boundary)).toBe(true);
    expect(s && pointInPolygon(pt(300, 0), s.boundary)).toBe(true);
    expect(s && pointInPolygon(pt(-300, 0), s.boundary)).toBe(false);
    expect(s && polygonArea(s.boundary)).toBeCloseTo(400 * 1000, -3);
    expect(report.counts.water).toBe(1);
    expect(report.warnings).toEqual([]);
    expect(() => {
      validateFeatures(features, (p) => Math.abs(p.x) <= 500 && Math.abs(p.y) <= 500);
    }).not.toThrow();
  });
});
