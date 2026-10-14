import { surfaceHeightAt } from './bridge-navigation';
import { validateCombatConfig, weaponCombatProfile } from './combat-config';
import { azimuthFromDegrees, type Vec2 } from './geometry';
import { pointProblem } from './navigation';
import { clonePlainData } from './plain-data';
import { createRngState } from './rng';
import { deepFreeze, shareTerrain } from './shared-terrain';
import {
  orgUnitId,
  soldierId,
  type Echelon,
  type OrgUnit,
  type Posture,
  type Side,
  type SimState,
  type Soldier,
} from './state';
import { isOnTerrain, validateTerrain, type TerrainDataset } from './terrain';
import { validateBehaviorParams, type BehaviorParams } from './behavior/params';
import {
  validateMovementParams,
  type CombatSetup,
  type MovementParams,
  type SimWorld,
} from './world';

// Scenario: the human-authored, plain-data description of a simulation's
// starting point. Ids are plain strings and angles are in degrees
// (docs/adr/0002); `createInitialState` validates and converts them once.

export interface ScenarioUnit {
  readonly id: string;
  readonly echelon: Echelon;
  readonly parentId: string | null;
  readonly leaderId: string | null;
}

export interface ScenarioSoldier {
  readonly id: string;
  readonly side: Side;
  readonly unitId: string;
  /** Map position; elevation comes from the terrain. */
  readonly position: Readonly<Vec2>;
  /** Degrees clockwise from grid north. */
  readonly azimuthDeg: number;
  readonly posture: Posture;
}

export interface Scenario {
  readonly id: string;
  readonly terrain: TerrainDataset;
  readonly movement: MovementParams;
  readonly units: readonly ScenarioUnit[];
  readonly soldiers: readonly ScenarioSoldier[];
  /** The combat model, for scenarios that can fight (docs/adr/0019). */
  readonly combat?: CombatSetup;
  /** Unit-movement tuning (docs/behavior-lab/03); absent: the defaults. */
  readonly behavior?: BehaviorParams;
}

/** Builds the tick-0 simulation state. Throws an Error describing the first invalid entry. */
export function createInitialState(scenario: Scenario, seed: number): SimState {
  const fail = (message: string): never => {
    throw new Error(`Scenario "${scenario.id}": ${message}`);
  };
  const { terrain } = scenario;
  try {
    validateTerrain(terrain);
    validateMovementParams(scenario.movement);
    if (scenario.behavior) validateBehaviorParams(scenario.behavior);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const unitsById = new Map<string, ScenarioUnit>();
  for (const unit of scenario.units) {
    if (unitsById.has(unit.id)) fail(`duplicate unit id "${unit.id}"`);
    if (typeof unit.echelon !== 'string' || unit.echelon === '') {
      fail(`unit "${unit.id}" has no echelon label`);
    }
    unitsById.set(unit.id, unit);
  }

  // Ancestor chain of every unit, starting with the unit itself and ending at its root.
  const chains = new Map<string, string[]>();
  for (const unit of scenario.units) {
    const chain = [unit.id];
    for (let parentId = unit.parentId; parentId !== null;) {
      const parent =
        unitsById.get(parentId) ?? fail(`unit "${unit.id}" has unknown parent "${parentId}"`);
      if (chain.includes(parent.id)) fail(`unit "${unit.id}" is part of a parent cycle`);
      chain.push(parent.id);
      parentId = parent.parentId;
    }
    chains.set(unit.id, chain);
  }

  const soldiersById = new Map<string, ScenarioSoldier>();
  const sideByRoot = new Map<string, Side>();
  for (const soldier of scenario.soldiers) {
    if (soldiersById.has(soldier.id)) fail(`duplicate soldier id "${soldier.id}"`);
    soldiersById.set(soldier.id, soldier);

    const chain =
      chains.get(soldier.unitId) ??
      fail(`soldier "${soldier.id}" has unknown unit "${soldier.unitId}"`);
    const root = chain[chain.length - 1] ?? soldier.unitId;
    const rootSide = sideByRoot.get(root) ?? soldier.side;
    if (rootSide !== soldier.side) fail(`organization "${root}" mixes BLUEFOR and OPFOR soldiers`);
    sideByRoot.set(root, rootSide);

    const { x, y } = soldier.position;
    if (![x, y, soldier.azimuthDeg].every(Number.isFinite)) {
      fail(`soldier "${soldier.id}" has a non-finite position or azimuth`);
    }
    if (!isOnTerrain(terrain, x, y)) fail(`soldier "${soldier.id}" is off the terrain`);
    const blocked = pointProblem(terrain, { x, y });
    if (blocked?.kind === 'inWater') {
      fail(`soldier "${soldier.id}" stands in water "${blocked.waterId}"`);
    } else if (blocked && blocked.kind !== 'offTerrain') {
      fail(`soldier "${soldier.id}" stands in or against building "${blocked.buildingId}"`);
    }
  }

  if (scenario.combat) {
    try {
      validateCombatConfig(scenario.combat.config);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    for (const [id, ref] of Object.entries(scenario.combat.weapons)) {
      if (!soldiersById.has(id)) fail(`combat weapon assigned to unknown soldier "${id}"`);
      if (ref !== null && !weaponCombatProfile(scenario.combat.config, ref)) {
        fail(`soldier "${id}" fires "${ref}", which has no combat profile`);
      }
    }
  }

  for (const unit of scenario.units) {
    if (unit.leaderId === null) continue;
    const leader =
      soldiersById.get(unit.leaderId) ??
      fail(`unit "${unit.id}" has unknown leader "${unit.leaderId}"`);
    if (!chains.get(leader.unitId)?.includes(unit.id)) {
      fail(`leader "${leader.id}" of unit "${unit.id}" is not a member of it`);
    }
  }

  const units: OrgUnit[] = scenario.units.map((unit) => ({
    id: orgUnitId(unit.id),
    echelon: unit.echelon,
    parentId: unit.parentId === null ? null : orgUnitId(unit.parentId),
    leaderId: unit.leaderId === null ? null : soldierId(unit.leaderId),
  }));

  const soldiers: Soldier[] = scenario.soldiers.map((soldier) => ({
    id: soldierId(soldier.id),
    side: soldier.side,
    unitId: orgUnitId(soldier.unitId),
    position: {
      x: soldier.position.x,
      y: soldier.position.y,
      z: surfaceHeightAt(terrain, soldier.position.x, soldier.position.y),
    },
    azimuth: azimuthFromDegrees(soldier.azimuthDeg),
    posture: soldier.posture,
    status: 'active',
    orders: null,
  }));

  return { tick: 0, rng: createRngState(seed), units, soldiers, engagementAreas: [] };
}

/**
 * Builds the immutable reference data for a simulation from a scenario
 * already validated by `createInitialState`: deep-frozen copies, so later
 * changes to the scenario object cannot affect a running simulation. The
 * terrain is shared (`shareTerrain`): a terrain that is already shared is
 * used as it is, so simulations on the same battlefield share one terrain.
 */
export function createWorld(scenario: Scenario): SimWorld {
  const world = {
    terrain: shareTerrain(scenario.terrain),
    movement: deepFreeze(clonePlainData(scenario.movement)),
  };
  // Without combat the world has no `combat` property at all, so its
  // fingerprint is what it was before combat existed.
  // Likewise unit-movement parameters (docs/behavior-lab/03): absent unless
  // the scenario overrides the defaults.
  return Object.freeze({
    ...world,
    ...(scenario.combat ? { combat: deepFreeze(clonePlainData(scenario.combat)) } : {}),
    ...(scenario.behavior ? { behavior: deepFreeze(clonePlainData(scenario.behavior)) } : {}),
  });
}
