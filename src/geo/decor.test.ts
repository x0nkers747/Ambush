import { describe, expect, it } from 'vitest';
import { validateTerrain, type TerrainDataset } from '#sim';
import { crossingPaint, decorFromOsm, decorLineKind, decorPointKind, decorQuery } from './decor';
import { createFrame, toGeo } from './frame';
import {
  featuresFromOsm,
  overpassQuery,
  parseMaxspeed,
  roadTraffic,
  type OverpassResponse,
} from './osm';

// Mapped roadside details (docs/adr/0036): imported for display only.

const frame = createFrame({ lat: 49.717, lon: 11.906 }, 1000);
const rect = { minX: -500, minY: -500, maxX: 500, maxY: 500 };
const node = (id: number, x: number, y: number, tags: Record<string, string>) => ({
  type: 'node' as const,
  id,
  ...toGeo(frame, { x, y }),
  tags,
});
const way = (id: number, tags: Record<string, string>, pts: [number, number][]) => ({
  type: 'way' as const,
  id,
  tags,
  geometry: pts.map(([x, y]) => toGeo(frame, { x, y })),
});

describe('roadside details from OpenStreetMap', () => {
  it('asks Overpass for the details with targeted statements only', () => {
    const q = decorQuery([{ south: 1, west: 2, north: 3, east: 4 }]);
    expect(q).toContain('node["highway"~"^(street_lamp|stop|give_way)$"]');
    expect(q).toContain('node["natural"="tree"]');
    expect(q).toContain('way["power"~"^(line|minor_line)$"]');
    expect(q).toContain('way["barrier"~"^(fence|wall|retaining_wall|guard_rail|city_wall)$"]');
    // Never every node in the box.
    expect(q).not.toMatch(/node\(\d/);
    const full = overpassQuery([{ south: 1, west: 2, north: 3, east: 4 }]);
    expect(full).toContain('node["traffic_sign"]');
    expect(
      overpassQuery([{ south: 1, west: 2, north: 3, east: 4 }], { decor: false }),
    ).not.toContain('street_lamp');
  });

  it('classifies nodes and ways, keeping only what it draws', () => {
    expect(decorPointKind({ highway: 'street_lamp' })).toBe('streetLamp');
    expect(decorPointKind({ natural: 'tree' })).toBe('tree');
    expect(decorPointKind({ power: 'tower' })).toBe('powerTower');
    expect(decorPointKind({ highway: 'stop' })).toBe('trafficSign');
    expect(decorPointKind({ amenity: 'bench' })).toBe('bench');
    expect(decorPointKind({ amenity: 'restaurant' })).toBeNull();
    expect(decorLineKind({ barrier: 'retaining_wall' })).toBe('wall');
    expect(decorLineKind({ barrier: 'hedge' })).toBeNull(); // a vegetation area already (osm.ts)
    expect(decorLineKind({ power: 'minor_line' })).toBe('minorLine');
  });

  it('reads positions, attributes and lines, clipped to the battlefield', () => {
    const { decor, dropped } = decorFromOsm(
      [
        node(3, 10, 20, { natural: 'tree', leaf_type: 'needleleaved', height: '14 m' }),
        node(1, -5, 5, { highway: 'street_lamp' }),
        node(2, 0, 0, { traffic_sign: 'DE:206', height: 'tall' }),
        node(4, 900, 0, { highway: 'street_lamp' }), // off the battlefield
        { type: 'node' as const, id: 5, tags: { natural: 'tree' } }, // no position
        node(6, 0, 0, { shop: 'bakery' }),
        way(10, { barrier: 'fence', fence_type: 'chain_link', height: '2' }, [
          [-600, 0],
          [0, 0],
          [0, 100],
        ]),
        way(11, { power: 'line' }, [
          [-100, -100],
          [100, -100],
        ]),
      ],
      frame,
      rect,
    );
    expect(dropped).toBe(1);
    expect(decor.points.map((p) => p.id)).toEqual(['osm-n1', 'osm-n2', 'osm-n3']);
    const tree = decor.points.find((p) => p.kind === 'tree');
    expect(tree?.leafType).toBe('needleleaved');
    expect(tree?.heightMeters).toBe(14);
    expect(tree?.position.x).toBeCloseTo(10, 3);
    const sign = decor.points.find((p) => p.kind === 'trafficSign');
    expect(sign?.sign).toBe('de:206');
    expect(sign?.heightMeters).toBeUndefined();
    const fence = decor.lines.find((l) => l.kind === 'fence');
    expect(fence?.material).toBe('chain_link');
    expect(fence?.heightMeters).toBe(2);
    // Clipped at the battlefield's edge.
    expect(Math.min(...(fence?.points.map((p) => p.x) ?? []))).toBeCloseTo(-500, 3);
    expect(decor.lines.find((l) => l.kind === 'powerLine')?.points).toHaveLength(2);
  });

  it('comes out of the OSM import beside the features, with counts, and leaves them unchanged', () => {
    const data: OverpassResponse = {
      elements: [
        way(20, { highway: 'residential' }, [
          [-100, 0],
          [100, 0],
        ]),
        node(21, 5, 8, { highway: 'street_lamp' }),
        node(22, 15, 8, { highway: 'street_lamp' }),
      ],
    };
    const withDecor = featuresFromOsm(data, frame);
    const without = featuresFromOsm({ elements: data.elements.slice(0, 1) }, frame);
    expect(withDecor.features).toEqual(without.features);
    expect(withDecor.decor.points).toHaveLength(2);
    expect(withDecor.report.decor).toEqual({ streetLamp: 2 });
    expect(without.decor).toEqual({ points: [], lines: [] });
  });

  it('keeps terrain without details valid, and checks details when present', () => {
    const base: TerrainDataset = {
      formatVersion: 2,
      georef: null,
      heightfield: {
        originX: 0,
        originY: 0,
        cellSize: 10,
        columns: 2,
        rows: 2,
        elevations: [0, 0, 0, 0],
      },
      features: { roads: [], buildings: [], vegetation: [] },
    };
    expect(() => {
      validateTerrain(base);
    }).not.toThrow();
    expect(() => {
      validateTerrain({ ...base, decor: { points: [], lines: [] } });
    }).not.toThrow();
    expect(() => {
      validateTerrain({ ...base, decor: { points: 'nope' } } as unknown as TerrainDataset);
    }).toThrow(/decor/);
  });
});

describe('road attributes and crossings for road markings (docs/adr/0037)', () => {
  it('keeps traffic attributes for display, valid values only, with roads unchanged', () => {
    expect(
      roadTraffic({
        highway: 'primary',
        lanes: '4',
        'lanes:forward': '2',
        'lanes:backward': '2',
        oneway: 'no',
        surface: 'asphalt',
        maxspeed: '35 mph',
        lit: 'yes',
        overtaking: 'both',
        lane_markings: 'yes',
        divider: 'barrier',
        sidewalk: 'both',
      }),
    ).toEqual({
      lanes: 4,
      lanesForward: 2,
      lanesBackward: 2,
      oneway: 'no',
      surface: 'asphalt',
      maxspeedKmh: 56,
      lit: true,
      overtaking: 'yes',
      laneMarkings: true,
      divider: 'barrier',
      sidewalk: 'both',
    });
    // Malformed values are left out; roundabouts are one-way.
    expect(
      roadTraffic({ lanes: 'two', oneway: 'perhaps', maxspeed: 'fast', junction: 'roundabout' }),
    ).toEqual({
      oneway: 'yes',
      junction: 'roundabout',
    });
    expect(roadTraffic({ highway: 'residential' })).toBeNull();
    expect(parseMaxspeed('DE:urban')).toBe(50);
    expect(parseMaxspeed('DE:rural')).toBe(100);
    expect(parseMaxspeed('none')).toBeNull();
    // The importer keeps them on roads, without touching class or width.
    const data: OverpassResponse = {
      elements: [
        way(30, { highway: 'secondary', lanes: '2', oneway: 'yes' }, [
          [-100, 0],
          [100, 0],
        ]),
      ],
    };
    const [r] = featuresFromOsm(data, frame).features.roads;
    expect(r).toMatchObject({
      roadClass: 'major',
      widthMeters: 8,
      traffic: { lanes: 2, oneway: 'yes' },
    });
  });

  it('imports marked pedestrian crossings, and how they are painted', () => {
    expect(crossingPaint({ crossing: 'uncontrolled' })).toBe('lines');
    expect(crossingPaint({ crossing: 'uncontrolled', 'crossing:markings': 'zebra' })).toBe('zebra');
    expect(crossingPaint({ crossing_ref: 'zebra' })).toBe('zebra');
    expect(crossingPaint({ crossing: 'unmarked' })).toBeNull();
    expect(crossingPaint({ crossing: 'marked', 'crossing:markings': 'no' })).toBeNull();
    const { decor } = decorFromOsm(
      [
        node(40, 0, 0, { highway: 'crossing', crossing: 'marked', crossing_ref: 'zebra' }),
        node(41, 5, 0, { highway: 'crossing', crossing: 'unmarked' }),
      ],
      frame,
      rect,
    );
    expect(decor.points).toEqual([
      {
        id: 'osm-n40',
        kind: 'crossing',
        position: expect.anything() as unknown,
        crossing: 'zebra',
      },
    ]);
  });
});
