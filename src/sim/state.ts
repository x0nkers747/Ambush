import type { Azimuth, Vec2, Vec3 } from './geometry';
import type { RngState } from './rng';

// Mutable simulation state (docs/adr/0004). Plain data only: no classes,
// closures or host objects, so it can be cloned, serialized and hashed.
// Collections are arrays in a fixed (scenario) order, so iteration is deterministic.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type SoldierId = Brand<string, 'SoldierId'>;
export type OrgUnitId = Brand<string, 'OrgUnitId'>;
export type WaypointId = Brand<string, 'WaypointId'>;
export type EngagementAreaId = Brand<string, 'EngagementAreaId'>;

export const soldierId = (id: string): SoldierId => id as SoldierId;
export const orgUnitId = (id: string): OrgUnitId => id as OrgUnitId;
export const waypointId = (id: string): WaypointId => id as WaypointId;
export const engagementAreaId = (id: string): EngagementAreaId => id as EngagementAreaId;

export type Side = 'BLUEFOR' | 'OPFOR';

/** Stored only; posture behavior arrives in later phases. */
export type Posture = 'standing' | 'kneeling' | 'prone';

/** Every soldier starts `active`; nothing changes status until combat (later phases). */
export type SoldierStatus = 'active' | 'wounded' | 'killed';

/** Organizational echelons. Labels only: doctrine lives in scenario data, not here. */
export type Echelon = 'squad' | 'fireTeam';

/** A map point of a soldier's route. Z always comes from the terrain. */
export interface Waypoint extends Readonly<Vec2> {
  /** Stable identifier, chosen by whoever authored the orders (e.g. the trainee's plan). */
  readonly id: WaypointId;
}

/**
 * Orders as given: the trainee's intent. Never modified by the simulation;
 * progress is tracked separately in `ActiveOrders`.
 */
export interface Orders {
  /** Points to move through, in order. May be empty (turn in place to `finalFacing`). */
  readonly waypoints: readonly Waypoint[];
  /** Azimuth to face once the last waypoint is reached. */
  readonly finalFacing: Azimuth;
}

/**
 * Behavior of a soldier with orders (a soldier without orders is idle):
 * `moving` toward `waypoints[nextWaypointIndex]`, then `facing` (turning to
 * `finalFacing`), then `inPosition`.
 */
export type OrdersBehavior = 'moving' | 'facing' | 'inPosition';

/** Orders being executed, with progress. */
export interface ActiveOrders {
  readonly orders: Orders;
  /** Index of the waypoint being moved to; equals `waypoints.length` once all are reached. */
  nextWaypointIndex: number;
  behavior: OrdersBehavior;
}

/** An individual soldier: the unit of simulation. */
export interface Soldier {
  readonly id: SoldierId;
  readonly side: Side;
  /** The soldier's immediate unit (e.g. their fire team, or the squad for a squad leader). */
  readonly unitId: OrgUnitId;
  /** Z is always the terrain elevation at (x, y). */
  position: Vec3;
  /** Facing. While moving it turns toward the direction of travel at a limited rate. */
  azimuth: Azimuth;
  posture: Posture;
  status: SoldierStatus;
  /** `null` while idle. */
  orders: ActiveOrders | null;
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

/**
 * A map polygon watched for soldiers of one side entering it (docs/adr/0010).
 * Geometry and monitoring only: what an entry means (e.g. springing an ambush)
 * is decided outside the simulation.
 */
export interface EngagementArea {
  readonly id: EngagementAreaId;
  /** A simple polygon of at least three map points; the boundary belongs to the area. */
  readonly vertices: readonly Vec2[];
  /** Soldiers of this side entering the area produce `engagementAreaEntered` events. */
  readonly monitoredSide: Side;
}

export interface SimState {
  /** Number of completed ticks. Simulation time is `tick / tickRateHz`. */
  tick: number;
  rng: RngState;
  units: OrgUnit[];
  soldiers: Soldier[];
  engagementAreas: EngagementArea[];
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
