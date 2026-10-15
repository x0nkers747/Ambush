// Force-on-force (docs/behavior-lab/force-on-force): the experimental contact
// and engagement model of the Force-on-Force Lab.
export {
  FOF_CONFIG_SCHEMA,
  FOF_CONFIG_SCHEMA_VERSION,
  FofConfigError,
  fofWeapon,
  validateFofConfig,
  VISIBILITY_CLASSES,
  type DetectionConfig,
  type EffectivenessConfig,
  type FireConfig,
  type FofConfig,
  type FofWeapon,
  type ForceBehaviorConfig,
  type SuppressionConfig,
  type TerminationConfig,
  type UniformSeconds,
  type VisibilityClass,
  type VisibilityConditions,
} from './config';
export {
  chanceIn,
  confidenceAt,
  cyclesOnTarget,
  sight,
  ttpf,
  vegetationTransmission,
  type Sighting,
} from './detection';
export { ACTIONS_ON, forceMembers, validateFofSetup } from './setup';
export { ORDER_KINDS } from './types';
export type * from './types';
export {
  activeOrder,
  validateOrderSquad,
  type OrderSquadCommand,
  type OrderSquadRejection,
} from './orders';
export { orderSpecProblem } from './setup';
export { hitProbabilityAt, type RangeProbability } from './hit-probability';
