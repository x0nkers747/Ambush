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
import { unitInContact } from './fof/setup';
import type { SimEvent } from './events';
import { clonePlainData } from './plain-data';
import { planPath } from './navigation';
import { findSoldier, type Orders, type SimState, type SoldierId } from './state';
import type { Vec2 } from './geometry';
import { applyOrderSquad, validateOrderSquad, type OrderSquadCommand } from './fof/orders';
import { applyOrderVehicle, type OrderVehicleCommand } from './vehicles';
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

export type SimCommand =
  | SetOrdersCommand
  | OrderUnitCommand
  | DisturbAgentCommand
  | OrderSquadCommand
  | OrderVehicleCommand;

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
    case 'orderUnit':
      if (typeof command.unitId !== 'string' || command.unitId === '') {
        throw new RangeError('orderUnit unitId must be a non-empty string');
      }
      validateUnitOrder(command.order);
      return;
    case 'disturbAgent':
      validateDisturbance(command.disturbance);
      return;
    case 'orderSquad':
      validateOrderSquad(command);
      return;
    case 'orderVehicle':
      if (typeof command.vehicleId !== 'string' || command.vehicleId === '') {
        throw new RangeError('orderVehicle vehicleId must be a non-empty string');
      }
      {
        const mode: string = command.mode;
        if (mode !== 'replace' && mode !== 'append') {
          throw new RangeError(`orderVehicle mode must be replace or append, got ${mode}`);
        }
      }
      for (const { x, y } of command.destinations) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new RangeError(
            `orderVehicle destinations must be finite, got (${String(x)}, ${String(y)})`,
          );
        }
      }
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
      case 'orderUnit':
        // A force in a force-on-force experiment is driven by its contact
        // behaviour while in contact: no outside order may conflict with it.
        if (unitInContact(state, command.unitId)) {
          events.push({
            type: 'commandRejected',
            tick: state.tick,
            command,
            reason: 'unitInContact',
          });
          break;
        }
        applyOrderUnit(state, world, command, startSeconds, events);
        break;
      case 'disturbAgent':
        applyDisturbAgent(state, command, events);
        break;
      case 'orderSquad':
        applyOrderSquad(state, world, command, startSeconds, events);
        break;
      case 'orderVehicle':
        applyOrderVehicle(state, world, command, events);
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
