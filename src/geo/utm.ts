// Universal Transverse Mercator on WGS84 (docs/adr/0006, docs/adr/0014).
//
// Forward and inverse transverse Mercator by the Krüger series to sixth order
// in the third flattening n (C. F. F. Karney, "Transverse Mercator with an
// accuracy of a few nanometers", J. Geodesy 85, 2011). Within a UTM zone and
// several degrees beyond it, this is accurate to well under a millimetre.
// Tested against PROJ. Pure arithmetic: deterministic on any JavaScript engine
// to within floating-point rounding.

/** A geographic position: WGS84 latitude and longitude in degrees. */
export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

export type Hemisphere = 'N' | 'S';

/** A UTM coordinate: easting and northing in metres within a zone and hemisphere. */
export interface UtmPoint {
  readonly zone: number;
  readonly hemisphere: Hemisphere;
  readonly easting: number;
  readonly northing: number;
}

/** UTM is defined from 80° S to 84° N; the polar regions use UPS, which Ambush! does not support. */
export const UTM_MIN_LAT = -80;
export const UTM_MAX_LAT = 84;

const A_AXIS = 6378137;
const FLATTENING = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500000;
const FALSE_NORTHING_SOUTH = 10000000;

const N = FLATTENING / (2 - FLATTENING);
const E = Math.sqrt(FLATTENING * (2 - FLATTENING));
const n2 = N * N;
const n3 = n2 * N;
const n4 = n3 * N;
const n5 = n4 * N;
const n6 = n5 * N;
/** Radius of the rectifying sphere. */
const A = (A_AXIS / (1 + N)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);

const ALPHA = [
  N / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180 - (127 * n5) / 288 + (7891 * n6) / 37800,
  (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440 + (281 * n5) / 630 - (1983433 * n6) / 1935360,
  (61 * n3) / 240 - (103 * n4) / 140 + (15061 * n5) / 26880 + (167603 * n6) / 181440,
  (49561 * n4) / 161280 - (179 * n5) / 168 + (6601661 * n6) / 7257600,
  (34729 * n5) / 80640 - (3418889 * n6) / 1995840,
  (212378941 * n6) / 319334400,
];
const BETA = [
  N / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360 - (81 * n5) / 512 + (96199 * n6) / 604800,
  n2 / 48 + n3 / 15 - (437 * n4) / 1440 + (46 * n5) / 105 - (1118711 * n6) / 3870720,
  (17 * n3) / 480 - (37 * n4) / 840 - (209 * n5) / 4480 + (5569 * n6) / 90720,
  (4397 * n4) / 161280 - (11 * n5) / 504 - (830251 * n6) / 7257600,
  (4583 * n5) / 161280 - (108847 * n6) / 3991680,
  (20648693 * n6) / 638668800,
];

const RAD = Math.PI / 180;

/** Throws a RangeError unless `p` is a finite position UTM can represent. */
export function validateLatLon(p: LatLon): void {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
    throw new RangeError('latitude and longitude must be finite numbers');
  }
  if (p.lat < UTM_MIN_LAT || p.lat > UTM_MAX_LAT) {
    throw new RangeError(
      `latitude ${String(p.lat)} is outside the supported range ${String(UTM_MIN_LAT)}° to ${String(UTM_MAX_LAT)}°`,
    );
  }
  if (p.lon < -180 || p.lon > 180) {
    throw new RangeError(`longitude ${String(p.lon)} is outside −180° to 180°`);
  }
}

/** A longitude normalized to [−180, 180). */
export function normalizeLon(lon: number): number {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Object.is(l, -0) ? 0 : l;
}

/**
 * The UTM zone (1–60) of a position, with the standard exceptions for
 * south-west Norway (zone 32 widened) and Svalbard (zones 31, 33, 35, 37), so
 * that grid references match published maps.
 */
export function utmZone(p: LatLon): number {
  const lon = normalizeLon(p.lon);
  const { lat } = p;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) return 31;
    if (lon >= 9 && lon < 21) return 33;
    if (lon >= 21 && lon < 33) return 35;
    if (lon >= 33 && lon < 42) return 37;
  }
  return Math.min(60, Math.floor((lon + 180) / 6) + 1);
}

/** Central meridian of a UTM zone, in degrees. */
export function centralMeridian(zone: number): number {
  return zone * 6 - 183;
}

/** The EPSG code of a WGS84 UTM zone: 326zz north, 327zz south. */
export function utmEpsg(zone: number, hemisphere: Hemisphere): number {
  return (hemisphere === 'N' ? 32600 : 32700) + zone;
}

/**
 * Projects a position into a UTM zone: by default its own, but any nearby zone
 * may be forced (a battlefield uses the zone of its centre throughout).
 */
export function toUtm(
  p: LatLon,
  zone = utmZone(p),
  hemisphere: Hemisphere = p.lat >= 0 ? 'N' : 'S',
): UtmPoint {
  const phi = p.lat * RAD;
  let dLon = normalizeLon(p.lon - centralMeridian(zone));
  if (dLon >= 180) dLon -= 360;
  const lambda = dLon * RAD;
  const sinPhi = Math.sin(phi);
  // Tangent of the conformal latitude.
  const t = Math.sinh(Math.atanh(sinPhi) - E * Math.atanh(E * sinPhi));
  const xiP = Math.atan2(t, Math.cos(lambda));
  const etaP = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + t * t));
  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 6; j += 1) {
    const a = ALPHA[j - 1] ?? 0;
    xi += a * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += a * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }
  return {
    zone,
    hemisphere,
    easting: FALSE_EASTING + K0 * A * eta,
    northing: K0 * A * xi + (hemisphere === 'S' ? FALSE_NORTHING_SOUTH : 0),
  };
}

/** Inverse of `toUtm`: the WGS84 position of a UTM coordinate. Longitude in [−180, 180). */
export function fromUtm(u: UtmPoint): LatLon {
  const xi = (u.northing - (u.hemisphere === 'S' ? FALSE_NORTHING_SOUTH : 0)) / (K0 * A);
  const eta = (u.easting - FALSE_EASTING) / (K0 * A);
  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 6; j += 1) {
    const b = BETA[j - 1] ?? 0;
    xiP -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const sinhEta = Math.sinh(etaP);
  const tauP = Math.sin(xiP) / Math.sqrt(sinhEta * sinhEta + Math.cos(xiP) ** 2);
  const lambda = Math.atan2(sinhEta, Math.cos(xiP));
  // Newton's method for the tangent of the latitude (Karney 2011, eq. 19–21).
  const e2 = E * E;
  let tau = tauP;
  for (let i = 0; i < 6; i += 1) {
    const sqrt1tau = Math.sqrt(1 + tau * tau);
    const sigma = Math.sinh(E * Math.atanh((E * tau) / sqrt1tau));
    const tauI = tau * Math.sqrt(1 + sigma * sigma) - sigma * sqrt1tau;
    const delta =
      ((tauP - tauI) / Math.sqrt(1 + tauI * tauI)) *
      ((1 + (1 - e2) * tau * tau) / ((1 - e2) * sqrt1tau));
    tau += delta;
    if (Math.abs(delta) < 1e-14) break;
  }
  return {
    lat: Math.atan(tau) / RAD,
    lon: normalizeLon(centralMeridian(u.zone) + lambda / RAD),
  };
}
