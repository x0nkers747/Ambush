import type { AreaEffect } from '../fof/config';
import type { RangeProbability } from '../fof/hit-probability';

// Combined arms (docs/combined-arms.md): the data of platforms, mounts,
// weapons and ammunition. Plain, readonly data: definitions are looked up by
// id (`catalog.ts`, and a scenario's own `platforms`), and nothing in the
// combat code knows a vehicle by name.

/** What a target is, for weapon effects and priorities. */
export type TargetClass = 'infantry' | 'unarmored' | 'lightArmor' | 'heavyArmor';
export const TARGET_CLASSES: readonly TargetClass[] = [
  'infantry',
  'unarmored',
  'lightArmor',
  'heavyArmor',
];

/** A face of a vehicle's armour. */
export type ArmorZone = 'front' | 'side' | 'rear' | 'top';
export const ARMOR_ZONES: readonly ArmorZone[] = ['front', 'side', 'rear', 'top'];

/** How a round defeats armour: kinetic energy, or a shaped charge (chemical energy). */
export type Energy = 'ke' | 'ce';

export type CrewRole = 'driver' | 'gunner' | 'commander' | 'loader';
export const CREW_ROLES: readonly CrewRole[] = ['driver', 'gunner', 'commander', 'loader'];

/** A protection value per zone (RHA-equivalent millimetres). */
export type ZoneValues = Readonly<Record<ArmorZone, number>>;

export interface ArmorSpec {
  /** Protection against kinetic-energy attack (APFSDS, AP, ball). */
  readonly ke: ZoneValues;
  /** Protection against chemical-energy attack (HEAT, shaped charges). */
  readonly ce: ZoneValues;
}

export type MobilityKind = 'tracked' | 'wheeled';

export interface MobilitySpec {
  readonly kind: MobilityKind;
  /** Top speeds (m/s): on paved roads, on tracks and open ground, in woods. */
  readonly roadSpeedMps: number;
  readonly offRoadSpeedMps: number;
  readonly woodsSpeedMps: number;
  /** Accelerating and braking (m/s²). */
  readonly accelMps2: number;
  readonly decelMps2: number;
  /** The fastest it turns at speed (deg/s), and the most sideways acceleration (m/s²). */
  readonly turnRateDegS: number;
  readonly lateralAccelMps2: number;
  /** Tracked: turning on the spot (deg/s). Wheeled: 0 (it cannot), and `minTurnRadiusM` instead. */
  readonly pivotRateDegS: number;
  readonly minTurnRadiusM: number;
  /** Speed lost per unit of grade uphill (0.25 grade × 2.5 → 62 % lost), and the most it loses. */
  readonly climbLoss: number;
  readonly maxClimbLoss: number;
}

export interface SensorSpec {
  /** Magnification of its sights over the naked eye (multiplies the cycles on target). */
  readonly opticsFactor: number;
  /** Thermal sights: vegetation and haze hide less, a firing or moving target shows more. */
  readonly thermal: boolean;
  /** The observer's eye above the ground (m): the commander's, head out or at his sight. */
  readonly eyeHeightM: number;
  /** Half the field of regard it searches (deg; 180: all round). */
  readonly regardHalfAngleDeg: number;
}

/** A point on a platform (m): forward of the hull's centre, to its right, above the ground. */
export interface PlatformPoint {
  readonly forward: number;
  readonly right: number;
  readonly up: number;
}

export type MountKind = 'turret' | 'cupola' | 'pintle' | 'rws' | 'hull' | 'launcher';

export interface MountSpec {
  readonly id: string;
  readonly kind: MountKind;
  /** The mount it turns with (a launcher on a turret), or `null`: the hull. */
  readonly parent: string | null;
  /** Its pivot: on the hull (no parent), or relative to its parent's pivot. */
  readonly pivot: PlatformPoint;
  /** Traverse limits left and right of its parent's forward (deg); `null`: all round. */
  readonly traverse: { readonly leftDeg: number; readonly rightDeg: number } | null;
  readonly traverseRateDegS: number;
  readonly elevation: { readonly minDeg: number; readonly maxDeg: number };
  readonly elevationRateDegS: number;
  /** Its weapons fire on the move (stabilized), at this share of their accuracy at a halt; unstabilized, a small share. */
  readonly stabilized: boolean;
  readonly movingAccuracyFactor: number;
  /** Who lays and fires it, and who may take over. */
  readonly operator: CrewRole;
  readonly alternate?: CrewRole;
}

/** Ammunition a weapon is loaded with, ready to fire and stowed (rounds). */
export interface AmmoLoad {
  readonly ammo: string;
  readonly ready: number;
  readonly stowed: number;
}

export interface MountedWeaponSpec {
  /** Its slot on the platform (`main`, `coax`, `atgm`…). */
  readonly id: string;
  /** The weapon (`CombatWeaponSpec.id`). */
  readonly weapon: string;
  readonly mount: string;
  /** Its muzzle relative to the mount's pivot (m), for effects. */
  readonly muzzle: PlatformPoint;
  /** Its ammunition, in order of preference when equal. */
  readonly loads: readonly AmmoLoad[];
  /** Reloading needs this crew role (a loader); without it, `reloadWithoutFactor` × slower. */
  readonly loader?: CrewRole;
  readonly reloadWithoutFactor?: number;
}

/** Procedural model parameters (`src/view3d/vehicle-models.ts`): what each platform looks like. */
export interface VisualSpec {
  /** The hull: its builder, and its colours. */
  readonly hull: 'm113' | 'abrams' | 'bmp2' | 't72' | 'box';
  readonly turret: 'none' | 'abrams' | 'bmp2' | 't72' | 'box';
  readonly color: number;
  readonly darkColor: number;
  /** Running gear: road wheels a side, their radius and spacing (m), sprocket front or rear. */
  readonly roadWheels: number;
  readonly wheelRadiusM: number;
  readonly wheelSpacingM: number;
  readonly sprocket: 'front' | 'rear';
  /** Return rollers a side (0: none). */
  readonly returnRollers: number;
  /** Track (or tyre) width (m). */
  readonly trackWidthM: number;
}

export interface PlatformSpec {
  /** Stable id: what scenarios name (`m113`, `m1a1`, `bmp2`, `t72b`). */
  readonly id: string;
  readonly name: string;
  /** The representative real variant (documented assumptions). */
  readonly variant: string;
  readonly targetClass: Exclude<TargetClass, 'infantry'>;
  /** Hull length, width and height (to the turret roof) (m). */
  readonly dimensions: {
    readonly lengthM: number;
    readonly widthM: number;
    readonly heightM: number;
  };
  readonly mobility: MobilitySpec;
  readonly armor: ArmorSpec;
  readonly crew: readonly CrewRole[];
  readonly sensors: SensorSpec;
  readonly mounts: readonly MountSpec[];
  readonly weapons: readonly MountedWeaponSpec[];
  /** Chance that a perforation of its fighting compartment destroys it outright (× the round's lethality). */
  readonly catastrophicVulnerability: number;
  readonly visual: VisualSpec;
}

/** How a round strikes soldiers: a direct hit table (machine guns) or a blast. */
export interface InfantryEffect {
  /** Direct fire: the hit table and effects of the infantry model (`FofWeapon`'s). */
  readonly hitProbabilityByRange: readonly RangeProbability[];
  readonly burstRoundWeight: number;
  readonly incapacitationProbabilityOnHit: number;
  readonly suppressionPerBurst: number;
  readonly suppressionRadiusM: number;
  /** A blast where it lands (HE): its incapacitation by distance; `null`: none. */
  readonly area: AreaEffect | null;
}

export type AmmoKind = 'ball' | 'ap' | 'apfsds' | 'heat' | 'tandemHeat' | 'he' | 'heFrag';

export interface AmmoSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: AmmoKind;
  readonly energy: Energy;
  /** Penetration (RHA mm) by range (linear between points, the last held beyond). */
  readonly penetrationByRange: readonly { readonly rangeM: number; readonly mm: number }[];
  /** Strikes the roof (a top-attack missile). */
  readonly topAttack?: boolean;
  /** Effect behind the armour once it perforates (0–1): spall, fire, blast. */
  readonly lethality: number;
  /** Chance a hit that does not perforate still damages sights or running gear. */
  readonly nonPenetratingDamage: number;
  /** What it does to soldiers; `null`: not used against them. */
  readonly vsInfantry: InfantryEffect | null;
  /**
   * Its speed (m/s, the muzzle velocity): it flies (range ÷ speed) and does
   * what it does when it arrives. Absent: it strikes when fired (missiles fly
   * by `guided`).
   */
  readonly velocityMps?: number;
}

export type WeaponKind = 'machineGun' | 'autocannon' | 'cannon' | 'atRocket' | 'atgm';

export interface CombatWeaponSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: WeaponKind;
  readonly ammo: readonly AmmoSpec[];
  /** Rounds per shot (a burst) and seconds between shots. */
  readonly roundsPerShot: { readonly min: number; readonly max: number };
  readonly secondsBetweenShots: { readonly minSeconds: number; readonly maxSeconds: number };
  /** Rounds it holds ready (a belt, a magazine, 1 for a gun), and the time to reload from stowage (s). */
  readonly readyCapacity: number;
  readonly reloadSeconds: { readonly minSeconds: number; readonly maxSeconds: number };
  /** A soldier's weapon: the rounds he (and his team) carries in all, the one ready among them. */
  readonly carriedRounds?: number;
  readonly minRangeM: number;
  readonly maxRangeM: number;
  /**
   * One round's (one missile's) chance to hit a stationary vehicle-sized target
   * (2.5 m × 2.5 m presented), from a still platform, by range.
   */
  readonly hitVsVehicleByRange: readonly RangeProbability[];
  /** Guided weapons: flight speed (m/s); the gunner guides it to impact (wire, SACLOS). */
  readonly guided: { readonly flightSpeedMps: number; readonly guidedToImpact: boolean } | null;
  /** Fired only from a halt (missiles from a vehicle; unstabilized guns are slowed instead). */
  readonly requiresHalt: boolean;
  /** Ammunition cost of a shot, for target selection (a burst 1, a main-gun round 8, a missile 20). */
  readonly costPerShot: number;
  /** Time to aim and fire once the gunner has the target (a launcher's lock-on, s); 0: none beyond the cycle. */
  readonly aimSeconds: number;
  /** How much more conspicuous firing it makes the shooter (the detection model's firing cue). */
  readonly firingSignature: number;
}

/** What a target class is worth killing, and how dangerous each class is by default. */
export interface TargetingConfig {
  /** Below this effect a weapon is ineffective against a target. */
  readonly minimumEffect: number;
  readonly classValue: Readonly<Record<TargetClass, number>>;
  /** Reassess targets this often (s); switch only for this much more utility. */
  readonly reassessSeconds: number;
  readonly switchFactor: number;
  /** A mount is laid when within these errors (deg). */
  readonly layToleranceDeg: number;
  readonly elevationToleranceDeg: number;
}
