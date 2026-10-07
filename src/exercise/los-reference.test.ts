import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  heightAt,
  isOnTerrain,
  lineOfSight,
  pointInPolygon,
  segmentIntersectionParams,
  STANDING_EYE_HEIGHT_M,
  STANDING_TARGET_HEIGHT_M,
  type Box,
  type LosCause,
  type LosObstruction,
  type LosOptions,
  type LosResult,
  type TerrainDataset,
  type Vec2,
  type Vec3,
} from '#sim';
import { DEMO_SCENARIO } from './demo-scenario';

/** Deterministic uniform numbers in [0, 1) for test inputs (a 32-bit LCG). */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

// The optimized line-of-sight core must give exactly the results of the
// original Phase 3.6 implementation, kept below verbatim as the reference.

describe('lineOfSight matches the reference implementation exactly', () => {
  const terrain = DEMO_SCENARIO.terrain;
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const random = lcg(2026);
  const point = (): Vec2 => ({
    x: originX + random() * (columns - 1) * cellSize,
    y: originY + random() * (rows - 1) * cellSize,
  });

  it('on 4000 random sight lines across the demo map', () => {
    let blocked = 0;
    for (let i = 0; i < 4000; i += 1) {
      const from = point();
      const to = point();
      const expected = referenceLineOfSight(terrain, from, to);
      expect(lineOfSight(terrain, from, to)).toEqual(expected);
      if (!expected.clear) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(1000);
  });

  it('on sight lines near buildings and vegetation, including grazing ones', () => {
    const anchors = [
      ...terrain.features.buildings.flatMap((b) => b.footprint),
      ...terrain.features.vegetation.flatMap((v) => v.boundary),
    ];
    for (const anchor of anchors) {
      for (let k = 0; k < 12; k += 1) {
        const from = point();
        const to = { x: anchor.x + (k - 6) * 0.25, y: anchor.y };
        if (!isOnTerrain(terrain, to.x, to.y)) continue;
        expect(lineOfSight(terrain, from, to)).toEqual(referenceLineOfSight(terrain, from, to));
        const raised = { observerHeightMeters: 6, targetHeightMeters: 0.5 };
        expect(lineOfSight(terrain, from, to, raised)).toEqual(
          referenceLineOfSight(terrain, from, to, raised),
        );
      }
    }
  });
});

function referenceLineOfSight(
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

const referencePrepared = new WeakMap<
  TerrainDataset,
  { buildings: PreparedBuilding[]; vegetation: PreparedVegetation[] }
>();

/** Features with bounds and roof levels, computed once per terrain. A spatial index can replace this later. */
function queryFeatures(terrain: TerrainDataset) {
  let features = referencePrepared.get(terrain);
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
    referencePrepared.set(terrain, features);
  }
  return features;
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
