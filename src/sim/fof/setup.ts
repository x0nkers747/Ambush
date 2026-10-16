import type { ScenarioSoldier, ScenarioUnit } from '../scenario';
import type { SimState } from '../state';
import { fofWeapon, validateFofConfig, VISIBILITY_CLASSES } from './config';
import { ORDER_KINDS, type ActionsOn, type FofSetup, type KillZone, type OrderSpec } from './types';

/** The actions on contact a force can be given. */
export const ACTIONS_ON: readonly ActionsOn[] = ['continue', 'attack', 'hold', 'withdraw'];

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
  const termination: string = setup.termination ?? 'experiment';
  if (termination !== 'experiment' && termination !== 'manual') {
    fail(`unknown termination "${termination}"`);
  }
  if (termination === 'experiment') {
    // The lab's adjudicator decides between two opposed forces.
    if (setup.forces.length !== 2) fail('needs exactly two forces');
    const [a, b] = setup.forces;
    if (a?.side === b?.side) fail('the two forces must be of opposite sides');
  } else if (setup.forces.length === 0) {
    fail('needs at least one force');
  }
  const seen = new Set<string>();
  const forceIds = new Set<string>();
  for (const force of setup.forces) {
    if (forceIds.has(force.unitId)) fail(`force "${force.unitId}" is given twice`);
    forceIds.add(force.unitId);
    if (!units.some((u) => u.id === force.unitId)) fail(`unknown unit "${force.unitId}"`);
    const members = new Set(forceMembers(force.unitId, units, soldiers));
    if (members.size === 0) fail(`force "${force.unitId}" has no soldiers`);
    for (const id of members) {
      if (seen.has(id)) fail(`soldier "${id}" is in two forces`);
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
    for (const [id, weapon] of Object.entries(force.secondaryWeapons ?? {})) {
      if (!members.has(id)) fail(`force "${force.unitId}" arms "${id}", who is not a member`);
      if (weapon === null) continue;
      const w = fofWeapon(setup.config, weapon);
      if (!w) fail(`soldier "${id}" carries "${weapon}", which is not a configured weapon`);
      else if (w.area === null)
        fail(
          `soldier "${id}"'s secondary weapon "${weapon}" is not an area weapon (a grenade launcher)`,
        );
      if ((force.weapons[id] ?? null) === null)
        fail(`soldier "${id}" has a secondary weapon but no primary one`);
    }
    if (force.pace !== undefined && !(force.pace > 0))
      fail(`force "${force.unitId}" pace must be > 0`);
    if (force.actionsOn !== undefined && !ACTIONS_ON.includes(force.actionsOn)) {
      fail(`force "${force.unitId}" has unknown actions on contact "${force.actionsOn}"`);
    }
    (force.plan ?? []).forEach((order, k) => {
      const problem = orderSpecProblem(order);
      if (problem) fail(`force "${force.unitId}" order ${String(k + 1)}: ${problem}`);
    });
  }
}

/** What is wrong with an order as given (its own shape only), or `null`. */
export function orderSpecProblem(order: OrderSpec): string | null {
  const kind: string = order.kind;
  if (!(ORDER_KINDS as readonly string[]).includes(kind)) return `unknown order kind "${kind}"`;
  const d = order.destination;
  if (d === null) return `a ${order.kind} order needs a destination`;
  if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) return 'the destination must be finite';
  const actionsOn: string | undefined = order.actionsOn;
  if (actionsOn !== undefined && !(ACTIONS_ON as readonly string[]).includes(actionsOn))
    return `unknown actions on contact "${actionsOn}"`;
  const zone = order.killZone;
  if (order.kind !== 'ambush')
    return zone === undefined ? null : `a ${order.kind} order has no kill zone`;
  if (zone === undefined) return 'an ambush order needs a kill zone';
  return killZoneProblem(zone);
}

/** Kill zones are this many metres across and deep, at least and at most. */
export const KILL_ZONE_MIN_M = 5;
export const KILL_ZONE_MAX_M = 1000;

/** What is wrong with a kill zone, or `null`. */
export function killZoneProblem(zone: KillZone): string | null {
  if (
    !Number.isFinite(zone.centre.x) ||
    !Number.isFinite(zone.centre.y) ||
    !Number.isFinite(zone.facing)
  ) {
    return 'the kill zone must be finite';
  }
  for (const size of [zone.widthM, zone.depthM]) {
    if (!(size >= KILL_ZONE_MIN_M && size <= KILL_ZONE_MAX_M)) {
      return `the kill zone must be ${String(KILL_ZONE_MIN_M)}–${String(KILL_ZONE_MAX_M)} m across and deep`;
    }
  }
  return null;
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
