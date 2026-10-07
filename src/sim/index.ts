// Public API of the simulation layer. Other layers import only from here (`#sim`).
export type { SetOrdersCommand, SimCommand } from './commands';
export {
  DEFAULT_TICK_RATE_HZ,
  MAX_TICK_RATE_HZ,
  MIN_TICK_RATE_HZ,
  validateSimConfig,
  type SimConfig,
} from './config';
export type { CommandRejectedEvent, OrdersChangedEvent, SimEvent } from './events';
export {
  azimuthFromDegrees,
  normalizeAzimuth,
  type Azimuth,
  type Vec2,
  type Vec3,
} from './geometry';
export { hashSimState } from './hash';
export { MAX_SEED, type RngState } from './rng';
export {
  createInitialState,
  type Scenario,
  type ScenarioSoldier,
  type ScenarioUnit,
} from './scenario';
export { createSimulation, type SimSnapshot, type Simulation } from './simulation';
export {
  findSoldier,
  orgUnitId,
  soldierId,
  type DeepReadonly,
  type Echelon,
  type OrgUnit,
  type OrgUnitId,
  type Orders,
  type Posture,
  type Side,
  type SimState,
  type Soldier,
  type SoldierId,
  type SoldierStatus,
} from './state';
