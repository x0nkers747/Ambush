// The Force-on-Force Lab's headless side (docs/behavior-lab/force-on-force):
// runs, experiments and metrics. Its own entry point
// (#exercise/force-on-force), not re-exported from #exercise, so the game
// never loads it.
export {
  createFofRun,
  defaultVisibility,
  FOF_DEFAULT_CONFIG,
  FOF_TERRAINS,
  fofSecondHashes,
  fofTerrainFor,
  formationsForLab,
  LAB_ORGANIZATION_NAMES,
  type FofCommandOrigin,
  type FofForceSpec,
  type FofReplay,
  type FofRun,
  type FofRunForce,
  type FofRunSpec,
  type FofTerrainKind,
} from './run';
export { woodsFeatures, type WoodsOptions } from './woods';
export {
  createFofMetrics,
  sampleState,
  type FofMetrics,
  type FofMetricsRecorder,
  type FofSample,
  type FofSideMetrics,
  type FofSideSample,
} from './metrics';
export { headOn, SQUAD } from './test-specs';
export {
  FOF_EXPERIMENTS,
  fofExperiment,
  withConfig,
  type FofExperiment,
  type FofExperimentId,
  type FofVariant,
} from './experiments';
