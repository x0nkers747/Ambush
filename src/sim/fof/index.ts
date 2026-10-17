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
export { KILL_ZONE_MAX_M, KILL_ZONE_MIN_M, killZoneProblem, orderSpecProblem } from './setup';
export { inKillZone, killZoneCorners } from './ambush';
export { hitProbabilityAt, type RangeProbability } from './hit-probability';
export { armed, roundsLeft } from './weapons';
export { recovered, spent } from './force';
export { areaIncapacitation, SMALL_ARMS_VELOCITY_MPS } from './fire';
export { DEFENCE_ARC_MIN_RAD } from './setup';
export { defenceAzimuth, defenceFormation, hardGround, RING_FROM_RAD } from './defence';
