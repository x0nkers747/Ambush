// Public API of the simulation layer. Other layers import only from here (`#sim`).
export type { SetEngagementAreaCommand, SetOrdersCommand, SimCommand } from './commands';
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
  OrdersChangedEvent,
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
  NO_FEATURES,
  rectangle,
  validateFeatures,
  type Box,
  type Building,
  type EnvironmentFeatures,
  type Road,
  type RoadClass,
  type VegetationArea,
  type VegetationKind,
} from './environment';
export { fingerprintWorld, hashSimState } from './hash';
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
  type DeepReadonly,
  type Echelon,
  type EngagementArea,
  type EngagementAreaId,
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
} from './terrain';
export type { MovementParams, SimWorld } from './world';
export {
  cellCentre,
  computeViewshed,
  computeViewshedRows,
  viewshedGrid,
  visibleCellsIn,
  type Viewshed,
  type ViewshedGrid,
} from './viewshed';
