// Public API of the simulation layer. Other layers import only from here (`#sim`).
export type { SetOrdersCommand, SimCommand } from './commands';
export {
  DEFAULT_TICK_RATE_HZ,
  MAX_TICK_RATE_HZ,
  MIN_TICK_RATE_HZ,
  validateSimConfig,
  type SimConfig,
} from './config';
export type {
  CommandRejectedEvent,
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
export { hashSimState } from './hash';
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
  findSoldier,
  orgUnitId,
  soldierId,
  waypointId,
  type ActiveOrders,
  type DeepReadonly,
  type Echelon,
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
