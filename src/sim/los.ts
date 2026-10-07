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
  const result = (obstruction: LosObstruction | null): LosResult => ({
    from: a,
    to: b,
    distance,
    clear: obstruction === null,
    obstruction,
  });
  if (distance === 0) return result(null);

  const at = (t: number): Vec2 => ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
  const lineZ = (t: number) => a.z + t * (b.z - a.z);
  const ground = (t: number) => {
    const p = at(t);
    return heightAt(terrain, p.x, p.y);
  };
  const obstructionAt = (t: number, cause: LosCause): LosObstruction => {
    const p = at(t);
    return { cause, point: { x: p.x, y: p.y, z: lineZ(t) }, distance: t * distance };
  };

  const box = boundsOf([a, b]);
  const buildings = queryFeatures(terrain).buildings.filter((f) => overlaps(f.box, box));
  const vegetation = queryFeatures(terrain).vegetation.filter((f) => overlaps(f.box, box));

  const cuts = new Set<number>([0, 1]);
  for (const t of terrainBreaks(terrain, a, b)) cuts.add(t);
  for (const { polygon } of [...buildings, ...vegetation]) {
    for (const [p, q] of edges(polygon))
      for (const t of segmentIntersectionParams(a, b, p, q)) cuts.add(t);
  }
  const pieces = mergeClose([...cuts].sort((x, y) => x - y));

  let obscuration = 0;
  for (let i = 0; i + 1 < pieces.length; i += 1) {
    const t0 = pieces[i] ?? 0;
    const t1 = pieces[i + 1] ?? 1;
    const mid = at((t0 + t1) / 2);
    const inBuildings = buildings.filter((f) => pointInPolygon(mid, f.polygon));
    const inVegetation = vegetation.filter((f) => pointInPolygon(mid, f.polygon));

    // Clearance of the sight line above the ground is linear on this piece.
    const c0 = lineZ(t0) - ground(t0);
    const c1 = lineZ(t1) - ground(t1);
    const clearance = (t: number) => c0 + ((t - t0) / (t1 - t0)) * (c1 - c0);
    const crossing = (level: number): number | undefined =>
      (c0 - level) * (c1 - level) < 0 ? t0 + ((c0 - level) / (c0 - c1)) * (t1 - t0) : undefined;

    // Split the piece where the line crosses the ground, a roof, or a canopy top.
    const sub = new Set<number>([t0, t1]);
    const terrainCut = crossing(0);
    if (terrainCut !== undefined) sub.add(terrainCut);
    for (const f of inBuildings) {
      const tr = rootOfLinear(lineZ(t0) - f.roofZ, lineZ(t1) - f.roofZ, t0, t1);
      if (tr !== undefined) sub.add(tr);
    }
    for (const f of inVegetation) {
      const tc = crossing(f.canopy);
      if (tc !== undefined) sub.add(tc);
    }
    const parts = [...sub].sort((x, y) => x - y);

    for (let j = 0; j + 1 < parts.length; j += 1) {
      const s0 = parts[j] ?? t0;
      const s1 = parts[j + 1] ?? t1;
      if (s1 <= s0) continue;
      const sm = (s0 + s1) / 2;
      if (clearance(sm) < 0) return result(obstructionAt(s0, { kind: 'terrain' }));
      const building = inBuildings.find((f) => lineZ(sm) < f.roofZ);
      if (building) return result(obstructionAt(s0, { kind: 'building', featureId: building.id }));

      // Vegetation obscuration accumulates at a constant rate on this part.
      const contributions = inVegetation
        .filter((f) => clearance(sm) < f.canopy)
        .map((f) => ({ id: f.id, rate: 1 / f.seeThrough }));
      const rate = contributions.reduce((sum, c) => sum + c.rate, 0);
      const length = (s1 - s0) * distance;
      if (rate > 0 && obscuration + rate * length >= 1) {
        const t = s0 + (1 - obscuration) / rate / distance;
        const densest = contributions.reduce((best, c) =>
          c.rate > best.rate || (c.rate === best.rate && c.id < best.id) ? c : best,
        );
        return result(obstructionAt(t, { kind: 'vegetation', featureId: densest.id }));
      }
      obscuration += rate * length;
    }
  }
  return result(null);
}

// --- Feature preparation -----------------------------------------------------------

interface PreparedBuilding {
  readonly id: string;
  readonly polygon: readonly Vec2[];
  readonly box: Box;
  /** Flat roof elevation: height above the lowest ground at the footprint corners. */
  readonly roofZ: number;
}

interface PreparedVegetation {
  readonly id: string;
  readonly polygon: readonly Vec2[];
  readonly box: Box;
  readonly canopy: number;
  readonly seeThrough: number;
}

const prepared = new WeakMap<
  TerrainDataset,
  { buildings: PreparedBuilding[]; vegetation: PreparedVegetation[] }
>();

/** Features with bounds and roof levels, computed once per terrain. A spatial index can replace this later. */
function queryFeatures(terrain: TerrainDataset) {
  let features = prepared.get(terrain);
  if (!features) {
    features = {
      buildings: terrain.features.buildings.map((f) => ({
        id: f.id,
        polygon: f.footprint,
        box: boundsOf(f.footprint),
        roofZ: Math.min(...f.footprint.map((p) => heightAt(terrain, p.x, p.y))) + f.heightMeters,
      })),
      vegetation: terrain.features.vegetation.map((f) => ({
        id: f.id,
        polygon: f.boundary,
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

/**
 * Parameters t ∈ (0, 1) where the 2D segment a→b crosses a terrain grid line
 * or a cell diagonal: the only places the interpolated ground changes slope.
 */
function terrainBreaks(terrain: TerrainDataset, a: Vec2, b: Vec2): number[] {
  const { originX, originY, cellSize } = terrain.heightfield;
  const gx0 = (a.x - originX) / cellSize;
  const gy0 = (a.y - originY) / cellSize;
  const gx1 = (b.x - originX) / cellSize;
  const gy1 = (b.y - originY) / cellSize;
  const out: number[] = [];
  const crossings = (v0: number, v1: number) => {
    if (v0 === v1) return;
    const lo = Math.min(v0, v1);
    const hi = Math.max(v0, v1);
    for (let k = Math.ceil(lo); k <= Math.floor(hi); k += 1) {
      const t = (k - v0) / (v1 - v0);
      if (t > 0 && t < 1) out.push(t);
    }
  };
  crossings(gx0, gx1);
  crossings(gy0, gy1);
  crossings(gx0 - gy0, gx1 - gy1); // the SW–NE diagonals (docs/adr/0008)
  return out;
}

function rootOfLinear(v0: number, v1: number, t0: number, t1: number): number | undefined {
  return v0 * v1 < 0 ? t0 + (v0 / (v0 - v1)) * (t1 - t0) : undefined;
}

function mergeClose(sorted: number[]): number[] {
  return sorted.filter((t, i) => i === 0 || t - (sorted[i - 1] ?? t) > 1e-12);
}

function edges(polygon: readonly Vec2[]): [Vec2, Vec2][] {
  return polygon.map((p, i) => [p, polygon[(i + 1) % polygon.length] ?? p]);
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}
