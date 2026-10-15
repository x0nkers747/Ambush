import type { Side, SimEvent, SoldierId, SoldierIncapacitatedEvent } from '#sim';

// What poses the 3D characters' firing and falling (docs/character-animation.md):
// a burst fired (a battle's `fofFire`, as a shot), or a soldier incapacitated.

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
  readonly hitProbability: number;
  readonly hit: boolean;
  readonly incapacitated: boolean;
}

/** A grenade's burst, where it landed (the 3D view shows it). */
export interface GrenadeImpactEvent {
  readonly type: 'grenadeImpact';
  readonly tick: number;
  readonly atSeconds: number;
  readonly shooterId: SoldierId;
  readonly impact: { readonly x: number; readonly y: number };
}

export type CombatEvent = ShotFiredEvent | SoldierIncapacitatedEvent | GrenadeImpactEvent;

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
    hitProbability: event.hitProbability,
    hit: event.hit,
    incapacitated: event.incapacitated,
  };
}
