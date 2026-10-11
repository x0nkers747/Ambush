import type { Road, RoadClass } from '#sim';
import { finishMesh, type Draper, type MeshData } from './drape';
import { drapeNetwork, type NetworkLine } from './line-network';

// Roads and tracks in 3D (docs/adr/0030): the road network draped on the
// ground as continuous ribbons (see line-network.ts). The imported data keeps
// only a class and a width per road (no surface, lanes, bridges or layers),
// so that is all the styling can go on. Every layer is one mesh with one
// material, so all the roads cost a handful of draw calls.

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
  /** Height above the ground in metres; higher layers cover lower ones where they meet. */
  readonly offset: number;
  readonly roughness: number;
}

/** Muted colours: asphalt for roads, earth and gravel for the rest. */
export const ROAD_STYLE: Readonly<Record<RoadLayer, RoadLayerStyle>> = {
  verge: { color: 0x9a947f, offset: 0.04, roughness: 1 },
  path: { color: 0xa69a7c, offset: 0.05, roughness: 1 },
  track: { color: 0x8f7d5e, offset: 0.06, roughness: 1 },
  unpaved: { color: 0x9c9077, offset: 0.07, roughness: 1 },
  paved: { color: 0x74736e, offset: 0.08, roughness: 0.9 },
  major: { color: 0x63625e, offset: 0.09, roughness: 0.85 },
};

/** Width of the verge on each side of a paved road, in metres. */
export const VERGE_M = 0.6;

/** The draped road layers, one mesh each (layers with no roads are left out). */
export function roadGeometry(roads: readonly Road[], draper: Draper): Map<RoadLayer, MeshData> {
  const lines: NetworkLine<RoadLayer>[] = roads.map((r) => ({
    id: r.id,
    style: r.roadClass,
    centerline: r.centerline,
    halfWidth: r.widthMeters / 2,
  }));
  // The verge is a network of its own, so that its junctions are found among
  // paved roads only.
  const verges: NetworkLine<RoadLayer>[] = roads
    .filter((r) => r.roadClass === 'paved' || r.roadClass === 'major')
    .map((r) => ({
      id: r.id,
      style: 'verge',
      centerline: r.centerline,
      halfWidth: r.widthMeters / 2 + VERGE_M,
    }));
  const offset = (layer: RoadLayer) => ROAD_STYLE[layer].offset;
  const built = new Map([
    ...drapeNetwork(verges, draper, offset),
    ...drapeNetwork(lines, draper, offset),
  ]);
  const out = new Map<RoadLayer, MeshData>();
  for (const layer of ROAD_LAYERS) {
    const b = built.get(layer);
    if (b && b.positions.length > 0) out.set(layer, finishMesh(b));
  }
  return out;
}
