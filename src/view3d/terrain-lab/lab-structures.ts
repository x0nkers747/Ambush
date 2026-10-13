import { bridgeIndex, planBridges, type Bridge, type BridgeIndex, type TerrainDataset } from '#sim';
import { createGeoFeatures, type GeoFeatureLayer } from '../geo-features';
import { createGenerator, type Generator } from '../generation';
import { plantModels } from '../plant-models';
import type { QualityPreset } from '../quality';
import { createVegetationLayer, type VegetationLayer } from '../vegetation-layer';

// The structures on the lab's ground (research §5.6): the game's own
// buildings, bridges, road markings, roadside details and trees, generated
// on a TerrainDataset whose ground is the lab surface (structureTerrain).
// Its draped roads, paths and water are hidden: the lab's ground material
// and water draw those.

const HIDDEN = /^(roads: |paths: |water$|shore: )/;

export interface LabStructures {
  readonly ready: Promise<{ features: GeoFeatureLayer; vegetation: VegetationLayer }>;
  /** Bridge decks, for walking over them. */
  readonly bridges: BridgeIndex;
  readonly plan: readonly Bridge[];
  dispose(): void;
}

export function createLabStructures(
  terrain: TerrainDataset,
  quality: QualityPreset,
): LabStructures {
  const generator: Generator = createGenerator();
  const plan = planBridges(terrain).bridges;
  const bridges = bridgeIndex(plan);
  let features: GeoFeatureLayer | null = null;
  let vegetation: VegetationLayer | null = null;
  let disposed = false;
  const job = generator.start(terrain, () => undefined);
  const ready = job.result.then((result) => {
    if (disposed) throw new Error('disposed');
    features = createGeoFeatures(result.features);
    for (const child of features.group.children) if (HIDDEN.test(child.name)) child.visible = false;
    vegetation = createVegetationLayer(
      plantModels(),
      result.vegetation.instances,
      quality.vegetation,
      {
        cast: quality.shadows !== null,
        receive: false,
      },
    );
    return { features, vegetation };
  });
  return {
    ready,
    bridges,
    plan,
    dispose() {
      disposed = true;
      job.cancel();
      generator.dispose();
      features?.dispose();
      vegetation?.dispose();
    },
  };
}
