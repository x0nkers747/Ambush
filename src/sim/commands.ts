import type { PathPoint } from './bridge-navigation';
import {
  applyDisturbAgent,
  applyOrderUnit,
  validateDisturbance,
  validateUnitOrder,
  type DisturbAgentCommand,
  type OrderUnitCommand,
} from './behavior/orders';
import { releaseAgent } from './behavior/system';
import { beginEngagement } from './combat';
import type { SimEvent } from './events';
import { clonePlainData } from './plain-data';
import { planPath } from './navigation';
import { isSimplePolygon } from './polygon';
import {
  findSoldier,
  type EngagementArea,
  type Orders,
  type SimState,
  type SoldierId,
} from './state';
import type { Vec2 } from './geometry';
import { isOnTerrain } from './terrain';
import type { SimWorld } from './world';

// Commands are the only way to change simulation state from outside
// (docs/adr/0004). They are plain, serializable data, stamped with the tick at
// whose start they apply. Commands for the same tick apply in submission order.

/**
 * Assigns or replaces a soldier's orders, starting from the soldier's current
 * position and facing; `orders: null` clears them and the soldier stops.
 */
export interface SetOrdersCommand {
  readonly type: 'setOrders';
  readonly tick: number;
  readonly soldierId: SoldierId;
  readonly orders: Orders | null;
}

/**
 * Adds an engagement area, or replaces the one with the same id. Soldiers
 * already inside it when it is set have not entered it (docs/adr/0010).
 */
export interface SetEngagementAreaCommand {
  readonly type: 'setEngagementArea';
  readonly tick: number;
  readonly area: EngagementArea;
}

/**
 * Begins the engagement (docs/adr/0019): from this tick on, combat runs. The
 * exercise submits it when the ambush is sprung. Rejected in a world without
 * a combat model, or when an engagement has already begun.
 */
export interface BeginEngagementCommand {
  readonly type: 'beginEngagement';
  readonly tick: number;
}

export type SimCommand =
  | SetOrdersCommand
  | SetEngagementAreaCommand
  | BeginEngagementCommand
  | OrderUnitCommand
  | DisturbAgentCommand;

/**
 * Rejects malformed commands with a RangeError. Checks only the command's own
 * shape and timing; whether it applies to the state and world is decided when
 * it runs, and reported as a `commandRejected` event.
 */
export function validateCommand(command: SimCommand, currentTick: number): void {
  if (!Number.isInteger(command.tick) || command.tick < currentTick) {
    throw new RangeError(
      `command tick must be an integer >= the current tick ${String(currentTick)}, got ${String(command.tick)}`,
    );
  }
  switch (command.type) {
    case 'setOrders':
      validateOrders(command.orders);
      return;
    case 'setEngagementArea': {
      const { id, vertices } = command.area;
      if (typeof id !== 'string' || id === '') {
        throw new RangeError('engagement area id must be a non-empty string');
      }
      if (!vertices.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))) {
        throw new RangeError('engagement area vertices must be finite');
      }
      if (!isSimplePolygon(vertices)) {
        throw new RangeError(
          `engagement area "${id}" must be a simple polygon of at least 3 vertices`,
        );
      }
      return;
    }
    case 'beginEngagement':
      return;
    case 'orderUnit':
      if (typeof command.unitId !== 'string' || command.unitId === '') {
        throw new RangeError('orderUnit unitId must be a non-empty string');
      }
      validateUnitOrder(command.order);
      return;
    case 'disturbAgent':
      validateDisturbance(command.disturbance);
      return;
  }
}

function validateOrders(orders: Orders | null): void {
  if (orders === null) return;
  const { finalFacing, followRoads } = orders;
  if (followRoads !== undefined && typeof followRoads !== 'boolean') {
    throw new RangeError(`followRoads must be a boolean when given, got ${String(followRoads)}`);
  }
  if (!(finalFacing >= 0 && finalFacing < 2 * Math.PI)) {
    throw new RangeError(`finalFacing must be an azimuth in [0, 2π), got ${String(finalFacing)}`);
  }
  const ids = new Set<string>();
  for (const { id, x, y } of orders.waypoints) {
    if (typeof id !== 'string' || id === '' || ids.has(id)) {
      throw new RangeError(`waypoint ids must be unique, non-empty strings, got "${String(id)}"`);
    }
    ids.add(id);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new RangeError(`waypoint coordinates must be finite, got (${String(x)}, ${String(y)})`);
    }
  }
}

/** Applies `commands` (all stamped with the current tick) in order. */
export function applyCommands(
  state: SimState,
  world: SimWorld,
  commands: readonly SimCommand[],
  startSeconds: number,
  events: SimEvent[],
): void {
  for (const command of commands) {
    switch (command.type) {
      case 'setOrders':
        applySetOrders(state, world, command, startSeconds, events);
        break;
      case 'setEngagementArea':
        applySetEngagementArea(state, world, command, events);
        break;
      case 'beginEngagement':
        beginEngagement(state, world, command, startSeconds, events);
        break;
      case 'orderUnit':
        applyOrderUnit(state, world, command, startSeconds, events);
        break;
      case 'disturbAgent':
        applyDisturbAgent(state, command, events);
        break;
    }
  }
}

function applySetOrders(
  state: SimState,
  world: SimWorld,
  command: SetOrdersCommand,
  startSeconds: number,
  events: SimEvent[],
): void {
  const soldier = findSoldier(state, command.soldierId);
  if (!soldier) {
    events.push({ type: 'commandRejected', tick: state.tick, command, reason: 'unknownSoldier' });
    return;
  }
  // Individual orders take a Marine out of his unit's task (docs/behavior-lab/07 Q10).
  const release = () => {
    const agents = state.behavior?.agents;
    const index = agents?.findIndex((a) => a.soldierId === soldier.id) ?? -1;
    if (state.behavior && index >= 0) {
      releaseAgent(state.behavior, index, 'individualOrders', state.tick, startSeconds, events);
    }
  };
  const { orders } = command;
  if (orders === null) {
    release();
    soldier.orders = null;
    events.push({ type: 'ordersChanged', tick: state.tick, soldierId: soldier.id, orders });
    return;
  }
  // Plan every leg now, from where the soldier stands: the route is fixed when
  // the orders are given (docs/adr/0011), along the roads if they say so (docs/adr/0043).
  const legPaths: PathPoint[][] = [];
  let from: Vec2 = { x: soldier.position.x, y: soldier.position.y };
  const options = { followRoads: orders.followRoads === true };
  for (const waypoint of orders.waypoints) {
    const path = planPath(world.terrain, from, waypoint, options);
    if (!path.ok) {
      const reason =
        path.problem.kind === 'offTerrain'
          ? 'waypointOffTerrain'
          : path.problem.kind === 'unreachable'
            ? 'waypointUnreachable'
            : 'waypointBlocked';
      events.push({ type: 'commandRejected', tick: state.tick, command, reason });
      return;
    }
    legPaths.push(
      path.turns.map((p) => (p.z === undefined ? { x: p.x, y: p.y } : { x: p.x, y: p.y, z: p.z })),
    );
    from = waypoint;
  }
  release();
  soldier.orders = {
    orders: clonePlainData(orders),
    nextWaypointIndex: 0,
    behavior: orders.waypoints.length > 0 ? 'moving' : 'facing',
    legPaths,
    nextTurnIndex: 0,
  };
  events.push({ type: 'ordersChanged', tick: state.tick, soldierId: soldier.id, orders });
}

function applySetEngagementArea(
  state: SimState,
  world: SimWorld,
  command: SetEngagementAreaCommand,
  events: SimEvent[],
): void {
  const { area } = command;
  if (area.vertices.some(({ x, y }) => !isOnTerrain(world.terrain, x, y))) {
    events.push({ type: 'commandRejected', tick: state.tick, command, reason: 'areaOffTerrain' });
    return;
  }
  const copy = clonePlainData(area);
  const index = state.engagementAreas.findIndex((a) => a.id === area.id);
  if (index >= 0) state.engagementAreas[index] = copy;
  else state.engagementAreas.push(copy);
  events.push({ type: 'engagementAreaChanged', tick: state.tick, area });
}
