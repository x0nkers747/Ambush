import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
} from 'three';
import { heightAt, terrainDeckTop, type TerrainDataset } from '#sim';
import { buildingGeometry, type BuildingEntrance, type BuildingStats } from './building-geometry';
import { createBuildingMaterials } from './building-materials';
import { regionOf } from './building-style';
import { DECOR_VERSION, planDecor, type DecorStats } from './decor-plan';
import { createDraper, type MeshData } from './drape';
import { MARKING_VERSION, roadMarkings, type MarkingStats } from './road-markings';
import type { SurfaceMeshData } from './surface-mesh';
import type { PlacedInstance } from './vegetation-placement';

// The battlefield's buildings and road markings (docs/adr/0030, 0035, 0037).
// The ground itself, its roads, water and bridges are drawn by the terrain
// renderer from the terrain field (docs/adr/0049). `buildFeatureGeometry`
// runs the pure generators (in the generation worker, docs/adr/0031);
// `createGeoFeatures` turns the result into scene meshes. Built once per
// terrain and kept until the terrain changes; nothing is rebuilt per frame.
// Each kind of surface is one mesh with one material: three draw calls however
// many features there are.

/** Bump when the generated geometry changes, e.g. to key a geometry cache. */
export const GEOMETRY_VERSION = 8;
/** The roadside details' own version (docs/adr/0036). */
export { DECOR_VERSION };
/** The road markings' own version (docs/adr/0037). */
export { MARKING_VERSION };

export interface GeoFeatureStats {
  /** Walls, roofs and trim; and windows and doors. */
  readonly buildingTriangles: number;
  readonly openingTriangles: number;
  readonly buildings: number;
  /** Roof shapes, footprint shapes, windows and doors drawn, and the region's style. */
  readonly buildingDetail: BuildingStats;
  /** Buildings whose uphill corners stand higher than their roof (steep ground). */
  readonly buriedBuildings: number;
  /** Roadside and settlement details (docs/adr/0036). */
  readonly decor: DecorStats;
  /** Painted road markings (docs/adr/0037). */
  readonly markings: MarkingStats;
  /** Generation times in milliseconds. */
  readonly ms: {
    readonly buildings: number;
    readonly decor: number;
    readonly markings: number;
  };
}

/** The generated feature geometry: plain typed arrays, transferable between threads. */
export interface FeatureGeometry {
  readonly buildings: SurfaceMeshData;
  readonly openings: SurfaceMeshData;
  /** Building entrances (doors and garage doors): display metadata. */
  readonly entrances: readonly BuildingEntrance[];
  /** Road markings: one vertex-coloured mesh (docs/adr/0037), on bridge decks where they cross them. */
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
  const buildings = buildingGeometry(terrain, {});
  const buildingMs = clock() - t;
  t = clock();
  const decor = planDecor(terrain, buildings.designs, buildings.entrances);
  const decorMs = clock() - t;
  t = clock();
  const markings = roadMarkings(terrain, draper, regionOf(terrain));
  const onDecks = liftOntoDecks(markings.mesh, terrain);
  const markingMs = clock() - t;
  const geometry: FeatureGeometry = {
    buildings: buildings.surfaces,
    openings: buildings.openings,
    entrances: buildings.entrances,
    markings: onDecks,
    stats: {
      buildingTriangles: buildings.surfaces.triangleCount,
      openingTriangles: buildings.openings.triangleCount,
      buildings: buildings.count,
      buildingDetail: buildings.stats,
      buriedBuildings: buildings.buried,
      decor: decor.stats,
      markings: markings.stats,
      ms: { buildings: buildingMs, decor: decorMs, markings: markingMs },
    },
  };
  return { geometry, decorInstances: decor.instances };
}

/** Markings sit this far above a bridge deck they cross, metres. */
const DECK_LIFT_M = 0.02;

/** A mesh draped on the ground, with its vertices over a bridge deck put on the deck (docs/adr/0049). */
function liftOntoDecks(mesh: MeshData, terrain: TerrainDataset): MeshData {
  if (!terrain.grading?.decks?.length || mesh.triangleCount === 0) return mesh;
  const deckTop = terrainDeckTop(terrain);
  const p = mesh.positions.slice();
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] ?? 0;
    const y = -(p[i + 2] ?? 0);
    const top = deckTop(x, y);
    // Over the deck, not where it meets its road at the same height.
    if (top !== null && top > heightAt(terrain, x, y) + 0.05) p[i + 1] = top + DECK_LIFT_M;
  }
  return { ...mesh, positions: p };
}

/** The typed arrays of a feature geometry, for transferring them to another thread. */
export function featureBuffers(f: FeatureGeometry): ArrayBuffer[] {
  return [f.markings, f.buildings, f.openings].flatMap((d) =>
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
  g.boundingSphere = boundingSphereOf(data.positions);
  return g;
}

/**
 * The bounding sphere Three.js's `computeBoundingSphere` gives (centred on the
 * bounding box, out to the farthest vertex), in one pass over the typed array:
 * on a large city that call made hundreds of megabytes of short-lived garbage
 * on the main thread (docs/adr/0045).
 */
export function boundingSphereOf(positions: Float32Array): Sphere {
  const n = positions.length;
  if (n < 3) return new Sphere();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let r2 = 0;
  for (let i = 0; i < n; i += 3) {
    const dx = (positions[i] ?? 0) - cx;
    const dy = (positions[i + 1] ?? 0) - cy;
    const dz = (positions[i + 2] ?? 0) - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return new Sphere(new Vector3(cx, cy, cz), Math.sqrt(r2));
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
