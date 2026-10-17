import {
  COMBAT_TUNING,
  COMBAT_WEAPONS,
  INFANTRY_ANTI_TANK,
  VEHICLE_PLATFORMS,
  type FofConfig,
  type Side,
  type VehicleKind,
} from '#sim';
import {
  FOF_DEFAULT_CONFIG,
  SQUAD_ORGANIZATIONS,
  secondaryWeaponCategory,
  weaponCategory,
  type SquadOrganization,
} from '../forces/forces';
import { DEFAULT_ANTI_TANK, type AntiTankLoadout } from './battle';

// A squad's or vehicle's range rings (docs/range-rings.md): how far it sees,
// how far its weapons are effective, and how far it fires at all. Detection
// and the furthest it fires are the simulation's own; the effective range is
// doctrine's, of its main weapon.

export interface RangeRings {
  /** The furthest it can see an enemy (m): open ground, a clear day; a vehicle's sights farther. */
  readonly detectionM: number;
  /** The maximum effective range of its main weapon (m): a rifle's, a vehicle's main armament's. */
  readonly effectiveM: number;
  /** The furthest any of its weapons fires (m), as the simulation allows. */
  readonly maxM: number;
}

/**
 * Doctrinal maximum effective ranges (m) of the vehicles' main weapons
 * (FM 3-20.12, FM 3-22.65 and open sources): against the targets each is
 * meant for, a point target where the manuals give both.
 */
const VEHICLE_EFFECTIVE_M: Readonly<Record<string, number>> = {
  m2hb: 1500,
  m240c: 900,
  pkt: 1000,
  m256: 3000,
  '2a46m': 2100,
  '2a42': 1500,
  '9p135m': 4000,
};

/** A squad's rings: its rifles' effective range, its longest-reaching weapon's. */
export function squadRangeRings(
  side: Side,
  organization: SquadOrganization,
  antiTank: AntiTankLoadout = DEFAULT_ANTI_TANK,
  config: FofConfig = FOF_DEFAULT_CONFIG,
): RangeRings {
  const template = SQUAD_ORGANIZATIONS[organization];
  const carried = new Set(
    template.slots.flatMap((slot) =>
      [weaponCategory(template, slot), secondaryWeaponCategory(template, slot)].filter(
        (c): c is string => c !== null,
      ),
    ),
  );
  const weapons = config.fire.weapons;
  const reach = (id: string) => weapons.find((w) => w.id === id)?.maxEngagementRangeM ?? 0;
  const arms = INFANTRY_ANTI_TANK[side];
  const antiTankIds =
    antiTank === 'none' ? [] : antiTank === 'rockets' ? [arms.rocket] : [arms.rocket, arms.missile];
  const maxM = Math.max(
    0,
    ...[...carried].map(reach),
    ...antiTankIds.map((id) => COMBAT_WEAPONS.find((w) => w.id === id)?.maxRangeM ?? 0),
  );
  return {
    detectionM: config.visibility.open.maxObservationRangeM,
    effectiveM: reach('rifle') || maxM,
    maxM,
  };
}

/** A vehicle's rings: its sights' reach, its main armament's effective range, its longest-reaching weapon's. */
export function vehicleRangeRings(
  kind: VehicleKind,
  config: FofConfig = FOF_DEFAULT_CONFIG,
): RangeRings {
  const platform = VEHICLE_PLATFORMS.find((p) => p.id === kind);
  const specs = (platform?.weapons ?? []).flatMap((w) => {
    const spec = COMBAT_WEAPONS.find((x) => x.id === w.weapon);
    return spec ? [spec] : [];
  });
  const maxM = Math.max(0, ...specs.map((s) => s.maxRangeM));
  // The main armament: its first gun or cannon (a tank's, an IFV's), else its first weapon.
  const main = specs.find((s) => s.kind === 'cannon' || s.kind === 'autocannon') ?? specs[0];
  return {
    detectionM: Math.min(
      COMBAT_TUNING.maxObservationM,
      config.visibility.open.maxObservationRangeM *
        Math.max(1, platform?.sensors.opticsFactor ?? 1),
    ),
    effectiveM: main ? Math.min(main.maxRangeM, VEHICLE_EFFECTIVE_M[main.id] ?? main.maxRangeM) : 0,
    maxM,
  };
}
