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

export type CombatEvent = ShotFiredEvent | SoldierIncapacitatedEvent;

/** A burst or a casualty as the character layer's combat event (it reads the shooter and the time). */
export function combatEventOf(event: SimEvent): CombatEvent | null {
  if (event.type === 'soldierIncapacitated') return event;
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
