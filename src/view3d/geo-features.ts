import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  NotEqualStencilFunc,
  ReplaceStencilOp,
} from 'three';
import type { TerrainDataset } from '#sim';
import { buildingGeometry } from './building-geometry';
import { createDraper, type MeshData } from './drape';
import { ROAD_LAYERS, ROAD_STYLE, roadGeometry, type RoadLayer } from './road-geometry';
import { waterGeometry } from './water-geometry';

// The battlefield's geographic features (docs/adr/0030): roads, water and
// buildings. `buildFeatureGeometry` runs the pure generators (in the
// generation worker, docs/adr/0031); `createGeoFeatures` turns the result into
// scene meshes. Built once per terrain and kept until the terrain changes;
// nothing is rebuilt per frame. Each kind of surface is one mesh with one
// material, so the whole battlefield adds about eight draw calls however many
// features it has.

/** Bump when the generated geometry changes, e.g. to key a geometry cache. */
export const GEOMETRY_VERSION = 1;

export interface GeoFeatureStats {
  readonly roadTriangles: number;
  readonly waterTriangles: number;
  readonly buildingTriangles: number;
  readonly buildings: number;
  /** Buildings whose uphill corners stand higher than their roof (steep ground). */
  readonly buriedBuildings: number;
  /** Generation times in milliseconds. */
  readonly ms: { readonly roads: number; readonly water: number; readonly buildings: number };
}

/** The generated feature geometry: plain typed arrays, transferable between threads. */
export interface FeatureGeometry {
  readonly roads: readonly (readonly [RoadLayer, MeshData])[];
  readonly water: MeshData;
  readonly buildings: MeshData;
  readonly stats: GeoFeatureStats;
}

export interface GeoFeatureLayer {
  readonly group: Group;
  readonly stats: GeoFeatureStats;
  dispose(): void;
}

/** Runs the feature generators. Pure: no scene, no DOM. */
export function buildFeatureGeometry(terrain: TerrainDataset): FeatureGeometry {
  const draper = createDraper(terrain);
  const clock = () => performance.now();
  let t = clock();
  const roads = roadGeometry(terrain.features.roads, draper);
  const roadMs = clock() - t;
  t = clock();
  const water = waterGeometry(terrain, draper);
  const waterMs = clock() - t;
  t = clock();
  const buildings = buildingGeometry(terrain);
  const buildingMs = clock() - t;
  const roadList = ROAD_LAYERS.flatMap((layer) => {
    const data = roads.get(layer);
    return data ? [[layer, data] as const] : [];
  });
  return {
    roads: roadList,
    water: water.mesh,
    buildings: buildings.mesh,
    stats: {
      roadTriangles: roadList.reduce((s, [, d]) => s + d.triangleCount, 0),
      waterTriangles: water.mesh.triangleCount,
      buildingTriangles: buildings.mesh.triangleCount,
      buildings: buildings.count,
      buriedBuildings: buildings.buried,
      ms: { roads: roadMs, water: waterMs, buildings: buildingMs },
    },
  };
}

/** The typed arrays of a feature geometry, for transferring them to another thread. */
export function featureBuffers(f: FeatureGeometry): ArrayBuffer[] {
  return [...f.roads.map(([, d]) => d), f.water, f.buildings].flatMap((d) =>
    [d.positions, d.normals, d.colors].flatMap((a) => (a ? [a.buffer as ArrayBuffer] : [])),
  );
}

function geometryOf(data: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new BufferAttribute(data.normals, 3));
  if (data.colors) g.setAttribute('color', new BufferAttribute(data.colors, 3));
  g.computeBoundingSphere();
  return g;
}

/** Scene meshes for generated feature geometry. */
export function createGeoFeatures(features: FeatureGeometry): GeoFeatureLayer {
  const group = new Group();
  group.name = 'geographic features';
  const meshes: Mesh<BufferGeometry, MeshStandardMaterial>[] = [];
  const add = (name: string, data: MeshData, material: MeshStandardMaterial) => {
    if (data.triangleCount === 0) {
      material.dispose();
      return null;
    }
    const mesh = new Mesh(geometryOf(data), material);
    mesh.name = name;
    meshes.push(mesh);
    group.add(mesh);
    return mesh;
  };

  for (const [layer, data] of features.roads) {
    const style = ROAD_STYLE[layer];
    const rank = ROAD_LAYERS.indexOf(layer);
    // Draped surfaces lie on the ground; the polygon offset, larger for higher
    // layers, keeps them in front of it (and of lower layers) at any distance.
    const mesh = add(
      `roads: ${layer}`,
      data,
      new MeshStandardMaterial({
        color: style.color,
        roughness: style.roughness,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2 - 2 * rank,
      }),
    );
    if (mesh) mesh.receiveShadow = true;
  }

  // Slightly transparent. The stencil lets each pixel take water once, so
  // where a river's line overlaps its area, or its own bends, it is no darker.
  add(
    'water',
    features.water,
    new MeshStandardMaterial({
      color: 0x3f6272,
      roughness: 0.45,
      metalness: 0,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: NotEqualStencilFunc,
      stencilZPass: ReplaceStencilOp,
    }),
  );

  const buildings = add(
    'buildings',
    features.buildings,
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
  );
  if (buildings) {
    buildings.castShadow = true;
    buildings.receiveShadow = true;
  }

  return {
    group,
    stats: features.stats,
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        m.material.dispose();
      }
      group.clear();
    },
  };
}
