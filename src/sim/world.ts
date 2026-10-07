import type { TerrainDataset } from './terrain';

/** Movement model parameters, in SI units (docs/adr/0008). */
export interface MovementParams {
  /** Ground speed along the route, in metres per second (horizontal distance). */
  readonly speed: number;
  /** Maximum rate at which a soldier turns, in radians per second. */
  readonly maxTurnRate: number;
}

/**
 * Immutable reference data a simulation runs against (docs/adr/0004). Built
 * once from the scenario, deep-frozen, and never part of `SimState` or snapshots.
 */
export interface SimWorld {
  readonly terrain: TerrainDataset;
  readonly movement: MovementParams;
}

/** Throws a RangeError describing the first invalid field. */
export function validateMovementParams(movement: MovementParams): void {
  for (const [name, value] of [
    ['speed', movement.speed],
    ['maxTurnRate', movement.maxTurnRate],
  ] as const) {
    if (!(value > 0) || !Number.isFinite(value)) {
      throw new RangeError(`movement.${name} must be a finite number > 0, got ${String(value)}`);
    }
  }
}
