import type { Loadout } from './organization';

// Display profiles of weapons, for the planning map's engagement wedge only.
//
// Weapons are not modelled yet: organization templates name them by weapon
// profile reference (`Loadout.weaponProfileRefs`, docs/adr/0012) and nothing
// defines their performance, and there is no combat. These nominal effective
// ranges exist only so the map can show how far a Marine could engage. They
// are not used by the simulation, are not hit probabilities, and must not be
// taken as combat range limits: a weapon model, when there is one, should
// replace this table rather than sit beside it.
//
// The values are the nominal point-target effective ranges of the weapons the
// 1991 rifle squad carries (MCWP 3-11.2 para 1004a, the template's source).
// Area-target ranges are longer (M16A2 800 m, M249 800 m on its bipod, M203
// 350 m) and are not shown.

/**
 * What a weapon is to the soldier carrying it: a primary firearm (the one the
 * wedge shows), an auxiliary weapon fitted to or carried with it (the M203 on
 * a fire team leader's rifle), or a melee weapon.
 */
export type WeaponClass = 'primary' | 'auxiliary' | 'melee';

/** How a display range was chosen. */
export type DisplayRangeBasis = 'pointTarget';

export interface WeaponDisplayProfile {
  /** The weapon's name for display. */
  readonly name: string;
  readonly weaponClass: WeaponClass;
  /** Nominal effective range in metres; `null` for melee weapons. */
  readonly effectiveRangeM: number | null;
  readonly basis: DisplayRangeBasis | null;
}

/**
 * Every weapon profile reference the templates use, by reference (spelled
 * exactly as in the templates). A reference missing here is unknown: a wedge
 * is then not drawn rather than guessed.
 */
export const WEAPON_DISPLAY_PROFILES: Readonly<Record<string, WeaponDisplayProfile>> = {
  'm16-rifle': {
    name: 'M16A2 rifle',
    weaponClass: 'primary',
    effectiveRangeM: 550,
    basis: 'pointTarget',
  },
  'squad-automatic-weapon': {
    name: 'M249 SAW',
    weaponClass: 'primary',
    effectiveRangeM: 600,
    basis: 'pointTarget',
  },
  'm203-grenade-launcher': {
    name: 'M203 grenade launcher',
    weaponClass: 'auxiliary',
    effectiveRangeM: 150,
    basis: 'pointTarget',
  },
  'bayonet-knife': { name: 'Bayonet', weaponClass: 'melee', effectiveRangeM: null, basis: null },
  'combat-knife': {
    name: 'Combat knife',
    weaponClass: 'melee',
    effectiveRangeM: null,
    basis: null,
  },
};

/** The weapon an engagement wedge shows, or why there is none. */
export type PrimaryWeapon =
  | {
      readonly kind: 'weapon';
      readonly ref: string;
      readonly name: string;
      readonly effectiveRangeM: number;
    }
  /** The loadout names a weapon this table does not know: nothing is guessed in its place. */
  | { readonly kind: 'unknownWeapon'; readonly ref: string }
  /** No primary firearm: only melee or auxiliary weapons, or none. */
  | { readonly kind: 'noPrimaryWeapon' };

/**
 * The primary ranged weapon of a (resolved) loadout, for the engagement wedge.
 *
 * Templates do not mark a primary weapon, so it is the first weapon in the
 * loadout classed `primary` here. Auxiliary and melee weapons are never
 * chosen, wherever they are listed, and the longest range does not decide.
 * With several primary firearms, the loadout's order does. A loadout naming
 * an unknown weapon has no wedge: the unknown one might be the primary.
 */
export function primaryWeapon(loadout: Loadout): PrimaryWeapon {
  const unknown = loadout.weaponProfileRefs.find((ref) => !(ref in WEAPON_DISPLAY_PROFILES));
  if (unknown !== undefined) return { kind: 'unknownWeapon', ref: unknown };
  for (const ref of loadout.weaponProfileRefs) {
    const profile = WEAPON_DISPLAY_PROFILES[ref];
    if (profile?.weaponClass === 'primary' && profile.effectiveRangeM !== null) {
      return { kind: 'weapon', ref, name: profile.name, effectiveRangeM: profile.effectiveRangeM };
    }
  }
  return { kind: 'noPrimaryWeapon' };
}
