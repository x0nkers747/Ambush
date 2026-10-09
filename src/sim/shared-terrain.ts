import { clonePlainData } from './plain-data';
import type { TerrainDataset } from './terrain';

// Terrain is immutable reference data (docs/adr/0006), and on a 5 km
// battlefield it is large: copying it for every simulation also defeated the
// per-terrain caches (navigation grid, line of sight), which are keyed by the
// terrain object. A shared terrain is a deep-frozen copy made once: it cannot
// change, so simulations, scenario editing and those caches can all use the
// same object.

const shared = new WeakSet();

/**
 * A deep-frozen copy of `terrain` that simulations can share without copying
 * it again; `terrain` itself when it is already one. Throws a TypeError if it
 * is not plain data.
 */
export function shareTerrain(terrain: TerrainDataset): TerrainDataset {
  if (shared.has(terrain)) return terrain;
  const copy = deepFreeze(clonePlainData(terrain));
  shared.add(copy);
  return copy;
}

/** Whether `terrain` is a shared (deep-frozen, so unchangeable) terrain. */
export function isSharedTerrain(terrain: TerrainDataset): boolean {
  return shared.has(terrain);
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
