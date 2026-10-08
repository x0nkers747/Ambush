import { describe, expect, it } from 'vitest';
import { isOnTerrain, isSimplePolygon, validateFeatures, type Vec2 } from '#sim';
import { createFrame, toGeo } from './frame';
import {
  assembleRings,
  featuresFromOsm,
  overpassQuery,
  parseMetres,
  type OverpassResponse,
} from './osm';
import grafenwoehr from './test-data/grafenwoehr-de.overpass.json';
import quantico from './test-data/quantico-va.overpass.json';

const QUANTICO = createFrame({ lat: 38.5223, lon: -77.2934 }, 1000);
const GRAFENWOEHR = createFrame({ lat: 49.717, lon: 11.906 }, 1000);
const onMap = (p: Vec2) => p.x >= -500 && p.x <= 500 && p.y >= -500 && p.y <= 500;

describe('OSM import of recorded real-world data', () => {
  it.each([
    ['Quantico, Virginia', quantico as OverpassResponse, QUANTICO],
    ['Grafenwöhr, Germany', grafenwoehr as OverpassResponse, GRAFENWOEHR],
  ])('produces valid features for %s, all inside the battlefield', (_name, data, frame) => {
    const { features, report } = featuresFromOsm(data, frame);
    expect(() => {
      validateFeatures(features, onMap);
    }).not.toThrow();
    for (const b of features.buildings) expect(isSimplePolygon(b.footprint)).toBe(true);
    expect(report.counts.buildings).toBeGreaterThan(100);
    expect(report.counts.roads).toBeGreaterThan(30);
    expect(report.timestampOsmBase).toMatch(/^2026-10-08T/);
    // Every element of the real data was usable.
    expect(report.dropped).toEqual([]);
    // Deterministic: the same input gives the same output.
    expect(featuresFromOsm(data, frame)).toEqual({ features, report });
  });

  it('finds the Potomac, woods and a stream at Quantico', () => {
    const { features } = featuresFromOsm(quantico as OverpassResponse, QUANTICO);
    const river = features.water.find((w) => w.source?.ref === 'osm:relation/11880156');
    expect(river?.kind).toBe('water');
    expect(features.vegetation.some((v) => v.kind === 'woodland')).toBe(true);
    expect(features.waterways.some((w) => w.kind === 'stream')).toBe(true);
    expect(features.water.some((w) => w.kind === 'wetland')).toBe(true);
  });

  it('finds the town, its roads and the forest multipolygon at Grafenwöhr', () => {
    const { features } = featuresFromOsm(grafenwoehr as OverpassResponse, GRAFENWOEHR);
    expect(features.roads.some((r) => r.roadClass === 'major')).toBe(true);
    expect(features.roads.some((r) => r.roadClass === 'track')).toBe(true);
    expect(features.landUse.some((l) => l.kind === 'residential')).toBe(true);
    expect(features.waterways.length).toBeGreaterThan(0);
  });

  it('records estimated values and keeps tagged ones', () => {
    const { features } = featuresFromOsm(grafenwoehr as OverpassResponse, GRAFENWOEHR);
    const estimated = features.buildings.filter((b) =>
      b.source?.estimated?.includes('heightMeters'),
    );
    expect(estimated.length).toBeGreaterThan(0);
    // Estimated: the 6 m default, or storeys × 3 m.
    expect(estimated.every((b) => b.heightMeters === 6 || b.heightMeters % 3 === 0)).toBe(true);
    for (const v of features.vegetation)
      expect(v.source?.estimated).toContain('canopyHeightMeters');
  });
});

describe('OSM import rules', () => {
  /** A synthetic response with ways placed by local metres. */
  const way = (id: number, tags: Record<string, string>, points: Vec2[], frame = QUANTICO) => ({
    type: 'way' as const,
    id,
    tags,
    geometry: points.map((p) => toGeo(frame, p)),
  });
  const sq = (cx: number, cy: number, h: number): Vec2[] => {
    const r = [
      { x: cx - h, y: cy - h },
      { x: cx + h, y: cy - h },
      { x: cx + h, y: cy + h },
      { x: cx - h, y: cy + h },
    ];
    return [...r, r[0] ?? { x: 0, y: 0 }];
  };

  it('clips features to the battlefield and skips those outside it', () => {
    const data: OverpassResponse = {
      elements: [
        way(1, { highway: 'residential' }, [
          { x: -900, y: 0 },
          { x: 900, y: 0 },
        ]),
        way(2, { building: 'yes' }, sq(2000, 2000, 10)),
        way(3, { natural: 'wood' }, sq(450, 0, 100)),
      ],
    };
    const { features } = featuresFromOsm(data, QUANTICO);
    expect(features.roads).toHaveLength(1);
    expect(features.roads[0]?.centerline.every(onMap)).toBe(true);
    expect(features.roads[0]?.centerline.map((p) => Math.round(p.x))).toEqual([-500, 500]);
    expect(features.buildings).toHaveLength(0);
    expect(features.vegetation[0]?.boundary.every(onMap)).toBe(true);
  });

  it('maps tags to classes, widths and heights', () => {
    const line = [
      { x: -100, y: 0 },
      { x: 100, y: 0 },
    ];
    const data: OverpassResponse = {
      elements: [
        way(10, { highway: 'primary' }, line),
        way(11, { highway: 'track' }, line),
        way(12, { highway: 'footway' }, line),
        way(13, { highway: 'service', surface: 'gravel', width: '3.5' }, line),
        way(14, { highway: 'construction' }, line),
        way(15, { building: 'house', 'building:levels': '2' }, sq(0, 100, 5)),
        way(16, { building: 'yes', height: '12 m' }, sq(0, 150, 5)),
        way(17, { waterway: 'river' }, line),
        way(18, { natural: 'water' }, sq(-200, -200, 30)),
        way(19, { landuse: 'farmland' }, sq(200, -200, 30)),
        way(20, { natural: 'tree_row' }, [
          { x: -50, y: 300 },
          { x: 50, y: 300 },
        ]),
        way(21, { landuse: 'forest' }, sq(200, 200, 30)),
        way(22, { natural: 'wetland' }, sq(-200, 200, 30)),
      ],
    };
    const { features, report } = featuresFromOsm(data, QUANTICO);
    expect(features.roads.map((r) => [r.id, r.roadClass, r.widthMeters])).toEqual([
      ['osm-w10', 'major', 8],
      ['osm-w11', 'track', 3],
      ['osm-w12', 'path', 1.5],
      ['osm-w13', 'unpaved', 3.5],
    ]);
    expect(
      features.buildings.map((b) => [b.id, b.heightMeters, b.source?.estimated ?? []]),
    ).toEqual([
      ['osm-w15', 6, ['heightMeters']], // 2 storeys × 3 m: estimated
      ['osm-w16', 12, []],
    ]);
    expect(features.waterways).toMatchObject([{ id: 'osm-w17', kind: 'river', widthMeters: 12 }]);
    expect(features.water.map((w) => w.kind)).toEqual(['water', 'wetland']);
    expect(features.landUse).toMatchObject([{ kind: 'farmland' }]);
    expect(features.vegetation.map((v) => v.kind)).toEqual(['treeLine', 'woodland']);
    expect(report.counts).toEqual({
      roads: 4,
      buildings: 2,
      vegetation: 2,
      water: 2,
      waterways: 1,
      landUse: 1,
    });
    // Every id is unique.
    const all = [
      ...features.roads,
      ...features.buildings,
      ...features.vegetation,
      ...features.water,
      ...features.waterways,
      ...features.landUse,
    ];
    expect(new Set(all.map((f) => f.id)).size).toBe(all.length);
  });

  it('drops broken geometry with a reason instead of failing', () => {
    const bowtie = [
      { x: 0, y: 0 },
      { x: 20, y: 20 },
      { x: 20, y: 0 },
      { x: 0, y: 20 },
      { x: 0, y: 0 },
    ];
    const data: OverpassResponse = {
      elements: [
        way(30, { building: 'yes' }, bowtie),
        way(31, { natural: 'wood' }, [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
          { x: 50, y: 50 },
        ]), // not closed
        { type: 'way', id: 32, tags: { highway: 'path' }, geometry: [null, null] },
      ],
    };
    const { features, report } = featuresFromOsm(data, QUANTICO);
    expect(features.buildings).toEqual([]);
    expect(features.vegetation).toEqual([]);
    expect(report.dropped).toEqual([
      { ref: 'osm:way/30', reason: 'self-intersecting outline' },
      { ref: 'osm:way/31', reason: 'area outline is not closed' },
      { ref: 'osm:way/32', reason: 'missing geometry' },
    ]);
  });

  it('assembles multipolygon rings from member ways, with holes', () => {
    const outerA = [
      { x: -100, y: -100 },
      { x: 100, y: -100 },
      { x: 100, y: 100 },
    ].map((p) => toGeo(QUANTICO, p));
    const outerB = [
      { x: 100, y: 100 },
      { x: -100, y: 100 },
      { x: -100, y: -100 },
    ].map((p) => toGeo(QUANTICO, p));
    const inner = sq(0, 0, 20).map((p) => toGeo(QUANTICO, p));
    const data: OverpassResponse = {
      elements: [
        {
          type: 'relation',
          id: 40,
          tags: { type: 'multipolygon', natural: 'wood' },
          members: [
            { type: 'way', ref: 1, role: 'outer', geometry: outerA },
            { type: 'way', ref: 2, role: 'outer', geometry: [...outerB].reverse() },
            { type: 'way', ref: 3, role: 'inner', geometry: inner },
          ],
        },
      ],
    };
    const { features } = featuresFromOsm(data, QUANTICO);
    expect(features.vegetation).toHaveLength(1);
    expect(features.vegetation[0]?.id).toBe('osm-r40');
    expect(features.vegetation[0]?.holes).toHaveLength(1);
    expect(
      assembleRings([
        [
          { lat: 0, lon: 0 },
          { lat: 1, lon: 0 },
        ],
      ]),
    ).toEqual({ rings: [], unclosed: 1 });
  });

  it('parses metric tag values only', () => {
    expect([
      parseMetres('12'),
      parseMetres('12 m'),
      parseMetres('7,5'),
      parseMetres("40'"),
      parseMetres('tall'),
    ]).toEqual([12, 12, 7.5, null, null]);
  });

  it('builds one query covering every box', () => {
    const q = overpassQuery([
      { south: 1, west: 179.99, north: 1.01, east: 180 },
      { south: 1, west: -180, north: 1.01, east: -179.99 },
    ]);
    expect(q).toMatch(/^\[out:json\]\[timeout:90\];/);
    expect(q).toContain('way["highway"](1.000000,179.990000,1.010000,180.000000);');
    expect(q).toContain('way["highway"](1.000000,-180.000000,1.010000,-179.990000);');
    expect(q.trim().endsWith('out geom;')).toBe(true);
  });
});

describe('terrain bounds check used above', () => {
  it('matches the simulation’s inclusive edge rule', () => {
    expect(
      isOnTerrain(
        {
          formatVersion: 2,
          georef: null,
          heightfield: {
            originX: -500,
            originY: -500,
            cellSize: 10,
            columns: 101,
            rows: 101,
            elevations: [],
          },
          features: { roads: [], buildings: [], vegetation: [] },
        },
        500,
        -500,
      ),
    ).toBe(true);
  });
});
