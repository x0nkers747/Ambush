import type { BehaviorParams } from './behavior/params';
import type { CombatConfig } from './combat-config';
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
  /** The combat model; absent in worlds without combat (docs/adr/0019). */
  readonly combat?: CombatSetup;
  /** Unit-movement tuning (docs/behavior-lab/03); absent: `DEFAULT_BEHAVIOR_PARAMS`. */
  readonly behavior?: BehaviorParams;
}

/**
 * Everything combat needs beyond the state (docs/adr/0019): the validated
 * configuration, and the weapon each soldier fires. Which weapon that is (the
 * primary weapon of the soldier's resolved loadout) is decided outside the
 * simulation; the simulation only fires it.
 */
export interface CombatSetup {
  readonly config: CombatConfig;
  /**
   * The weapon profile reference each soldier fires, by soldier id; `null`
   * (or no entry) for a soldier without a usable weapon, who never fires.
   * Every reference must have a profile in `config.weapons`.
   */
  readonly weapons: Readonly<Record<string, string | null>>;
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
