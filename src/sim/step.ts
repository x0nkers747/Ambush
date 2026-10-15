import { updateBehavior } from './behavior/system';
import { applyCommands, type SimCommand } from './commands';
import type { SimEvent } from './events';
import { updateForceOnForce } from './fof/system';
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
  //    Marines steered by unit tasks move first (docs/behavior-lab/03 §4.3);
  //    `moveSoldiers` moves those following individual orders. Force on
  //    force (docs/behavior-lab/force-on-force) runs only with a setup in the
  //    world: a battle's detection, fire and outcomes.
  updateBehavior(state, world, time, events);
  moveSoldiers(state, world, time, events);
  updateForceOnForce(state, world, time, events);

  // 3. Advance the clock.
  state.tick += 1;
  return events;
}
