import { validateCombatConfig, type CombatConfig } from '#sim';
import combatV1 from './combat/combat-v1.json';

// The combat configuration every exercise uses unless given another
// (docs/adr/0019). Its values are documented in docs/combat-configuration.md.

/** The default combat configuration (src/exercise/combat/combat-v1.json), validated. */
export const DEFAULT_COMBAT_CONFIG: CombatConfig = validateCombatConfig(combatV1);
