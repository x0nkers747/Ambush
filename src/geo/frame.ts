import type { Vec2 } from '#sim';
import {
  fromUtm,
  normalizeLon,
  toUtm,
  utmEpsg,
  utmZone,
  validateLatLon,
  type Hemisphere,
  type LatLon,
} from './utm';

// The local metric frame of a battlefield (docs/adr/0006, docs/adr/0014): the
// UTM zone of the battlefield's centre, with the false origin at the centre
// rounded to the metre. Local x is metres east and y metres north (grid north)
// of that origin, the simulation's own frame (docs/adr/0002). The simulation
// never sees latitude or longitude; conversions happen here, at import and for
// display.

export interface BattlefieldFrame {
  /** The requested centre. */
  readonly centre: LatLon;
  /** Battlefield extent in metres, centred on the local origin. */
  readonly widthM: number;
  readonly heightM: number;
  readonly zone: number;
  readonly hemisphere: Hemisphere;
  /** e.g. 32618 for UTM 18N. */
  readonly epsg: number;
  /** UTM easting and northing of the local origin (0, 0), whole metres. */
  readonly falseEasting: number;
  readonly falseNorthing: number;
}

/** A WGS84 bounding box. `west > east` never occurs: boxes crossing ±180° are split. */
export interface GeoBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/** The frame of a battlefield centred on `centre`. Throws for invalid sizes or positions. */
export function createFrame(centre: LatLon, widthM: number, heightM = widthM): BattlefieldFrame {
  validateLatLon(centre);
  for (const [name, v] of [
    ['width', widthM],
    ['height', heightM],
  ] as const) {
    if (!(v > 0) || !Number.isFinite(v)) {
      throw new RangeError(`battlefield ${name} must be a finite number of metres > 0`);
    }
  }
  const c = { lat: centre.lat, lon: normalizeLon(centre.lon) };
  const zone = utmZone(c);
  const hemisphere: Hemisphere = c.lat >= 0 ? 'N' : 'S';
  const u = toUtm(c, zone, hemisphere);
  return {
    centre: c,
    widthM,
    heightM,
    zone,
    hemisphere,
    epsg: utmEpsg(zone, hemisphere),
    falseEasting: Math.round(u.easting),
    falseNorthing: Math.round(u.northing),
  };
}

/** Local metres of a WGS84 position, in the frame's zone. */
export function toLocal(frame: BattlefieldFrame, p: LatLon): Vec2 {
  const u = toUtm(p, frame.zone, frame.hemisphere);
  return { x: u.easting - frame.falseEasting, y: u.northing - frame.falseNorthing };
}

/** WGS84 position of a local point. */
export function toGeo(frame: BattlefieldFrame, p: Vec2): LatLon {
  return fromUtm({
    zone: frame.zone,
    hemisphere: frame.hemisphere,
    easting: frame.falseEasting + p.x,
    northing: frame.falseNorthing + p.y,
  });
}

/** The battlefield rectangle in local metres. */
export function localBounds(frame: BattlefieldFrame): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return {
    minX: -frame.widthM / 2,
    minY: -frame.heightM / 2,
    maxX: frame.widthM / 2,
    maxY: frame.heightM / 2,
  };
}

/**
 * WGS84 boxes covering the battlefield grown by `marginM` on every side. The
 * rectangle's edges are densified before conversion, since its sides are not
 * lines of latitude or longitude. Usually one box; two when it crosses ±180°.
 */
export function geographicBounds(frame: BattlefieldFrame, marginM: number): GeoBox[] {
  const hw = frame.widthM / 2 + marginM;
  const hh = frame.heightM / 2 + marginM;
  const steps = 8;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let dWest = Number.POSITIVE_INFINITY;
  let dEast = Number.NEGATIVE_INFINITY;
  for (let i = 0; i <= steps; i += 1) {
    const f = -1 + (2 * i) / steps;
    for (const p of [
      { x: f * hw, y: -hh },
      { x: f * hw, y: hh },
      { x: -hw, y: f * hh },
      { x: hw, y: f * hh },
    ]) {
      const g = toGeo(frame, p);
      south = Math.min(south, g.lat);
      north = Math.max(north, g.lat);
      // Longitude relative to the centre, so a box across ±180° stays contiguous.
      const d = normalizeLon(g.lon - frame.centre.lon);
      dWest = Math.min(dWest, d);
      dEast = Math.max(dEast, d);
    }
  }
  const west = frame.centre.lon + dWest;
  const east = frame.centre.lon + dEast;
  if (west < -180)
    return [
      { south, west: west + 360, north, east: 180 },
      { south, west: -180, north, east },
    ];
  if (east > 180)
    return [
      { south, west, north, east: 180 },
      { south, west: -180, north, east: east - 360 },
    ];
  return [{ south, west, north, east }];
}

/**
 * Grid convergence at the centre: the grid bearing of true north, in degrees
 * (positive when true north lies east of grid north). For display only.
 */
export function gridConvergenceDeg(frame: BattlefieldFrame): number {
  const a = toLocal(frame, frame.centre);
  const b = toLocal(frame, { lat: frame.centre.lat + 0.001, lon: frame.centre.lon });
  return (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
}
