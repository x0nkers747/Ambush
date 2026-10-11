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
import { ROAD_LAYERS, ROAD_STYLE, roadGeometry } from './road-geometry';
import { waterGeometry } from './water-geometry';

// The battlefield's geographic features in the scene (docs/adr/0030): roads,
// water and buildings, from the pure generators. Built once per terrain and
// kept until the terrain changes; nothing is rebuilt per frame. Each kind of
// surface is one mesh with one material, so the whole battlefield adds about
// eight draw calls however many features it has.

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

export interface GeoFeatureLayer {
  readonly group: Group;
  readonly stats: GeoFeatureStats;
  dispose(): void;
}

function geometryOf(data: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new BufferAttribute(data.normals, 3));
  if (data.colors) g.setAttribute('color', new BufferAttribute(data.colors, 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * The feature meshes for a terrain. `normals` are the terrain mesh's own
 * (`terrainMesh(...).normals`), so draped surfaces are lit like the ground.
 */
export function createGeoFeatures(
  terrain: TerrainDataset,
  normals?: Float32Array,
): GeoFeatureLayer {
  const group = new Group();
  group.name = 'geographic features';
  const meshes: Mesh<BufferGeometry, MeshStandardMaterial>[] = [];
  const add = (name: string, data: MeshData, material: MeshStandardMaterial, order = 0) => {
    if (data.triangleCount === 0) {
      material.dispose();
      return;
    }
    const mesh = new Mesh(geometryOf(data), material);
    mesh.name = name;
    mesh.renderOrder = order;
    meshes.push(mesh);
    group.add(mesh);
  };
  const draper = createDraper(terrain, normals);
  const clock = () => performance.now();

  let t = clock();
  const roads = roadGeometry(terrain.features.roads, draper);
  const roadMs = clock() - t;
  let roadTriangles = 0;
  ROAD_LAYERS.forEach((layer, rank) => {
    const data = roads.get(layer);
    if (!data) return;
    roadTriangles += data.triangleCount;
    const style = ROAD_STYLE[layer];
    // Draped surfaces lie on the ground; the polygon offset, larger for higher
    // layers, keeps them in front of it (and of lower layers) at any distance.
    add(
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
  });

  t = clock();
  const water = waterGeometry(terrain, draper);
  const waterMs = clock() - t;
  // Slightly transparent. The stencil lets each pixel take water once, so
  // where a river's line overlaps its area, or its own bends, it is no darker.
  add(
    'water',
    water.mesh,
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

  t = clock();
  const buildings = buildingGeometry(terrain);
  const buildingMs = clock() - t;
  add(
    'buildings',
    buildings.mesh,
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
  );

  return {
    group,
    stats: {
      roadTriangles,
      waterTriangles: water.mesh.triangleCount,
      buildingTriangles: buildings.mesh.triangleCount,
      buildings: buildings.count,
      buriedBuildings: buildings.buried,
      ms: { roads: roadMs, water: waterMs, buildings: buildingMs },
    },
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        m.material.dispose();
      }
      group.clear();
    },
  };
}
