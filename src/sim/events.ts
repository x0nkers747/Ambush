import type { TaskOutcome, TaskPhase } from './behavior/types';
import type {
  ForcePhase,
  FofOutcome,
  ObservationLevel,
  OrderKind,
  OrderStatus,
  SuppressionLevel,
} from './fof/types';
import type { SimCommand } from './commands';
import type { Vec2, Vec3 } from './geometry';
import type { Orders, OrgUnitId, Side, SoldierId, WaypointId } from './state';

// Domain events: plain, tick-stamped facts about what happened during a tick.
// `Simulation.step()` returns the events of that tick; there is no event bus.
// Each event carries enough data to update a reconstructed state without
// re-simulating (docs/adr/0005). Events that happen at a precise moment within
// a tick also carry `atSeconds`, the exact simulation time, which does not
// depend on the tick rate.

/** A soldier's orders were assigned, replaced or cleared. */
export interface OrdersChangedEvent {
  readonly type: 'ordersChanged';
  readonly tick: number;
  readonly soldierId: SoldierId;
  readonly orders: Orders | null;
}

/** A command was well-formed but not applicable to the state at its tick. */
export interface CommandRejectedEvent {
  readonly type: 'commandRejected';
  readonly tick: number;
  readonly command: SimCommand;
  readonly reason:
    | 'unknownSoldier'
    | 'waypointOffTerrain'
    | 'waypointBlocked'
    | 'waypointUnreachable'
    | 'unknownUnit'
    | 'formationMismatch'
    | 'noActiveMembers'
    | 'destinationOffTerrain'
    | 'destinationBlocked'
    | 'destinationUnreachable'
    | 'notSteered'
    | 'unitInContact'
    | 'noForceModel'
    | 'unitIneffective'
    | 'unknownVehicle';
}

/** A soldier arrived at one of its waypoints. */
export interface WaypointReachedEvent {
  readonly type: 'waypointReached';
  readonly tick: number;
  readonly soldierId: SoldierId;
  readonly waypointId: WaypointId;
  readonly atSeconds: number;
}

/** A soldier reached its last waypoint and turned to its final facing. */
export interface SoldierInPositionEvent {
  readonly type: 'soldierInPosition';
  readonly tick: number;
  readonly soldierId: SoldierId;
  readonly atSeconds: number;
}

/** A soldier was incapacitated by a hit (`byId`: the shooter). */
export interface SoldierIncapacitatedEvent {
  readonly type: 'soldierIncapacitated';
  readonly tick: number;
  readonly atSeconds: number;
  readonly soldierId: SoldierId;
  /** The shooter: a soldier, or a vehicle (its id). */
  readonly byId: string;
}

/**
 * An organization was given a task (docs/behavior-lab/03 §4.2): its
 * participating Marines are now steered by it.
 */
export interface UnitOrderedEvent {
  readonly type: 'unitOrdered';
  readonly tick: number;
  readonly unitId: OrgUnitId;
  readonly taskId: string;
  readonly memberIds: readonly SoldierId[];
}

/** A unit task entered a new phase. */
export interface UnitPhaseChangedEvent {
  readonly type: 'unitPhaseChanged';
  readonly tick: number;
  readonly taskId: string;
  readonly unitId: OrgUnitId;
  readonly phase: TaskPhase;
  readonly atSeconds: number;
}

/** A unit task ended: arrived, gave up waiting, was cancelled, or lost all its members. */
export interface UnitTaskEndedEvent {
  readonly type: 'unitTaskEnded';
  readonly tick: number;
  readonly taskId: string;
  readonly unitId: OrgUnitId;
  readonly outcome: TaskOutcome;
  readonly atSeconds: number;
}

/**
 * A Marine stopped being steered by a task: given another unit order or
 * individual orders, incapacitated, or the task was cancelled.
 */
export interface MemberReleasedEvent {
  readonly type: 'memberReleased';
  readonly tick: number;
  readonly taskId: string;
  readonly soldierId: SoldierId;
  readonly reason: 'reordered' | 'individualOrders' | 'incapacitated' | 'cancelled';
}

// Force-on-force (docs/behavior-lab/force-on-force). Decisions are taken at
// `atSeconds` on the decision grid, never between.

/** A force's picture of one enemy soldier changed level. */
export interface ContactObservedEvent {
  readonly type: 'contactObserved';
  readonly tick: number;
  readonly atSeconds: number;
  /** The observing force (its root unit) and side. */
  readonly unitId: string;
  readonly side: Side;
  /** The enemy seen: a soldier, or a vehicle (docs/combined-arms.md §5). */
  readonly targetId: string;
  readonly from: ObservationLevel;
  readonly to: ObservationLevel;
  /** Who saw him (`null`: the cue was his fire), and from how far (m). */
  readonly observerId: SoldierId | null;
  readonly rangeM: number | null;
  readonly confidence: number;
}

/**
 * A squad's order changed state: issued (`from` null, to pending), started,
 * ended (completed, failed, superseded, canceled). `reason` says why, in words.
 */
export interface OrderChangedEvent {
  readonly type: 'orderChanged';
  readonly tick: number;
  readonly atSeconds: number;
  readonly unitId: string;
  readonly side: Side;
  readonly orderId: string;
  readonly kind: OrderKind;
  readonly from: OrderStatus | null;
  readonly to: OrderStatus;
  readonly reason: string;
}

/** A force changed state (`reason` says why, in words). */
export interface ForcePhaseChangedEvent {
  readonly type: 'forcePhaseChanged';
  readonly tick: number;
  readonly atSeconds: number;
  readonly unitId: string;
  readonly side: Side;
  readonly from: ForcePhase;
  readonly to: ForcePhase;
  readonly reason: string;
}

/**
 * One burst (a fire event, not a bullet): aimed at a soldier the shooter
 * sees, or area fire at where his force last saw one. `hitId` is who was
 * hit (the target, or a soldier near the aim point of area fire).
 */
export interface FofFireEvent {
  readonly type: 'fofFire';
  readonly tick: number;
  readonly atSeconds: number;
  readonly shooterId: SoldierId;
  readonly unitId: string;
  readonly side: Side;
  readonly kind: 'aimed' | 'area';
  /** The soldier aimed at (area fire: the contact whose last known position is the aim point). */
  readonly targetId: SoldierId;
  readonly aimPoint: Vec2;
  readonly weapon: string;
  /** The fire mode: sustained, or rapid (docs/behavior-lab/force-on-force/06 §3). */
  readonly mode: 'sustained' | 'rapid';
  readonly rounds: number;
  readonly rangeM: number;
  /** The probability the burst was resolved with (for area fire, against `hitId` or the nearest soldier). */
  readonly hitProbability: number;
  readonly hit: boolean;
  readonly hitId: SoldierId | null;
  /** Whether it strikes `hitId` down: when it arrives (`soldierIncapacitated` then). */
  readonly incapacitated: boolean;
  /** When its rounds arrive (s): its range over `SMALL_ARMS_VELOCITY_MPS`. */
  readonly arriveAt: number;
}

/**
 * A grenade fired (docs/behavior-lab/force-on-force/06 §4): aimed at
 * `aimPoint`, it burst at `impact`; `exposed` soldiers were within its
 * effect and not behind cover, and these were incapacitated.
 */
export interface FofGrenadeEvent {
  readonly type: 'fofGrenade';
  readonly tick: number;
  readonly atSeconds: number;
  readonly shooterId: SoldierId;
  readonly unitId: string;
  readonly side: Side;
  readonly kind: 'aimed' | 'area';
  readonly targetId: SoldierId;
  readonly aimPoint: Vec2;
  readonly impact: Vec2;
  readonly weapon: string;
  readonly rangeM: number;
  readonly exposed: number;
  readonly incapacitated: readonly SoldierId[];
}

/** A soldier began or finished reloading a weapon; `loaded` and `reserve` are its rounds then. */
export interface FofReloadEvent {
  readonly type: 'fofReload';
  readonly tick: number;
  readonly atSeconds: number;
  readonly soldierId: SoldierId;
  readonly weapon: string;
  readonly phase: 'started' | 'completed';
  readonly loaded: number;
  readonly reserve: number;
}

/** A soldier's weapon is empty with nothing in reserve. */
export interface AmmunitionExhaustedEvent {
  readonly type: 'ammunitionExhausted';
  readonly tick: number;
  readonly atSeconds: number;
  readonly soldierId: SoldierId;
  readonly weapon: string;
}

/** A soldier's suppression crossed a threshold. */
export interface SuppressionChangedEvent {
  readonly type: 'suppressionChanged';
  readonly tick: number;
  readonly atSeconds: number;
  readonly soldierId: SoldierId;
  readonly from: SuppressionLevel;
  readonly to: SuppressionLevel;
  readonly suppression: number;
}

/**
 * A shot at or from a vehicle, or an anti-tank weapon's (docs/combined-arms.md
 * §7): one round, missile or burst. `missileId` is set for a missile, which is
 * resolved when it arrives (`missileImpact`); otherwise `hit` is the outcome.
 */
export interface VehicleFireEvent {
  readonly type: 'vehicleFire';
  readonly tick: number;
  readonly atSeconds: number;
  /** A vehicle or a soldier (an anti-tank weapon). */
  readonly shooterId: string;
  readonly shooter: 'vehicle' | 'soldier';
  readonly side: Side;
  /** The weapon's slot on the vehicle (`main`, `coax`…), or the soldier's weapon. */
  readonly slot: string;
  readonly weapon: string;
  readonly ammo: string;
  readonly rounds: number;
  readonly targetId: string;
  readonly target: 'soldier' | 'vehicle';
  /** The muzzle and where it was aimed (m, with height). */
  readonly from: Vec3;
  readonly aimPoint: Vec3;
  readonly rangeM: number;
  readonly hitProbability: number;
  readonly hit: boolean;
  /** A soldier struck down (direct fire at soldiers). */
  readonly incapacitated: readonly SoldierId[];
  readonly missileId: string | null;
  readonly impactAt: number | null;
  /** Where it landed: on the target when it hit, beside it when not. */
  readonly impact: Vec3;
}

/** A missile arrived (docs/combined-arms.md §7): it hit its target or missed. */
export interface MissileImpactEvent {
  readonly type: 'missileImpact';
  readonly tick: number;
  readonly atSeconds: number;
  readonly missileId: string;
  readonly shooterId: string;
  readonly targetId: string;
  readonly hit: boolean;
  /** Why it missed when it did: the draw, the gunner lost, the target gone. */
  readonly reason: 'hit' | 'missed' | 'guidanceLost' | 'targetGone';
  readonly impact: Vec3;
}

/**
 * A vehicle was hit (docs/combined-arms.md §8): the face, whether it
 * perforated, and what that did; `condition` is its state after.
 */
export interface VehicleHitEvent {
  readonly type: 'vehicleHit';
  readonly tick: number;
  readonly atSeconds: number;
  readonly vehicleId: string;
  readonly byId: string;
  readonly weapon: string;
  readonly ammo: string;
  readonly zone: 'front' | 'side' | 'rear' | 'top';
  readonly penetrationMm: number;
  readonly protectionMm: number;
  readonly perforated: boolean;
  readonly catastrophic: boolean;
  readonly mobility: boolean;
  readonly firepower: readonly string[];
  readonly sensorsLost: number;
  readonly crew: readonly { readonly role: string; readonly to: string }[];
  readonly condition: 'operational' | 'damaged' | 'missionKill' | 'destroyed';
}

/** A vehicle's condition changed (`operational` → `damaged` → `missionKill`, or `destroyed`). */
export interface VehicleConditionEvent {
  readonly type: 'vehicleCondition';
  readonly tick: number;
  readonly atSeconds: number;
  readonly vehicleId: string;
  readonly from: 'operational' | 'damaged' | 'missionKill' | 'destroyed';
  readonly to: 'operational' | 'damaged' | 'missionKill' | 'destroyed';
}

/** The experiment ended: its outcome and why. */
export interface FofEndedEvent {
  readonly type: 'fofEnded';
  readonly tick: number;
  readonly atSeconds: number;
  readonly outcome: FofOutcome;
}

export type SimEvent =
  | OrdersChangedEvent
  | CommandRejectedEvent
  | WaypointReachedEvent
  | SoldierInPositionEvent
  | SoldierIncapacitatedEvent
  | UnitOrderedEvent
  | UnitPhaseChangedEvent
  | UnitTaskEndedEvent
  | MemberReleasedEvent
  | ContactObservedEvent
  | ForcePhaseChangedEvent
  | OrderChangedEvent
  | FofFireEvent
  | FofGrenadeEvent
  | FofReloadEvent
  | AmmunitionExhaustedEvent
  | SuppressionChangedEvent
  | FofEndedEvent
  | VehicleFireEvent
  | MissileImpactEvent
  | VehicleHitEvent
  | VehicleConditionEvent;
