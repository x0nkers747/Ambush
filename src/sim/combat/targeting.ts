import { areaIncapacitation } from '../fof/fire';
import { hitProbabilityAt } from '../fof/hit-probability';
import { penetrationAt, perforationChance, protectionOf } from './armor';
import type { Engagement } from './state';
import type {
  AmmoSpec,
  ArmorZone,
  CombatWeaponSpec,
  PlatformSpec,
  TargetClass,
  TargetingConfig,
} from './types';

// Target and weapon selection (docs/combined-arms.md §6). Every weapon is
// valued against every target by its effect, and the target by its threat,
// its value and the ammunition it costs: no weapon is tied to a target type
// by name. A rifle is never offered a tank because its effect on one is nil;
// an Abrams fires its coaxial gun at soldiers because a main-gun round is
// dearer for little more effect, and its main gun at a tank because nothing
// else on it has any effect there.

/** One round's (one shot's) chance to hit a vehicle at a range: 0 outside the weapon's ranges. */
export function hitVsVehicle(weapon: CombatWeaponSpec, rangeM: number): number {
  if (rangeM < weapon.minRangeM) return 0;
  return hitProbabilityAt(
    { hitProbabilityByRange: weapon.hitVsVehicleByRange, maxEngagementRangeM: weapon.maxRangeM },
    rangeM,
  );
}

/** How much harm a perforation by this ammunition does, for valuing it (a kill is not needed: a mission kill counts). */
function harmOf(ammo: AmmoSpec): number {
  return Math.min(1, 0.4 + ammo.lethality);
}

/** The chance one shot of `ammo` from `weapon` harms the vehicle meaningfully on its face `zone`. */
export function effectOnVehicle(
  weapon: CombatWeaponSpec,
  ammo: AmmoSpec,
  target: PlatformSpec,
  rangeM: number,
  zone: ArmorZone,
): number {
  if (rangeM > weapon.maxRangeM) return 0;
  const face: ArmorZone = ammo.topAttack === true ? 'top' : zone;
  const perforate = perforationChance(
    penetrationAt(ammo, rangeM),
    protectionOf(target, ammo, face),
  );
  // A burst of a machine gun: several rounds, each a chance (not independent: weighted).
  const rounds = (weapon.roundsPerShot.min + weapon.roundsPerShot.max) / 2;
  const effective = 1 + (rounds - 1) * 0.3;
  const hit = 1 - Math.pow(1 - hitVsVehicle(weapon, rangeM), effective);
  return hit * perforate * harmOf(ammo);
}

/** The chance one shot of `ammo` strikes down the soldier aimed at, standing in the open. */
export function effectOnSoldier(weapon: CombatWeaponSpec, ammo: AmmoSpec, rangeM: number): number {
  const vs = ammo.vsInfantry;
  if (!vs || rangeM > weapon.maxRangeM || rangeM < weapon.minRangeM) return 0;
  if (vs.area) {
    // Where it lands: on average two thirds of its dispersion off.
    const spread = vs.area.dispersionM.atZeroM + (rangeM / 100) * vs.area.dispersionM.per100M;
    return areaIncapacitation(vs.area, (2 / 3) * spread);
  }
  const p = hitProbabilityAt(
    { hitProbabilityByRange: vs.hitProbabilityByRange, maxEngagementRangeM: weapon.maxRangeM },
    rangeM,
  );
  const rounds = (weapon.roundsPerShot.min + weapon.roundsPerShot.max) / 2;
  const effective = 1 + (rounds - 1) * vs.burstRoundWeight;
  return (1 - Math.pow(1 - p, effective)) * vs.incapacitationProbabilityOnHit;
}

/** The effect of a weapon's ammunition on a target (a soldier: `null` platform). */
export function effectOn(
  weapon: CombatWeaponSpec,
  ammo: AmmoSpec,
  target: PlatformSpec | null,
  rangeM: number,
  zone: ArmorZone,
): number {
  return target
    ? effectOnVehicle(weapon, ammo, target, rangeM, zone)
    : effectOnSoldier(weapon, ammo, rangeM);
}

/** The best of the ammunition `available` (ids, in preference order) against a target: the first of equals. */
export function bestAmmo(
  weapon: CombatWeaponSpec,
  available: readonly string[],
  target: PlatformSpec | null,
  rangeM: number,
  zone: ArmorZone,
): { ammo: AmmoSpec; effect: number } | null {
  let best: { ammo: AmmoSpec; effect: number } | null = null;
  for (const id of available) {
    const ammo = weapon.ammo.find((a) => a.id === id);
    if (!ammo) continue;
    const effect = effectOn(weapon, ammo, target, rangeM, zone);
    if (!best || effect > best.effect + 1e-12) best = { ammo, effect };
  }
  return best;
}

export type Suitability = 'ineffective' | 'suitable' | 'preferred';

/** A weapon is ineffective against a target below the minimum effect; else suitable. */
export function suitabilityOf(
  effect: number,
  config: TargetingConfig,
): Exclude<Suitability, 'preferred'> {
  return effect >= config.minimumEffect ? 'suitable' : 'ineffective';
}

/** A candidate engagement: a target, and a weapon and ammunition against it. */
export interface EngagementOption {
  readonly targetId: string;
  readonly target: 'soldier' | 'vehicle';
  readonly targetClass: TargetClass;
  readonly weapon: string;
  readonly ammo: string;
  readonly rangeM: number;
  readonly effect: number;
  readonly threat: number;
  readonly cost: number;
  /** effect × (threat + value) / cost. */
  readonly utility: number;
  /** Seconds until the weapon could fire (laying, reloading). */
  readonly delaySeconds: number;
}

/** The utility of an engagement: its effect on what it is worth, over its cost, and less for a long wait. */
export function utilityOf(
  effect: number,
  threat: number,
  targetClass: TargetClass,
  cost: number,
  delaySeconds: number,
  config: TargetingConfig,
): number {
  return (
    (effect * (threat + config.classValue[targetClass])) /
    Math.max(cost, 1e-6) /
    (1 + delaySeconds / 4)
  );
}

/**
 * The engagement to take among `options` (the suitable ones; ineffective ones
 * are never offered), committed to `current`: kept until its reassessment
 * time unless its target is no longer offered; then a different target is
 * taken only for `switchFactor` × the utility. Ties go to the first offered.
 */
export function chooseEngagement(
  current: Engagement | undefined,
  options: readonly EngagementOption[],
  t: number,
  config: TargetingConfig,
): EngagementOption | null {
  let best: EngagementOption | null = null;
  for (const o of options) if (!best || o.utility > best.utility + 1e-12) best = o;
  if (!best) return null;
  if (!current) return best;
  // The best way to keep engaging the current target.
  let same: EngagementOption | null = null;
  for (const o of options) {
    if (o.targetId !== current.targetId) continue;
    if (!same || o.utility > same.utility + 1e-12) same = o;
  }
  if (!same) return best;
  // Its weapon too: kept (a coaxial gun reloading its belt) unless another is markedly better.
  const kept = options.find((o) => o.targetId === current.targetId && o.weapon === current.weapon);
  if (kept && same !== kept && same.utility <= kept.utility * config.switchFactor) same = kept;
  if (t < current.reassessAt - 1e-9) return same;
  return best.targetId !== same.targetId && best.utility > same.utility * config.switchFactor
    ? best
    : same;
}
