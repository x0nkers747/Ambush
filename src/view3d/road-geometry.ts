import type { Road, RoadClass } from '#sim';
import { finishMesh, type Draper, type MeshData } from './drape';
import type { Occupancy } from './planar';
import {
  CLASS_PRIORITY,
  drapeSurface,
  onSurface,
  roadLevel,
  type SurfaceLine,
  type SurfaceOwner,
  type SurfaceStats,
} from './road-surface';

// Roads and tracks in 3D (docs/adr/0030, docs/adr/0044): the road network
// draped on the ground as one coherent surface (see road-surface.ts): pieces
// placed in order of importance, each cut by those placed before it, so
// junctions are single paved areas and no surface lies on another. The
// styling goes on the road's class and width. Every layer is one mesh with
// one material, so all the roads cost a handful of draw calls.

/** The road layers, lowest first. `verge` is the shoulder under paved roads. */
export type RoadLayer = 'verge' | RoadClass;

export const ROAD_LAYERS: readonly RoadLayer[] = [
  'verge',
  'path',
  'track',
  'unpaved',
  'paved',
  'major',
];

export interface RoadLayerStyle {
  /** sRGB colour. */
  readonly color: number;
  /**
   * Height above the ground in metres. The same for every layer: the surfaces
   * do not overlap (docs/adr/0044), so none needs lifting over another.
   */
  readonly offset: number;
  readonly roughness: number;
}

/** Height of every road surface above the ground, metres. */
export const ROAD_OFFSET_M = 0.06;

/** Muted colours: asphalt for roads, earth and gravel for the rest. */
export const ROAD_STYLE: Readonly<Record<RoadLayer, RoadLayerStyle>> = {
  verge: { color: 0x9a947f, offset: ROAD_OFFSET_M, roughness: 1 },
  path: { color: 0xa69a7c, offset: ROAD_OFFSET_M, roughness: 1 },
  track: { color: 0x8f7d5e, offset: ROAD_OFFSET_M, roughness: 1 },
  unpaved: { color: 0x9c9077, offset: ROAD_OFFSET_M, roughness: 1 },
  paved: { color: 0x74736e, offset: ROAD_OFFSET_M, roughness: 0.9 },
  major: { color: 0x63625e, offset: ROAD_OFFSET_M, roughness: 0.85 },
};

/** Width of the verge on each side of a paved road, in metres. */
export const VERGE_M = 0.6;

export interface RoadSurfaces {
  /** The draped road layers, one mesh each (layers with no roads are left out). */
  readonly layers: Map<RoadLayer, MeshData>;
  /** The space the roads and verges take, for cutting later surfaces (driveways). */
  readonly occupancy: Occupancy<SurfaceOwner>;
  readonly stats: SurfaceStats & {
    readonly vergePieces: number;
    readonly vergeCutMs: number;
    readonly vergeDrapeMs: number;
  };
}

/** The draped road layers, one mesh each (layers with no roads are left out). */
export function roadGeometry(roads: readonly Road[], draper: Draper): Map<RoadLayer, MeshData> {
  return roadSurfaces(roads, draper).layers;
}

/**
 * The roads as one surface (docs/adr/0044): every road on the surface (not
 * tunnels), then the verges of paved roads around them, cut by the roads.
 */
export function roadSurfaces(roads: readonly Road[], draper: Draper): RoadSurfaces {
  const drawn = roads.filter(onSurface);
  const lines: SurfaceLine<RoadLayer>[] = drawn.map((r) => ({
    id: r.id,
    style: r.roadClass,
    rank: CLASS_PRIORITY.indexOf(r.roadClass),
    centerline: r.centerline,
    halfWidth: r.widthMeters / 2,
    level: roadLevel(r),
    fillets: r.roadClass !== 'path',
  }));
  const offset = (layer: RoadLayer) => ROAD_STYLE[layer].offset;
  const built = drapeSurface(lines, draper, offset);
  // The verges after every road, so they show only beside the roads.
  const verges: SurfaceLine<RoadLayer>[] = drawn
    .filter((r) => r.roadClass === 'paved' || r.roadClass === 'major')
    .map((r) => ({
      id: `verge:${r.id}`,
      style: 'verge',
      rank: CLASS_PRIORITY.length,
      centerline: r.centerline,
      halfWidth: r.widthMeters / 2 + VERGE_M,
      // Only the band beside the road.
      inner: r.widthMeters / 2,
      level: roadLevel(r),
      fillets: false,
      // Joined to its road, and to whatever its road is joined to; a shoulder gives way to every road.
      joins: [r.id, ...(built.joined.get(r.id) ?? [])],
      yields: true,
    }));
  const verge = drapeSurface(verges, draper, offset, built.occupancy);
  const out = new Map<RoadLayer, MeshData>();
  for (const layer of ROAD_LAYERS) {
    const b = (layer === 'verge' ? verge : built).meshes.get(layer);
    if (b && b.positions.length > 0) out.set(layer, finishMesh(b));
  }
  return {
    layers: out,
    occupancy: built.occupancy,
    stats: {
      ...built.stats,
      cutMs: built.stats.cutMs + verge.stats.cutMs,
      drapeMs: built.stats.drapeMs + verge.stats.drapeMs,
      vergePieces: verge.stats.cutPieces,
      vergeCutMs: verge.stats.cutMs,
      vergeDrapeMs: verge.stats.drapeMs,
    },
  };
}
