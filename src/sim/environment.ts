import type { Vec2 } from './geometry';
import { isSimplePolygon, pointInPolygon } from './polygon';

// Normalized environment features (docs/adr/0011, docs/adr/0014): roads,
// buildings, vegetation, water, waterways and land use in simulation map
// coordinates (metres, X = East, Y = North). Immutable world data, part of
// `TerrainDataset`. Synthetic scenarios build them directly; the OSM importer
// (src/geo) converts its source data into exactly this form, so the
// simulation never sees the source.

/** Where an imported feature came from, and which of its values were estimated. */
export interface FeatureSource {
  /** e.g. "osm:way/123" or "osm:relation/456". */
  readonly ref: string;
  /** Names of fields set from defaults because the source gave no value (e.g. "heightMeters"). */
  readonly estimated?: readonly string[];
}

/**
 * Road classes. Labels only: roads do not affect movement yet. `path` is a
 * foot or cycle path; `major` a primary road or higher.
 */
export type RoadClass = 'path' | 'track' | 'unpaved' | 'paved' | 'major';

export interface Road {
  readonly id: string;
  readonly roadClass: RoadClass;
  /** Centreline, at least two points. */
  readonly centerline: readonly Vec2[];
  /** Full carriageway width in metres. */
  readonly widthMeters: number;
  readonly source?: FeatureSource;
  /**
   * The source's own road type, kept for display (docs/adr/0035): the OSM
   * `highway` value (e.g. "residential", "service") and, for service roads,
   * `service` (e.g. "driveway", "parking_aisle"). The simulation and grading
   * use `roadClass` only.
   */
  readonly highway?: string;
  readonly service?: string;
}

/**
 * A building: a footprint extruded to a flat roof. A hard obstacle to movement
 * and to line of sight. The roof is `heightMeters` above the lowest ground
 * elevation at the footprint's corners.
 */
export interface Building {
  readonly id: string;
  /** A simple polygon, at least three corners. Inner courtyards are not represented. */
  readonly footprint: readonly Vec2[];
  readonly heightMeters: number;
  readonly source?: FeatureSource;
  /** What the source says about the building's look; display only (docs/adr/0035). */
  readonly appearance?: BuildingAppearance;
}

/** Roof shapes as the sources name them (OSM `roof:shape`, Overture `roof_shape`). */
export type RoofShape =
  | 'flat'
  | 'gabled'
  | 'hipped'
  | 'half-hipped'
  | 'skillion'
  | 'pyramidal'
  | 'gambrel'
  | 'mansard'
  | 'saltbox'
  | 'dome'
  | 'onion'
  | 'round'
  | 'sawtooth';

/**
 * What a source records about a building's architecture (docs/adr/0035).
 * Every field is explicit source data, never a default: a field is absent
 * when the source does not give it, or gives something unusable. The 3D view
 * infers the rest. The simulation never reads any of it: a tagged
 * `roofHeightMeters` or `minHeightMeters` does not change `heightMeters`.
 */
export interface BuildingAppearance {
  /** OSM `building` (other than "yes") or Overture `class`, e.g. "house", "garage", "industrial". */
  readonly kind?: string;
  /** OSM `building:part`, when a footprint is mapped as a part. */
  readonly part?: string;
  /** A use from other tags: `amenity`, `shop` or `military`, as "amenity=school" etc. */
  readonly use?: string;
  readonly levels?: number;
  readonly levelsUnderground?: number;
  /** The tagged height, metres, as metadata (the simulation's `heightMeters` is decided separately). */
  readonly heightMeters?: number;
  readonly minHeightMeters?: number;
  readonly roofShape?: RoofShape;
  readonly roofHeightMeters?: number;
  readonly roofLevels?: number;
  readonly roofAngleDegrees?: number;
  /** Ridge along or across the longest side. */
  readonly roofOrientation?: 'along' | 'across';
  /** Compass bearing the main roof face points to, degrees. */
  readonly roofDirectionDegrees?: number;
  /** Normalised material names, e.g. "roof_tiles", "slate", "metal", "brick", "plaster". */
  readonly roofMaterial?: string;
  readonly wallMaterial?: string;
  /** Colours as "#rrggbb". */
  readonly roofColour?: string;
  readonly wallColour?: string;
  /** ISO 3166-1 alpha-2 country code from the address, upper case. */
  readonly country?: string;
}

export type VegetationKind = 'woodland' | 'treeLine' | 'scrub';

/**
 * An area of vegetation, abstracted rather than modelled tree by tree. It does
 * not obstruct movement. It obscures sight lines that pass through it below
 * its canopy: `seeThroughMeters` is how deep into it one can see before the
 * view is fully obscured (smaller is denser). See `lineOfSight`.
 */
export interface VegetationArea {
  readonly id: string;
  readonly kind: VegetationKind;
  /** A simple polygon, at least three corners. */
  readonly boundary: readonly Vec2[];
  /**
   * Clearings: simple polygons inside the boundary that are not part of the
   * area (e.g. a meadow in a wood). Sight lines through them are not obscured.
   */
  readonly holes?: readonly (readonly Vec2[])[];
  /** Canopy height above the ground in metres. */
  readonly canopyHeightMeters: number;
  /** Depth of this vegetation that fully obscures a sight line, in metres. */
  readonly seeThroughMeters: number;
  readonly source?: FeatureSource;
}

/**
 * Standing water: lakes, ponds, reservoirs, river surfaces. Soldiers cannot
 * enter `water`; `wetland` is drawn but does not block movement (yet).
 * Neither affects line of sight.
 */
export interface WaterArea {
  readonly id: string;
  readonly kind: 'water' | 'wetland';
  /** A simple polygon, at least three corners. */
  readonly boundary: readonly Vec2[];
  /** Islands: simple polygons inside the boundary. Drawn as land; still impassable (they can only be reached across water). */
  readonly holes?: readonly (readonly Vec2[])[];
  readonly source?: FeatureSource;
}

export type WaterwayKind = 'river' | 'stream' | 'canal' | 'drain' | 'ditch';

/** A watercourse drawn as a line. Display only: it neither blocks movement nor sight. */
export interface Waterway {
  readonly id: string;
  readonly kind: WaterwayKind;
  /** Centreline, at least two points. */
  readonly centerline: readonly Vec2[];
  /** Width in metres. */
  readonly widthMeters: number;
  readonly source?: FeatureSource;
}

export type LandUseKind =
  | 'farmland'
  | 'meadow'
  | 'orchard'
  | 'residential'
  | 'commercial'
  | 'industrial'
  | 'military'
  | 'cemetery'
  | 'recreation'
  | 'other';

/** How land is used. Display only. */
export interface LandUseArea {
  readonly id: string;
  readonly kind: LandUseKind;
  /** A simple polygon, at least three corners. */
  readonly boundary: readonly Vec2[];
  readonly holes?: readonly (readonly Vec2[])[];
  readonly source?: FeatureSource;
}

/**
 * Mapped roadside and settlement details (docs/adr/0036): street lamps,
 * single trees, power poles and lines, fences and walls, signs and street
 * furniture. Display only: the simulation never reads them (they are not
 * obstacles, cover or concealment), and a terrain without them is complete.
 */
export interface DecorFeatures {
  readonly points: readonly DecorPoint[];
  readonly lines: readonly DecorLine[];
}

export type DecorPointKind =
  | 'streetLamp'
  | 'tree'
  | 'powerPole'
  | 'powerTower'
  | 'trafficSign'
  | 'bollard'
  | 'bench'
  | 'wasteBasket'
  | 'postBox';

export interface DecorPoint {
  readonly id: string;
  readonly kind: DecorPointKind;
  readonly position: Vec2;
  /** Trees: OSM `leaf_type`. */
  readonly leafType?: 'broadleaved' | 'needleleaved';
  /** Tagged height, metres (trees, poles). */
  readonly heightMeters?: number;
  /** Signs: the sign's class, from `traffic_sign` or `highway=stop|give_way` (e.g. "stop"). */
  readonly sign?: string;
}

export type DecorLineKind = 'powerLine' | 'minorLine' | 'fence' | 'wall' | 'guardRail';

export interface DecorLine {
  readonly id: string;
  readonly kind: DecorLineKind;
  /** At least two points. */
  readonly points: readonly Vec2[];
  /** Fences and walls: `fence_type` or `material` (e.g. "chain_link", "wood", "stone"). */
  readonly material?: string;
  /** Tagged height, metres. */
  readonly heightMeters?: number;
}

export interface EnvironmentFeatures {
  readonly roads: readonly Road[];
  readonly buildings: readonly Building[];
  readonly vegetation: readonly VegetationArea[];
  /** Absent in terrain format 2; imported terrain (format 3) always has them. */
  readonly water?: readonly WaterArea[];
  readonly waterways?: readonly Waterway[];
  readonly landUse?: readonly LandUseArea[];
}

export const NO_FEATURES: EnvironmentFeatures = { roads: [], buildings: [], vegetation: [] };

/**
 * Throws a RangeError describing the first invalid feature. `isOnMap` tells
 * whether a point lies on the terrain.
 */
export function validateFeatures(
  features: EnvironmentFeatures,
  isOnMap: (p: Vec2) => boolean,
): void {
  const ids = new Set<string>();
  const fail = (message: string): never => {
    throw new RangeError(message);
  };
  const checkId = (kind: string, id: string) => {
    if (typeof id !== 'string' || id === '') fail(`${kind} ids must be non-empty strings`);
    if (ids.has(id)) fail(`duplicate feature id "${id}"`);
    ids.add(id);
  };
  const checkPoints = (label: string, points: readonly Vec2[]) => {
    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) fail(`${label} has a non-finite point`);
      if (!isOnMap(p)) fail(`${label} extends off the terrain`);
    }
  };
  const positive = (label: string, value: number) => {
    if (!(value > 0) || !Number.isFinite(value)) {
      fail(`${label} must be a finite number > 0, got ${String(value)}`);
    }
  };

  for (const road of features.roads) {
    checkId('road', road.id);
    if (road.centerline.length < 2) fail(`road "${road.id}" needs at least two points`);
    checkPoints(`road "${road.id}"`, road.centerline);
    positive(`road "${road.id}" width`, road.widthMeters);
  }
  for (const building of features.buildings) {
    checkId('building', building.id);
    checkPoints(`building "${building.id}"`, building.footprint);
    if (!isSimplePolygon(building.footprint)) {
      fail(`building "${building.id}" footprint must be a simple polygon`);
    }
    positive(`building "${building.id}" height`, building.heightMeters);
    const look: unknown = building.appearance;
    if (look !== undefined && (typeof look !== 'object' || look === null || Array.isArray(look))) {
      fail(`building "${building.id}" appearance must be an object`);
    }
  }
  /** A simple boundary and simple holes, each hole inside the boundary. */
  const checkArea = (
    label: string,
    boundary: readonly Vec2[],
    holes: readonly (readonly Vec2[])[] | undefined,
  ) => {
    checkPoints(label, boundary);
    if (!isSimplePolygon(boundary)) fail(`${label} boundary must be a simple polygon`);
    (holes ?? []).forEach((hole, i) => {
      checkPoints(`${label} hole ${String(i + 1)}`, hole);
      if (!isSimplePolygon(hole)) fail(`${label} hole ${String(i + 1)} must be a simple polygon`);
      if (!hole.every((p) => pointInPolygon(p, boundary))) {
        fail(`${label} hole ${String(i + 1)} must lie inside the boundary`);
      }
    });
  };
  for (const area of features.vegetation) {
    checkId('vegetation', area.id);
    checkArea(`vegetation "${area.id}"`, area.boundary, area.holes);
    positive(`vegetation "${area.id}" canopy height`, area.canopyHeightMeters);
    positive(`vegetation "${area.id}" see-through depth`, area.seeThroughMeters);
  }
  for (const area of features.water ?? []) {
    checkId('water', area.id);
    // Imported data is checked at run time, whatever its static type says.
    const kind: string = area.kind;
    if (kind !== 'water' && kind !== 'wetland') fail(`water "${area.id}" has an unknown kind`);
    checkArea(`water "${area.id}"`, area.boundary, area.holes);
  }
  for (const way of features.waterways ?? []) {
    checkId('waterway', way.id);
    if (way.centerline.length < 2) fail(`waterway "${way.id}" needs at least two points`);
    checkPoints(`waterway "${way.id}"`, way.centerline);
    positive(`waterway "${way.id}" width`, way.widthMeters);
  }
  for (const area of features.landUse ?? []) {
    checkId('land use', area.id);
    checkArea(`land use "${area.id}"`, area.boundary, area.holes);
  }
}

/** Water areas soldiers cannot enter (`kind: 'water'`). */
export function impassableWater(features: EnvironmentFeatures): readonly WaterArea[] {
  return (features.water ?? []).filter((w) => w.kind === 'water');
}

/** Axis-aligned bounds of a point set, for cheap rejection before exact tests. */
export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function boundsOf(points: readonly Vec2[]): Box {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const { x, y } of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** A rectangular footprint of `width` × `depth` metres centred on (cx, cy), rotated clockwise by `azimuthDeg`. */
export function rectangle(
  cx: number,
  cy: number,
  width: number,
  depth: number,
  azimuthDeg = 0,
): Vec2[] {
  const a = (azimuthDeg * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = -Math.sin(a); // "width" axis: east, rotated clockwise
  const vx = Math.sin(a);
  const vy = Math.cos(a); // "depth" axis: north, rotated clockwise
  const hw = width / 2;
  const hd = depth / 2;
  return [
    { x: cx - hw * ux - hd * vx, y: cy - hw * uy - hd * vy },
    { x: cx + hw * ux - hd * vx, y: cy + hw * uy - hd * vy },
    { x: cx + hw * ux + hd * vx, y: cy + hw * uy + hd * vy },
    { x: cx - hw * ux + hd * vx, y: cy - hw * uy + hd * vy },
  ];
}
