import { describe, expect, it } from 'vitest';
import { validateFeatures, type Vec2 } from '#sim';
import {
  buildingAppearance,
  osmBuildingAttributes,
  parseBearing,
  parseColour,
  parseLength,
  parseLevels,
} from './building-tags';
import { createFrame, toGeo } from './frame';
import { DEFAULT_BUILDING_M, featuresFromOsm, STOREY_M, type OverpassResponse } from './osm';
import quantico from './test-data/quantico-va.overpass.json';

// Richer building and road attributes at import (docs/adr/0035): kept for
// display, checked, and never allowed to change the simulated building.

describe('parsing building tags', () => {
  it('reads colours by name and as hex, and refuses anything else', () => {
    expect(parseColour('#FFF')).toBe('#ffffff');
    expect(parseColour('#a1B2c3')).toBe('#a1b2c3');
    expect(parseColour('a1b2c3')).toBe('#a1b2c3');
    expect(parseColour('Light Grey')).toBe('#d3d3d3');
    expect(parseColour('terracotta')).toBe('#e2725b');
    for (const bad of ['#12', '#ggg', 'reddish', '', 42, undefined])
      expect(parseColour(bad)).toBeNull();
  });

  it('reads lengths in metres and feet, storeys and bearings', () => {
    expect(parseLength('12')).toBe(12);
    expect(parseLength('12,5 m')).toBe(12.5);
    expect(parseLength("30'")).toBeCloseTo(9.144, 3);
    expect(parseLength('30 ft')).toBeCloseTo(9.144, 3);
    for (const bad of ['-3', '0', 'tall', '3 storeys', '']) expect(parseLength(bad)).toBeNull();
    expect(parseLevels('2')).toBe(2);
    expect(parseLevels('2.5')).toBe(2.5);
    for (const bad of ['-1', '2.3', '1000', 'two']) expect(parseLevels(bad)).toBeNull();
    expect(parseBearing('SW')).toBe(225);
    expect(parseBearing('370')).toBe(10);
    expect(parseBearing('-90')).toBe(270);
    expect(parseBearing('sideways')).toBeNull();
  });

  it('normalises shapes and materials, and drops what is malformed or contradictory', () => {
    const a = buildingAppearance(
      osmBuildingAttributes({
        building: 'house',
        'building:levels': '2',
        'roof:shape': 'Hipped',
        'roof:material': 'roof_tiles',
        'roof:colour': 'red',
        'building:material': 'brick',
        'building:colour': '#eeddcc',
        'roof:orientation': 'across',
        'roof:direction': 'NE',
        'roof:angle': '40',
        'addr:country': 'de',
        height: '9',
        'roof:height': '3',
      }),
    );
    expect(a).toEqual({
      kind: 'house',
      levels: 2,
      heightMeters: 9,
      roofShape: 'hipped',
      roofHeightMeters: 3,
      roofAngleDegrees: 40,
      roofOrientation: 'across',
      roofDirectionDegrees: 45,
      roofMaterial: 'roof_tiles',
      wallMaterial: 'brick',
      roofColour: '#ff0000',
      wallColour: '#eeddcc',
      country: 'DE',
    });
    // Malformed values are left out; a roof taller than the building, and a
    // minimum height above the height, contradict it and are left out too.
    const b = buildingAppearance(
      osmBuildingAttributes({
        building: 'yes',
        'roof:shape': 'banana',
        'roof:material': 'cheese',
        'roof:colour': 'reddish',
        'building:levels': 'two',
        'roof:angle': '95',
        'roof:orientation': 'diagonal',
        'addr:country': 'Germany',
        height: '6',
        'roof:height': '8',
        min_height: '7',
      }),
    );
    expect(b).toEqual({ heightMeters: 6 });
    // `building=yes` alone says nothing.
    expect(buildingAppearance(osmBuildingAttributes({ building: 'yes' }))).toBeNull();
  });
});

describe('the OSM import', () => {
  const frame = createFrame({ lat: 38.5223, lon: -77.2934 }, 1000);
  const way = (id: number, tags: Record<string, string>, points: Vec2[]) => ({
    type: 'way' as const,
    id,
    tags,
    geometry: points.map((p) => toGeo(frame, p)),
  });
  const square = (cx: number, cy: number, h: number): Vec2[] => [
    { x: cx - h, y: cy - h },
    { x: cx + h, y: cy - h },
    { x: cx + h, y: cy + h },
    { x: cx - h, y: cy + h },
    { x: cx - h, y: cy - h },
  ];

  it('keeps building attributes for display, and never lets them change the simulated height', () => {
    const data: OverpassResponse = {
      elements: [
        way(
          1,
          {
            building: 'house',
            'building:levels': '2',
            'roof:shape': 'gabled',
            'roof:height': '3',
            min_height: '1',
          },
          square(0, 0, 5),
        ),
        way(2, { building: 'garage', 'roof:shape': 'flat' }, square(30, 0, 3)),
        way(3, { building: 'yes', height: '12', 'roof:height': '4' }, square(60, 0, 6)),
        way(4, { building: 'yes' }, square(90, 0, 6)),
      ],
    };
    const { features } = featuresFromOsm(data, frame);
    validateFeatures(features, (p) => Math.abs(p.x) <= 500 && Math.abs(p.y) <= 500);
    const [house, garage, tall, plain] = features.buildings;
    // Heights as before: storeys × 3 m, the 6 m default, or the tagged height.
    expect(house?.heightMeters).toBe(2 * STOREY_M);
    expect(garage?.heightMeters).toBe(DEFAULT_BUILDING_M);
    expect(tall?.heightMeters).toBe(12);
    expect(plain?.heightMeters).toBe(DEFAULT_BUILDING_M);
    // The roof height and minimum height are kept as metadata only.
    expect(house?.appearance).toEqual({
      kind: 'house',
      levels: 2,
      minHeightMeters: 1,
      roofShape: 'gabled',
      roofHeightMeters: 3,
    });
    expect(garage?.appearance).toEqual({ kind: 'garage', roofShape: 'flat' });
    expect(tall?.appearance).toEqual({ heightMeters: 12, roofHeightMeters: 4 });
    expect(plain?.appearance).toBeUndefined();
  });

  it('keeps mapped driveways as driveways, with their road class unchanged', () => {
    const data: OverpassResponse = {
      elements: [
        way(10, { highway: 'residential' }, [
          { x: -100, y: 0 },
          { x: 100, y: 0 },
        ]),
        way(11, { highway: 'service', service: 'driveway' }, [
          { x: 0, y: 0 },
          { x: 0, y: 30 },
        ]),
        way(12, { highway: 'service', service: 'Not Valid!' }, [
          { x: 20, y: 0 },
          { x: 20, y: 30 },
        ]),
      ],
    };
    const { features } = featuresFromOsm(data, frame);
    const [street, drive, odd] = features.roads;
    expect(street).toMatchObject({ roadClass: 'paved', highway: 'residential' });
    expect(street?.service).toBeUndefined();
    // Classed and sized exactly as before (so grading and the simulation are unchanged).
    expect(drive).toMatchObject({
      roadClass: 'paved',
      widthMeters: 6,
      highway: 'service',
      service: 'driveway',
    });
    expect(odd).toMatchObject({ highway: 'service' });
    expect(odd?.service).toBeUndefined();
  });

  it('finds the recorded Quantico houses, garages and driveways', () => {
    const { features } = featuresFromOsm(quantico as OverpassResponse, frame);
    const kinds = new Map<string, number>();
    for (const b of features.buildings) {
      const k = b.appearance?.kind ?? 'none';
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    expect(kinds.get('house') ?? 0).toBeGreaterThan(5);
    expect(features.roads.some((r) => r.service === 'driveway')).toBe(true);
    // Nothing new reaches the simulation's fields.
    for (const b of features.buildings) expect(b.heightMeters).toBeGreaterThan(0);
  });
});
