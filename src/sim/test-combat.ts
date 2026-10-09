import type { CombatConfig, WeaponCombatProfile } from './combat-config';
import type { EnvironmentFeatures } from './environment';
import type { Scenario } from './scenario';
import { createSyntheticTerrain, flatElevation } from './synthetic-terrain';

// Test fixtures for combat (docs/adr/0019): a configuration with a few
// predictable weapons, and small scenarios on flat terrain. Used by tests only.

/** Hits 50 % at 0 m, 30 % at 100 m, 10 % at 300 m; fires out to 400 m. */
export const TEST_RIFLE: WeaponCombatProfile = {
  weaponProfileRef: 'rifle',
  hitProbabilityByRange: [
    { rangeM: 0, probability: 0.5 },
    { rangeM: 100, probability: 0.3 },
    { rangeM: 300, probability: 0.1 },
  ],
  maxEngagementRangeM: 400,
  incapacitationProbabilityOnHit: 0.5,
  secondsBetweenShots: 1,
};

/** Always hits and always incapacitates, out to 1 km. */
export const TEST_SURE: WeaponCombatProfile = {
  weaponProfileRef: 'sure',
  hitProbabilityByRange: [{ rangeM: 0, probability: 1 }],
  maxEngagementRangeM: 1000,
  incapacitationProbabilityOnHit: 1,
  secondsBetweenShots: 1,
};

/** Never hits, out to 1 km. */
export const TEST_BLANK: WeaponCombatProfile = {
  weaponProfileRef: 'blank',
  hitProbabilityByRange: [{ rangeM: 0, probability: 0 }],
  maxEngagementRangeM: 1000,
  incapacitationProbabilityOnHit: 0,
  secondsBetweenShots: 1,
};

/** Never hits, and reaches only 100 m. */
export const TEST_SHORT_BLANK: WeaponCombatProfile = {
  ...TEST_BLANK,
  weaponProfileRef: 'short-blank',
  maxEngagementRangeM: 100,
};

export const TEST_COMBAT_CONFIG: CombatConfig = {
  schema: 'ambush.combat-config',
  schemaVersion: 1,
  id: 'test-combat',
  version: '1.0.0',
  name: 'Test combat configuration',
  notes: ['Fixture for tests.'],
  weapons: [TEST_RIFLE, TEST_SURE, TEST_BLANK, TEST_SHORT_BLANK],
  postureHitMultipliers: { standing: 1, kneeling: 0.75, prone: 0.5 },
  opfor: {
    reactionProbabilities: { prone: 0.6, flee: 0.4 },
    reactionDelay: { minSeconds: 0.5, maxSeconds: 2 },
    returnFireDelaySeconds: 1,
    fleeSpeedMps: 4.5,
    fleeDistanceM: 600,
    escapeDistanceM: 300,
  },
  engagement: {
    maxDurationSeconds: 60,
    bluforFirstShotDelay: { minSeconds: 0, maxSeconds: 1 },
    targetRecheckSeconds: 0.5,
    targetSelection: { BLUEFOR: 'nearest', OPFOR: 'nearest' },
  },
};

/** `TEST_COMBAT_CONFIG` with some OPFOR and engagement settings replaced. */
export function testCombatConfig(changes: {
  opfor?: Partial<CombatConfig['opfor']>;
  engagement?: Partial<CombatConfig['engagement']>;
  weapons?: readonly WeaponCombatProfile[];
}): CombatConfig {
  return {
    ...TEST_COMBAT_CONFIG,
    weapons: changes.weapons ?? TEST_COMBAT_CONFIG.weapons,
    opfor: { ...TEST_COMBAT_CONFIG.opfor, ...changes.opfor },
    engagement: { ...TEST_COMBAT_CONFIG.engagement, ...changes.engagement },
  };
}

/** One soldier of a combat test scenario. */
export interface TestCombatant {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Weapon profile reference, or `null` for none. */
  readonly weapon: string | null;
  readonly azimuthDeg?: number;
}

/**
 * Two sides on flat terrain 2 km square (−1000 to 1000 m), soldiers in the
 * order given (BLUEFOR first unless `opforFirst`).
 */
export function combatScenario(options: {
  blufor: readonly TestCombatant[];
  opfor: readonly TestCombatant[];
  config?: CombatConfig;
  features?: EnvironmentFeatures;
  opforFirst?: boolean;
}): Scenario {
  const soldier = (side: 'BLUEFOR' | 'OPFOR') => (c: TestCombatant) => ({
    id: c.id,
    side,
    unitId: side === 'BLUEFOR' ? 'B' : 'O',
    position: { x: c.x, y: c.y },
    azimuthDeg: c.azimuthDeg ?? (side === 'BLUEFOR' ? 0 : 180),
    posture: 'standing' as const,
  });
  const blue = options.blufor.map(soldier('BLUEFOR'));
  const red = options.opfor.map(soldier('OPFOR'));
  return {
    id: 'combat-test',
    terrain: createSyntheticTerrain(
      { originX: -1000, originY: -1000, cellSize: 20, columns: 101, rows: 101 },
      flatElevation(0),
      options.features,
    ),
    movement: { speed: 1.5, maxTurnRate: Math.PI },
    units: [
      { id: 'B', echelon: 'squad', parentId: null, leaderId: null },
      { id: 'O', echelon: 'squad', parentId: null, leaderId: null },
    ],
    soldiers: options.opforFirst ? [...red, ...blue] : [...blue, ...red],
    combat: {
      config: options.config ?? TEST_COMBAT_CONFIG,
      weapons: Object.fromEntries(
        [...options.blufor, ...options.opfor].map((c) => [c.id, c.weapon]),
      ),
    },
  };
}
