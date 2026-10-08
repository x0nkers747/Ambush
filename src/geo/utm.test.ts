import { describe, expect, it } from 'vitest';
import { fromUtm, normalizeLon, toUtm, utmEpsg, utmZone, validateLatLon } from './utm';

/**
 * Reference coordinates from PROJ (pyproj, EPSG:4326 → EPSG:326zz/327zz):
 * latitude, longitude, zone, hemisphere, easting, northing.
 */
const PROJ: readonly [number, number, number, 'N' | 'S', number, number][] = [
  [38.5223, -77.2934, 18, 'N', 300069.9769, 4266260.7304], // Quantico, Virginia
  [49.717, 11.906, 32, 'N', 709469.8252, 5511220.2166], // Grafenwöhr, Germany
  [-33.86, 151.2, 56, 'S', 333491.2299, 6251909.206], // Sydney
  [0.0, 3.0, 31, 'N', 500000.0, 0.0], // equator on a central meridian
  [-1.29, 36.82, 37, 'S', 257422.7797, 9857312.0679], // Nairobi
  [60.4, 10.5, 32, 'N', 582649.6392, 6696900.4052], // Norway exception (would be 32 anyway)
  [83.9, -30.0, 26, 'N', 464424.3198, 9317856.4661], // northern limit
  [-79.9, 170.0, 59, 'S', 480423.389, 1129407.4826], // southern limit
  [51.4778, -0.0015, 30, 'N', 708213.9506, 5707224.5426], // Greenwich
  [64.0, -21.0, 27, 'N', 500000.0, 7097014.1626], // Iceland, on the central meridian
  [45.5, -73.6, 18, 'N', 609377.3474, 5039449.713], // Montreal
  [10.0, 179.999, 60, 'N', 828818.9983, 1106907.8557], // just west of the antimeridian
  [-45.0, -179.999, 1, 'S', 263632.7893, 5012673.4156], // just east of it
];

describe('UTM', () => {
  it.each(PROJ)('projects %f, %f like PROJ (zone %i%s)', (lat, lon, zone, hemi, e, n) => {
    expect(utmZone({ lat, lon })).toBe(zone);
    const u = toUtm({ lat, lon });
    expect(u.zone).toBe(zone);
    expect(u.hemisphere).toBe(hemi);
    expect(Math.abs(u.easting - e)).toBeLessThan(0.001);
    expect(Math.abs(u.northing - n)).toBeLessThan(0.001);
  });

  it.each(PROJ)('inverts %f, %f to within a millimetre', (lat, lon, zone, hemi, e, n) => {
    const p = fromUtm({ zone, hemisphere: hemi, easting: e, northing: n });
    // 1e-8° is about 1 mm.
    expect(Math.abs(p.lat - lat)).toBeLessThan(1e-8);
    expect(Math.abs(normalizeLon(p.lon - lon))).toBeLessThan(1e-8);
  });

  it('round-trips across every zone, both hemispheres and beyond the zone edge', () => {
    for (let zone = 1; zone <= 60; zone += 1) {
      for (const lat of [-79.5, -45, -0.001, 0.001, 30, 60, 83.5]) {
        for (const off of [-3.5, -2.9, 0, 1.7, 3.5]) {
          const lon = normalizeLon(zone * 6 - 183 + off);
          const u = toUtm({ lat, lon }, zone);
          const back = fromUtm(u);
          expect(Math.abs(back.lat - lat)).toBeLessThan(1e-9);
          expect(Math.abs(normalizeLon(back.lon - lon))).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('applies the Norway and Svalbard zone exceptions', () => {
    expect(utmZone({ lat: 60, lon: 5 })).toBe(32); // would be 31
    expect(utmZone({ lat: 55.9, lon: 5 })).toBe(31);
    expect(utmZone({ lat: 78, lon: 8 })).toBe(31);
    expect(utmZone({ lat: 78, lon: 10 })).toBe(33); // would be 32
    expect(utmZone({ lat: 78, lon: 22 })).toBe(35); // would be 34
    expect(utmZone({ lat: 78, lon: 35 })).toBe(37); // would be 36
    expect(utmZone({ lat: 0, lon: 180 })).toBe(1); // 180° is −180°
    expect(utmZone({ lat: 0, lon: 179.99 })).toBe(60);
  });

  it('gives EPSG codes and refuses positions outside UTM', () => {
    expect(utmEpsg(18, 'N')).toBe(32618);
    expect(utmEpsg(56, 'S')).toBe(32756);
    expect(() => {
      validateLatLon({ lat: 85, lon: 0 });
    }).toThrow(/outside the supported range/);
    expect(() => {
      validateLatLon({ lat: -80.5, lon: 0 });
    }).toThrow(/outside the supported range/);
    expect(() => {
      validateLatLon({ lat: 10, lon: 181 });
    }).toThrow(/longitude/);
    expect(() => {
      validateLatLon({ lat: Number.NaN, lon: 0 });
    }).toThrow(/finite/);
    expect(() => {
      validateLatLon({ lat: 84, lon: -180 });
    }).not.toThrow();
  });
});
