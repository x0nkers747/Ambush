import type { Vec2 } from '../geometry';
import type { CrewRole, PlatformSpec } from './types';

// The combat state of vehicles and anti-tank soldiers (docs/combined-arms.md):
// plain data in `SimState` (each vehicle's `VehicleState.combat`, and
// `SimState.combat` for what belongs to no one vehicle), so it is hashed,
// snapshotted and replayed with the rest of the simulation.

/** A crew member's state: able, slowed (wounded, shaken), or out. */
export type CrewState = 'operational' | 'degraded' | 'incapacitated';

export interface CrewMemberState {
  readonly role: CrewRole;
  state: CrewState;
}

/** A mount's orientation (rad): `azimuth` from its parent's forward (clockwise), `elevation` up. */
export interface MountState {
  readonly id: string;
  azimuth: number;
  elevation: number;
  /** Where it is being laid (relative to its parent, like its orientation). */
  goalAzimuth: number;
  goalElevation: number;
  /** Jammed or wrecked: it no longer turns. */
  disabled: boolean;
}

/** Rounds of one ammunition a mounted weapon has: ready to fire, and stowed. */
export interface AmmoCount {
  readonly ammo: string;
  ready: number;
  stowed: number;
}

export interface MountedWeaponState {
  /** Its slot (`MountedWeaponSpec.id`). */
  readonly id: string;
  /** The ammunition loaded (chambered) or being loaded. */
  ammo: string;
  loads: AmmoCount[];
  /** Its next shot no sooner than this (s). */
  readyAt: number;
  /** Reloading from stowage until this (s), or `null`. */
  reloadUntil: number | null;
  disabled: boolean;
  fired: number;
}

/** What one of a vehicle's crew knows of one enemy: a soldier or a vehicle. */
export interface VehicleTrack {
  readonly targetId: string;
  readonly target: 'soldier' | 'vehicle';
  confidence: number;
  lastSeenAt: number;
  confirmed: boolean;
  lastKnown: Vec2;
  readonly firstAt: number;
}

/** A mount's engagement: its target and the weapon and ammunition chosen against it. */
export interface Engagement {
  readonly mount: string;
  targetId: string;
  target: 'soldier' | 'vehicle';
  weapon: string;
  ammo: string;
  /** When it was chosen, and when it is next reassessed (s). */
  since: number;
  reassessAt: number;
  /** Its value when chosen (a new target must be markedly better). */
  utility: number;
  /** Since when its weapon has been laid and ready, aiming (`aimSeconds`), or `null`. */
  aimedAt: number | null;
}

/**
 * A vehicle's damage: what is broken stays broken. `destroyed`: a
 * catastrophic kill (it burns, then is a wreck). `sensors`: the share of its
 * sight left (1: all). Weapons and mounts carry their own `disabled`.
 */
export interface VehicleDamage {
  mobility: boolean;
  sensors: number;
  destroyed: boolean;
  /** Burning until this (s), or `null`. */
  burningUntil: number | null;
  /** Hits taken and perforations. */
  hits: number;
  perforations: number;
}

export interface VehicleCombat {
  crew: CrewMemberState[];
  mounts: MountState[];
  weapons: MountedWeaponState[];
  engagements: Engagement[];
  tracks: VehicleTrack[];
  damage: VehicleDamage;
  /** Halted to fire (a missile, an unstabilized gun) until this (s), or `null`. */
  haltUntil: number | null;
  lastFiredAt: number | null;
  /** Its ground speed at the last decision (m/s). */
  speed: number;
  lastX: number;
  lastY: number;
}

/** A soldier's anti-tank weapon (docs/combined-arms.md §9): its rounds, and his aim. */
export interface AntiTankState {
  readonly soldierId: string;
  /** `CombatWeaponSpec.id`. */
  readonly weapon: string;
  loaded: number;
  reserve: number;
  readyAt: number;
  reloadUntil: number | null;
  /** Aiming at this vehicle until `aimUntil` (a launcher's lock-on), or `null`. */
  aimingAt: string | null;
  aimUntil: number;
  fired: number;
}

/** A missile in flight, resolved when it arrives (`impactAt`). */
export interface MissileState {
  readonly id: string;
  readonly shooterId: string;
  readonly side: 'BLUEFOR' | 'OPFOR';
  readonly weapon: string;
  readonly ammo: string;
  readonly targetId: string;
  readonly from: { readonly x: number; readonly y: number; readonly z: number };
  readonly launchedAt: number;
  readonly impactAt: number;
  /** Its chance to hit, drawn at launch from the launch geometry (guidance can be lost in flight). */
  readonly hitProbability: number;
  readonly rangeM: number;
}

/** Combat state that belongs to no one vehicle. Absent until a battle has vehicles or anti-tank weapons. */
export interface CombatState {
  /**
   * Each observer–target pair's detectability threshold where a vehicle is
   * one of them (`"observer>target"`), drawn at the start (a pair not drawn
   * then, when first seen).
   */
  thresholds: Record<string, number>;
  antiTank: AntiTankState[];
  missiles: MissileState[];
  nextMissile: number;
}

/** A vehicle's combat state at the start: its crew able, its mounts forward, its weapons loaded. */
export function initialVehicleCombat(platform: PlatformSpec, at: Vec2): VehicleCombat {
  return {
    crew: platform.crew.map((role) => ({ role, state: 'operational' })),
    mounts: platform.mounts.map((m) => ({
      id: m.id,
      azimuth: 0,
      elevation: 0,
      goalAzimuth: 0,
      goalElevation: 0,
      disabled: false,
    })),
    weapons: platform.weapons.map((w) => ({
      id: w.id,
      ammo: w.loads[0]?.ammo ?? '',
      loads: w.loads.map((l) => ({ ammo: l.ammo, ready: l.ready, stowed: l.stowed })),
      readyAt: 0,
      reloadUntil: null,
      disabled: false,
      fired: 0,
    })),
    engagements: [],
    tracks: [],
    damage: {
      mobility: false,
      sensors: 1,
      destroyed: false,
      burningUntil: null,
      hits: 0,
      perforations: 0,
    },
    haltUntil: null,
    lastFiredAt: null,
    speed: 0,
    lastX: at.x,
    lastY: at.y,
  };
}

/** The state of the crew member in `role`, or `incapacitated` without one. */
export function crewState(combat: VehicleCombat, role: CrewRole): CrewState {
  return combat.crew.find((c) => c.role === role)?.state ?? 'incapacitated';
}

/** Whether every crew member is out. */
export function crewLost(combat: VehicleCombat): boolean {
  return combat.crew.every((c) => c.state === 'incapacitated');
}
