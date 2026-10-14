import { updateBehavior } from './behavior/system';
import { resolveCombat } from './combat';
import { applyCommands, type SimCommand } from './commands';
import { monitorEngagementAreas } from './engagement-areas';
import type { SimEvent } from './events';
import { moveSoldiers } from './movement';
import type { SimState } from './state';
import type { SimWorld } from './world';

/**
 * Advances `state` by exactly one tick, in place, and returns the events of
 * that tick. This function is the whole simulation pipeline: the order of the
 * statements below is the execution order.
 *
 * Tick T runs from simulation time T / tickRateHz to (T + 1) / tickRateHz.
 * `commands` must be exactly the commands stamped with tick T, in submission order.
 */
export function stepState(
  state: SimState,
  world: SimWorld,
  tickRateHz: number,
  commands: readonly SimCommand[],
): SimEvent[] {
  const events: SimEvent[] = [];
  const time = {
    tick: state.tick,
    startSeconds: state.tick / tickRateHz,
    dtSeconds: 1 / tickRateHz,
  };

  // 1. External input: commands take effect at the start of their tick.
  applyCommands(state, world, commands, time.startSeconds, events);

  // 2. Systems, as free functions in fixed order. They work in seconds, never
  //    in ticks, so behavior does not depend on the tick rate (docs/adr/0003).
  //    Combat resolves the tick's firing opportunities against the positions
  //    soldiers reached by its end (docs/adr/0019).
  //    Marines steered by unit tasks move first (docs/behavior-lab/03 §4.3);
  //    `moveSoldiers` moves those following individual orders.
  const steered = updateBehavior(state, world, time, events);
  const path = moveSoldiers(state, world, time, events);
  monitorEngagementAreas(state, steered.length > 0 ? [...steered, ...path] : path, time, events);
  resolveCombat(state, world, time, events);

  // 3. Advance the clock.
  state.tick += 1;
  return events;
}
