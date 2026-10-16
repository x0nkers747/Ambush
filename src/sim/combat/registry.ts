import type { SimWorld } from '../world';
import { COMBAT_WEAPONS, VEHICLE_PLATFORMS } from './catalog';
import {
  ARMOR_ZONES,
  CREW_ROLES,
  type AmmoSpec,
  type CombatWeaponSpec,
  type PlatformSpec,
} from './types';

// The platforms and weapons a battle uses (docs/combined-arms.md §15): the
// catalog's, and any a scenario adds or redefines (`Scenario.platforms`,
// `Scenario.combatWeapons`, carried in the world). Looked up by id; nothing in
// the combat code knows a vehicle by name.

export interface CombatCatalog {
  readonly platforms: ReadonlyMap<string, PlatformSpec>;
  readonly weapons: ReadonlyMap<string, CombatWeaponSpec>;
}

const builtIn: CombatCatalog = {
  platforms: new Map(VEHICLE_PLATFORMS.map((p) => [p.id, p])),
  weapons: new Map(COMBAT_WEAPONS.map((w) => [w.id, w])),
};

const catalogs = new WeakMap<SimWorld, CombatCatalog>();

/** The catalog of a world: the built-in one, with the scenario's own platforms and weapons over it. */
export function catalogOf(world: Pick<SimWorld, 'platforms' | 'combatWeapons'>): CombatCatalog {
  if (!world.platforms && !world.combatWeapons) return builtIn;
  const key = world as SimWorld;
  const known = catalogs.get(key);
  if (known) return known;
  const made: CombatCatalog = {
    platforms: new Map([
      ...builtIn.platforms,
      ...(world.platforms ?? []).map((p) => [p.id, p] as const),
    ]),
    weapons: new Map([
      ...builtIn.weapons,
      ...(world.combatWeapons ?? []).map((w) => [w.id, w] as const),
    ]),
  };
  catalogs.set(key, made);
  return made;
}

/** The built-in catalog (for the views and the planner, which have no world). */
export function builtInCatalog(): CombatCatalog {
  return builtIn;
}

/** A platform by id; throws for an unknown one (scenarios are validated when they load). */
export function platformOf(catalog: CombatCatalog, id: string): PlatformSpec {
  const p = catalog.platforms.get(id);
  if (!p) throw new Error(`unknown vehicle platform "${id}"`);
  return p;
}

export function combatWeaponOf(catalog: CombatCatalog, id: string): CombatWeaponSpec {
  const w = catalog.weapons.get(id);
  if (!w) throw new Error(`unknown combat weapon "${id}"`);
  return w;
}

/** A weapon's ammunition by id, or `undefined`. */
export function ammoOf(weapon: CombatWeaponSpec, id: string): AmmoSpec | undefined {
  return weapon.ammo.find((a) => a.id === id);
}

/**
 * Throws an Error naming the first problem of a platform: its mounts form a
 * tree, its weapons sit on mounts and fire ammunition their weapon takes,
 * its crew roles are known, its armour and numbers are sane.
 */
export function validatePlatform(p: PlatformSpec, catalog: CombatCatalog): void {
  const fail = (m: string): never => {
    throw new Error(`platform "${p.id}": ${m}`);
  };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id)) fail('its id must be lower-case letters, digits and -');
  const positive = (v: number, what: string) => {
    if (!(Number.isFinite(v) && v > 0)) fail(`${what} must be positive`);
  };
  positive(p.dimensions.lengthM, 'its length');
  positive(p.dimensions.widthM, 'its width');
  positive(p.dimensions.heightM, 'its height');
  const m = p.mobility;
  positive(m.roadSpeedMps, 'its road speed');
  positive(m.offRoadSpeedMps, 'its off-road speed');
  positive(m.woodsSpeedMps, 'its speed in woods');
  positive(m.accelMps2, 'its acceleration');
  positive(m.decelMps2, 'its braking');
  positive(m.turnRateDegS, 'its turn rate');
  if (m.kind === 'tracked' && !(m.pivotRateDegS > 0))
    fail('a tracked vehicle pivots: pivotRateDegS');
  if (m.kind === 'wheeled' && !(m.minTurnRadiusM > 0)) fail('a wheeled vehicle has a turn radius');
  for (const zone of ARMOR_ZONES) {
    if (!(p.armor.ke[zone] >= 0) || !(p.armor.ce[zone] >= 0)) fail(`its ${zone} armour`);
  }
  if (p.crew.length === 0) fail('it has no crew');
  for (const role of p.crew) if (!CREW_ROLES.includes(role)) fail(`unknown crew role "${role}"`);
  if (!(p.catastrophicVulnerability >= 0 && p.catastrophicVulnerability <= 1))
    fail('catastrophicVulnerability must be 0–1');
  const mounts = new Map(p.mounts.map((x) => [x.id, x]));
  if (mounts.size !== p.mounts.length) fail('a mount id is used twice');
  for (const mount of p.mounts) {
    // Its chain of parents reaches the hull without a cycle.
    const seen = new Set<string>();
    for (let at: string | null = mount.id; at !== null;) {
      if (seen.has(at)) fail(`mount "${mount.id}" is in a cycle of parents`);
      seen.add(at);
      const here = mounts.get(at);
      if (!here) fail(`mount "${mount.id}" has an unknown parent "${at}"`);
      at = here?.parent ?? null;
    }
    if (!p.crew.includes(mount.operator))
      fail(`mount "${mount.id}": no ${mount.operator} in the crew`);
    if (mount.elevation.minDeg > mount.elevation.maxDeg)
      fail(`mount "${mount.id}": elevation limits`);
    if (mount.traverse && (mount.traverse.leftDeg < 0 || mount.traverse.rightDeg < 0))
      fail(`mount "${mount.id}": traverse limits are degrees left and right (≥ 0)`);
    if (!(mount.movingAccuracyFactor >= 0 && mount.movingAccuracyFactor <= 1))
      fail(`mount "${mount.id}": movingAccuracyFactor must be 0–1`);
  }
  const slots = new Set<string>();
  for (const w of p.weapons) {
    if (slots.has(w.id)) fail(`weapon slot "${w.id}" is used twice`);
    slots.add(w.id);
    if (!mounts.has(w.mount)) fail(`weapon "${w.id}" is on an unknown mount "${w.mount}"`);
    const spec = catalog.weapons.get(w.weapon);
    if (!spec) return fail(`weapon "${w.id}": unknown weapon "${w.weapon}"`);
    if (w.loads.length === 0) fail(`weapon "${w.id}" has no ammunition`);
    for (const load of w.loads) {
      if (!ammoOf(spec, load.ammo))
        fail(`weapon "${w.id}": ${spec.label} does not fire "${load.ammo}"`);
      if (!(load.ready >= 0 && load.stowed >= 0 && Number.isInteger(load.ready + load.stowed)))
        fail(`weapon "${w.id}": rounds must be whole and not negative`);
    }
  }
}

/** Throws for a malformed weapon: its ammunition, rates and ranges. */
export function validateCombatWeapon(w: CombatWeaponSpec): void {
  const fail = (m: string): never => {
    throw new Error(`weapon "${w.id}": ${m}`);
  };
  if (w.ammo.length === 0) fail('it fires no ammunition');
  if (!(w.maxRangeM > w.minRangeM && w.minRangeM >= 0)) fail('its ranges');
  if (!(w.readyCapacity >= 1)) fail('it holds no round ready');
  if (w.roundsPerShot.min < 1 || w.roundsPerShot.max < w.roundsPerShot.min) fail('rounds per shot');
  if (w.hitVsVehicleByRange.length === 0) fail('it has no hit table');
  for (const a of w.ammo) {
    if (a.penetrationByRange.length === 0) fail(`ammunition "${a.id}" has no penetration`);
    if (!(a.lethality >= 0 && a.lethality <= 1)) fail(`ammunition "${a.id}": lethality 0–1`);
  }
}
