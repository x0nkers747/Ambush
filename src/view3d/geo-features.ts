import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
} from 'three';
import { heightAt, type TerrainDataset } from '#sim';
import {
  carveShoreField,
  groundCut,
  SHORE_CUT_M,
  shoreField,
  shoreline,
  waterLevelNear,
  type ShoreMask,
  type ShorelineStats,
  type WallMesh,
} from './shoreline';
import { createShoreMaterials, createShoreTexture, type ShoreTexture } from './shore-material';
import { buildingGeometry, type BuildingEntrance, type BuildingStats } from './building-geometry';
import { createBuildingMaterials } from './building-materials';
import { regionOf } from './building-style';
import { PATH_COLOR, pathGeometry } from './decor-geometry';
import type { PathStyle } from './decor-paths';
import { DECOR_VERSION, planDecor, type DecorStats } from './decor-plan';
import {
  coordinateBridges,
  cutUnderDecks,
  groundRoadHoles,
  waterIndex,
  roadEntrances,
} from './bridge-complexes';
import { BRIDGE_VERSION, bridgeGeometry, liftOntoBridges, planBridges } from './bridges';
import { createDraper, type MeshData } from './drape';
import { MARKING_VERSION, roadMarkings, type MarkingStats } from './road-markings';
import { ROAD_LAYERS, ROAD_STYLE, roadSurfaces, type RoadLayer } from './road-geometry';
import type { SurfaceStats } from './road-surface';
import type { SurfaceMeshData } from './surface-mesh';
import type { PlacedInstance } from './vegetation-placement';
import { waterGeometry } from './water-geometry';
import { createWaterMaterial } from './water-material';

// The battlefield's geographic features (docs/adr/0030): roads, water and
// buildings. `buildFeatureGeometry` runs the pure generators (in the
// generation worker, docs/adr/0031); `createGeoFeatures` turns the result into
// scene meshes. Built once per terrain and kept until the terrain changes;
// nothing is rebuilt per frame. Each kind of surface is one mesh with one
// material, so the whole battlefield adds about eight draw calls however many
// features it has (buildings: two, docs/adr/0035).

/** Bump when the generated geometry changes, e.g. to key a geometry cache. */
export const GEOMETRY_VERSION = 7;
/** The roadside details' own version (docs/adr/0036). */
export { DECOR_VERSION };
/** The road markings' own version (docs/adr/0037). */
export { MARKING_VERSION };
/** The bridges' own version (docs/adr/0041). */
export { BRIDGE_VERSION };

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
  /** Decorative bridges (docs/adr/0041). */
  readonly bridges: {
    readonly count: number;
    /** Structures drawn (decks mapped side by side are one, docs/adr/0044), and those of several decks. */
    readonly structures: number;
    readonly shared: number;
    /** Decks too low above the water for a real bridge: the water is cut away beneath them. */
    readonly lowDecks: number;
    readonly mapped: number;
    readonly inferred: number;
    readonly piers: number;
    readonly lowClearance: number;
    readonly skipped: number;
    readonly triangles: number;
  };
  /** The road surface: pieces before and after cutting, junctions and corner fillets (docs/adr/0044). */
  readonly junctions: SurfaceStats & {
    readonly vergePieces: number;
    readonly vergeCutMs: number;
    readonly vergeDrapeMs: number;
  };
  /** The shoreline (docs/adr/0046): mask, cut and walls; null without levelled water. */
  readonly shoreline: (ShorelineStats & { readonly wallTriangles: number }) | null;
  /** Generation times in milliseconds. */
  readonly ms: {
    readonly roads: number;
    readonly water: number;
    readonly buildings: number;
    readonly decor: number;
    readonly bridges: number;
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
  /** Bridge decks, barriers and supports: one vertex-coloured mesh (docs/adr/0041). */
  readonly bridges: MeshData;
  /** The shore mask and walls (docs/adr/0046), or null without levelled water. */
  readonly shore: {
    readonly mask: ShoreMask;
    readonly quay: WallMesh;
    readonly bank: WallMesh;
  } | null;
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
  /** The shore mask for the terrain's material (docs/adr/0046), or null. Disposed with the layer. */
  readonly shore: ShoreTexture | null;
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
  const surfaces = roadSurfaces(terrain.features.roads, draper);
  const roads = surfaces.layers;
  const roadMs = clock() - t;
  t = clock();
  const water = waterGeometry(terrain, draper);
  // Where levelled water is, on a fine grid (docs/adr/0046): buildings and
  // piers standing in it reach down into it.
  const field = shoreField(terrain);
  const waterMs = clock() - t;
  t = clock();
  const buildings = buildingGeometry(
    terrain,
    field ? { waterLevelNear: (x, y) => waterLevelNear(field, x, y) } : {},
  );
  const buildingMs = clock() - t;
  const roadList = ROAD_LAYERS.flatMap((layer) => {
    const data = roads.get(layer);
    return data ? [[layer, data] as const] : [];
  });
  t = clock();
  const decor = planDecor(terrain, buildings.designs, buildings.entrances);
  const paths = pathGeometry(decor.paths, draper, surfaces.occupancy);
  const decorMs = clock() - t;
  const markings = roadMarkings(terrain, draper, regionOf(terrain));
  // Bridges (display only): their structure, and the road's own surface,
  // verges, markings and paths lifted onto their decks.
  t = clock();
  const plan = planBridges(terrain);
  // Decks mapped side by side are one structure (docs/adr/0044).
  const coordinated = coordinateBridges(plan.bridges);
  const index = coordinated.index;
  const ground = (x: number, y: number) => heightAt(terrain, x, y);
  // Supports go down to the ground, or into the water where the 3D view cuts
  // the ground away above it (docs/adr/0046).
  const supportGround = (x: number, y: number) => {
    const z = ground(x, y);
    const level = field ? waterLevelNear(field, x, y, 0) : null;
    return level !== null && z > level + SHORE_CUT_M ? level : z;
  };
  const bridges = bridgeGeometry(coordinated.decks, supportGround, {
    coordinated,
    roadEntrance: roadEntrances(terrain.features.roads, coordinated),
  });
  const onBridges = (d: MeshData) => liftOntoBridges(d, index, ground);
  // No water drawn over a deck that stands too low above it, or over a road
  // on a bank below the water level (docs/adr/0044).
  const wet = waterIndex(water.mesh);
  const roadHoles = groundRoadHoles(
    surfaces.occupancy,
    terrain.features.roads,
    wet,
    coordinated.decks,
    terrain,
  );
  const cut = cutUnderDecks(water.mesh, coordinated.decks, roadHoles, wet);
  const liftedRoads = roadList.map(([layer, d]) => [layer, onBridges(d)] as const);
  const liftedPaths = paths.map(([style, d]) => [style, onBridges(d)] as const);
  const liftedMarkings = onBridges(markings.mesh);
  const bridgeMs = clock() - t;
  // The shoreline: where the water sheet is cut away, the ground is never cut either.
  if (field) carveShoreField(field, [...roadHoles, ...cut.holes]);
  const shore = shoreline(terrain, field);
  const geometry: FeatureGeometry = {
    roads: liftedRoads,
    water: cut.mesh,
    buildings: buildings.surfaces,
    openings: buildings.openings,
    entrances: buildings.entrances,
    paths: liftedPaths,
    markings: liftedMarkings,
    bridges: bridges.mesh,
    shore: shore && { mask: shore.mask, quay: shore.quay, bank: shore.bank },
    stats: {
      roadTriangles: liftedRoads.reduce((s, [, d]) => s + d.triangleCount, 0),
      waterTriangles: cut.mesh.triangleCount,
      buildingTriangles: buildings.surfaces.triangleCount,
      openingTriangles: buildings.openings.triangleCount,
      buildings: buildings.count,
      buildingDetail: buildings.stats,
      buriedBuildings: buildings.buried,
      decor: {
        ...decor.stats,
        pathTriangles: liftedPaths.reduce((sum, [, d]) => sum + d.triangleCount, 0),
      },
      markings: markings.stats,
      bridges: {
        count: bridges.bridges,
        structures: coordinated.complexes.length,
        shared: coordinated.complexes.filter((c) => c.members.length > 1).length,
        lowDecks: cut.lowDecks,
        mapped: bridges.mapped,
        inferred: bridges.inferred,
        piers: bridges.piers,
        lowClearance: bridges.lowClearance,
        skipped: plan.skipped.length,
        triangles: bridges.mesh.triangleCount,
      },
      junctions: surfaces.stats,
      shoreline: shore && {
        ...shore.stats,
        wallTriangles: shore.quay.triangleCount + shore.bank.triangleCount,
      },
      ms: {
        roads: roadMs,
        water: waterMs,
        buildings: buildingMs,
        decor: decorMs,
        bridges: bridgeMs,
      },
    },
  };
  // No roadside props on ground the 3D view cuts away in the water (docs/adr/0046).
  const decorInstances = field
    ? decor.instances.filter((i) => !groundCut(terrain, field, i.x, i.y))
    : decor.instances;
  return { geometry, decorInstances };
}

/** The typed arrays of a feature geometry, for transferring them to another thread. */
export function featureBuffers(f: FeatureGeometry): ArrayBuffer[] {
  return [
    ...f.roads.map(([, d]) => d),
    ...f.paths.map(([, d]) => d),
    f.water,
    f.bridges,
    f.buildings,
    f.openings,
    ...(f.shore ? [f.shore.quay, f.shore.bank] : []),
  ]
    .flatMap((d) =>
      [
        d.positions,
        d.normals,
        d.colors,
        'uvs' in d ? (d as SurfaceMeshData).uvs : null,
        'layers' in d ? (d as SurfaceMeshData).layers : null,
      ].flatMap((a) => (a ? [a.buffer as ArrayBuffer] : [])),
    )
    .concat(f.shore ? [f.shore.mask.pixels.buffer as ArrayBuffer] : []);
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

  // Bridges (docs/adr/0041): concrete and steel, one draw call. Decoration
  // only: picking and the simulation go by the ground, never these meshes.
  const bridgeMesh = add(
    'bridges',
    features.bridges,
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
  );
  if (bridgeMesh) {
    bridgeMesh.castShadow = true;
    bridgeMesh.receiveShadow = true;
  }

  // Water (docs/adr/0040, 0046): its own material, colours from the mesh,
  // shallows from the shore mask; the shore's quays and banks.
  const shore = features.shore ? createShoreTexture(features.shore.mask) : null;
  add('water', features.water, createWaterMaterial(shore));
  const shoreMaterials = features.shore ? createShoreMaterials() : null;
  if (features.shore && shoreMaterials) {
    for (const [name, data, material] of [
      ['shore: quays', features.shore.quay, shoreMaterials.quay],
      ['shore: banks', features.shore.bank, shoreMaterials.bank],
    ] as const) {
      const mesh = add(name, data, material);
      if (mesh) {
        mesh.geometry.setAttribute('uv', new BufferAttribute(data.uvs, 2));
        mesh.receiveShadow = true;
      }
    }
  }

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
    shore,
    dispose() {
      disposed = true;
      shore?.dispose();
      shoreMaterials?.dispose();
      for (const m of meshes) {
        m.geometry.dispose();
        m.material.dispose();
      }
      materials.dispose();
      group.clear();
    },
  };
}
