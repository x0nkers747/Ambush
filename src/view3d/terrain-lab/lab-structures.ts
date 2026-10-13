import { Mesh, type BufferGeometry } from 'three';
import { bridgeIndex, planBridges, type Bridge, type BridgeIndex, type TerrainDataset } from '#sim';
import { createGeoFeatures, type GeoFeatureLayer } from '../geo-features';
import { createGenerator, type Generator } from '../generation';

import type { QualityPreset } from '../quality';
import type { TerrainField, TerrainSurface } from '#sim/terrain-lab';
import type { VegetationLayer } from '../vegetation-layer';
import { createLabVegetation } from './lab-vegetation';

// The structures on the lab's ground (research §5.6): the game's own
// buildings, road markings, roadside details and trees, generated
// on a TerrainDataset whose ground is the lab surface (structureTerrain).
// Its draped roads, paths, water and bridges are hidden: the lab's ground
// material, water and bridges (lab-bridges.ts) draw those. Markings the
// game lifted onto its own bridge decks are put on the lab's.

const HIDDEN = /^(roads: |paths: |water$|shore: |bridges$)/;
/** Markings sit this far above the deck or ground they are put on, metres. */
const MARKING_LIFT_M = 0.02;

export interface LabStructures {
  readonly ready: Promise<{ features: GeoFeatureLayer; vegetation: VegetationLayer }>;
  /** The game's bridges (its plan, not drawn). */
  readonly bridges: BridgeIndex;
  readonly plan: readonly Bridge[];
  dispose(): void;
}

export function createLabStructures(
  terrain: TerrainDataset,
  quality: QualityPreset,
  lab: {
    /** The lab's terrain field (where the understorey grows). */
    readonly field: TerrainField;
    readonly surface: TerrainSurface;
    /** The top of the lab's deck at (x, y), or null. */
    readonly deckAt: (x: number, y: number) => number | null;
    /** The lab ground's height at (x, y). */
    readonly ground: (x: number, y: number) => number;
  },
): LabStructures {
  const generator: Generator = createGenerator();
  const plan = planBridges(terrain).bridges;
  const bridges = bridgeIndex(plan);
  let features: GeoFeatureLayer | null = null;
  let vegetation: VegetationLayer | null = null;
  let disposed = false;
  /** Markings the game lifted onto its decks: onto the lab's deck there, or back onto the ground. */
  const reseat = (geometry: BufferGeometry) => {
    const p = geometry.getAttribute('position');
    for (let i = 0; i < p.count; i += 1) {
      const x = p.getX(i);
      const y = -p.getZ(i);
      if (!bridges.at(x, y)) continue;
      p.setY(i, (lab.deckAt(x, y) ?? lab.ground(x, y)) + MARKING_LIFT_M);
    }
    p.needsUpdate = true;
    geometry.computeBoundingSphere();
  };
  const job = generator.start(terrain, () => undefined);
  const ready = job.result.then((result) => {
    if (disposed) throw new Error('disposed');
    features = createGeoFeatures(result.features);
    for (const child of features.group.children) {
      if (HIDDEN.test(child.name)) child.visible = false;
      if (child.name === 'road markings' && child instanceof Mesh)
        reseat(child.geometry as BufferGeometry);
    }
    vegetation = createLabVegetation({
      instances: result.vegetation.instances,
      field: lab.field,
      surface: lab.surface,
      settings: quality.vegetation,
      // Trees shade one another (dappled light under the canopy) whenever there are shadows.
      shadows: { cast: quality.shadows !== null, receive: quality.shadows !== null },
    });
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
