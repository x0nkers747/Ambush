import { validateCommand, type SimCommand } from './commands';
import { validateSimConfig, type SimConfig } from './config';
import type { SimEvent } from './events';
import { fingerprintWorld } from './hash';
import { clonePlainData } from './plain-data';
import { createInitialState, createWorld, type Scenario } from './scenario';
import type { DeepReadonly, SimState } from './state';
import { stepState } from './step';
import type { SimWorld } from './world';

/**
 * A copy of the complete mutable simulation state at a tick boundary
 * (docs/adr/0007). Plain data: it can be stored, serialized and restored.
 * It does not contain the immutable world, only the world's fingerprint, and
 * can only be restored into a simulation with the same tick rate and world.
 */
export interface SimSnapshot {
  readonly tickRateHz: number;
  /** `fingerprintWorld` of the world the snapshot was taken in. */
  readonly worldFingerprint: string;
  readonly state: DeepReadonly<SimState>;
}

/** Handle to a running simulation: owns its state and its queue of pending commands. */
export interface Simulation {
  readonly config: SimConfig;
  /** Fixed duration of one tick, in seconds. */
  readonly dtSeconds: number;
  /** Number of completed ticks. */
  readonly tick: number;
  /** Simulation time in seconds, derived from the tick count (never accumulated). */
  readonly timeSeconds: number;
  /** Immutable reference data (terrain, movement parameters). */
  readonly world: SimWorld;
  /** Content fingerprint of `world`, computed once at creation. */
  readonly worldFingerprint: string;
  /** Current state, read-only. Re-read it after `restore`, which replaces it. */
  readonly state: DeepReadonly<SimState>;
  /**
   * Queues a command for its tick, which must not be in the past. Throws a
   * RangeError for malformed commands. The command is copied.
   */
  submit(command: SimCommand): void;
  /** Advances the simulation by exactly one tick and returns that tick's events. */
  step(): readonly SimEvent[];
  snapshot(): SimSnapshot;
  /**
   * Replaces the state with a copy of `snapshot` and discards all pending
   * commands: commands are input, not state, so the caller resubmits them
   * (for a replay, from the command log). Throws a RangeError if the
   * snapshot was taken at a different tick rate or in a different world.
   */
  restore(snapshot: SimSnapshot): void;
}

export function createSimulation(config: SimConfig, scenario: Scenario): Simulation {
  validateSimConfig(config);
  const frozenConfig: SimConfig = Object.freeze({ ...config });
  let state = createInitialState(scenario, frozenConfig.seed);
  const world = createWorld(scenario);
  const worldFingerprint = fingerprintWorld(world);
  let pending: SimCommand[] = [];

  return {
    config: frozenConfig,
    dtSeconds: 1 / frozenConfig.tickRateHz,
    world,
    worldFingerprint,
    get tick() {
      return state.tick;
    },
    get timeSeconds() {
      return state.tick / frozenConfig.tickRateHz;
    },
    get state() {
      return state;
    },
    submit(command) {
      validateCommand(command, state.tick);
      pending.push(clonePlainData(command));
    },
    step() {
      const due = pending.filter((c) => c.tick === state.tick);
      if (due.length > 0) pending = pending.filter((c) => c.tick !== state.tick);
      return stepState(state, world, frozenConfig.tickRateHz, due);
    },
    snapshot() {
      return {
        tickRateHz: frozenConfig.tickRateHz,
        worldFingerprint,
        state: clonePlainData(state),
      };
    },
    restore(snapshot) {
      if (snapshot.tickRateHz !== frozenConfig.tickRateHz) {
        throw new RangeError(
          `snapshot tick rate ${String(snapshot.tickRateHz)} Hz does not match simulation tick rate ${String(frozenConfig.tickRateHz)} Hz`,
        );
      }
      if (snapshot.worldFingerprint !== worldFingerprint) {
        throw new RangeError(
          `snapshot was taken in a different world (terrain or movement parameters): fingerprint ${snapshot.worldFingerprint}, this simulation ${worldFingerprint}`,
        );
      }
      state = clonePlainData(snapshot.state as SimState);
      pending = [];
    },
  };
}
