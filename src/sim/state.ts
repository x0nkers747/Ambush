import type { Azimuth, Vec2, Vec3 } from './geometry';
import type { RngState } from './rng';

// Mutable simulation state (docs/adr/0004). Plain data only: no classes,
// closures or host objects, so it can be cloned, serialized and hashed.
// Collections are arrays in a fixed (scenario) order, so iteration is deterministic.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type SoldierId = Brand<string, 'SoldierId'>;
export type OrgUnitId = Brand<string, 'OrgUnitId'>;

export const soldierId = (id: string): SoldierId => id as SoldierId;
export const orgUnitId = (id: string): OrgUnitId => id as OrgUnitId;

export type Side = 'BLUEFOR' | 'OPFOR';

/** Stored only; posture behavior arrives in later phases. */
export type Posture = 'standing' | 'kneeling' | 'prone';

/** Every soldier starts `active`; nothing changes status until combat (later phases). */
export type SoldierStatus = 'active' | 'wounded' | 'killed';

/** Organizational echelons. Labels only: doctrine lives in scenario data, not here. */
export type Echelon = 'squad' | 'fireTeam';

/** A soldier's current orders. Phase 1 only stores them; movement executes them in Phase 2. */
export interface Orders {
  /** Map points to move through, in order. */
  readonly waypoints: readonly Vec2[];
}

/** An individual soldier: the unit of simulation. */
export interface Soldier {
  readonly id: SoldierId;
  readonly side: Side;
  /** The soldier's immediate unit (e.g. their fire team, or the squad for a squad leader). */
  readonly unitId: OrgUnitId;
  position: Vec3;
  azimuth: Azimuth;
  posture: Posture;
  status: SoldierStatus;
  orders: Orders | null;
}

/**
 * A node in an organization tree (squad, fire team, …). Units are structure,
 * not simulated entities: they have no position and never act. Membership is
 * recorded on soldiers (`Soldier.unitId`); a unit's members include those of
 * its descendant units.
 */
export interface OrgUnit {
  readonly id: OrgUnitId;
  readonly echelon: Echelon;
  readonly parentId: OrgUnitId | null;
  /** Leader, if any. Always a member of this unit or one of its descendants. */
  leaderId: SoldierId | null;
}

export interface SimState {
  /** Number of completed ticks. Simulation time is `tick / tickRateHz`. */
  tick: number;
  rng: RngState;
  units: OrgUnit[];
  soldiers: Soldier[];
}

/** Read-only view of simulation state handed to code outside the simulation. */
export type DeepReadonly<T> = T extends
  string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : { readonly [K in keyof T]: DeepReadonly<T[K]> };

export function findSoldier(state: SimState, id: SoldierId): Soldier | undefined {
  return state.soldiers.find((s) => s.id === id);
}
