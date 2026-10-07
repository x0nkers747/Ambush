import type { Vec2 } from './geometry';
import { isSimplePolygon } from './polygon';

// Normalized environment features (docs/adr/0011): roads, buildings and
// vegetation in simulation map coordinates (metres, X = East, Y = North).
// Immutable world data, part of `TerrainDataset`. Synthetic scenarios build
// them directly; future importers (OSM, cadastral data, …) convert their
// source data into exactly this form, so the simulation never sees the source.

/** Road classes, from least to most developed. Labels only: roads do not affect movement yet. */
export type RoadClass = 'track' | 'unpaved' | 'paved';

export interface Road {
  readonly id: string;
  readonly roadClass: RoadClass;
  /** Centreline, at least two points. */
  readonly centerline: readonly Vec2[];
  /** Full carriageway width in metres. */
  readonly widthMeters: number;
}

/**
 * A building: a footprint extruded to a flat roof. A hard obstacle to movement
 * and to line of sight. The roof is `heightMeters` above the lowest ground
 * elevation at the footprint's corners.
 */
export interface Building {
  readonly id: string;
  /** A simple polygon, at least three corners. */
  readonly footprint: readonly Vec2[];
  readonly heightMeters: number;
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
  /** Canopy height above the ground in metres. */
  readonly canopyHeightMeters: number;
  /** Depth of this vegetation that fully obscures a sight line, in metres. */
  readonly seeThroughMeters: number;
}

export interface EnvironmentFeatures {
  readonly roads: readonly Road[];
  readonly buildings: readonly Building[];
  readonly vegetation: readonly VegetationArea[];
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
  }
  for (const area of features.vegetation) {
    checkId('vegetation', area.id);
    checkPoints(`vegetation "${area.id}"`, area.boundary);
    if (!isSimplePolygon(area.boundary)) {
      fail(`vegetation "${area.id}" boundary must be a simple polygon`);
    }
    positive(`vegetation "${area.id}" canopy height`, area.canopyHeightMeters);
    positive(`vegetation "${area.id}" see-through depth`, area.seeThroughMeters);
  }
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
