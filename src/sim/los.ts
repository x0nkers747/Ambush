import { boundsOf, type Box } from './environment';
import type { Vec2, Vec3 } from './geometry';
import { pointInPolygon, segmentIntersectionParams } from './polygon';
import { heightAt, isOnTerrain, type TerrainDataset } from './terrain';

// Line of sight (docs/adr/0011): a pure, deterministic query over terrain,
// buildings and vegetation, used by the planning tools now and by combat later.
//
// The sight line runs from the observer's eye to the target point. It is cut
// at every crossing of a terrain grid line or cell diagonal (where the
// interpolated ground changes slope) and of every building and vegetation
// edge. On each piece the ground, the sight line, roof and canopy levels are
// all linear, so every crossing is found exactly rather than by sampling.

/** Standing eye height above the ground. */
export const STANDING_EYE_HEIGHT_M = 1.7;
/** Height of the point looked at on a standing person (upper body). */
export const STANDING_TARGET_HEIGHT_M = 1.5;

export interface LosOptions {
  readonly observerHeightMeters?: number;
  readonly targetHeightMeters?: number;
}

/** What first obstructs a sight line. */
export type LosCause =
  | { readonly kind: 'terrain' }
  | { readonly kind: 'building'; readonly featureId: string }
  | { readonly kind: 'vegetation'; readonly featureId: string };

export interface LosObstruction {
  readonly cause: LosCause;
  /** Where the sight line is first obstructed. */
  readonly point: Vec3;
  /** Horizontal distance from the observer to that point, in metres. */
  readonly distance: number;
}

export interface LosResult {
  /** Observer's eye. */
  readonly from: Vec3;
  /** The point looked at. */
  readonly to: Vec3;
  /** Horizontal distance between them, in metres. */
  readonly distance: number;
  readonly clear: boolean;
  /** The first obstruction, or `null` when clear. */
  readonly obstruction: LosObstruction | null;
}

/**
 * Line of sight from an observer standing at `from` to a target standing at
 * `to` (both map points on the terrain).
 *
 * - **Terrain** obstructs where the ground rises above the sight line.
 * - **A building** obstructs where the sight line passes over its footprint
 *   below its roof; a line passing above the roof is clear.
 * - **Vegetation** obscures gradually: each metre of sight line inside an
 *   area and below its canopy adds 1 / `seeThroughMeters` of obscuration.
 *   The line is blocked where the total, over all areas, reaches 1; the area
 *   adding most at that point is reported (lowest id on a tie).
 *
 * The first obstruction along the line is reported.
 */
export function lineOfSight(
  terrain: TerrainDataset,
  from: Vec2,
  to: Vec2,
  options: LosOptions = {},
): LosResult {
  if (!isOnTerrain(terrain, from.x, from.y) || !isOnTerrain(terrain, to.x, to.y)) {
    throw new RangeError('line of sight endpoints must be on the terrain');
  }
  const eye = options.observerHeightMeters ?? STANDING_EYE_HEIGHT_M;
  const aim = options.targetHeightMeters ?? STANDING_TARGET_HEIGHT_M;
  const a: Vec3 = { x: from.x, y: from.y, z: heightAt(terrain, from.x, from.y) + eye };
  const b: Vec3 = { x: to.x, y: to.y, z: heightAt(terrain, to.x, to.y) + aim };
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const hit = distance === 0 ? null : traceSightLine(terrain, a, b);
  return {
    from: a,
    to: b,
    distance,
    clear: hit === null,
    obstruction: hit && {
      cause: hit.cause,
      point: {
        x: a.x + hit.t * (b.x - a.x),
        y: a.y + hit.t * (b.y - a.y),
        z: a.z + hit.t * (b.z - a.z),
      },
      distance: hit.t * distance,
    },
  };
}

/** The first obstruction on a sight line: where (as a fraction t of the line) and what. */
export interface SightLineHit {
  readonly t: number;
  readonly cause: LosCause;
}

/** Reused scratch space for the cut parameters of one sight line. */
let cutBuffer = new Float64Array(1024);

/**
 * The shared core of `lineOfSight` and `computeViewshed`: traces the sight
 * line from eye point `a` to target point `b` (map coordinates and
 * elevations, distinct in X/Y) and returns its first obstruction, or `null`.
 * Allocation-light so it can be called tens of thousands of times per viewshed.
 */
export function traceSightLine(terrain: TerrainDataset, a: Vec3, b: Vec3): SightLineHit | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const distance = Math.hypot(dx, dy);
  const features = queryFeatures(terrain);
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const near = (box: Box) =>
    box.minX <= maxX && minX <= box.maxX && box.minY <= maxY && minY <= box.maxY;
  const buildings = features.buildings.filter((f) => near(f.box));
  const vegetation = features.vegetation.filter((f) => near(f.box));

  // Cut points: the ends, terrain slope changes, and feature edge crossings.
  let n = 0;
  const push = (t: number) => {
    if (n === cutBuffer.length) {
      const bigger = new Float64Array(cutBuffer.length * 2);
      bigger.set(cutBuffer);
      cutBuffer = bigger;
    }
    cutBuffer[n] = t;
    n += 1;
  };
  push(0);
  push(1);
  const { originX, originY, cellSize } = terrain.heightfield;
  const gx0 = (a.x - originX) / cellSize;
  const gy0 = (a.y - originY) / cellSize;
  const gx1 = (b.x - originX) / cellSize;
  const gy1 = (b.y - originY) / cellSize;
  const crossings = (v0: number, v1: number) => {
    if (v0 === v1) return;
    const lo = Math.min(v0, v1);
    const hi = Math.max(v0, v1);
    for (let k = Math.ceil(lo); k <= Math.floor(hi); k += 1) {
      const t = (k - v0) / (v1 - v0);
      if (t > 0 && t < 1) push(t);
    }
  };
  crossings(gx0, gx1);
  crossings(gy0, gy1);
  crossings(gx0 - gy0, gx1 - gy1); // the SW–NE diagonals (docs/adr/0008)
  for (const { polygon } of buildings) addEdgeCrossings(a, b, polygon, push);
  for (const { polygon, holes } of vegetation) {
    addEdgeCrossings(a, b, polygon, push);
    for (const hole of holes) addEdgeCrossings(a, b, hole, push);
  }
  const cuts = cutBuffer.subarray(0, n).sort();

  const groundAt = (t: number) => heightAt(terrain, a.x + t * dx, a.y + t * dy);
  const inside = (
    f: { box: Box; polygon: readonly Vec2[]; holes?: readonly (readonly Vec2[])[] },
    x: number,
    y: number,
  ) =>
    x >= f.box.minX &&
    x <= f.box.maxX &&
    y >= f.box.minY &&
    y <= f.box.maxY &&
    pointInPolygon({ x, y }, f.polygon) &&
    !(f.holes ?? []).some((hole) => pointInPolygon({ x, y }, hole));

  const parts: number[] = [];
  const inBuildings: PreparedBuilding[] = [];
  const inVegetation: PreparedVegetation[] = [];
  const anyFeatures = buildings.length + vegetation.length > 0;
  let obscuration = 0;
  let t0 = cuts[0] ?? 0;
  let c0 = a.z + t0 * dz - groundAt(t0);
  for (let i = 1; i < n; i += 1) {
    const t1 = cuts[i] ?? 1;
    // Cuts closer than 1e-12 to the previous one are the same point.
    if (!(t1 - (cuts[i - 1] ?? t1) > 1e-12)) continue;
    const c1 = a.z + t1 * dz - groundAt(t1);
    inBuildings.length = 0;
    inVegetation.length = 0;
    if (anyFeatures) {
      const mx = a.x + ((t0 + t1) / 2) * dx;
      const my = a.y + ((t0 + t1) / 2) * dy;
      for (const f of buildings) if (inside(f, mx, my)) inBuildings.push(f);
      for (const f of vegetation) if (inside(f, mx, my)) inVegetation.push(f);
    }
    // Fast path: with no feature on this piece and the line at or above the ground
    // at both ends, nothing here can obstruct it (a linear interpolation of two
    // non-negative values stays non-negative in floating point).
    if (inBuildings.length + inVegetation.length === 0 && c0 >= 0 && c1 >= 0) {
      t0 = t1;
      c0 = c1;
      continue;
    }

    // Clearance of the sight line above the ground is linear on this piece.
    const ct0 = t0;
    const cc0 = c0;
    const clearance = (t: number) => cc0 + ((t - ct0) / (t1 - ct0)) * (c1 - cc0);
    const crossing = (level: number): number | undefined =>
      (cc0 - level) * (c1 - level) < 0
        ? ct0 + ((cc0 - level) / (cc0 - c1)) * (t1 - ct0)
        : undefined;
    const lineZ = (t: number) => a.z + t * dz;

    // Split the piece where the line crosses the ground, a roof, or a canopy top.
    parts.length = 0;
    parts.push(t0, t1);
    const terrainCut = crossing(0);
    if (terrainCut !== undefined) parts.push(terrainCut);
    for (const f of inBuildings) {
      const tr = rootOfLinear(lineZ(t0) - f.roofZ, lineZ(t1) - f.roofZ, t0, t1);
      if (tr !== undefined) parts.push(tr);
    }
    for (const f of inVegetation) {
      const tc = crossing(f.canopy);
      if (tc !== undefined) parts.push(tc);
    }
    if (parts.length > 2) parts.sort((x, y) => x - y);

    for (let j = 0; j + 1 < parts.length; j += 1) {
      const s0 = parts[j] ?? t0;
      const s1 = parts[j + 1] ?? t1;
      if (s1 <= s0) continue;
      const sm = (s0 + s1) / 2;
      if (clearance(sm) < 0) return { t: s0, cause: TERRAIN };
      const building = inBuildings.find((f) => lineZ(sm) < f.roofZ);
      if (building) return { t: s0, cause: building.cause };
      if (inVegetation.length === 0) continue;

      // Vegetation obscuration accumulates at a constant rate on this part.
      let rate = 0;
      let densest: PreparedVegetation | undefined;
      for (const f of inVegetation) {
        if (!(clearance(sm) < f.canopy)) continue;
        const r = 1 / f.seeThrough;
        rate += r;
        const best = densest ? 1 / densest.seeThrough : -1;
        if (!densest || r > best || (r === best && f.id < densest.id)) densest = f;
      }
      const length = (s1 - s0) * distance;
      if (densest && rate > 0 && obscuration + rate * length >= 1) {
        return { t: s0 + (1 - obscuration) / rate / distance, cause: densest.cause };
      }
      obscuration += rate * length;
    }
    t0 = t1;
    c0 = c1;
  }
  return null;
}

const TERRAIN: LosCause = { kind: 'terrain' };

/** Pushes the parameters where segment a–b meets each polygon edge. */
function addEdgeCrossings(
  a: Vec2,
  b: Vec2,
  polygon: readonly Vec2[],
  push: (t: number) => void,
): void {
  for (let k = 0; k < polygon.length; k += 1) {
    const p = polygon[k];
    const q = polygon[(k + 1) % polygon.length];
    if (!p || !q) continue;
    for (const t of segmentIntersectionParams(a, b, p, q)) push(t);
  }
}

// --- Feature preparation -----------------------------------------------------------

export interface PreparedBuilding {
  readonly id: string;
  readonly cause: LosCause;
  readonly polygon: readonly Vec2[];
  readonly box: Box;
  /** Flat roof elevation: height above the lowest ground at the footprint corners. */
  readonly roofZ: number;
}

export interface PreparedVegetation {
  readonly id: string;
  readonly cause: LosCause;
  readonly polygon: readonly Vec2[];
  /** Clearings: not part of the area. */
  readonly holes: readonly (readonly Vec2[])[];
  readonly box: Box;
  readonly canopy: number;
  readonly seeThrough: number;
}

const prepared = new WeakMap<
  TerrainDataset,
  { buildings: PreparedBuilding[]; vegetation: PreparedVegetation[] }
>();

/** Features with bounds and roof levels, computed once per terrain. A spatial index can replace this later. */
export function queryFeatures(terrain: TerrainDataset) {
  let features = prepared.get(terrain);
  if (!features) {
    features = {
      buildings: terrain.features.buildings.map((f) => ({
        id: f.id,
        cause: { kind: 'building' as const, featureId: f.id },
        polygon: f.footprint,
        box: boundsOf(f.footprint),
        roofZ: Math.min(...f.footprint.map((p) => heightAt(terrain, p.x, p.y))) + f.heightMeters,
      })),
      vegetation: terrain.features.vegetation.map((f) => ({
        id: f.id,
        cause: { kind: 'vegetation' as const, featureId: f.id },
        polygon: f.boundary,
        holes: f.holes ?? [],
        box: boundsOf(f.boundary),
        canopy: f.canopyHeightMeters,
        seeThrough: f.seeThroughMeters,
      })),
    };
    prepared.set(terrain, features);
  }
  return features;
}

/** Roof elevation of each building, as used by `lineOfSight`. */
export function buildingRoofElevations(terrain: TerrainDataset): ReadonlyMap<string, number> {
  return new Map(queryFeatures(terrain).buildings.map((b) => [b.id, b.roofZ]));
}

// --- Geometry helpers --------------------------------------------------------------

function rootOfLinear(v0: number, v1: number, t0: number, t1: number): number | undefined {
  return v0 * v1 < 0 ? t0 + (v0 / (v0 - v1)) * (t1 - t0) : undefined;
}
