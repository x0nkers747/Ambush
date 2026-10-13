import { ShapeUtils, Vector2 } from 'three';
import {
  buildingRoofElevations,
  heightAt,
  pointInPolygon,
  type Building,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import {
  buildingStyle,
  categoryOf,
  landUseLookup,
  regionOf,
  ROOF_LAYERS,
  ROOF_TILE_M,
  WALL_LAYERS,
  WALL_TILE_M,
  type BuildingStyle,
  type Region,
  type RoofKind,
} from './building-style';
import type { Rgb } from './drape';
import {
  cellUv,
  storeysOf,
  wallOpenings,
  type FacadeWall,
  type Opening,
  type OpeningKind,
} from './facade';
import { cleanRing, footprintShape, signedArea, type FootprintShape } from './footprint-shape';
import { hashString, unit } from './hash';
import {
  emitPitchedRoof,
  planRoof,
  roofHeightAt,
  type GableEnd,
  type RoofPlan,
} from './roof-geometry';
import { polylineSegments, segmentGrid, type SegmentGrid } from './spatial-index';
import {
  surfaceBuilder,
  type SurfaceBuilder,
  type SurfaceMeshData,
  type SurfaceVertex,
} from './surface-mesh';
import { srgbToLinear } from './terrain-mesh';

// Buildings in 3D (docs/adr/0030, procedural since docs/adr/0035).
//
// Each building is drawn from its footprint and its reference roof elevation:
// exactly where line of sight finds its top (`buildingRoofElevations`, the
// lowest ground at its corners plus its height). A pitched roof keeps that
// as its mean height (eaves below it, ridge above, see roof-geometry.ts), a
// flat roof lies at it. The walls reach down past the lowest ground anywhere
// along the footprint's edges, so they always meet the ground with no gap;
// the ground itself is never changed. A concrete plinth runs along the bottom.
//
// The look (roof shape and pitch, wall and roof materials and colours,
// windows, doors) comes from building-style.ts: the source's tags where it
// has them, else defaults for the building's kind and the battlefield's
// region, varied by a hash of the building's id. The same building always
// looks the same, whatever order buildings are loaded in. None of it reaches
// the simulation.
//
// Output: one mesh of walls, roofs and trim (textured from one texture array,
// with a layer per vertex), and one of windows and doors (from an atlas):
// two draw calls for every building on the battlefield.

/** Plinth height above the lowest corner, at most. */
export const PLINTH_M = 0.5;
/** The walls reach this far below the lowest ground on the footprint's edges. */
export const FOOTING_M = 0.5;
/** Ground along the edges is sampled at least this often. */
export const EDGE_SAMPLE_M = 0.5;
/** Parapet height above a flat roof, metres. */
export const PARAPET_M = 0.6;
/** Openings stand this far in front of their wall, metres. */
export const OPENING_OFFSET_M = 0.04;
/** Roads farther than this from every wall leave the longest wall as the entrance, metres. */
const ENTRANCE_REACH_M = 60;
/** Walls shorter than this never take the entrance, metres. */
const MIN_ENTRANCE_WALL_M = 3;
/** Roads that are not for vehicles do not draw entrances. */
const FOOT_HIGHWAYS = new Set([
  'footway',
  'path',
  'cycleway',
  'bridleway',
  'steps',
  'pedestrian',
  'corridor',
]);

/** Texture layers: wall layers first, then roof layers; trim is untextured (−1). */
export const WALL_LAYER_BASE = 0;
export const ROOF_LAYER_BASE = WALL_LAYERS.length;
export const TRIM_LAYER = -1;
const PLINTH_TINT = 0x8e8a82;

/** Where a building's door is: on its wall, at ground level, facing out. Display metadata. */
export interface BuildingEntrance {
  readonly buildingId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit outward direction. */
  readonly nx: number;
  readonly ny: number;
  readonly kind: OpeningKind;
}

export interface BuildingStats {
  readonly roofs: Readonly<Record<RoofKind, number>>;
  readonly shapes: Readonly<Record<FootprintShape['kind'], number>>;
  readonly windows: number;
  readonly doors: number;
  readonly region: Region;
}

export interface BuildingGeometry {
  /** Walls, roofs and trim. */
  readonly surfaces: SurfaceMeshData;
  /** Windows and doors. */
  readonly openings: SurfaceMeshData;
  /** Buildings drawn. */
  readonly count: number;
  /**
   * Buildings whose reference roof (as line of sight uses it) is below the
   * highest ground at their corners: on steep ground the uphill wall disappears.
   */
  readonly buried: number;
  readonly entrances: readonly BuildingEntrance[];
  readonly stats: BuildingStats;
  /** Each building's shape and style (for the roadside details, docs/adr/0036). */
  readonly designs: ReadonlyMap<string, BuildingDesign>;
}

const linear = (srgb: number, shade = 1): Rgb => [
  srgbToLinear(((srgb >> 16) & 255) * shade),
  srgbToLinear(((srgb >> 8) & 255) * shade),
  srgbToLinear((srgb & 255) * shade),
];

/** A building's look, decided once: its footprint's shape and its style. */
export interface BuildingDesign {
  readonly shape: FootprintShape | null;
  readonly style: BuildingStyle;
}

/** Designs every building: deterministic in each building and the battlefield's region and land use. */
export function designBuildings(terrain: TerrainDataset): ReadonlyMap<string, BuildingDesign> {
  const region = regionOf(terrain);
  const landUse = landUseLookup(terrain.features.landUse ?? []);
  const out = new Map<string, BuildingDesign>();
  for (const b of terrain.features.buildings) {
    const shape = safeShape(b.footprint);
    const area = shape ? shape.area : Math.abs(signedArea(b.footprint));
    const centre = centroid(b.footprint);
    const category = categoryOf(b, landUse(centre), area);
    const width = shape
      ? Math.min(shape.ombr.s1 - shape.ombr.s0, shape.ombr.t1 - shape.ombr.t0)
      : 0;
    const style = buildingStyle(b, category, region, {
      area,
      shape: shape?.kind ?? 'irregular',
      width,
    });
    out.set(b.id, { shape, style });
  }
  return out;
}

function safeShape(footprint: readonly Vec2[]): FootprintShape | null {
  const ring = cleanRing(footprint);
  if (ring.length < 3 || !(signedArea(ring) > 0.5)) return null;
  return footprintShape(footprint);
}

function centroid(ring: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / Math.max(1, ring.length), y: y / Math.max(1, ring.length) };
}

/** Roads for choosing entrances: everything vehicles use, driveways included. */
function roadIndex(terrain: TerrainDataset): SegmentGrid {
  const roads = terrain.features.roads.filter(
    (r) => r.roadClass !== 'path' && !(r.highway !== undefined && FOOT_HIGHWAYS.has(r.highway)),
  );
  return segmentGrid(
    polylineSegments(roads.map((r) => ({ points: r.centerline, halfWidth: r.widthMeters / 2 }))),
    ENTRANCE_REACH_M,
    40,
  );
}

/** Display context for the buildings. */
export interface BuildingContext {
  /**
   * The level of levelled water at or just beside (x, y), or null: walls
   * standing in water reach below it (docs/adr/0046), where the 3D view cuts
   * away ground the grading left above the water.
   */
  readonly waterLevelNear?: (x: number, y: number) => number | null;
}

/** Walls standing in water reach this far below its level, metres. */
export const WATER_FOOTING_M = 0.6;

export function buildingGeometry(
  terrain: TerrainDataset,
  context: BuildingContext = {},
): BuildingGeometry {
  const roofs = buildingRoofElevations(terrain);
  const designs = designBuildings(terrain);
  const roads = roadIndex(terrain);
  const surfaces = surfaceBuilder();
  const openings = surfaceBuilder();
  const entrances: BuildingEntrance[] = [];
  const roofCounts: Record<RoofKind, number> = { flat: 0, gabled: 0, hipped: 0, skillion: 0 };
  const shapeCounts: Record<FootprintShape['kind'], number> = {
    rectangle: 0,
    rectilinear: 0,
    irregular: 0,
  };
  let windows = 0;
  let doors = 0;

  const sorted = [...terrain.features.buildings].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  let buried = 0;
  let count = 0;
  for (const building of sorted) {
    const reference = roofs.get(building.id);
    const design = designs.get(building.id);
    if (reference === undefined || !design) continue;
    count += 1;
    const result = emitBuilding(
      terrain,
      building,
      reference,
      design,
      roads,
      surfaces,
      openings,
      context,
    );
    if (result.buried) buried += 1;
    roofCounts[result.roof] += 1;
    shapeCounts[design.shape?.kind ?? 'irregular'] += 1;
    windows += result.windows;
    doors += result.doors;
    entrances.push(...result.entrances);
  }
  return {
    surfaces: surfaces.finish(),
    openings: openings.finish(),
    count,
    buried,
    entrances,
    designs,
    stats: {
      roofs: roofCounts,
      shapes: shapeCounts,
      windows,
      doors,
      region: regionOf(terrain),
    },
  };
}

interface BuildingResult {
  readonly buried: boolean;
  readonly roof: RoofKind;
  readonly windows: number;
  readonly doors: number;
  readonly entrances: readonly BuildingEntrance[];
}

function emitBuilding(
  terrain: TerrainDataset,
  building: Building,
  reference: number,
  design: BuildingDesign,
  roads: SegmentGrid,
  surfaces: SurfaceBuilder,
  openings: SurfaceBuilder,
  context: BuildingContext,
): BuildingResult {
  const { shape, style } = design;
  const ring = shape ? shape.ring : counterClockwise(building.footprint);
  // Ground samples just outside a wall are kept on the terrain.
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const maxX = originX + (columns - 1) * cellSize;
  const maxY = originY + (rows - 1) * cellSize;
  const ground = (x: number, y: number) =>
    heightAt(terrain, Math.min(maxX, Math.max(originX, x)), Math.min(maxY, Math.max(originY, y)));
  const corners = building.footprint.map((p) => ground(p.x, p.y));
  const lowestCorner = Math.min(...corners);
  const buried = Math.max(...corners) > reference;
  // The lowest ground anywhere along the edges, so no wall stops short of it.
  let lowest = Math.min(lowestCorner, ...ring.map((p) => ground(p.x, p.y)));
  // And below any water the walls stand in.
  let water = Infinity;
  const inWater = (x: number, y: number) => {
    const level = context.waterLevelNear?.(x, y) ?? null;
    if (level !== null) water = Math.min(water, level - WATER_FOOTING_M);
  };
  ring.forEach((a, i) => {
    inWater(a.x, a.y);
    const b = ring[(i + 1) % ring.length] ?? a;
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / EDGE_SAMPLE_M);
    for (let k = 1; k < steps; k += 1) {
      const t = k / steps;
      const x = a.x + t * (b.x - a.x);
      const y = a.y + t * (b.y - a.y);
      lowest = Math.min(lowest, ground(x, y));
      inWater(x, y);
    }
  });
  const bottom = Math.min(lowest - FOOTING_M, water);
  const id = hashString(building.id);
  const chance = unit(Math.imul(id, 0x9e3779b1) >>> 0);

  const plan: RoofPlan | null = shape
    ? planRoof({
        shape,
        kind: style.roof,
        pitchDegrees: style.pitchDegrees,
        overhangM: style.overhangM,
        reference,
        base: lowestCorner,
        appearance: building.appearance,
        chance,
      })
    : null;
  const roofKind: RoofKind = plan?.kind ?? 'flat';
  const pitched = plan !== null && roofKind !== 'flat';
  const eaves = pitched ? plan.eaves : reference;
  const parapet = !pitched && style.parapet;
  const wallTopFlat = parapet ? reference + PARAPET_M : reference;

  /** The wall's top at a corner. */
  const topAt = (p: Vec2) => {
    if (!pitched) return wallTopFlat;
    const z = roofHeightAt(plan, p.x, p.y);
    if (z === null) return eaves;
    return plan.kind === 'skillion'
      ? Math.min(plan.top, Math.max(eaves, z))
      : Math.min(eaves + 0.3, Math.max(eaves - 1, z));
  };

  const wallLayer = WALL_LAYER_BASE + WALL_LAYERS.indexOf(style.wallLayer);
  const wallTile = WALL_TILE_M[style.wallLayer];
  const plinthLayer = WALL_LAYER_BASE + WALL_LAYERS.indexOf('concrete');
  const plinthTile = WALL_TILE_M.concrete;
  const wallColour = linear(style.wallTint);
  const plinthColour = linear(PLINTH_TINT);
  const trimColour = linear(style.trimTint);
  const roofColour = linear(style.roofTint);
  const roofLayer = ROOF_LAYER_BASE + ROOF_LAYERS.indexOf(style.roofLayer);
  const plinthTop = Math.min(lowestCorner + PLINTH_M, eaves - 1);

  // Walls, the plinth along their bottom.
  let along = 0;
  const walls: {
    a: Vec2;
    b: Vec2;
    len: number;
    nx: number;
    ny: number;
    ta: number;
    tb: number;
  }[] = [];
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length] ?? a;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) return;
    // Outward normal of a counter-clockwise ring: (dy, −dx).
    const nx = (b.y - a.y) / len;
    const ny = -(b.x - a.x) / len;
    const facing = [nx, ny, 0] as const;
    const ta = topAt(a);
    const tb = topAt(b);
    const v = (p: Vec2, z: number, u: number, tile: number): SurfaceVertex => ({
      x: p.x,
      y: p.y,
      z,
      u: u / tile,
      v: (z - lowestCorner) / tile,
    });
    const u0 = along;
    const u1 = along + len;
    surfaces.quad(
      v(a, bottom, u0, plinthTile),
      v(b, bottom, u1, plinthTile),
      v(b, plinthTop, u1, plinthTile),
      v(a, plinthTop, u0, plinthTile),
      facing,
      plinthColour,
      plinthLayer,
    );
    surfaces.quad(
      v(a, plinthTop, u0, wallTile),
      v(b, plinthTop, u1, wallTile),
      v(b, tb, u1, wallTile),
      v(a, ta, u0, wallTile),
      facing,
      wallColour,
      wallLayer,
    );
    if (parapet) {
      // The parapet's inner face, above the roof.
      surfaces.quad(
        v(a, reference, u0, wallTile),
        v(b, reference, u1, wallTile),
        v(b, wallTopFlat, u1, wallTile),
        v(a, wallTopFlat, u0, wallTile),
        [-nx, -ny, 0],
        wallColour,
        wallLayer,
      );
      // A coping along its top.
      const inset = 0.25;
      const ix = -nx * inset;
      const iy = -ny * inset;
      const t = (p: Vec2, dx: number, dy: number): SurfaceVertex => ({
        x: p.x + dx,
        y: p.y + dy,
        z: wallTopFlat,
        u: 0,
        v: 0,
      });
      surfaces.quad(
        t(a, 0, 0),
        t(b, 0, 0),
        t(b, ix, iy),
        t(a, ix, iy),
        [0, 0, 1],
        trimColour,
        TRIM_LAYER,
      );
    }
    walls.push({ a, b, len, nx, ny, ta, tb });
    along = u1;
  });

  // The roof.
  let gables: GableEnd[] = [];
  if (pitched) {
    gables = emitPitchedRoof(plan, surfaces, {
      roof: roofColour,
      roofLayer,
      wall: wallColour,
      wallLayer,
      wallTileM: wallTile,
      roofTileM: ROOF_TILE_M[style.roofLayer],
      trim: trimColour,
      base: lowestCorner,
    });
  } else {
    const roofTile = ROOF_TILE_M[style.roofLayer];
    const contour = ring.map((p) => new Vector2(p.x, p.y));
    for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
      const at = (t: number | undefined): SurfaceVertex => {
        const p = ring[t ?? 0] ?? { x: 0, y: 0 };
        return { x: p.x, y: p.y, z: reference, u: p.x / roofTile, v: p.y / roofTile };
      };
      surfaces.triangle(at(i), at(j), at(k), [0, 0, 1], roofColour, roofLayer);
    }
  }

  // Windows and doors. The entrance faces the nearest road.
  let entranceWall = -1;
  let bestScore = -Infinity;
  walls.forEach((w, i) => {
    if (w.len < MIN_ENTRANCE_WALL_M) return;
    const mx = (w.a.x + w.b.x) / 2 + w.nx * 2;
    const my = (w.a.y + w.b.y) / 2 + w.ny * 2;
    const score = -roads.distance(mx, my, ENTRANCE_REACH_M) + 0.02 * w.len;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      entranceWall = i;
    }
  });
  const floor = lowestCorner + 0.15;
  const storeys = storeysOf(eaves - floor, style.storeyM, building.appearance?.levels);
  const storeyM = (eaves - floor) / storeys;
  const tint = new Map<number, Rgb>();
  const tintOf = (c: number) => {
    let t = tint.get(c);
    if (!t) {
      t = linear(c);
      tint.set(c, t);
    }
    return t;
  };
  let windows = 0;
  let doors = 0;
  const entrances: BuildingEntrance[] = [];
  walls.forEach((w, i) => {
    const dx = (w.b.x - w.a.x) / w.len;
    const dy = (w.b.y - w.a.y) / w.len;
    const wall: FacadeWall = {
      length: w.len,
      top: (s) => w.ta + ((w.tb - w.ta) * s) / w.len,
      ground: (s) => ground(w.a.x + dx * s + w.nx * 0.3, w.a.y + dy * s + w.ny * 0.3),
      entrance: i === entranceWall,
    };
    const list = wallOpenings(wall, {
      style,
      floor,
      storeys,
      storeyM,
      chance: unit(Math.imul(id ^ (i + 1), 0x85ebca6b) >>> 0),
    });
    for (const o of list) {
      emitOpening(openings, w.a, dx, dy, w.nx, w.ny, o, tintOf(o.tint));
      if (o.kind === 'window') windows += 1;
      else {
        doors += 1;
        const s = (o.s0 + o.s1) / 2;
        entrances.push({
          buildingId: building.id,
          x: w.a.x + dx * s,
          y: w.a.y + dy * s,
          z: o.z0,
          nx: w.nx,
          ny: w.ny,
          kind: o.kind,
        });
      }
    }
  });
  // A window in each outer gable of a pitched house roof that has room for one.
  if (style.window && !style.window.strip && style.category === 'residential') {
    for (const g of gables) {
      if (g.apex - g.eaves < 2.6) continue;
      // Only on an outer wall: just in front of the gable is outside the footprint.
      const mid = {
        x: (g.left.x + g.right.x) / 2 + g.nx * 0.3,
        y: (g.left.y + g.right.y) / 2 + g.ny * 0.3,
      };
      if (pointInPolygon(mid, ring)) continue;
      const half = Math.hypot(g.right.x - g.left.x, g.right.y - g.left.y) / 2;
      const z0 = g.eaves + 0.35;
      const h = Math.min(1.0, g.apex - g.eaves - 1.2);
      const w = 0.8;
      // The triangle's half-width at the window's top must leave room.
      if (h < 0.6 || (half * (g.apex - z0 - h)) / (g.apex - g.eaves) < w / 2 + 0.2) continue;
      const dx = (g.right.x - g.left.x) / (2 * half);
      const dy = (g.right.y - g.left.y) / (2 * half);
      // Not where the ground has buried the gable (steep slopes).
      const outside = (s: number) =>
        ground(g.left.x + dx * s + g.nx * 0.3, g.left.y + dy * s + g.ny * 0.3);
      if (z0 < Math.max(outside(half - w / 2), outside(half + w / 2)) + 0.3) continue;
      emitOpening(
        openings,
        g.left,
        dx,
        dy,
        g.nx,
        g.ny,
        {
          kind: 'window',
          cell: 7,
          s0: half - w / 2,
          s1: half + w / 2,
          z0,
          z1: z0 + h,
          tint: 0xffffff,
        },
        tintOf(0xffffff),
      );
      windows += 1;
    }
  }
  return { buried, roof: roofKind, windows, doors, entrances };
}

/** An opening's quad, just in front of its wall. */
function emitOpening(
  out: SurfaceBuilder,
  start: Vec2,
  dx: number,
  dy: number,
  nx: number,
  ny: number,
  o: Opening,
  colour: Rgb,
) {
  const [u0, v0, u1, v1] = cellUv(o.cell);
  const ox = nx * OPENING_OFFSET_M;
  const oy = ny * OPENING_OFFSET_M;
  const v = (s: number, z: number, u: number, vv: number): SurfaceVertex => ({
    x: start.x + dx * s + ox,
    y: start.y + dy * s + oy,
    z,
    u,
    v: vv,
  });
  out.quad(
    v(o.s0, o.z0, u0, v0),
    v(o.s1, o.z0, u1, v0),
    v(o.s1, o.z1, u1, v1),
    v(o.s0, o.z1, u0, v1),
    [nx, ny, 0],
    colour,
    0,
  );
}

/** The footprint counter-clockwise (seen from above), without a repeated closing corner. */
function counterClockwise(footprint: readonly Vec2[]): Vec2[] {
  const ring = [...footprint];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && ring.length > 3 && first.x === last.x && first.y === last.y) ring.pop();
  return signedArea(ring) < 0 ? ring.reverse() : ring;
}
