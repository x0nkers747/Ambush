import type { SimEvent } from './events';
import { clonePlainData } from './plain-data';
import { isSimplePolygon } from './polygon';
import {
  findSoldier,
  type EngagementArea,
  type Orders,
  type SimState,
  type SoldierId,
} from './state';
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

export type SimCommand = SetOrdersCommand | SetEngagementAreaCommand;

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
  }
}

function validateOrders(orders: Orders | null): void {
  if (orders === null) return;
  const { finalFacing } = orders;
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
  events: SimEvent[],
): void {
  for (const command of commands) {
    switch (command.type) {
      case 'setOrders':
        applySetOrders(state, world, command, events);
        break;
      case 'setEngagementArea':
        applySetEngagementArea(state, world, command, events);
        break;
    }
  }
}

function applySetOrders(
  state: SimState,
  world: SimWorld,
  command: SetOrdersCommand,
  events: SimEvent[],
): void {
  const soldier = findSoldier(state, command.soldierId);
  if (!soldier) {
    events.push({ type: 'commandRejected', tick: state.tick, command, reason: 'unknownSoldier' });
    return;
  }
  const { orders } = command;
  if (orders?.waypoints.some(({ x, y }) => !isOnTerrain(world.terrain, x, y))) {
    events.push({
      type: 'commandRejected',
      tick: state.tick,
      command,
      reason: 'waypointOffTerrain',
    });
    return;
  }
  soldier.orders =
    orders === null
      ? null
      : {
          orders: clonePlainData(orders),
          nextWaypointIndex: 0,
          behavior: orders.waypoints.length > 0 ? 'moving' : 'facing',
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
