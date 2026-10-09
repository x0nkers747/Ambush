import type { Loadout } from './organization';

import { weaponCombatProfile, type CombatConfig } from '#sim';
import { DEFAULT_COMBAT_CONFIG } from './combat';

// Weapon identity, and which weapon a soldier fights with (docs/adr/0018,
// docs/adr/0019).
//
// Organization templates name weapons by weapon profile reference
// (`Loadout.weaponProfileRefs`, docs/adr/0012). This table gives each
// reference its name and class; the combat configuration
// (src/exercise/combat/combat-v1.json) gives its performance, including the
// maximum engagement range. `primaryWeapon` is the one rule for which weapon
// a soldier uses: the combat model fires it and the engagement wedge draws
// its maximum engagement range, so the two can never disagree.

/**
 * What a weapon is to the soldier carrying it: a primary firearm (the one the
 * wedge shows), an auxiliary weapon fitted to or carried with it (the M203 on
 * a fire team leader's rifle), or a melee weapon.
 */
export type WeaponClass = 'primary' | 'auxiliary' | 'melee';

export interface WeaponDisplayProfile {
  /** The weapon's name for display. */
  readonly name: string;
  readonly weaponClass: WeaponClass;
}

/**
 * Every weapon profile reference the templates and OPFOR forces use, by
 * reference (spelled exactly as in the templates). A reference missing here
 * is unknown: the soldier then neither fires nor shows a wedge, rather than
 * a weapon being guessed.
 */
export const WEAPON_DISPLAY_PROFILES: Readonly<Record<string, WeaponDisplayProfile>> = {
  'm16-rifle': { name: 'M16A2 rifle', weaponClass: 'primary' },
  'squad-automatic-weapon': { name: 'M249 SAW', weaponClass: 'primary' },
  'm203-grenade-launcher': { name: 'M203 grenade launcher', weaponClass: 'auxiliary' },
  'bayonet-knife': { name: 'Bayonet', weaponClass: 'melee' },
  'combat-knife': { name: 'Combat knife', weaponClass: 'melee' },
  // The OPFOR patrol's rifle (`OPFOR_FORCES`): a generic opposing-force weapon.
  'ak-assault-rifle': { name: 'AK-pattern assault rifle', weaponClass: 'primary' },
};

/** The weapon a soldier fights with (and its wedge shows), or why there is none. */
export type PrimaryWeapon =
  | {
      readonly kind: 'weapon';
      readonly ref: string;
      readonly name: string;
      /** The combat profile's maximum engagement range, in metres. */
      readonly maxEngagementRangeM: number;
    }
  /**
   * The loadout names a weapon this table does not know, or its primary
   * weapon has no combat profile: nothing is guessed in its place.
   */
  | { readonly kind: 'unknownWeapon'; readonly ref: string }
  /** No primary firearm: only melee or auxiliary weapons, or none. */
  | { readonly kind: 'noPrimaryWeapon' };

/**
 * The primary ranged weapon of a (resolved) loadout: the weapon the soldier
 * fires in combat, and the one his engagement wedge shows.
 *
 * Templates do not mark a primary weapon, so it is the first weapon in the
 * loadout classed `primary` here. Auxiliary and melee weapons are never
 * chosen, wherever they are listed, and the longest range does not decide.
 * With several primary firearms, the loadout's order does. A loadout naming
 * an unknown weapon has none: the unknown one might be the primary. Nor does
 * a primary weapon the combat configuration has no profile for.
 */
export function primaryWeapon(
  loadout: Loadout,
  combat: CombatConfig = DEFAULT_COMBAT_CONFIG,
): PrimaryWeapon {
  const unknown = loadout.weaponProfileRefs.find((ref) => !(ref in WEAPON_DISPLAY_PROFILES));
  if (unknown !== undefined) return { kind: 'unknownWeapon', ref: unknown };
  for (const ref of loadout.weaponProfileRefs) {
    const profile = WEAPON_DISPLAY_PROFILES[ref];
    if (profile?.weaponClass !== 'primary') continue;
    const performance = weaponCombatProfile(combat, ref);
    if (!performance) return { kind: 'unknownWeapon', ref };
    return {
      kind: 'weapon',
      ref,
      name: profile.name,
      maxEngagementRangeM: performance.maxEngagementRangeM,
    };
  }
  return { kind: 'noPrimaryWeapon' };
}
