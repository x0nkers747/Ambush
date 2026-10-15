import type * as THREE from 'three';
import { makeRifle, makeSawPlaceholder, type WeaponInstance, type WeaponKind } from './weapons';

// Which weapon model a soldier carries (docs/character-animation.md), from the
// weapon the simulation has it fire (`ViewFigures.weapons`, the primary
// weapon of its loadout). Display only: the simulation's weapon profiles
// decide every shot.

const KINDS: Readonly<Record<string, WeaponKind>> = {
  'm16-rifle': 'm16',
  'squad-automatic-weapon': 'm249',
  'ak-assault-rifle': 'ak',
};

/** The model for a simulation weapon profile; `null` for none or an unknown weapon. */
export function weaponKindOf(profileRef: string | null | undefined): WeaponKind | null {
  return profileRef ? (KINDS[profileRef] ?? null) : null;
}

export interface WeaponModels {
  readonly rifle: THREE.Object3D;
  readonly ak: THREE.Object3D;
}

/**
 * A weapon instance for a soldier. The M249 is a documented placeholder (no
 * openly licensed M249 model exists): a model built from boxes, held with the
 * rifle's handling.
 */
export function makeWeapon(kind: WeaponKind | null, models: WeaponModels): WeaponInstance | null {
  switch (kind) {
    case 'm16':
      return makeRifle(models.rifle, 'm16');
    case 'ak':
      return makeRifle(models.ak, 'ak');
    case 'm249':
      return makeSawPlaceholder();
    default:
      return null;
  }
}
