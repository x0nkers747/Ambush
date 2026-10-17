import type { Side, SimEvent, SoldierId, SoldierIncapacitatedEvent } from '#sim';

// What poses the 3D characters' firing and falling (docs/character-animation.md):
// a burst fired (a battle's `fofFire`, as a shot), or a soldier incapacitated;
// and what the vehicles' effects are drawn from (docs/combined-arms.md §11):
// heavy shots, missiles and strikes on vehicles.

/** A burst fired at a target, and what it did. */
export interface ShotFiredEvent {
  readonly type: 'shotFired';
  readonly tick: number;
  readonly atSeconds: number;
  readonly shooterId: SoldierId;
  readonly shooterSide: Side;
  readonly targetId: SoldierId;
  readonly weaponProfileRef: string;
  /** Horizontal distance from shooter to target, in metres. */
  readonly rangeM: number;
  /** Rounds in the burst, where it was aimed, and how (at a soldier seen, or at an area). */
  readonly rounds: number;
  readonly aimPoint: { readonly x: number; readonly y: number };
  readonly aimed: boolean;
  readonly hitProbability: number;
  readonly hit: boolean;
  readonly incapacitated: boolean;
  /** When its rounds arrive (battle s; the target falls then). */
  readonly arriveAt: number;
}

/** A grenade's burst, where it landed (the 3D view shows it). */
export interface GrenadeImpactEvent {
  readonly type: 'grenadeImpact';
  readonly tick: number;
  readonly atSeconds: number;
  readonly shooterId: SoldierId;
  readonly impact: { readonly x: number; readonly y: number };
}

/**
 * A shot at or from a vehicle, or an anti-tank weapon's (docs/combined-arms.md
 * §11): from its muzzle to where it landed; a missile flies until `impactAt`.
 */
export interface HeavyShotEvent {
  readonly type: 'heavyShot';
  readonly tick: number;
  readonly atSeconds: number;
  readonly shooterId: string;
  readonly shooter: 'vehicle' | 'soldier';
  readonly side: Side;
  /** The weapon's slot (`main`, `coax`…) or a soldier's weapon, and the weapon and ammunition. */
  readonly slot: string;
  readonly weapon: string;
  readonly ammo: string;
  readonly rounds: number;
  readonly targetId: string;
  readonly target: 'soldier' | 'vehicle';
  readonly from: { readonly x: number; readonly y: number; readonly z: number };
  readonly impact: { readonly x: number; readonly y: number; readonly z: number };
  readonly hit: boolean;
  /** A missile: its id and when it arrives (`null`: a round, there at once). */
  readonly missileId: string | null;
  readonly impactAt: number | null;
}

/** A missile arrived: where, and whether it struck its target. */
export interface MissileArrivedEvent {
  readonly type: 'missileArrived';
  readonly tick: number;
  readonly atSeconds: number;
  readonly missileId: string;
  readonly hit: boolean;
  readonly impact: { readonly x: number; readonly y: number; readonly z: number };
}

/** A vehicle was struck: whether the round perforated and whether it was destroyed. */
export interface VehicleStruckEvent {
  readonly type: 'vehicleStruck';
  readonly tick: number;
  readonly atSeconds: number;
  readonly vehicleId: string;
  readonly perforated: boolean;
  readonly catastrophic: boolean;
}

export type CombatEvent =
  | ShotFiredEvent
  | SoldierIncapacitatedEvent
  | GrenadeImpactEvent
  | HeavyShotEvent
  | MissileArrivedEvent
  | VehicleStruckEvent;

/** A burst or a casualty as the character layer's combat event (it reads the shooter and the time). */
export function combatEventOf(event: SimEvent): CombatEvent | null {
  if (event.type === 'soldierIncapacitated') return event;
  if (event.type === 'fofGrenade')
    return {
      type: 'grenadeImpact',
      tick: event.tick,
      atSeconds: event.atSeconds,
      shooterId: event.shooterId,
      impact: event.impact,
    };
  if (event.type === 'vehicleFire')
    return {
      type: 'heavyShot',
      tick: event.tick,
      atSeconds: event.atSeconds,
      shooterId: event.shooterId,
      shooter: event.shooter,
      side: event.side,
      slot: event.slot,
      weapon: event.weapon,
      ammo: event.ammo,
      rounds: event.rounds,
      targetId: event.targetId,
      target: event.target,
      from: event.from,
      impact: event.impact,
      hit: event.hit,
      missileId: event.missileId,
      impactAt: event.impactAt,
    };
  if (event.type === 'missileImpact')
    return {
      type: 'missileArrived',
      tick: event.tick,
      atSeconds: event.atSeconds,
      missileId: event.missileId,
      hit: event.hit,
      impact: event.impact,
    };
  if (event.type === 'vehicleHit')
    return {
      type: 'vehicleStruck',
      tick: event.tick,
      atSeconds: event.atSeconds,
      vehicleId: event.vehicleId,
      perforated: event.perforated,
      catastrophic: event.catastrophic,
    };
  if (event.type !== 'fofFire') return null;
  return {
    type: 'shotFired',
    tick: event.tick,
    atSeconds: event.atSeconds,
    shooterId: event.shooterId,
    shooterSide: event.side,
    targetId: event.targetId,
    weaponProfileRef: event.weapon,
    rangeM: event.rangeM,
    rounds: event.rounds,
    aimPoint: event.aimPoint,
    aimed: event.kind === 'aimed',
    hitProbability: event.hitProbability,
    hit: event.hit,
    incapacitated: event.incapacitated,
    arriveAt: event.arriveAt,
  };
}
