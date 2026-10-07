import { validateSeed } from './rng';

/**
 * Simulation-wide configuration. Fixed for the lifetime of a simulation and
 * recorded with every exercise (docs/adr/0003).
 */
export interface SimConfig {
  /** Fixed simulation tick rate in Hz. Sim time = tick / tickRateHz. */
  readonly tickRateHz: number;
  /** Seed for the simulation PRNG: an integer in [0, 2^32 − 1]. */
  readonly seed: number;
}

export const MIN_TICK_RATE_HZ = 1;
export const MAX_TICK_RATE_HZ = 240;

/**
 * Provisional default. The production tick rate is deliberately undecided and
 * will be chosen by measurement in later phases; nothing may depend on this value.
 */
export const DEFAULT_TICK_RATE_HZ = 30;

/** Throws a RangeError describing the first invalid field. */
export function validateSimConfig(config: SimConfig): void {
  const { tickRateHz } = config;
  if (!Number.isFinite(tickRateHz)) {
    throw new RangeError(`tickRateHz must be a finite number, got ${String(tickRateHz)}`);
  }
  if (tickRateHz < MIN_TICK_RATE_HZ || tickRateHz > MAX_TICK_RATE_HZ) {
    throw new RangeError(
      `tickRateHz must be within [${String(MIN_TICK_RATE_HZ)}, ${String(MAX_TICK_RATE_HZ)}], got ${String(tickRateHz)}`,
    );
  }
  validateSeed(config.seed);
}
