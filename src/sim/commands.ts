import type { SimEvent } from './events';
import { clonePlainData } from './plain-data';
import { findSoldier, type Orders, type SimState, type SoldierId } from './state';
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

export type SimCommand = SetOrdersCommand;

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
  // Only one command type exists; dispatch on `command.type` when a second is added.
  const { orders } = command;
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
  for (const command of commands) applySetOrders(state, world, command, events);
}

function applySetOrders(
  state: SimState,
  world: SimWorld,
  command: SetOrdersCommand,
  events: SimEvent[],
): void {
  const reject = (reason: 'unknownSoldier' | 'waypointOffTerrain') => {
    events.push({ type: 'commandRejected', tick: state.tick, command, reason });
  };
  const soldier = findSoldier(state, command.soldierId);
  if (!soldier) {
    reject('unknownSoldier');
    return;
  }
  const { orders } = command;
  if (orders?.waypoints.some(({ x, y }) => !isOnTerrain(world.terrain, x, y))) {
    reject('waypointOffTerrain');
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
