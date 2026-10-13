import { BufferAttribute, BufferGeometry, Group, Mesh } from 'three';
import type { TerrainDataset } from '#sim';
import { boundingSphereOf, createGeoFeatures, type GeoFeatureLayer } from '../geo-features';
import { createGenerator, type Generator } from '../generation';
import { createGroundMaterial } from '../ground-material';
import { landCoverTints } from '../landcover';
import { plantModels } from '../plant-models';
import type { QualityPreset } from '../quality';
import { terrainMesh } from '../terrain-mesh';
import { createVegetationLayer, type VegetationLayer } from '../vegetation-layer';

// The game's 3D view of a battlefield, built from the same parts as view.ts
// (terrain mesh, ground material and map, features, vegetation) for
// side-by-side comparison with the same camera. Nothing here is changed.

export interface CurrentScene {
  readonly group: Group;
  /** Resolves when features and vegetation are in. */
  readonly ready: Promise<void>;
  readonly vegetation: () => VegetationLayer | null;
  readonly features: () => GeoFeatureLayer | null;
  readonly stats: { buildMs: number; triangles: number };
  dispose(): void;
}

export function createCurrentScene(graded: TerrainDataset, quality: QualityPreset): CurrentScene {
  const started = performance.now();
  const group = new Group();
  group.name = 'current renderer';
  const data = terrainMesh(graded, landCoverTints(graded));
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  if (data.colors) geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.boundingSphere = boundingSphereOf(data.positions);
  const ground = createGroundMaterial({ path: 'full' });
  const mesh = new Mesh(geometry, ground.material);
  mesh.name = 'terrain (current)';
  mesh.receiveShadow = true;
  group.add(mesh);
  const stats = { buildMs: performance.now() - started, triangles: data.indices.length / 3 };
  const generator: Generator = createGenerator();
  let features: GeoFeatureLayer | null = null;
  let vegetation: VegetationLayer | null = null;
  let disposed = false;
  const groundJob = generator.ground(graded);
  void groundJob.result.then((baked) => {
    if (!disposed) ground.setMap(baked.map);
  });
  const job = generator.start(graded, () => undefined);
  const ready = job.result.then((result) => {
    if (disposed) return;
    features = createGeoFeatures(result.features);
    vegetation = createVegetationLayer(
      plantModels(),
      result.vegetation.instances,
      quality.vegetation,
      {
        cast: quality.shadows !== null,
        receive: false,
      },
    );
    group.add(features.group, vegetation.group);
    ground.setShore(features.shore);
  });
  return {
    group,
    ready,
    vegetation: () => vegetation,
    features: () => features,
    stats,
    dispose() {
      disposed = true;
      groundJob.cancel();
      job.cancel();
      generator.dispose();
      geometry.dispose();
      ground.dispose();
      features?.dispose();
      vegetation?.dispose();
      group.clear();
    },
  };
}
