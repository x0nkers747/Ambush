import type { Loadout } from './organization';

// Display ranges for weapons, for the planning map's engagement wedge only.
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

/** How a display range was chosen. */
export type DisplayRangeBasis = 'pointTarget';

export interface WeaponDisplayRange {
  /** The weapon's name for display. */
  readonly name: string;
  /** Nominal effective range in metres. */
  readonly effectiveRangeM: number;
  readonly basis: DisplayRangeBasis;
}

/**
 * Display ranges by weapon profile reference. References not listed here
 * (knives and bayonets, or weapons a template may name later) have no range
 * and draw no wedge.
 */
export const WEAPON_DISPLAY_RANGES: Readonly<Record<string, WeaponDisplayRange>> = {
  'm16-rifle': { name: 'M16A2 rifle', effectiveRangeM: 550, basis: 'pointTarget' },
  'squad-automatic-weapon': { name: 'M249 SAW', effectiveRangeM: 600, basis: 'pointTarget' },
  'm203-grenade-launcher': {
    name: 'M203 grenade launcher',
    effectiveRangeM: 150,
    basis: 'pointTarget',
  },
};

/**
 * The weapon a soldier's engagement wedge shows: the first weapon in the
 * loadout that has a display range (loadouts list the primary weapon first:
 * a fire team leader's rifle before its grenade launcher), or `null`.
 */
export function engagementWeapon(
  loadout: Loadout,
): (WeaponDisplayRange & { readonly ref: string }) | null {
  for (const ref of loadout.weaponProfileRefs) {
    const range = WEAPON_DISPLAY_RANGES[ref];
    if (range) return { ref, ...range };
  }
  return null;
}
