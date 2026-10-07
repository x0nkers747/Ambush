import type { SimCommand } from './commands';
import type { Vec2 } from './geometry';
import type { EngagementArea, EngagementAreaId, Orders, SoldierId, WaypointId } from './state';

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
    | 'areaOffTerrain';
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

export type SimEvent =
  | OrdersChangedEvent
  | CommandRejectedEvent
  | WaypointReachedEvent
  | SoldierInPositionEvent
  | EngagementAreaChangedEvent
  | EngagementAreaEnteredEvent;
