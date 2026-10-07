import { validateSimConfig, type SimConfig } from './config';

/**
 * Handle to a running simulation. Phase 0 only advances time; simulation state,
 * commands and systems arrive in Phase 1.
 */
export interface Simulation {
  readonly config: SimConfig;
  /** Fixed duration of one tick, in seconds. */
  readonly dtSeconds: number;
  /** Number of completed ticks. */
  readonly tick: number;
  /** Simulation time in seconds, derived from the tick count (never accumulated). */
  readonly timeSeconds: number;
  /** Advances the simulation by exactly one tick. */
  step(): void;
}

export function createSimulation(config: SimConfig): Simulation {
  validateSimConfig(config);
  const frozenConfig: SimConfig = Object.freeze({ ...config });
  let tick = 0;

  return {
    config: frozenConfig,
    dtSeconds: 1 / frozenConfig.tickRateHz,
    get tick() {
      return tick;
    },
    get timeSeconds() {
      return tick / frozenConfig.tickRateHz;
    },
    step() {
      tick += 1;
    },
  };
}
