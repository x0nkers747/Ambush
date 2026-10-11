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
import { buildingGeometry, type BuildingEntrance, type BuildingStats } from './building-geometry';
import { createBuildingMaterials } from './building-materials';
import { regionOf } from './building-style';
import { PATH_COLOR, pathGeometry } from './decor-geometry';
import type { PathStyle } from './decor-paths';
import { DECOR_VERSION, planDecor, type DecorStats } from './decor-plan';
import { createDraper, type MeshData } from './drape';
import { MARKING_VERSION, roadMarkings, type MarkingStats } from './road-markings';
import { ROAD_LAYERS, ROAD_STYLE, roadGeometry, type RoadLayer } from './road-geometry';
import type { SurfaceMeshData } from './surface-mesh';
import type { PlacedInstance } from './vegetation-placement';
import { waterGeometry } from './water-geometry';

// The battlefield's geographic features (docs/adr/0030): roads, water and
// buildings. `buildFeatureGeometry` runs the pure generators (in the
// generation worker, docs/adr/0031); `createGeoFeatures` turns the result into
// scene meshes. Built once per terrain and kept until the terrain changes;
// nothing is rebuilt per frame. Each kind of surface is one mesh with one
// material, so the whole battlefield adds about eight draw calls however many
// features it has (buildings: two, docs/adr/0035).

/** Bump when the generated geometry changes, e.g. to key a geometry cache. */
export const GEOMETRY_VERSION = 3;
/** The roadside details' own version (docs/adr/0036). */
export { DECOR_VERSION };
/** The road markings' own version (docs/adr/0037). */
export { MARKING_VERSION };

export interface GeoFeatureStats {
  readonly roadTriangles: number;
  readonly waterTriangles: number;
  /** Walls, roofs and trim; and windows and doors. */
  readonly buildingTriangles: number;
  readonly openingTriangles: number;
  readonly buildings: number;
  /** Roof shapes, footprint shapes, windows and doors drawn, and the region's style. */
  readonly buildingDetail: BuildingStats;
  /** Buildings whose uphill corners stand higher than their roof (steep ground). */
  readonly buriedBuildings: number;
  /** Roadside and settlement details (docs/adr/0036). */
  readonly decor: DecorStats & { readonly pathTriangles: number };
  /** Painted road markings (docs/adr/0037). */
  readonly markings: MarkingStats;
  /** Generation times in milliseconds. */
  readonly ms: {
    readonly roads: number;
    readonly water: number;
    readonly buildings: number;
    readonly decor: number;
  };
}

/** The generated feature geometry: plain typed arrays, transferable between threads. */
export interface FeatureGeometry {
  readonly roads: readonly (readonly [RoadLayer, MeshData])[];
  readonly water: MeshData;
  readonly buildings: SurfaceMeshData;
  readonly openings: SurfaceMeshData;
  /** Building entrances (doors and garage doors): display metadata. */
  readonly entrances: readonly BuildingEntrance[];
  /** Inferred paths and driveways, by style (docs/adr/0036). */
  readonly paths: readonly (readonly [PathStyle, MeshData])[];
  /** Road markings: one vertex-coloured mesh (docs/adr/0037). */
  readonly markings: MeshData;
  readonly stats: GeoFeatureStats;
}

/** Feature geometry, with the roadside details that the vegetation layer draws. */
export interface BuiltFeatures {
  readonly geometry: FeatureGeometry;
  readonly decorInstances: readonly PlacedInstance[];
}

export interface GeoFeatureLayer {
  readonly group: Group;
  readonly stats: GeoFeatureStats;
  /** Resolves when the building textures are in use (false if they could not load). */
  readonly ready: Promise<boolean>;
  dispose(): void;
}

/** Runs the feature generators. Pure: no scene, no DOM. */
export function buildFeatureGeometry(terrain: TerrainDataset): FeatureGeometry {
  return buildFeatures(terrain).geometry;
}

/** Runs the feature generators, keeping the roadside instances apart for the vegetation. */
export function buildFeatures(terrain: TerrainDataset): BuiltFeatures {
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
  t = clock();
  const decor = planDecor(terrain, buildings.designs, buildings.entrances);
  const paths = pathGeometry(decor.paths, draper);
  const decorMs = clock() - t;
  const markings = roadMarkings(terrain, draper, regionOf(terrain));
  const geometry: FeatureGeometry = {
    roads: roadList,
    water: water.mesh,
    buildings: buildings.surfaces,
    openings: buildings.openings,
    entrances: buildings.entrances,
    paths,
    markings: markings.mesh,
    stats: {
      roadTriangles: roadList.reduce((s, [, d]) => s + d.triangleCount, 0),
      waterTriangles: water.mesh.triangleCount,
      buildingTriangles: buildings.surfaces.triangleCount,
      openingTriangles: buildings.openings.triangleCount,
      buildings: buildings.count,
      buildingDetail: buildings.stats,
      buriedBuildings: buildings.buried,
      decor: {
        ...decor.stats,
        pathTriangles: paths.reduce((sum, [, d]) => sum + d.triangleCount, 0),
      },
      markings: markings.stats,
      ms: { roads: roadMs, water: waterMs, buildings: buildingMs, decor: decorMs },
    },
  };
  return { geometry, decorInstances: decor.instances };
}

/** The typed arrays of a feature geometry, for transferring them to another thread. */
export function featureBuffers(f: FeatureGeometry): ArrayBuffer[] {
  return [
    ...f.roads.map(([, d]) => d),
    ...f.paths.map(([, d]) => d),
    f.water,
    f.buildings,
    f.openings,
  ].flatMap((d) =>
    [
      d.positions,
      d.normals,
      d.colors,
      'uvs' in d ? (d as SurfaceMeshData).uvs : null,
      'layers' in d ? (d as SurfaceMeshData).layers : null,
    ].flatMap((a) => (a ? [a.buffer as ArrayBuffer] : [])),
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

  // Inferred paths and driveways (docs/adr/0036), under every road layer.
  features.paths.forEach(([style, data], rank) => {
    const mesh = add(
      `paths: ${style}`,
      data,
      new MeshStandardMaterial({
        color: PATH_COLOR[style],
        roughness: 1,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1 - 0.1 * rank,
      }),
    );
    if (mesh) mesh.receiveShadow = true;
  });

  // Painted road markings (docs/adr/0037), just above their roads: one draw call.
  const markingMesh = add(
    'road markings',
    features.markings,
    new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -16,
    }),
  );
  if (markingMesh) markingMesh.receiveShadow = true;

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

  // Buildings: walls, roofs and trim from a texture array; windows and doors
  // from an atlas, shown once it has loaded.
  const materials = createBuildingMaterials();
  const buildings = add('buildings', features.buildings, materials.surfaces);
  if (buildings) {
    buildings.geometry.setAttribute('surfaceUv', new BufferAttribute(features.buildings.uvs, 2));
    buildings.geometry.setAttribute(
      'surfaceLayer',
      new BufferAttribute(features.buildings.layers, 1),
    );
    buildings.castShadow = true;
    buildings.receiveShadow = true;
  }
  const openings = add('building openings', features.openings, materials.openings);
  if (openings) {
    openings.geometry.setAttribute('uv', new BufferAttribute(features.openings.uvs, 2));
    openings.receiveShadow = true;
    openings.visible = false;
  }
  let disposed = false;
  void materials.ready.then((loaded) => {
    if (loaded && !disposed && openings) openings.visible = true;
  });

  return {
    group,
    stats: features.stats,
    ready: materials.ready,
    dispose() {
      disposed = true;
      for (const m of meshes) {
        m.geometry.dispose();
        m.material.dispose();
      }
      materials.dispose();
      group.clear();
    },
  };
}
