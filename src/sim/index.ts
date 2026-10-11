// Public API of the simulation layer. Other layers import only from here (`#sim`).
export type {
  BeginEngagementCommand,
  SetEngagementAreaCommand,
  SetOrdersCommand,
  SimCommand,
} from './commands';
export {
  FLEE_HEADING_OFFSETS_DEG,
  isCombatCapable,
  summarizeEngagement,
  type EngagementSummary,
  type SideCombatSummary,
  type SoldierCombatSummary,
} from './combat';
export {
  COMBAT_CONFIG_SCHEMA,
  COMBAT_CONFIG_SCHEMA_VERSION,
  CombatConfigError,
  hitProbabilityAt,
  TARGET_SELECTION_POLICIES,
  validateCombatConfig,
  weaponCombatProfile,
  type CombatConfig,
  type EngagementConfig,
  type OpforBehaviorConfig,
  type RangeProbability,
  type TargetSelectionPolicy,
  type UniformSeconds,
  type WeaponCombatProfile,
} from './combat-config';
export {
  DEFAULT_TICK_RATE_HZ,
  MAX_TICK_RATE_HZ,
  MIN_TICK_RATE_HZ,
  validateSimConfig,
  type SimConfig,
} from './config';
export type {
  CommandRejectedEvent,
  EngagementAreaChangedEvent,
  EngagementAreaEnteredEvent,
  EngagementEndedEvent,
  EngagementStartedEvent,
  OpforReactedEvent,
  OrdersChangedEvent,
  ShotFiredEvent,
  SoldierEscapedEvent,
  SoldierIncapacitatedEvent,
  SimEvent,
  SoldierInPositionEvent,
  WaypointReachedEvent,
} from './events';
export {
  azimuthDelta,
  azimuthFromDegrees,
  azimuthOf,
  normalizeAzimuth,
  type Azimuth,
  type Vec2,
  type Vec3,
} from './geometry';
export {
  boundsOf,
  impassableWater,
  NO_FEATURES,
  rectangle,
  validateFeatures,
  type Box,
  type Building,
  type EnvironmentFeatures,
  type FeatureSource,
  type LandUseArea,
  type LandUseKind,
  type Road,
  type RoadClass,
  type VegetationArea,
  type VegetationKind,
  type WaterArea,
  type Waterway,
  type WaterwayKind,
} from './environment';
export { fingerprintPlainData, fingerprintWorld, hashSimState } from './hash';
export { clonePlainData } from './plain-data';
export {
  buildingRoofElevations,
  lineOfSight,
  STANDING_EYE_HEIGHT_M,
  STANDING_TARGET_HEIGHT_M,
  traceSightLine,
  type LosCause,
  type LosObstruction,
  type LosOptions,
  type LosResult,
  type SightLineHit,
} from './los';
export {
  isSegmentWalkable,
  NAV_CELL_M,
  OBSTACLE_CLEARANCE_M,
  planPath,
  nearestPointClearOfBuildings,
  pointProblem,
  stringPull,
  type PathResult,
  type PointProblem,
} from './navigation';
export { MAX_SEED, type RngState } from './rng';
export {
  createInitialState,
  createWorld,
  type Scenario,
  type ScenarioSoldier,
  type ScenarioUnit,
} from './scenario';
export { createSimulation, type SimSnapshot, type Simulation } from './simulation';
export { authoritativeGround, TERRAIN_MODEL } from './authoritative-terrain';
export {
  cleanElevations,
  cleanTerrain,
  DEM_CLEANING,
  DEM_CLEANING_VERSION,
  demQualitySummary,
  DemQualityError,
  type DemFinding,
  type DemQualityReport,
  type SourceCorrections,
  type TerrainCleaning,
} from './dem-quality';
export {
  BUILDING_APRON_M,
  CUT_SLOPE,
  FILL_SLOPE,
  FINE_SPACING_M,
  GRADING_VERSION,
  gradeTerrain,
  gradeWithSummary,
  MAX_CENTRE_DEPTH_M,
  MIN_CHANGE_M,
  ROAD_GRADING,
  terrainModelId,
  type GradingSummary,
} from './grading';
export {
  isRefinedAt,
  refinementIndex,
  surfaceMesh,
  surfaceSampler,
  type RefinementIndex,
  type SurfaceMesh,
} from './terrain-surface';
export { isSharedTerrain, shareTerrain } from './shared-terrain';
export {
  isOnPolygonBoundary,
  isSimplePolygon,
  pointInPolygon,
  polygonArea,
  segmentIntersectionParams,
  segmentPolygonEntries,
} from './polygon';
export {
  engagementAreaId,
  findSoldier,
  orgUnitId,
  soldierId,
  waypointId,
  type ActiveOrders,
  type CombatBehavior,
  type Combatant,
  type CombatantStats,
  type DeepReadonly,
  type Echelon,
  type EngagementArea,
  type EngagementAreaId,
  type EngagementEndReason,
  type EngagementState,
  type OpforReaction,
  type OrgUnit,
  type OrgUnitId,
  type Orders,
  type OrdersBehavior,
  type Posture,
  type Side,
  type SimState,
  type Soldier,
  type SoldierId,
  type SoldierStatus,
  type Waypoint,
  type WaypointId,
} from './state';
export {
  createSyntheticTerrain,
  flatElevation,
  ridgeElevation,
  slopeElevation,
  type ElevationFunction,
  type TerrainGrid,
} from './synthetic-terrain';
export {
  heightAt,
  isOnTerrain,
  terrainTriangleIndices,
  validateTerrain,
  type GeoReference,
  type Heightfield,
  type TerrainDataset,
  type TerrainGrading,
  type TerrainRefinement,
  type TerrainMetadata,
} from './terrain';
export type { CombatSetup, MovementParams, SimWorld } from './world';
export {
  cellCentre,
  computeViewshed,
  computeUnionRows,
  computeViewshedRows,
  prepareViewsheds,
  viewshedGrid,
  visibleCellsIn,
  type Viewshed,
  type ViewshedGrid,
} from './viewshed';
