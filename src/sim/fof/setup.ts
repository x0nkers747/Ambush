import type { ScenarioSoldier, ScenarioUnit } from '../scenario';
import type { SimState } from '../state';
import { fofWeapon, validateFofConfig, VISIBILITY_CLASSES } from './config';
import type { FofSetup } from './types';

/** Throws an Error naming the first problem of a force-on-force setup for these units and soldiers. */
export function validateFofSetup(
  setup: FofSetup,
  units: readonly ScenarioUnit[],
  soldiers: readonly ScenarioSoldier[],
): void {
  const fail = (message: string): never => {
    throw new Error(`force-on-force setup: ${message}`);
  };
  validateFofConfig(setup.config);
  if (!VISIBILITY_CLASSES.includes(setup.visibility)) {
    fail(`unknown visibility class "${setup.visibility}"`);
  }
  if (setup.forces.length !== 2) fail('needs exactly two forces');
  const [a, b] = setup.forces;
  if (a?.side === b?.side) fail('the two forces must be of opposite sides');
  const seen = new Set<string>();
  for (const force of setup.forces) {
    if (!units.some((u) => u.id === force.unitId)) fail(`unknown unit "${force.unitId}"`);
    const members = new Set(forceMembers(force.unitId, units, soldiers));
    if (members.size === 0) fail(`force "${force.unitId}" has no soldiers`);
    for (const id of members) {
      if (seen.has(id)) fail(`soldier "${id}" is in both forces`);
      seen.add(id);
      const soldier = soldiers.find((s) => s.id === id);
      if (soldier?.side !== force.side) fail(`soldier "${id}" is not of side ${force.side}`);
    }
    for (const [id, weapon] of Object.entries(force.weapons)) {
      if (!members.has(id)) fail(`force "${force.unitId}" arms "${id}", who is not a member`);
      if (weapon !== null && !fofWeapon(setup.config, weapon)) {
        fail(`soldier "${id}" fires "${weapon}", which is not a configured weapon`);
      }
    }
    if (force.pace !== undefined && !(force.pace > 0))
      fail(`force "${force.unitId}" pace must be > 0`);
  }
}

/** The soldier ids of a unit and the units below it, in soldier order. */
export function forceMembers(
  unitId: string,
  units: readonly { readonly id: string; readonly parentId: string | null }[],
  soldiers: readonly { readonly id: string; readonly unitId: string }[],
): string[] {
  const inUnit = new Set<string>([unitId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const u of units) {
      if (u.parentId !== null && inUnit.has(u.parentId) && !inUnit.has(u.id)) {
        inUnit.add(u.id);
        grew = true;
      }
    }
  }
  return soldiers.filter((s) => inUnit.has(s.unitId)).map((s) => s.id);
}

/**
 * Whether `unitId` belongs to a force-on-force force that its contact
 * behaviour is driving (halted in contact or withdrawing): outside unit
 * orders to it are rejected. Always `false` without a force-on-force state.
 */
export function unitInContact(state: SimState, unitId: string): boolean {
  const fof = state.fof;
  if (!fof) return false;
  // The unit's root.
  let id: string | null = unitId;
  let root = unitId;
  while (id !== null) {
    root = id;
    const parent: string | null = state.units.find((u) => u.id === id)?.parentId ?? null;
    id = parent;
  }
  const force = fof.forces.find((f) => f.unitId === root);
  return force !== undefined && force.phase !== 'moving' && force.phase !== 'atObjective';
}
