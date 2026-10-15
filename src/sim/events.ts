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
import type { Vec2 } from './geometry';
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
    | 'unitIneffective';
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
  readonly byId: SoldierId;
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
  readonly targetId: SoldierId;
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
  readonly rounds: number;
  readonly rangeM: number;
  /** The probability the burst was resolved with (for area fire, against `hitId` or the nearest soldier). */
  readonly hitProbability: number;
  readonly hit: boolean;
  readonly hitId: SoldierId | null;
  readonly incapacitated: boolean;
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
  | SuppressionChangedEvent
  | FofEndedEvent;
