import type { TaskOutcome, TaskPhase } from './behavior/types';
import type { SimCommand } from './commands';
import type { Vec2 } from './geometry';
import type {
  EngagementArea,
  EngagementAreaId,
  EngagementEndReason,
  Orders,
  OrgUnitId,
  Side,
  SoldierId,
  WaypointId,
} from './state';

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
    | 'areaOffTerrain'
    | 'noCombatModel'
    | 'engagementAlreadyBegun'
    | 'unknownUnit'
    | 'formationMismatch'
    | 'noActiveMembers'
    | 'destinationOffTerrain'
    | 'destinationBlocked'
    | 'destinationUnreachable'
    | 'notSteered';
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

/** An engagement area was added or replaced. */
export interface EngagementAreaChangedEvent {
  readonly type: 'engagementAreaChanged';
  readonly tick: number;
  readonly area: EngagementArea;
}

/**
 * A soldier of the area's monitored side passed from outside an engagement
 * area onto its boundary (docs/adr/0010). `atSeconds` and `point` are the exact
 * moment and place of entry along the soldier's path within the tick.
 */
export interface EngagementAreaEnteredEvent {
  readonly type: 'engagementAreaEntered';
  readonly tick: number;
  readonly areaId: EngagementAreaId;
  readonly soldierId: SoldierId;
  readonly atSeconds: number;
  readonly point: Vec2;
}

/** The engagement began (docs/adr/0019); every OPFOR soldier's reaction has been drawn. */
export interface EngagementStartedEvent {
  readonly type: 'engagementStarted';
  readonly tick: number;
  readonly atSeconds: number;
}

/**
 * An OPFOR soldier reacted to the ambush: dropped prone, or started to flee
 * toward `destination` at `speed`. `fleeBlocked` marks a flee that found no
 * route and dropped prone instead.
 */
export interface OpforReactedEvent {
  readonly type: 'opforReacted';
  readonly tick: number;
  readonly atSeconds: number;
  readonly soldierId: SoldierId;
  readonly reaction: 'prone' | 'flee';
  readonly fleeBlocked: boolean;
  readonly destination: Vec2 | null;
  readonly speed: number | null;
}

/** One firing opportunity taken: a shot at a target, and what it did. */
export interface ShotFiredEvent {
  readonly type: 'shotFired';
  readonly tick: number;
  readonly atSeconds: number;
  readonly shooterId: SoldierId;
  readonly shooterSide: Side;
  readonly targetId: SoldierId;
  readonly weaponProfileRef: string;
  /** Horizontal distance from shooter to target, in metres. */
  readonly rangeM: number;
  /** The hit probability the shot was resolved with (curve × target posture multiplier). */
  readonly hitProbability: number;
  readonly hit: boolean;
  readonly incapacitated: boolean;
}

/** A soldier was incapacitated by a shot. */
export interface SoldierIncapacitatedEvent {
  readonly type: 'soldierIncapacitated';
  readonly tick: number;
  readonly atSeconds: number;
  readonly soldierId: SoldierId;
  readonly byId: SoldierId;
}

/** A fleeing OPFOR soldier escaped. */
export interface SoldierEscapedEvent {
  readonly type: 'soldierEscaped';
  readonly tick: number;
  readonly atSeconds: number;
  readonly soldierId: SoldierId;
}

/** The engagement ended at the end of tick `tick`. */
export interface EngagementEndedEvent {
  readonly type: 'engagementEnded';
  readonly tick: number;
  readonly atSeconds: number;
  readonly reason: EngagementEndReason;
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

export type SimEvent =
  | OrdersChangedEvent
  | CommandRejectedEvent
  | WaypointReachedEvent
  | SoldierInPositionEvent
  | EngagementAreaChangedEvent
  | EngagementAreaEnteredEvent
  | EngagementStartedEvent
  | OpforReactedEvent
  | ShotFiredEvent
  | SoldierIncapacitatedEvent
  | SoldierEscapedEvent
  | EngagementEndedEvent
  | UnitOrderedEvent
  | UnitPhaseChangedEvent
  | UnitTaskEndedEvent
  | MemberReleasedEvent;
