import { normalizeAzimuth } from '../geometry';
import { nextFloat, type RngState } from '../rng';
import type { CrewMemberState, CrewState, VehicleCombat } from './state';
import type { AmmoSpec, ArmorZone, PlatformSpec } from './types';

// Armour and damage (docs/combined-arms.md §8): which face a round strikes,
// whether it perforates, and what it does behind the armour. Pure functions
// of their arguments and the random numbers they are given, in a fixed order.

const DEG = Math.PI / 180;

/** The round's penetration (RHA mm) at a range: linear between its points, the last held beyond. */
export function penetrationAt(ammo: AmmoSpec, rangeM: number): number {
  const table = ammo.penetrationByRange;
  const first = table[0];
  if (!first) return 0;
  if (rangeM <= first.rangeM) return first.mm;
  for (let i = 1; i < table.length; i += 1) {
    const a = table[i - 1];
    const b = table[i];
    if (!a || !b) continue;
    if (rangeM <= b.rangeM)
      return a.mm + ((rangeM - a.rangeM) / (b.rangeM - a.rangeM)) * (b.mm - a.mm);
  }
  return table[table.length - 1]?.mm ?? first.mm;
}

/**
 * The face of a hull an attack from `bearing` (the azimuth from the target
 * to the attacker) presents: front within 45° of the hull's heading, rear
 * within 45° of its back, side otherwise. Top for a top-attack round.
 */
export function presentedZone(heading: number, bearing: number, topAttack: boolean): ArmorZone {
  if (topAttack) return 'top';
  let off = normalizeAzimuth(bearing - heading);
  if (off > Math.PI) off -= 2 * Math.PI;
  const a = Math.abs(off);
  return a <= 45 * DEG ? 'front' : a >= 135 * DEG ? 'rear' : 'side';
}

/** How far a hit lands from the aim on the hull's outline, as an angle (±): it may strike the face beside. */
const ZONE_SCATTER_RAD = 15 * DEG;

/** The face a hit strikes: the presented one, scattered by one draw across a boundary near it. */
export function hitZone(
  rng: RngState,
  heading: number,
  bearing: number,
  topAttack: boolean,
): ArmorZone {
  const scatter = (nextFloat(rng) * 2 - 1) * ZONE_SCATTER_RAD;
  return presentedZone(heading, bearing + scatter, topAttack);
}

/**
 * The chance a round of `penetrationMm` perforates `protectionMm`: a logistic
 * of their difference over a spread of 10 % of the protection (and at least
 * 3 mm): even odds when they are equal, near certain well above.
 */
export function perforationChance(penetrationMm: number, protectionMm: number): number {
  if (protectionMm <= 0) return 1;
  const spread = Math.max(3, 0.1 * protectionMm);
  return 1 / (1 + Math.exp(-(penetrationMm - protectionMm) / spread));
}

/** The protection a face gives against a round. */
export function protectionOf(platform: PlatformSpec, ammo: AmmoSpec, zone: ArmorZone): number {
  return platform.armor[ammo.energy][zone];
}

/** What one hit did. Effects are not exclusive. */
export interface HitResult {
  readonly zone: ArmorZone;
  readonly penetrationMm: number;
  readonly protectionMm: number;
  readonly perforated: boolean;
  readonly catastrophic: boolean;
  readonly mobility: boolean;
  /** Weapon slots put out of action (and their mount, when a mount is hit). */
  readonly firepower: readonly string[];
  readonly mountsDisabled: readonly string[];
  /** The share of its sight lost (0: none). */
  readonly sensorsLost: number;
  readonly crew: readonly { readonly role: string; readonly to: CrewState }[];
}

/**
 * Resolves a hit on a vehicle: the face (one draw), perforation (one), and
 * behind the armour, independent draws in a fixed order: catastrophic,
 * mobility, firepower, sensors, and each crew member. A hit that does not
 * perforate may still damage sights or running gear (`nonPenetratingDamage`).
 * Does not change the vehicle: `applyHit` does.
 */
export function resolveHit(
  rng: RngState,
  platform: PlatformSpec,
  combat: VehicleCombat,
  ammo: AmmoSpec,
  rangeM: number,
  heading: number,
  bearing: number,
): HitResult {
  const zone = hitZone(rng, heading, bearing, ammo.topAttack === true);
  const penetrationMm = penetrationAt(ammo, rangeM);
  const protectionMm = protectionOf(platform, ammo, zone);
  const perforated = nextFloat(rng) < perforationChance(penetrationMm, protectionMm);
  const base = { zone, penetrationMm, protectionMm, perforated };
  if (!perforated) {
    // Outside damage: sights, a track, a road wheel.
    const damaged = nextFloat(rng) < ammo.nonPenetratingDamage;
    const which = nextFloat(rng);
    return {
      ...base,
      catastrophic: false,
      mobility: damaged && which < 0.4,
      firepower: [],
      mountsDisabled: [],
      sensorsLost: damaged && which >= 0.4 ? 0.35 : 0,
      crew: [],
    };
  }
  const lethality = ammo.lethality;
  // A perforation through the thinner faces carries more behind it (residual penetration).
  const residual = Math.min(
    1,
    Math.max(0, (penetrationMm - protectionMm) / Math.max(protectionMm, 20)),
  );
  const severity = Math.min(1, lethality * (0.75 + 0.5 * residual));
  const catastrophic = nextFloat(rng) < severity * platform.catastrophicVulnerability;
  const mobility =
    nextFloat(rng) < (zone === 'rear' ? 0.55 : zone === 'side' ? 0.35 : 0.2) * (0.5 + severity);
  // Firepower: one of its working weapons, or the mount it is on.
  const working = platform.weapons.filter(
    (w) => !combat.weapons.find((s) => s.id === w.id)?.disabled,
  );
  const firepowerHit = nextFloat(rng) < 0.3 * (0.5 + severity);
  const pick = nextFloat(rng);
  const mountHit = nextFloat(rng) < 0.35;
  let firepower: string[] = [];
  let mountsDisabled: string[] = [];
  const chosen = working[Math.min(working.length - 1, Math.floor(pick * working.length))];
  if (firepowerHit && chosen) {
    if (mountHit) {
      mountsDisabled = [chosen.mount];
      firepower = platform.weapons.filter((w) => w.mount === chosen.mount).map((w) => w.id);
    } else firepower = [chosen.id];
  }
  const sensorsLost = nextFloat(rng) < 0.25 * (0.5 + severity) ? 0.5 : 0;
  // Each crew member: struck down, shaken (degraded), or untouched.
  const crew: { role: string; to: CrewState }[] = [];
  for (const member of combat.crew) {
    const u = nextFloat(rng);
    if (member.state === 'incapacitated') continue;
    if (catastrophic || u < 0.4 * severity) crew.push({ role: member.role, to: 'incapacitated' });
    else if (u < 0.8 * severity && member.state === 'operational')
      crew.push({ role: member.role, to: 'degraded' });
  }
  return { ...base, catastrophic, mobility, firepower, mountsDisabled, sensorsLost, crew };
}

/** Applies a hit's damage to a vehicle at time `t`: persistent, never repaired. */
export function applyHit(
  combat: VehicleCombat,
  hit: HitResult,
  t: number,
  burnSeconds: number,
): void {
  combat.damage.hits += 1;
  if (hit.perforated) combat.damage.perforations += 1;
  if (hit.mobility || hit.catastrophic) combat.damage.mobility = true;
  for (const id of hit.firepower) {
    const w = combat.weapons.find((x) => x.id === id);
    if (w) w.disabled = true;
  }
  for (const id of hit.mountsDisabled) {
    const m = combat.mounts.find((x) => x.id === id);
    if (m) m.disabled = true;
  }
  if (hit.sensorsLost > 0) combat.damage.sensors *= 1 - hit.sensorsLost;
  for (const change of hit.crew) {
    const member = combat.crew.find((c: CrewMemberState) => c.role === change.role);
    if (member && member.state !== 'incapacitated') member.state = change.to;
  }
  if (hit.catastrophic) {
    combat.damage.destroyed = true;
    combat.damage.burningUntil = t + burnSeconds;
    for (const w of combat.weapons) w.disabled = true;
    for (const m of combat.mounts) m.disabled = true;
    for (const c of combat.crew) c.state = 'incapacitated';
    combat.engagements = [];
  }
}

/** A vehicle's state as its crew would report it. */
export type VehicleCondition = 'operational' | 'damaged' | 'missionKill' | 'destroyed';

/**
 * Its condition: `destroyed` (a catastrophic kill); a `missionKill` when it
 * can neither fight nor move, or its crew is gone; `damaged` with any
 * lasting damage; else `operational`.
 */
export function conditionOf(combat: VehicleCombat): VehicleCondition {
  if (combat.damage.destroyed) return 'destroyed';
  const crewGone = combat.crew.every((c) => c.state === 'incapacitated');
  const canFight = combat.weapons.some((w) => !w.disabled);
  if (crewGone || (!canFight && combat.damage.mobility)) return 'missionKill';
  const damaged =
    combat.damage.mobility ||
    combat.damage.sensors < 1 ||
    combat.weapons.some((w) => w.disabled) ||
    combat.mounts.some((m) => m.disabled) ||
    combat.crew.some((c) => c.state !== 'operational');
  return damaged ? 'damaged' : 'operational';
}
