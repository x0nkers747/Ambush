import type { SimEvent } from './events';
import { findSoldier, type Orders, type SimState, type SoldierId } from './state';

// Commands are the only way to change simulation state from outside
// (docs/adr/0004). They are plain, serializable data, stamped with the tick at
// whose start they apply. Commands for the same tick apply in submission order.

/** Assigns, replaces or (with `orders: null`) clears a soldier's orders. */
export interface SetOrdersCommand {
  readonly type: 'setOrders';
  readonly tick: number;
  readonly soldierId: SoldierId;
  readonly orders: Orders | null;
}

export type SimCommand = SetOrdersCommand;

/**
 * Rejects malformed commands with a RangeError. Checks only the command's own
 * shape and timing; whether it applies to the state is decided when it runs,
 * and reported as a `commandRejected` event.
 */
export function validateCommand(command: SimCommand, currentTick: number): void {
  if (!Number.isInteger(command.tick) || command.tick < currentTick) {
    throw new RangeError(
      `command tick must be an integer >= the current tick ${String(currentTick)}, got ${String(command.tick)}`,
    );
  }
  // Only one command type exists; dispatch on `command.type` when a second is added.
  for (const { x, y } of command.orders?.waypoints ?? []) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new RangeError(`waypoint coordinates must be finite, got (${String(x)}, ${String(y)})`);
    }
  }
}

/** Applies `commands` (all stamped with the current tick) in order. */
export function applyCommands(
  state: SimState,
  commands: readonly SimCommand[],
  events: SimEvent[],
): void {
  for (const command of commands) applySetOrders(state, command, events);
}

function applySetOrders(state: SimState, command: SetOrdersCommand, events: SimEvent[]): void {
  const soldier = findSoldier(state, command.soldierId);
  if (!soldier) {
    events.push({ type: 'commandRejected', tick: state.tick, command, reason: 'unknownSoldier' });
    return;
  }
  soldier.orders = command.orders;
  events.push({
    type: 'ordersChanged',
    tick: state.tick,
    soldierId: soldier.id,
    orders: command.orders,
  });
}
