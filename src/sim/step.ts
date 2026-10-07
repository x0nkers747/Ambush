import { applyCommands, type SimCommand } from './commands';
import type { SimEvent } from './events';
import type { SimState } from './state';

/**
 * Advances `state` by exactly one tick, in place, and returns the events of
 * that tick. This function is the whole simulation pipeline: the order of the
 * statements below is the execution order.
 *
 * Tick T runs from simulation time T / tickRateHz to (T + 1) / tickRateHz.
 * `commands` must be exactly the commands stamped with tick T, in submission order.
 */
export function stepState(state: SimState, commands: readonly SimCommand[]): SimEvent[] {
  const events: SimEvent[] = [];

  // 1. External input: commands take effect at the start of their tick.
  applyCommands(state, commands, events);

  // 2. Systems, as free functions in fixed order. Movement is added here in
  //    Phase 2; perception and combat follow in later phases. Each system
  //    receives the tick duration in seconds so behavior does not depend on
  //    the tick rate (docs/adr/0003).

  // 3. Advance the clock.
  state.tick += 1;
  return events;
}
