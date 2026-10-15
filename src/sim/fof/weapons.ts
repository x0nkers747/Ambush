import { nextFloat } from '../rng';
import {
  fofWeapon,
  type FireMode,
  type FofConfig,
  type FofWeapon,
  type UniformSeconds,
} from './config';
import type { FofContext } from './system';
import type { FofSoldier, FofWeaponState } from './types';

// Weapons and ammunition (docs/behavior-lab/force-on-force/06): each armed
// soldier's weapons, the rounds loaded in each and in reserve, his reloads,
// and the fire mode he fires in. Plain data in the model's state; every
// change keeps a weapon's rounds conserved (loaded + reserve + fired = its
// basic load), and every draw comes from the simulation's random numbers.

/** A weapon as carried at the start: one full feed loaded, the rest in reserve. */
export function armed(config: FofConfig, id: string): FofWeaponState | null {
  const weapon = fofWeapon(config, id);
  if (!weapon) return null;
  const loaded = Math.min(weapon.capacity, weapon.basicLoadRounds);
  return {
    id,
    loaded,
    reserve: weapon.basicLoadRounds - loaded,
    fired: 0,
    readyAt: 0,
    exhausted: weapon.basicLoadRounds === 0,
  };
}

/** Rounds a soldier has left for his primary weapon (loaded and in reserve). */
export function roundsLeft(member: {
  readonly arms: readonly { readonly loaded: number; readonly reserve: number }[];
}): number {
  const primary = member.arms[0];
  return primary ? primary.loaded + primary.reserve : 0;
}

/** The weapon a soldier's arm is. */
export function weaponOf(context: FofContext, arm: FofWeaponState): FofWeapon {
  const weapon = fofWeapon(context.setup.config, arm.id);
  if (!weapon) throw new Error(`force-on-force weapon ${arm.id} is not configured`);
  return weapon;
}

/** A duration drawn uniformly. */
export function drawSeconds(context: FofContext, range: UniformSeconds): number {
  return range.minSeconds + nextFloat(context.state.rng) * (range.maxSeconds - range.minSeconds);
}

/** A burst length drawn uniformly (whole rounds). */
export function drawRounds(context: FofContext, mode: FireMode): number {
  const { min, max } = mode.roundsPerBurst;
  if (max <= min) return min;
  return min + Math.min(max - min, Math.floor(nextFloat(context.state.rng) * (max - min + 1)));
}

/** The fire mode a soldier fires in at a target `rangeM` away (06 §3). */
export function fireMode(
  context: FofContext,
  member: FofSoldier,
  rangeM: number,
): 'sustained' | 'rapid' {
  const { rapidFire } = context.setup.config.fire;
  const force = context.fof.forces[member.force];
  if (!force) return 'sustained';
  const opening =
    force.firstFireAt === null || context.t - force.firstFireAt < rapidFire.afterOpeningSeconds;
  if (opening || rangeM <= rapidFire.withinRangeM) return 'rapid';
  return rapidFire.whenAssaulting && force.phase === 'assaulting' ? 'rapid' : 'sustained';
}

/** Whether the soldier is reloading now. */
export const reloading = (member: FofSoldier): boolean => member.reloadUntil !== null;

/**
 * Starts reloading arm `index` (it has rounds in reserve and is not full):
 * he fires nothing until it is done. Returns whether it started.
 */
export function startReload(context: FofContext, member: FofSoldier, index: number): boolean {
  const arm = member.arms[index];
  if (!arm || member.reloadUntil !== null || arm.reserve <= 0) return false;
  const weapon = weaponOf(context, arm);
  if (arm.loaded >= weapon.capacity) return false;
  member.reloading = index;
  member.reloadUntil = context.t + drawSeconds(context, weapon.reloadSeconds);
  context.events.push({
    type: 'fofReload',
    tick: context.tick,
    atSeconds: context.t,
    soldierId: member.soldierId,
    weapon: arm.id,
    phase: 'started',
    loaded: arm.loaded,
    reserve: arm.reserve,
  });
  return true;
}

/** An arm is empty with nothing in reserve: reported once. */
export function noteExhausted(context: FofContext, member: FofSoldier, index: number): void {
  const arm = member.arms[index];
  if (!arm || arm.exhausted || arm.loaded > 0 || arm.reserve > 0) return;
  arm.exhausted = true;
  context.events.push({
    type: 'ammunitionExhausted',
    tick: context.tick,
    atSeconds: context.t,
    soldierId: member.soldierId,
    weapon: arm.id,
  });
}

/**
 * Reloads that are done load their weapon: rounds move from the reserve to
 * the feed, up to its capacity (the rounds left in a changed magazine go back
 * to the reserve first: a last, partial magazine is loaded as it is). A
 * soldier struck down stops reloading. Soldiers in a lull change part-empty
 * magazines (tactical reload).
 */
export function updateReloads(context: FofContext): void {
  const { fof, t } = context;
  const lull = context.setup.config.fire.lullReloadSeconds;
  for (const member of fof.soldiers) {
    if (member.arms.length === 0) continue;
    const soldier = context.state.soldiers[context.soldierIndex.get(member.soldierId) ?? -1];
    const active = soldier?.status === 'active';
    if (member.reloadUntil !== null) {
      if (!active) {
        member.reloadUntil = null;
        member.reloading = -1;
        continue;
      }
      if (member.reloadUntil > t + 1e-9) continue;
      const arm = member.arms[member.reloading];
      member.reloadUntil = null;
      member.reloading = -1;
      if (!arm) continue;
      const weapon = weaponOf(context, arm);
      const pool = arm.loaded + arm.reserve;
      arm.loaded = Math.min(weapon.capacity, pool);
      arm.reserve = pool - arm.loaded;
      member.stats.reloads += 1;
      const force = fof.forces[member.force];
      if (force) force.stats.reloads += 1;
      context.events.push({
        type: 'fofReload',
        tick: context.tick,
        atSeconds: t,
        soldierId: member.soldierId,
        weapon: arm.id,
        phase: 'completed',
        loaded: arm.loaded,
        reserve: arm.reserve,
      });
      continue;
    }
    if (!active) continue;
    // Something to reload: an empty feed with rounds in reserve (the primary first).
    let started = false;
    for (let i = 0; i < member.arms.length && !started; i += 1) {
      const arm = member.arms[i];
      if (arm?.loaded === 0 && arm.reserve > 0) started = startReload(context, member, i);
    }
    if (started) continue;
    // A lull: a part-empty magazine is changed for a full one.
    const primary = member.arms[0];
    if (!primary || primary.reserve <= 0 || member.lastFiredAt === null) continue;
    if (t - member.lastFiredAt < lull) continue;
    const weapon = weaponOf(context, primary);
    if (weapon.feed !== 'magazine' || weapon.tacticalReloadBelow <= 0) continue;
    if (primary.loaded < weapon.capacity * weapon.tacticalReloadBelow)
      startReload(context, member, 0);
  }
}
