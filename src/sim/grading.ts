import type { Road, RoadClass } from './environment';
import type { Vec2 } from './geometry';
import { pointInPolygon } from './polygon';
import { heightAt, type TerrainDataset } from './terrain';
import {
  BANK_MAX_RISE,
  BANK_MIN_RISE,
  BANK_REACH_M,
  BED_SLOPE,
  SHORE_FREEBOARD_M,
  SHORE_INSET_M,
  waterLevels,
  waterQuery,
} from './water-grading';

// Terrain grading (docs/adr/0032): the authoritative ground is the imported
// elevation model with its roads and building foundations built into it.
// Roads get a smoothed longitudinal profile, a level cross-section over the
// carriageway and shoulders, and cuttings or embankments down to the original
// ground; buildings stand on level pads with the same side slopes. The source
// elevations are never changed: grading makes a new terrain, and every
// system (movement, line of sight, the 2D map, the 3D view) uses that one.
//
// Cuttings and embankments are narrower than the 10 m elevation grid, so
// grading works on a 2.5 m lattice and keeps it where the ground changed: the
// grid cells there become refined cells (`TerrainRefinement`). Elsewhere the
// terrain is the source, sample for sample. Deterministic: every value comes
// from the source and the features alone, and constraints from different
// features combine by maxima and minima, so the order the features were loaded
// in does not matter.
//
// Open water is levelled too (docs/adr/0040, water-grading.ts): a shallow bed
// under each levelled water body, its shores at the water's level, and its
// banks blended into the ground round it. Deep water far from any shore is
// lowered on the elevation grid itself, without refinement.

/** Bump when the grading rules change: graded terrains of different versions differ. */
export const GRADING_VERSION = 3;
/**
 * Which model of the ground a terrain is: the DEM cleaning version
 * (docs/adr/0033) and the grading version it went through, e.g.
 * `dem-clean-v1+graded-v3`; `source` for an untouched terrain. Scenarios
 * record it, so plans made on an earlier model are noticed (docs/adr/0032).
 */
export function terrainModelId(terrain: TerrainDataset): string {
  const steps = [
    ...(terrain.cleaning ? [terrain.cleaning.version] : []),
    ...(terrain.grading ? [`graded-v${String(terrain.grading.version)}`] : []),
  ];
  return steps.length > 0 ? steps.join('+') : 'source';
}

/** Target spacing of the refined lattice, metres. */
export const FINE_SPACING_M = 2.5;

interface RoadGrading {
  /** Level shoulder each side of the carriageway, metres. */
  readonly shoulder: number;
  /** Length of the longitudinal smoothing, metres. */
  readonly smoothing: number;
}

/** Roads that are graded (built roads); tracks and paths follow the ground. */
export const ROAD_GRADING: Readonly<Record<RoadClass, RoadGrading | null>> = {
  major: { shoulder: 1, smoothing: 50 },
  paved: { shoulder: 1, smoothing: 36 },
  unpaved: { shoulder: 0.5, smoothing: 24 },
  track: null,
  path: null,
};

/** Embankments rise 1 in 2; cuttings 1 in 1.5. */
export const FILL_SLOPE = 0.5;
export const CUT_SLOPE = 2 / 3;
/** A road's centreline stays within this of the original ground. */
export const MAX_CENTRE_DEPTH_M = 4;
/** Side slopes reach at most this far beyond the level part; the last few metres fade out. */
const SLOPE_REACH_M = 8;
const FADE_M = 3;
/** Level ground round a building's footprint, metres. */
export const BUILDING_APRON_M = 1;
/** Changes smaller than this are left out (the ground keeps its source value). */
export const MIN_CHANGE_M = 0.05;
/** No grading this close to a watercourse (roads do not dam streams), metres. */
const WATERWAY_MARGIN_M = 2;
/** Profile sampling along a road, metres. */
const PROFILE_STEP_M = 2.5;
/** Profiles reach a junction's level over this distance, metres. */
const PIN_BLEND_M = 40;
/** A road ending this close outside another's carriageway meets it (a T-junction), metres. */
const JUNCTION_SNAP_M = 0.5;
/** Junctions closer together than this meet at one level, metres. */
const JUNCTION_CLUSTER_M = 8;

export interface GradingSummary {
  readonly roads: number;
  readonly buildings: number;
  readonly refinedCells: number;
  /** Deepest cutting and highest embankment, metres. */
  readonly maxCutM: number;
  readonly maxFillM: number;
  /** Water (docs/adr/0040): bodies levelled and not, river profiles, and grid cells changed. */
  readonly water: {
    readonly levelled: number;
    readonly notLevelled: number;
    readonly rivers: number;
    /** Cells lowered on the elevation grid alone (deep water). */
    readonly coarseCells: number;
    /** Cells near shores, graded on the fine lattice. */
    readonly shoreCells: number;
  };
}

/** Constraints on the fine lattice, one block per touched coarse cell. */
interface Block {
  readonly cell: number;
  /** Source ground at each fine node. */
  readonly s: Float64Array;
  /** Lowest and highest graded ground allowed. */
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  /** Nodes that must not be graded (in or by water). */
  readonly wet: Uint8Array;
  /** Which feature a node's level belongs to: `ROAD_LEVEL`, `BUILDING_PAD`, `WATER` or 0 (none). */
  readonly own: Uint8Array;
}

/** A node a road constrains: its distance from the road, the road's level there and level width. */
interface RoadNode {
  readonly b: Block;
  readonly n: number;
  d: number;
  z: number;
  flat: number;
}

const ROAD_LEVEL = 1;
const BUILDING_PAD = 2;
const WATER = 3;

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function smoothFade(d: number, reach: number, fade = FADE_M): number {
  if (d <= reach - fade) return 1;
  if (d >= reach) return 0;
  const t = (reach - d) / fade;
  return t * t * (3 - 2 * t);
}

/** Even–odd containment with edges bucketed by 8 m bands (for large polygons). */
function bandIndex(rings: readonly (readonly Vec2[])[]) {
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of rings[0] ?? []) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const BAND = 8;
  const bands: number[][] = Array.from(
    { length: Math.max(1, Math.ceil((maxY - minY) / BAND) + 1) },
    () => [],
  );
  for (const ring of rings) {
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length] ?? a;
      if (a.y === b.y) return;
      const lo = Math.max(0, Math.floor((Math.min(a.y, b.y) - minY) / BAND));
      const hi = Math.min(bands.length - 1, Math.floor((Math.max(a.y, b.y) - minY) / BAND));
      for (let k = lo; k <= hi; k += 1) bands[k]?.push(a.x, a.y, b.x, b.y);
    });
  }
  return (x: number, y: number): boolean => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    const band = bands[Math.floor((y - minY) / BAND)] ?? [];
    let inside = false;
    for (let i = 0; i < band.length; i += 4) {
      const ax = band[i] ?? 0;
      const ay = band[i + 1] ?? 0;
      const bx = band[i + 2] ?? 0;
      const by = band[i + 3] ?? 0;
      if (ay > y !== by > y && ax + ((y - ay) * (bx - ax)) / (by - ay) > x) inside = !inside;
    }
    return inside;
  };
}

/** Parameter of the nearest point found by the last `segmentDistance` call. */
let nearestT = 0;

/** Distance from (x, y) to segment a–b; the nearest point's parameter goes to `nearestT`. */
function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
  nearestT = t;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/**
 * The graded terrain for a source terrain: the authoritative ground. A terrain
 * that is already graded is returned as it is. Pure and deterministic.
 */
export function gradeTerrain(source: TerrainDataset): TerrainDataset {
  if (source.grading) return source;
  return gradeWithSummary(source).terrain;
}

export function gradeWithSummary(source: TerrainDataset): {
  terrain: TerrainDataset;
  summary: GradingSummary;
} {
  const { originX, originY, cellSize, columns, rows, elevations } = source.heightfield;
  const k = Math.max(1, Math.round(cellSize / FINE_SPACING_M));
  const n1 = k + 1;
  const fine = cellSize / k;
  const maxX = originX + (columns - 1) * cellSize;
  const maxY = originY + (rows - 1) * cellSize;
  const onMap = (x: number, y: number) => x >= originX && x <= maxX && y >= originY && y <= maxY;
  const ground = (x: number, y: number) =>
    heightAt(source, Math.min(Math.max(x, originX), maxX), Math.min(Math.max(y, originY), maxY));

  // --- Where not to grade: open water and watercourses ----------------------------
  const { water = [], waterways = [] } = source.features;
  const waterTests = water
    .filter((w) => w.kind === 'water')
    .map((w) => ({
      test: bandIndex([w.boundary, ...(w.holes ?? [])]),
      minX: Math.min(...w.boundary.map((p) => p.x)),
      minY: Math.min(...w.boundary.map((p) => p.y)),
      maxX: Math.max(...w.boundary.map((p) => p.x)),
      maxY: Math.max(...w.boundary.map((p) => p.y)),
    }));
  const BUCKET = 50;
  const waterwayBuckets = new Map<number, number[]>();
  const waterwaySegments: number[] = [];
  for (const w of [...waterways].sort(byId)) {
    for (let i = 0; i + 1 < w.centerline.length; i += 1) {
      const a = w.centerline[i];
      const b = w.centerline[i + 1];
      if (!a || !b) continue;
      const s = waterwaySegments.length / 5;
      const h = w.widthMeters / 2 + WATERWAY_MARGIN_M;
      waterwaySegments.push(a.x, a.y, b.x, b.y, h);
      for (
        let bx = Math.floor((Math.min(a.x, b.x) - h) / BUCKET);
        bx <= Math.floor((Math.max(a.x, b.x) + h) / BUCKET);
        bx++
      ) {
        for (
          let by = Math.floor((Math.min(a.y, b.y) - h) / BUCKET);
          by <= Math.floor((Math.max(a.y, b.y) + h) / BUCKET);
          by++
        ) {
          const key = bx * 100_003 + by;
          const list = waterwayBuckets.get(key) ?? [];
          list.push(s);
          waterwayBuckets.set(key, list);
        }
      }
    }
  }
  const inWater = (x: number, y: number, tests: readonly ((x: number, y: number) => boolean)[]) => {
    for (const s of waterwayBuckets.get(
      Math.floor(x / BUCKET) * 100_003 + Math.floor(y / BUCKET),
    ) ?? []) {
      const o = s * 5;
      const d = segmentDistance(
        x,
        y,
        waterwaySegments[o] ?? 0,
        waterwaySegments[o + 1] ?? 0,
        waterwaySegments[o + 2] ?? 0,
        waterwaySegments[o + 3] ?? 0,
      );
      if (d < (waterwaySegments[o + 4] ?? 0)) return true;
    }
    for (const test of tests) if (test(x, y)) return true;
    return false;
  };

  // --- Constraint blocks ---------------------------------------------------------------
  const blocks = new Map<number, Block>();
  const block = (c: number, r: number): Block => {
    const cell = r * (columns - 1) + c;
    let b = blocks.get(cell);
    if (!b) {
      const s = new Float64Array(n1 * n1);
      for (let j = 0; j <= k; j += 1) {
        for (let i = 0; i <= k; i += 1) {
          // Coarse corners are the source samples exactly; other nodes the source surface.
          s[j * n1 + i] =
            i % k === 0 && j % k === 0
              ? (elevations[(r + j / k) * columns + c + i / k] ?? 0)
              : heightAt(source, originX + (c * k + i) * fine, originY + (r * k + j) * fine);
        }
      }
      const wet = new Uint8Array(n1 * n1);
      // Only the water that can reach this cell is tested at its nodes.
      const x0 = originX + c * cellSize;
      const y0 = originY + r * cellSize;
      const tests = waterTests
        .filter(
          (w) => w.minX <= x0 + cellSize && w.maxX >= x0 && w.minY <= y0 + cellSize && w.maxY >= y0,
        )
        .map((w) => w.test);
      let streams = false;
      for (const bx of [Math.floor(x0 / BUCKET), Math.floor((x0 + cellSize) / BUCKET)]) {
        for (const by of [Math.floor(y0 / BUCKET), Math.floor((y0 + cellSize) / BUCKET)]) {
          if (waterwayBuckets.has(bx * 100_003 + by)) streams = true;
        }
      }
      if (tests.length > 0 || streams) {
        for (let j = 0; j <= k; j += 1) {
          for (let i = 0; i <= k; i += 1) {
            const x = originX + (c * k + i) * fine;
            const y = originY + (r * k + j) * fine;
            wet[j * n1 + i] = inWater(x, y, tests) ? 1 : 0;
          }
        }
      }
      b = {
        cell,
        s,
        lo: new Float64Array(n1 * n1).fill(-Infinity),
        hi: new Float64Array(n1 * n1).fill(Infinity),
        wet,
        own: new Uint8Array(n1 * n1),
      };
      blocks.set(cell, b);
    }
    return b;
  };
  /**
   * Visits every fine node strictly within `reach` of a box, in each coarse
   * cell containing it, with its position and its block.
   */
  const halfDiagonal = (cellSize * Math.SQRT2) / 2;
  const visit = (
    box: { minX: number; minY: number; maxX: number; maxY: number },
    reach: number,
    fn: (x: number, y: number, b: Block, n: number) => void,
    /** Distance from a cell's centre to the feature, to skip cells out of reach. */
    centreDistance?: (x: number, y: number) => number,
  ) => {
    const c0 = Math.max(0, Math.floor((box.minX - reach - originX) / cellSize));
    const c1 = Math.min(columns - 2, Math.floor((box.maxX + reach - originX) / cellSize));
    const r0 = Math.max(0, Math.floor((box.minY - reach - originY) / cellSize));
    const r1 = Math.min(rows - 2, Math.floor((box.maxY + reach - originY) / cellSize));
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        // Every cell holding a node within reach has its centre within reach plus half a diagonal.
        if (
          centreDistance &&
          centreDistance(originX + (c + 0.5) * cellSize, originY + (r + 0.5) * cellSize) >=
            reach + halfDiagonal
        ) {
          continue;
        }
        const b = block(c, r);
        for (let j = 0; j <= k; j += 1) {
          for (let i = 0; i <= k; i += 1) {
            fn(originX + (c * k + i) * fine, originY + (r * k + j) * fine, b, j * n1 + i);
          }
        }
      }
    }
  };
  /** Applies a feature's bounds at a node: at most `hi`, at least `lo`, with strength `alpha`. */
  const constrain = (b: Block, n: number, lo: number, hi: number, alpha: number) => {
    const s = b.s[n] ?? 0;
    if (lo > s) b.lo[n] = Math.max(b.lo[n] ?? -Infinity, s + alpha * (lo - s));
    if (hi < s) b.hi[n] = Math.min(b.hi[n] ?? Infinity, s - alpha * (s - hi));
  };
  /** Level within `flat` of the feature, side slopes beyond, fading out by `flat + SLOPE_REACH_M`. */
  const shape = (b: Block, n: number, d: number, z: number, flat: number) => {
    const reach = flat + SLOPE_REACH_M;
    if (d >= reach) return;
    const alpha = smoothFade(d, reach);
    if (d <= flat) constrain(b, n, z, z, alpha);
    else constrain(b, n, z - (d - flat) * FILL_SLOPE, z + (d - flat) * CUT_SLOPE, alpha);
  };

  // --- Roads ------------------------------------------------------------------------------
  const roads = source.features.roads.filter((r) => ROAD_GRADING[r.roadClass] !== null).sort(byId);
  const chains = roadChains(roads);
  const levels = chains.map((chain) => smoothedLevels(chain, ground));
  const { pins, joinedEnds } = junctionPins(chains, levels);
  let maxCut = 0;
  let maxFill = 0;
  /** Nodes on some road's level part, with the nearest road's level there. */
  const level = new Map<number, RoadNode>();
  const slopes: RoadNode[] = [];

  chains.forEach((chain, ci) => {
    const chainLevels = levels[ci];
    if (!chainLevels) return;
    const profile = roadProfile(chain, chainLevels, pins.get(ci) ?? []);
    // Each node takes the design level at its nearest point on the whole
    // chain, so the segments of one road never compete over a node near a bend.
    const nearest = new Map<number, RoadNode>();
    const pts = chain.pts;
    // A road ending at a junction has no rounded end: beyond its end is the
    // road it joins. (A dead end keeps its end.)
    const openStart = !joinedEnds.has(`${String(ci)}:start`);
    const openEnd = !joinedEnds.has(`${String(ci)}:end`);
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i];
      const bp = pts[i + 1];
      if (!a || !bp) continue;
      // Level over the carriageway and its shoulders, and at least a lattice
      // diagonal beyond the carriageway's edge, so every fine triangle the
      // carriageway touches is level.
      const flat = (chain.widths[i] ?? 0) / 2 + Math.max(chain.shoulder, fine * Math.SQRT2);
      const len = Math.hypot(bp.x - a.x, bp.y - a.y);
      const sA = chain.cum[i] ?? 0;
      const box = {
        minX: Math.min(a.x, bp.x),
        minY: Math.min(a.y, bp.y),
        maxX: Math.max(a.x, bp.x),
        maxY: Math.max(a.y, bp.y),
      };
      visit(
        box,
        flat + SLOPE_REACH_M,
        (x, y, b, n) => {
          const d = segmentDistance(x, y, a.x, a.y, bp.x, bp.y);
          const t = nearestT;
          if (d >= flat + SLOPE_REACH_M || b.wet[n] === 1 || !onMap(x, y)) return;
          if (
            !chain.closed &&
            ((i === 0 && t === 0 && !openStart) || (i === pts.length - 2 && t === 1 && !openEnd))
          ) {
            return;
          }
          const id = b.cell * n1 * n1 + n;
          const known = nearest.get(id);
          if (known && known.d <= d) return;
          const z = profile(sA + t * len);
          if (known) {
            known.d = d;
            known.z = z;
            known.flat = flat;
          } else {
            nearest.set(id, { b, n, d, z, flat });
          }
        },
        (x, y) => segmentDistance(x, y, a.x, a.y, bp.x, bp.y),
      );
    }
    for (const [id, e] of nearest) {
      if (e.d > e.flat) {
        slopes.push(e);
        continue;
      }
      // On a carriageway or shoulder, the nearest road's level alone (the
      // first chain on a tie): where roads overlap at a junction, the ground
      // is one road's level or the other's, never a mix of both.
      const known = level.get(id);
      if (!known || e.d < known.d) {
        level.set(id, e);
        e.b.own[e.n] = ROAD_LEVEL;
      }
    }
  });

  // --- Buildings ---------------------------------------------------------------------------
  const buildings = [...source.features.buildings].sort(byId);
  for (const building of buildings) {
    const fp = building.footprint;
    const box = {
      minX: Math.min(...fp.map((p) => p.x)),
      minY: Math.min(...fp.map((p) => p.y)),
      maxX: Math.max(...fp.map((p) => p.x)),
      maxY: Math.max(...fp.map((p) => p.y)),
    };
    // The pad: the median ground under the footprint (its corners when it is too small for the lattice).
    const under: number[] = [];
    for (
      let fy = Math.ceil((box.minY - originY) / fine);
      originY + fy * fine <= box.maxY;
      fy += 1
    ) {
      for (
        let fx = Math.ceil((box.minX - originX) / fine);
        originX + fx * fine <= box.maxX;
        fx += 1
      ) {
        const x = originX + fx * fine;
        const y = originY + fy * fine;
        if (onMap(x, y) && pointInPolygon({ x, y }, fp)) under.push(ground(x, y));
      }
    }
    if (under.length === 0) for (const p of fp) under.push(ground(p.x, p.y));
    under.sort((p, q) => p - q);
    const pad =
      under.length % 2 === 1
        ? (under[(under.length - 1) / 2] ?? 0)
        : ((under[under.length / 2 - 1] ?? 0) + (under[under.length / 2] ?? 0)) / 2;
    // The level pad reaches past the footprint by the apron, and at least a
    // lattice diagonal, so every fine triangle under the building is level.
    const apron = Math.max(BUILDING_APRON_M, fine * Math.SQRT2);
    const reach = apron + SLOPE_REACH_M;
    /** Distance to the footprint's box: a lower bound of the distance to the footprint. */
    const boxDistance = (x: number, y: number) =>
      Math.hypot(Math.max(box.minX - x, 0, x - box.maxX), Math.max(box.minY - y, 0, y - box.maxY));
    visit(
      box,
      reach,
      (x, y, b, n) => {
        const outside = boxDistance(x, y);
        if (outside >= reach || b.wet[n] === 1 || !onMap(x, y)) return;
        let d = Infinity;
        if (outside === 0 && pointInPolygon({ x, y }, fp)) d = 0;
        else {
          for (let i = 0; i < fp.length; i += 1) {
            const p = fp[i];
            const q = fp[(i + 1) % fp.length];
            if (p && q) d = Math.min(d, segmentDistance(x, y, p.x, p.y, q.x, q.y));
          }
        }
        // A road's level part is the road's, even where a building comes close
        // to it (or, mapped carelessly, overlaps it).
        if (b.own[n] === ROAD_LEVEL) return;
        if (d <= apron) b.own[n] = BUILDING_PAD;
        shape(b, n, d, pad, apron);
      },
      boxDistance,
    );
  }

  // --- Precedence: road levels, then building pads, then side slopes ------------------------
  for (const e of level.values()) shape(e.b, e.n, e.d, e.z, e.flat);
  // Road side slopes, except on a road's level part or a building's pad,
  // combine with one another and with the buildings' by max and min.
  for (const e of slopes) if (e.b.own[e.n] === 0) shape(e.b, e.n, e.d, e.z, e.flat);

  // --- Water (docs/adr/0040) -----------------------------------------------------------------
  const surfaces = waterLevels(source);
  const wq = waterQuery(source.features, surfaces, { originX, originY, maxX, maxY });
  /** Coarse samples lowered under deep water, by sample index. */
  const deep = new Map<number, number>();
  let shoreCells = 0;
  let deepCells = 0;
  if (wq.any) {
    // Buildings, which water grading works round: the ground under a building
    // standing in water is left alone, and deep-water cells near one are graded
    // on the fine lattice. Roads over water get no ground of their own: the 3D
    // view draws their bridges (docs/adr/0041), and the ground under them is
    // the bed like the rest.
    const STRUCT_BUCKET = 50;
    const structures = new Map<number, number[]>();
    const addStructure = (minX: number, minY: number, maxX2: number, maxY2: number, s: number) => {
      for (
        let gx = Math.floor(minX / STRUCT_BUCKET);
        gx <= Math.floor(maxX2 / STRUCT_BUCKET);
        gx += 1
      ) {
        for (
          let gy = Math.floor(minY / STRUCT_BUCKET);
          gy <= Math.floor(maxY2 / STRUCT_BUCKET);
          gy += 1
        ) {
          const key = gx * 100_003 + gy;
          const list = structures.get(key);
          if (list) list.push(s);
          else structures.set(key, [s]);
        }
      }
    };
    const reachOf = halfDiagonal + 2;
    buildings.forEach((building, i) => {
      const xs = building.footprint.map((p) => p.x);
      const ys = building.footprint.map((p) => p.y);
      addStructure(
        Math.min(...xs) - reachOf,
        Math.min(...ys) - reachOf,
        Math.max(...xs) + reachOf,
        Math.max(...ys) + reachOf,
        i,
      );
    });
    const near = (x: number, y: number) =>
      structures.get(Math.floor(x / STRUCT_BUCKET) * 100_003 + Math.floor(y / STRUCT_BUCKET)) ?? [];
    const underBuilding = (x: number, y: number) =>
      near(x, y).some((s) => pointInPolygon({ x, y }, buildings[s]?.footprint ?? []));

    // Cells water can reach: round each levelled body and channel.
    const marked = new Uint8Array((columns - 1) * (rows - 1));
    const mark = (minX: number, minY: number, maxX2: number, maxY2: number) => {
      const c0 = Math.max(0, Math.floor((minX - wq.reach - originX) / cellSize));
      const c1 = Math.min(columns - 2, Math.floor((maxX2 + wq.reach - originX) / cellSize));
      const r0 = Math.max(0, Math.floor((minY - wq.reach - originY) / cellSize));
      const r1 = Math.min(rows - 2, Math.floor((maxY2 + wq.reach - originY) / cellSize));
      for (let r = r0; r <= r1; r += 1)
        marked.fill(1, r * (columns - 1) + c0, r * (columns - 1) + c1 + 1);
    };
    const levelled = new Set(surfaces.bodies.filter((b) => b.graded).map((b) => b.id));
    for (const area of water.filter((w) => w.kind === 'water' && levelled.has(w.id))) {
      const xs = area.boundary.map((p) => p.x);
      const ys = area.boundary.map((p) => p.y);
      mark(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    }
    for (const river of surfaces.rivers) {
      for (let i = 0; i + 3 < river.xy.length; i += 2) {
        const h = river.halfWidths[i / 2] ?? 0;
        if (h <= 0) continue;
        const ax = river.xy[i] ?? 0;
        const ay = river.xy[i + 1] ?? 0;
        const bx = river.xy[i + 2] ?? 0;
        const by = river.xy[i + 3] ?? 0;
        mark(
          Math.min(ax, bx) - h,
          Math.min(ay, by) - h,
          Math.max(ax, bx) + h,
          Math.max(ay, by) + h,
        );
      }
    }

    /** The water's constraint at a node, by the rules of docs/adr/0040. */
    const shapeWater = (x: number, y: number, b: Block, n: number) => {
      if (!onMap(x, y)) return;
      const w = wq.at(x, y);
      if (!w) return;
      const d = w.shoreDistance;
      if (w.inWater) {
        // The ground under a building standing in the water is left alone.
        if (underBuilding(x, y)) return;
        b.own[n] = WATER;
        if (d < SHORE_INSET_M) {
          // At the waterline: the ground at the level (just above it).
          constrain(b, n, w.level + SHORE_FREEBOARD_M, w.level + SHORE_FREEBOARD_M, 1);
        } else {
          // The bed: deeper away from the shore, to the class's depth; deeper ground stays.
          const depth = Math.min(w.depth, 0.1 + (d - SHORE_INSET_M) * BED_SLOPE);
          constrain(b, n, -Infinity, w.level - depth, 1);
        }
        return;
      }
      // A bank: not lower than the water beside it, not a wall above it, fading into the ground.
      if (d >= BANK_REACH_M || b.own[n] !== 0) return;
      const alpha = smoothFade(d, BANK_REACH_M);
      constrain(
        b,
        n,
        w.level + SHORE_FREEBOARD_M + BANK_MIN_RISE * d,
        w.level + SHORE_FREEBOARD_M + BANK_MAX_RISE * d,
        alpha,
      );
    };

    for (let r = 0; r < rows - 1; r += 1) {
      for (let c = 0; c < columns - 1; c += 1) {
        const cell = r * (columns - 1) + c;
        if (!marked[cell]) continue;
        const cx = originX + (c + 0.5) * cellSize;
        const cy = originY + (r + 0.5) * cellSize;
        const w = wq.at(cx, cy);
        if (!w) continue;
        // Deep water, far from any shore, road or building: the grid's own samples, lowered.
        const deepFrom = SHORE_INSET_M + (w.depth - 0.1) / BED_SLOPE + halfDiagonal;
        if (
          w.inWater &&
          w.shoreDistance >= Math.min(deepFrom, wq.reach) &&
          deepFrom < wq.reach &&
          !blocks.has(cell) &&
          near(cx, cy).length === 0
        ) {
          deepCells += 1;
          for (const [i, j] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ] as const) {
            const sample = (r + j) * columns + c + i;
            if (deep.has(sample)) continue;
            const x = originX + (c + i) * cellSize;
            const y = originY + (r + j) * cellSize;
            const at = wq.at(x, y);
            const s = elevations[sample] ?? 0;
            const g = at?.inWater ? Math.min(s, at.level - at.depth) : s;
            deep.set(sample, Math.abs(g - s) < MIN_CHANGE_M ? s : g);
          }
          continue;
        }
        shoreCells += 1;
        const b = block(c, r);
        for (let j = 0; j <= k; j += 1) {
          for (let i = 0; i <= k; i += 1) {
            shapeWater(originX + (c * k + i) * fine, originY + (r * k + j) * fine, b, j * n1 + i);
          }
        }
      }
    }
    // A deep cell's corner is in water at least the full depth from any shore, so a
    // block sharing it constrains it the same way; and a block made later (none
    // are) would too.
  }

  // --- The graded ground -------------------------------------------------------------------
  const graded = Float64Array.from(elevations);
  for (const [sample, g] of deep) {
    const s = elevations[sample] ?? 0;
    maxCut = Math.max(maxCut, s - g);
    graded[sample] = g;
  }
  const sortedBlocks = [...blocks.values()].sort((p, q) => p.cell - q.cell);
  /** Each changed block's graded values, and whether it needs its fine samples. */
  const settled = new Map<number, { values: Float64Array; fine: boolean }>();
  for (const b of sortedBlocks) {
    const values = new Float64Array(n1 * n1);
    let changed = false;
    for (let n = 0; n < n1 * n1; n += 1) {
      const s = b.s[n] ?? 0;
      const lo = b.lo[n] ?? -Infinity;
      const hi = b.hi[n] ?? Infinity;
      // Embankment and cutting both asked for (between two features): halfway.
      let g = lo > s && hi < s ? (lo + hi) / 2 : lo > s ? lo : hi < s ? hi : s;
      if (Math.abs(g - s) < MIN_CHANGE_M) g = s;
      else changed = true;
      maxFill = Math.max(maxFill, g - s);
      maxCut = Math.max(maxCut, s - g);
      values[n] = g;
    }
    if (!changed) continue;
    const c = b.cell % (columns - 1);
    const r = Math.floor(b.cell / (columns - 1));
    // The coarse samples at the cell's corners take the graded values.
    graded[r * columns + c] = values[0] ?? 0;
    graded[r * columns + c + 1] = values[k] ?? 0;
    graded[(r + 1) * columns + c] = values[k * n1] ?? 0;
    graded[(r + 1) * columns + c + 1] = values[k * n1 + k] ?? 0;
    // Refined only where its corners alone cannot hold the graded ground.
    settled.set(b.cell, { values, fine: k > 1 && !coarseHolds(values, k) });
  }
  const refined = (c: number, r: number) =>
    c >= 0 &&
    r >= 0 &&
    c < columns - 1 &&
    r < rows - 1 &&
    (settled.get(r * (columns - 1) + c)?.fine ?? false);
  const refinedCells: number[] = [];
  const refinedSamples: number[] = [];
  for (const [cell, { values, fine: isFine }] of [...settled].sort((p, q) => p[0] - q[0])) {
    if (!isFine) continue;
    const c = cell % (columns - 1);
    const r = Math.floor(cell / (columns - 1));
    // Along an edge with an unrefined cell, the fine samples lie on its straight
    // edge (they are within the smallest change of it), so the surface is continuous.
    const straighten = (from: number, to: number, at: (m: number) => number) => {
      const a = values[from] ?? 0;
      const z = values[to] ?? 0;
      for (let m = 1; m < k; m += 1) values[at(m)] = a + (m / k) * (z - a);
    };
    if (!refined(c, r - 1)) straighten(0, k, (m) => m);
    if (!refined(c, r + 1)) straighten(k * n1, k * n1 + k, (m) => k * n1 + m);
    if (!refined(c - 1, r)) straighten(0, k * n1, (m) => m * n1);
    if (!refined(c + 1, r)) straighten(k, k * n1 + k, (m) => m * n1 + k);
    refinedCells.push(cell);
    for (const v of values) refinedSamples.push(v);
  }

  const terrain: TerrainDataset = {
    ...source,
    heightfield: { ...source.heightfield, elevations: Array.from(graded) },
    ...(k > 1 && refinedCells.length > 0
      ? { refinement: { factor: k, cells: refinedCells, samples: refinedSamples } }
      : {}),
    grading: {
      version: GRADING_VERSION,
      fineSpacingM: fine,
      ...(surfaces.bodies.length > 0 || surfaces.rivers.length > 0 ? { water: surfaces } : {}),
    },
  };
  return {
    terrain,
    summary: {
      roads: roads.length,
      buildings: buildings.length,
      refinedCells: k > 1 ? refinedCells.length : 0,
      maxCutM: maxCut,
      maxFillM: maxFill,
      water: {
        levelled: surfaces.bodies.filter((b) => b.graded).length,
        notLevelled: surfaces.bodies.filter((b) => !b.graded).length,
        rivers: surfaces.rivers.length,
        coarseCells: deepCells,
        shoreCells,
      },
    },
  };
}

/** Whether a block's graded values lie, within the smallest change, on the triangles of its corners. */
function coarseHolds(values: Float64Array, k: number): boolean {
  const n1 = k + 1;
  const sw = values[0] ?? 0;
  const se = values[k] ?? 0;
  const nw = values[k * n1] ?? 0;
  const ne = values[k * n1 + k] ?? 0;
  for (let j = 0; j <= k; j += 1) {
    for (let i = 0; i <= k; i += 1) {
      const u = i / k;
      const v = j / k;
      // The cell's two triangles, split south-west to north-east (as `heightAt`).
      const z = u >= v ? sw + u * (se - sw) + v * (ne - se) : sw + v * (nw - sw) + u * (ne - nw);
      if (Math.abs((values[j * n1 + i] ?? 0) - z) >= MIN_CHANGE_M) return false;
    }
  }
  return true;
}

/**
 * A run of graded roads that simply continue one another: ways of one class
 * joined end to end where nothing else meets them (OSM splits a road into
 * many ways). Profiles are smoothed along whole chains, so a road split into
 * short ways is as smooth as one that is not.
 */
interface RoadChain {
  readonly id: string;
  readonly smoothing: number;
  readonly shoulder: number;
  /** A loop: its last point is its first. */
  readonly closed: boolean;
  readonly pts: readonly Vec2[];
  /** Carriageway width of the segment from `pts[i]` to `pts[i + 1]`. */
  readonly widths: readonly number[];
  /** Distance along the chain to `pts[i]`. */
  readonly cum: readonly number[];
}

const pointKey = (p: Vec2) => `${String(Math.round(p.x * 1000))},${String(Math.round(p.y * 1000))}`;

/** The roads (graded, sorted by id) joined into chains, in a deterministic order and direction. */
function roadChains(roads: readonly Road[]): RoadChain[] {
  const ends = new Map<string, { road: number; atStart: boolean }[]>();
  const interior = new Set<string>();
  roads.forEach((road, i) => {
    const pts = road.centerline;
    pts.forEach((p, j) => {
      if (j === 0 || j === pts.length - 1) {
        const list = ends.get(pointKey(p)) ?? [];
        list.push({ road: i, atStart: j === 0 });
        ends.set(pointKey(p), list);
      } else {
        interior.add(pointKey(p));
      }
    });
  });
  /** The two way-ends meeting at `p`, when the ways there simply continue each other. */
  const joint = (p: Vec2) => {
    const list = ends.get(pointKey(p));
    if (list?.length !== 2 || interior.has(pointKey(p))) return null;
    const [e, f] = list;
    if (!e || !f || roads[e.road]?.roadClass !== roads[f.road]?.roadClass) return null;
    return [e, f] as const;
  };
  const endOf = (road: number, forward: boolean, entry: boolean) => {
    const pts = roads[road]?.centerline ?? [];
    return (entry === forward ? pts[0] : pts[pts.length - 1]) ?? { x: 0, y: 0 };
  };

  const used = new Uint8Array(roads.length);
  const chains: RoadChain[] = [];
  for (let first = 0; first < roads.length; first += 1) {
    if (used[first]) continue;
    // Back to the head of the chain (`first` is its lowest index: lower ones are used).
    let road = first;
    let forward = true;
    let closed = false;
    const seen = new Set([first]);
    for (;;) {
      const at = joint(endOf(road, forward, true));
      const other = at?.find((e) => !(e.road === road && e.atStart === forward));
      if (!other) break;
      if (seen.has(other.road)) {
        closed = true;
        road = first;
        forward = true;
        break;
      }
      seen.add(other.road);
      road = other.road;
      forward = !other.atStart;
    }
    // Forward from the head, joining ways.
    const pts: Vec2[] = [];
    const widths: number[] = [];
    const head = road;
    for (;;) {
      used[road] = 1;
      const r = roads[road];
      if (!r) break;
      const way = forward ? r.centerline : [...r.centerline].reverse();
      way.forEach((p, j) => {
        if (j === 0 && pts.length > 0) return;
        if (pts.length > 0) widths.push(r.widthMeters);
        pts.push(p);
      });
      const at = joint(endOf(road, forward, false));
      const other = at?.find((e) => !(e.road === road && e.atStart === !forward));
      if (!other || other.road === head || used[other.road]) break;
      road = other.road;
      forward = other.atStart;
    }
    const firstRoad = roads[first];
    const grading = firstRoad ? ROAD_GRADING[firstRoad.roadClass] : null;
    if (!firstRoad || !grading || pts.length < 2) continue;
    const cum = [0];
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1] ?? { x: 0, y: 0 };
      const b = pts[i] ?? a;
      cum.push((cum[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
    }
    chains.push({
      id: firstRoad.id,
      smoothing: grading.smoothing,
      shoulder: grading.shoulder,
      closed,
      pts,
      widths,
      cum,
    });
  }
  return chains;
}

/** The point at distance `s` along a chain. */
function chainPoint(chain: RoadChain, s: number): Vec2 {
  const { pts, cum } = chain;
  let i = 1;
  while (i < pts.length - 1 && (cum[i] ?? 0) < s) i += 1;
  const a = pts[i - 1] ?? { x: 0, y: 0 };
  const b = pts[i] ?? a;
  const l = (cum[i] ?? 0) - (cum[i - 1] ?? 0);
  const t = l > 0 ? Math.min(Math.max((s - (cum[i - 1] ?? 0)) / l, 0), 1) : 0;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/** A chain's ground and smoothed ground along it, as functions of the distance along it. */
interface ChainLevels {
  readonly raw: (s: number) => number;
  readonly smooth: (s: number) => number;
}

/** The source ground along a chain, and its moving average over the chain's smoothing length (round a loop). */
function smoothedLevels(chain: RoadChain, ground: (x: number, y: number) => number): ChainLevels {
  const total = chain.cum[chain.cum.length - 1] ?? 0;
  const steps = Math.max(1, Math.ceil(total / PROFILE_STEP_M));
  const raw = Array.from({ length: steps + 1 }, (_, i) => {
    const p = chainPoint(chain, (total * i) / steps);
    return ground(p.x, p.y);
  });
  const half = Math.max(1, Math.round(chain.smoothing / 2 / (total / steps || 1)));
  let smooth: number[];
  if (chain.closed && steps >= 2) {
    // Round the loop: samples 0 … steps − 1 (the last is the first again).
    const m = steps;
    const w = Math.min(half, Math.floor((m - 1) / 2));
    smooth = raw.map((_, i) => {
      let sum = 0;
      for (let d = -w; d <= w; d += 1) sum += raw[(((i + d) % m) + m) % m] ?? 0;
      return sum / (2 * w + 1);
    });
  } else {
    const prefix = [0];
    for (const z of raw) prefix.push((prefix[prefix.length - 1] ?? 0) + z);
    smooth = raw.map((_, i) => {
      const lo = Math.max(0, i - half);
      const hi = Math.min(raw.length - 1, i + half);
      return ((prefix[hi + 1] ?? 0) - (prefix[lo] ?? 0)) / (hi - lo + 1);
    });
  }
  const interp = (values: readonly number[]) => (s: number) => {
    const f = total > 0 ? (s / total) * steps : 0;
    const i = Math.min(Math.max(Math.floor(f), 0), steps - 1);
    const t = Math.min(Math.max(f - i, 0), 1);
    const a = values[i] ?? 0;
    return a + t * ((values[i + 1] ?? a) - a);
  };
  return { raw: interp(raw), smooth: interp(smooth) };
}

/** A chain at a junction, and how far along it the junction is. */
interface Member {
  readonly chain: number;
  readonly s: number;
}

interface Pin {
  readonly s: number;
  /** Correction to the smoothed level there. */
  readonly delta: number;
}

/**
 * Where chains meet, and the level they meet at: points shared by two or more
 * chains (or twice by one), and chain ends inside another road's carriageway
 * (T-junctions that share no point). Each junction's level is the mean of the
 * smoothed levels meeting there, so every road keeps its own smooth line and
 * they agree where they join.
 */
function junctionPins(
  chains: readonly RoadChain[],
  levels: readonly ChainLevels[],
): { pins: Map<number, Pin[]>; joinedEnds: Set<string> } {
  const junctions = new Map<string, Member[]>();
  chains.forEach((chain, ci) => {
    const count = chain.closed ? chain.pts.length - 1 : chain.pts.length;
    for (let i = 0; i < count; i += 1) {
      const p = chain.pts[i];
      if (!p) continue;
      const list = junctions.get(pointKey(p)) ?? [];
      list.push({ chain: ci, s: chain.cum[i] ?? 0 });
      junctions.set(pointKey(p), list);
    }
  });
  for (const [k, list] of junctions) if (list.length < 2) junctions.delete(k);

  // T-junctions: an open chain's end, met by no other chain's point, inside another's carriageway.
  const BUCKET = 50;
  const buckets = new Map<number, [number, number][]>();
  chains.forEach((chain, ci) => {
    for (let i = 0; i + 1 < chain.pts.length; i += 1) {
      const a = chain.pts[i];
      const b = chain.pts[i + 1];
      if (!a || !b) continue;
      const h = (chain.widths[i] ?? 0) / 2 + JUNCTION_SNAP_M;
      for (
        let bx = Math.floor((Math.min(a.x, b.x) - h) / BUCKET);
        bx <= Math.floor((Math.max(a.x, b.x) + h) / BUCKET);
        bx++
      ) {
        for (
          let by = Math.floor((Math.min(a.y, b.y) - h) / BUCKET);
          by <= Math.floor((Math.max(a.y, b.y) + h) / BUCKET);
          by++
        ) {
          const key = bx * 100_003 + by;
          const list = buckets.get(key) ?? [];
          list.push([ci, i]);
          buckets.set(key, list);
        }
      }
    }
  });
  chains.forEach((chain, ci) => {
    if (chain.closed) return;
    for (const end of [0, chain.pts.length - 1]) {
      const p = chain.pts[end];
      if (!p || junctions.has(pointKey(p))) continue;
      let best: { d: number; member: Member } | null = null;
      for (const [cj, i] of buckets.get(
        Math.floor(p.x / BUCKET) * 100_003 + Math.floor(p.y / BUCKET),
      ) ?? []) {
        if (cj === ci) continue;
        const other = chains[cj];
        const a = other?.pts[i];
        const b = other?.pts[i + 1];
        if (!other || !a || !b) continue;
        const d = segmentDistance(p.x, p.y, a.x, a.y, b.x, b.y);
        if (d >= (other.widths[i] ?? 0) / 2 + JUNCTION_SNAP_M) continue;
        const s = (other.cum[i] ?? 0) + nearestT * Math.hypot(b.x - a.x, b.y - a.y);
        if (!best || d < best.d || (d === best.d && cj < best.member.chain)) {
          best = { d, member: { chain: cj, s } };
        }
      }
      if (best) junctions.set(pointKey(p), [{ chain: ci, s: chain.cum[end] ?? 0 }, best.member]);
    }
  });

  // Junctions this close together are one, at one level: a staggered
  // crossroads, or a junction mapped as several nearby points. (Levelled
  // apart, the short pieces of road between them would have to climb from
  // one level to the other.)
  const keys = [...junctions.keys()].sort();
  const position = keys.map((k) => {
    const [x = 0, y = 0] = k.split(',').map(Number);
    return { x: x / 1000, y: y / 1000 };
  });
  const parent = keys.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    return r;
  };
  const near = new Map<number, number[]>();
  const cell = (v: number) => Math.floor(v / JUNCTION_CLUSTER_M);
  position.forEach((p, i) => {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const j of near.get((cell(p.x) + dx) * 100_003 + cell(p.y) + dy) ?? []) {
          const q = position[j];
          if (!q || Math.hypot(q.x - p.x, q.y - p.y) > JUNCTION_CLUSTER_M) continue;
          const a = find(i);
          const b = find(j);
          if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        }
      }
    }
    const k = cell(p.x) * 100_003 + cell(p.y);
    near.set(k, [...(near.get(k) ?? []), i]);
  });
  const clusters = new Map<number, Member[]>();
  keys.forEach((k, i) => {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), ...(junctions.get(k) ?? [])]);
  });

  const pins = new Map<number, Pin[]>();
  /** Chain ends (`chain:start`, `chain:end`) at a junction. */
  const joinedEnds = new Set<string>();
  for (const members of clusters.values()) {
    for (const m of members) {
      const chain = chains[m.chain];
      if (!chain || chain.closed) continue;
      if (m.s === 0) joinedEnds.add(`${String(m.chain)}:start`);
      if (m.s === chain.cum[chain.cum.length - 1]) joinedEnds.add(`${String(m.chain)}:end`);
    }
    // Summed in a fixed order, so the level does not depend on how the features were listed.
    const sorted = [...members].sort((m, n) => m.chain - n.chain || m.s - n.s);
    const smoothAt = (m: Member) => levels[m.chain]?.smooth(m.s) ?? 0;
    const level = sorted.reduce((sum, m) => sum + smoothAt(m), 0) / sorted.length;
    for (const m of sorted) {
      const list = pins.get(m.chain) ?? [];
      list.push({ s: m.s, delta: level - smoothAt(m) });
      pins.set(m.chain, list);
    }
  }
  for (const list of pins.values()) list.sort((p, q) => p.s - q.s || p.delta - q.delta);
  return { pins, joinedEnds };
}

/**
 * A chain's design elevation as a function of the distance along it: its
 * smoothed ground, brought to the junction levels (corrections linear between
 * junctions, fading out over `PIN_BLEND_M` beyond the outermost, or round a
 * loop), and kept within `MAX_CENTRE_DEPTH_M` of the ground.
 */
function roadProfile(
  chain: RoadChain,
  levels: ChainLevels,
  pins: readonly Pin[],
): (s: number) => number {
  const total = chain.cum[chain.cum.length - 1] ?? 0;
  const fade = (delta: number, distance: number) => delta * Math.max(0, 1 - distance / PIN_BLEND_M);
  const between = (p: Pin, q: Pin, s: number) => {
    const t = q.s > p.s ? (s - p.s) / (q.s - p.s) : 0;
    return p.delta + t * (q.delta - p.delta);
  };
  const correction = (s: number): number => {
    const first = pins[0];
    const last = pins[pins.length - 1];
    if (!first || !last) return 0;
    if (chain.closed && total > 0) {
      if (pins.length === 1) {
        const d = Math.abs(s - first.s);
        return fade(first.delta, Math.min(d, total - d));
      }
      // Round the loop from the last junction to the first.
      if (s < first.s) return between({ s: last.s - total, delta: last.delta }, first, s);
      if (s > last.s) return between(last, { s: first.s + total, delta: first.delta }, s);
    } else {
      if (s <= first.s) return fade(first.delta, first.s - s);
      if (s >= last.s) return fade(last.delta, s - last.s);
    }
    for (let i = 1; i < pins.length; i += 1) {
      const p = pins[i - 1];
      const q = pins[i];
      if (p && q && s <= q.s) return between(p, q, s);
    }
    return 0;
  };
  return (s: number) => {
    const z = levels.smooth(s) + correction(s);
    const g = levels.raw(s);
    return Math.min(g + MAX_CENTRE_DEPTH_M, Math.max(g - MAX_CENTRE_DEPTH_M, z));
  };
}
