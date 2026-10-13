import { ShapeUtils, Vector2 } from 'three';
import {
  channelWidth,
  terrainWaterQuery,
  type TerrainDataset,
  type Vec2,
  type WaterClass,
} from '#sim';
import {
  finishMesh,
  meshBuffers,
  type Draper,
  type MeshBuffers,
  type MeshData,
  type Rgb,
} from './drape';
import { drapeNetwork } from './line-network';
import { srgbToLinear } from './terrain-mesh';
import {
  DRAPED_PROFILE,
  URBAN_CANAL_SHARE,
  urbanGrid,
  urbanShare,
  WATER_PROFILES,
  waterProfileFor,
  type WaterProfileName,
} from './water-profiles';

// Water in 3D (docs/adr/0030, docs/adr/0040): lakes, ponds, river surfaces
// and the sea (`water` areas, islands left open), and watercourses drawn as
// lines (`waterways`), as one opaque surface coloured by its visual profile
// (water-profiles.ts, docs/adr/0046).
//
// Water the grading levelled (sim/water-grading.ts) is drawn at its level:
// standing water as one exactly horizontal sheet, rivers on their profile,
// level across and falling smoothly downstream. The graded ground meets that
// level at the shore and lies below it in the water, so the sheet neither
// floats nor cuts the banks. Water that was not levelled (too small, or
// unlike the ground under it) and narrow watercourses are draped on the
// ground, as before. Wetland is marshy ground, not open water: it is shown in
// the ground's colours, not here.

/** Water not levelled lies just above the ground, below the roads that cross it. */
export const WATER_OFFSET_M = 0.03;

const rgb = (c: number): Rgb => [
  srgbToLinear((c >> 16) & 255),
  srgbToLinear((c >> 8) & 255),
  srgbToLinear(c & 255),
];

export interface WaterGeometry {
  readonly mesh: MeshData;
  readonly areas: number;
  readonly waterways: number;
  /** Areas drawn at their level (the rest are draped). */
  readonly levelled: number;
  /** Each water area's visual profile (by id). */
  readonly profiles: ReadonlyMap<string, WaterProfileName>;
}

const profileColor = (p: WaterProfileName): Rgb => rgb(WATER_PROFILES[p].color);

/** A levelled water's visual profile: its class and how built-up its shore is. */
export function areaProfile(cls: WaterClass, ring: readonly Vec2[], terrain: TerrainDataset) {
  return waterProfileFor(cls, urbanShare(ring, urbanGrid(terrain)));
}

/** Sets the heights of vertices `from`… of `out` (Three.js y) by `level(x, y)` where it gives one. */
function lift(out: MeshBuffers, from: number, level: (x: number, y: number) => number | null) {
  for (let i = from; i < out.positions.length; i += 3) {
    const l = level(out.positions[i] ?? 0, -(out.positions[i + 2] ?? 0));
    if (l !== null) out.positions[i + 1] = l;
  }
}

/** Triangulates a polygon with holes as a horizontal sheet at `level`, facing up. */
function flatSheet(
  boundary: readonly Vec2[],
  holes: readonly (readonly Vec2[])[],
  level: number,
  out: MeshBuffers,
  color: Rgb,
) {
  const contour = boundary.map((p) => new Vector2(p.x, p.y));
  const holeRings = holes.map((h) => h.map((p) => new Vector2(p.x, p.y)));
  const all = [...contour, ...holeRings.flat()];
  for (const tri of ShapeUtils.triangulateShape(contour, holeRings)) {
    const pa = all[tri[0] ?? -1];
    const pb = all[tri[1] ?? -1];
    const pc = all[tri[2] ?? -1];
    if (!pa || !pb || !pc) continue;
    // Counter-clockwise from above in map axes is counter-clockwise from above in Three.js.
    const ccw = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y) > 0;
    for (const p of ccw ? [pa, pb, pc] : [pa, pc, pb]) {
      out.positions.push(p.x, level, -p.y);
      out.normals.push(0, 1, 0);
      out.colors?.push(...color);
    }
  }
}

export function waterGeometry(terrain: TerrainDataset, draper: Draper): WaterGeometry {
  const { water = [], waterways = [] } = terrain.features;
  const query = terrainWaterQuery(terrain);
  const out = meshBuffers(true);
  const areas = water
    .filter((w) => w.kind === 'water')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const standing = new Map((terrain.grading?.water?.bodies ?? []).map((b) => [b.id, b] as const));
  let levelled = 0;
  const profiles = new Map<string, WaterProfileName>();
  for (const area of areas) {
    const cls = query?.bodyClass(area.id) ?? null;
    const body = standing.get(area.id);
    if (!query || cls === null || !body?.graded) {
      profiles.set(area.id, DRAPED_PROFILE);
      draper.polygon(
        area.boundary,
        area.holes ?? [],
        WATER_OFFSET_M,
        out,
        profileColor(DRAPED_PROFILE),
      );
      continue;
    }
    levelled += 1;
    const profile = areaProfile(cls, area.boundary, terrain);
    profiles.set(area.id, profile);
    const color = profileColor(profile);
    if (body.flow === 'standing' && body.level !== null) {
      // One exactly level sheet.
      flatSheet(area.boundary, area.holes ?? [], body.level, out, color);
    } else {
      // A river's surface: cut along the terrain's cells, each corner at the profile's level.
      const from = out.positions.length;
      draper.polygon(area.boundary, area.holes ?? [], 0, out, color);
      lift(out, from, (x, y) => query.bodyLevel(area.id, x, y));
    }
  }
  const urban = urbanGrid(terrain);
  const lineProfile = new Map(
    waterways.map((w) => [
      w.id,
      w.kind === 'canal' && urbanShare(w.centerline, urban) >= URBAN_CANAL_SHARE
        ? ('urbanCanal' as const)
        : ('river' as const),
    ]),
  );
  // Each profile's lines as a network of its own (each draws its junctions).
  for (const profile of ['river', 'urbanCanal'] as const) {
    const ways = waterways.filter((w) => lineProfile.get(w.id) === profile);
    if (ways.length === 0) continue;
    const lines = drapeNetwork(
      ways.map((w) => ({
        id: w.id,
        style: 'waterway' as const,
        centerline: w.centerline,
        // A levelled channel is drawn as wide as it was levelled (its banks are there).
        halfWidth: (query && channelWidth(w) > 0 ? channelWidth(w) : w.widthMeters) / 2,
      })),
      draper,
      () => WATER_OFFSET_M,
    ).get('waterway');
    if (!lines) continue;
    const from = out.positions.length;
    // (Element by element: spreading a long array overflows the call stack.)
    for (const v of lines.positions) out.positions.push(v);
    for (const v of lines.normals) out.normals.push(v);
    const color = profileColor(profile);
    for (let i = from; i < out.positions.length; i += 3) {
      // Where a watercourse runs in levelled water (its own channel, or a lake), it is at that level.
      const at = query?.at(out.positions[i] ?? 0, -(out.positions[i + 2] ?? 0)) ?? null;
      // (A channel's edge is its shore: at the level too.)
      const l = at && (at.inWater || at.shoreDistance < 0.5) ? at.level : null;
      if (l !== null) out.positions[i + 1] = l;
      out.colors?.push(...color);
    }
  }
  // Lit as a level surface whatever the ground under it: following the
  // ground's normals, bumps in the elevation data under the water would catch
  // the sun as bright streaks. (Rivers fall a few metres per kilometre at most.)
  for (let i = 0; i < out.normals.length; i += 3) {
    out.normals[i] = 0;
    out.normals[i + 1] = 1;
    out.normals[i + 2] = 0;
  }
  return {
    mesh: finishMesh(out),
    areas: areas.length,
    waterways: waterways.length,
    levelled,
    profiles,
  };
}
