import type { SimCommand } from './commands';
import type { Orders, SoldierId } from './state';

// Domain events: plain, tick-stamped facts about what happened during a tick.
// `Simulation.step()` returns the events of that tick; there is no event bus.
// Each event carries enough data to update a reconstructed state without
// re-simulating (docs/adr/0005).

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
  readonly reason: 'unknownSoldier';
}

export type SimEvent = OrdersChangedEvent | CommandRejectedEvent;
