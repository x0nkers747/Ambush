import { surfaceHeightAt } from '../bridge-navigation';
import { hitProbabilityAt } from './hit-probability';
import { azimuthOf, type Vec2 } from '../geometry';
import { nextFloat } from '../rng';
import { sightLineTracer } from '../sight-tracer';
import type { Soldier, SoldierId } from '../state';
import type { AreaEffect, FofWeapon } from './config';
import { ambushSectors } from './ambush';
import { dugInFactor, effectiveDugIn } from './defence';
import { enter, firingOnTheMove, pressingOn, underFire } from './force';
import { sightBetween } from './sight-cache';
import type { FofContext } from './system';
import { fireCombat } from '../combat/system';
import { hostile, soldierOf } from './system';
import type { FofSoldier, FofTrack, FofWeaponState, SuppressionLevel } from './types';
import {
  drawRounds,
  drawSeconds,
  fireMode,
  noteExhausted,
  roundsLeft,
  startReload,
  weaponOf,
} from './weapons';

// Abstract fire (docs/behavior-lab/force-on-force/03 §5, 06): a burst is a
// fire event, not a bullet. A soldier whose force is in contact (or
// assaulting or breaking contact, firing on the move at what he can see)
// fires when his next burst is due and he is not reloading: aimed, at the
// nearest contact of his force he can see (within his weapon's range and the
// rules of engagement), or else area fire at the last known position of a
// contact seen recently. His weapon's fire mode (sustained or rapid) sets
// the burst's length, cut short by the rounds loaded, and the time to the
// next; one draw decides whether the burst hits (the chance that any of its
// effective rounds does) and one more whether a hit incapacitates. Every
// burst suppresses the soldiers it lands near, hit or not. A fire team
// leader may fire his grenade launcher instead (06 §4): an area effect.

/**
 * Whether a force may fire at a track (rules of engagement): any confirmed
 * contact (`detected`: in the lab only the two forces are on the ground), or
 * only identified ones (`identified`, restrictive).
 */
function engageable(context: FofContext, track: FofTrack): boolean {
  if (!track.confirmed) return false;
  return track.identified || context.setup.config.fire.engageLevel === 'detected';
}

/** What a shooter gets of a target: the share of him in sight and the light through vegetation. */
function exposure(context: FofContext, shooter: Soldier, target: Soldier): number {
  const i = context.memberIndex.get(shooter.id) ?? -1;
  const j = context.memberIndex.get(target.id) ?? -1;
  const seen = sightBetween(context, i, j, shooter, target);
  if (seen.visibleFraction <= 0) return 0;
  return seen.visibleFraction * seen.transmission;
}

/** Whether the ground point `p` (half a metre up) is in the shooter's sight. */
function pointInSight(context: FofContext, shooter: Soldier, p: Vec2): boolean {
  const { terrain } = context.world;
  const eye = {
    x: shooter.position.x,
    y: shooter.position.y,
    z:
      surfaceHeightAt(terrain, shooter.position.x, shooter.position.y) +
      context.setup.config.detection.eyeHeightM[shooter.posture],
  };
  return !sightLineTracer(terrain).blocked(eye, {
    x: p.x,
    y: p.y,
    z: surfaceHeightAt(terrain, p.x, p.y) + 0.5,
  });
}

/** A soldier's chance of being hit, dug in (docs/behavior-lab/force-on-force/09): 1 in the open. */
function dugInHit(context: FofContext, target: Soldier): number {
  const member = context.fof.soldiers[context.memberIndex.get(target.id) ?? -1];
  const force = member ? context.fof.forces[member.force] : undefined;
  return dugInFactor(effectiveDugIn(force ?? null), context.setup.config.force.dugInHitFactor);
}

/** A round's hit probability is never raised by an ambush's steady fire beyond this. */
const AMBUSH_MAX_P_ROUND = 0.95;

/**
 * An ambush sprung with surprise fires from steady, prepared prone
 * positions without the stress of being fired upon (docs/behavior-lab/force-on-force/08):
 * `ambushAccuracyFactor` until it is fired upon (at most `ambushAccuracySeconds`); else 1.
 */
function ambushSteadiness(context: FofContext, member: FofSoldier): number {
  const force = context.fof.forces[member.force];
  const until = force?.ambushSteadyUntil ?? null;
  return until !== null && context.t < until - 1e-9
    ? context.setup.config.force.ambushAccuracyFactor
    : 1;
}

/** Avoiding contact, a force returns fire only this long after it was fired upon (s). */
const HOLD_FIRE_UNLESS_FIRED_UPON_S = 60;

/** Phases in which a force's soldiers fire. */
function firing(phase: string): boolean {
  return (
    phase === 'contact' ||
    phase === 'engaged' ||
    phase === 'holding' ||
    phase === 'withdrawing' ||
    phase === 'assaulting' ||
    // Pressing on through contact (it fires on the move).
    phase === 'moving'
  );
}

/**
 * What the bursts of one decision do, applied together after all of them:
 * fire within a decision is simultaneous, so the order soldiers are listed
 * in gives no side the first shot.
 */
interface Volley {
  /** Suppression to add, by member. */
  readonly suppression: Map<FofSoldier, number>;
  /** Soldiers incapacitated, by whom (in the order of the bursts). */
  readonly down: Map<
    string,
    { readonly victim: Soldier; readonly by: { readonly id: string }; readonly force: number }
  >;
}

/** What a soldier fires at: a target in sight, or area fire at a last known position. */
interface Aim {
  readonly kind: 'aimed' | 'area';
  /** Aimed at; for area fire, the contact whose last known position is aimed at. */
  readonly target: Soldier;
  readonly point: Vec2;
  readonly rangeM: number;
  /** Per-round hit probability, and against whom (area fire: the soldier nearest the aim point, if any). */
  readonly pRound: number;
  readonly victim: Soldier | null;
}

/** The bursts due at this decision, in soldier order, resolved as simultaneous. */
export function resolveFire(context: FofContext): void {
  const { fof, t, tick, events } = context;
  const volley: Volley = { suppression: new Map(), down: new Map() };
  fof.soldiers.forEach((member) => {
    if (member.nextFireAt === null || member.nextFireAt > t + 1e-9) return;
    const shooter = soldierOf(context, member);
    const force = fof.forces[member.force];
    if (
      shooter.status !== 'active' ||
      !force ||
      !firing(force.phase) ||
      (force.phase === 'moving' && !pressingOn(context, force)) ||
      (!member.reacted && !firingOnTheMove(force.phase) && !pressingOn(context, force))
    ) {
      member.nextFireAt = null;
      return;
    }
    const primary = member.arms[0];
    if (!primary) {
      member.nextFireAt = null;
      return;
    }
    const weapon = weaponOf(context, primary);
    const left = roundsLeft(member);
    const launcher = member.arms[1];
    const grenades = launcher ? launcher.loaded + launcher.reserve : 0;
    if (left <= 0 && grenades <= 0) {
      member.nextFireAt = null;
      return;
    }
    // Reloading: his next chance is when he is done.
    if (member.reloadUntil !== null) {
      member.nextFireAt = Math.max(member.nextFireAt, member.reloadUntil);
      return;
    }
    // Breaking contact, a soldier keeps his last rounds (below the withdrawal share of his load).
    if (
      force.phase === 'withdrawing' &&
      left < weapon.basicLoadRounds * context.setup.config.force.withdrawAmmunitionFraction
    ) {
      member.nextFireAt = null;
      return;
    }
    // Avoiding contact, it holds its fire unless it has been fired upon lately.
    // So does a combat-ineffective force falling back.
    if (
      (force.actionsOn === 'withdraw' ||
        (force.phase === 'withdrawing' && force.combatIneffective)) &&
      (force.lastFiredUponAt === null || t - force.lastFiredUponAt > HOLD_FIRE_UNLESS_FIRED_UPON_S)
    ) {
      member.nextFireAt = t + 1;
      return;
    }
    // Pinned: no fire; look again shortly.
    if (member.level === 'pinned') {
      member.nextFireAt = t + 1;
      return;
    }
    const aim =
      aimedTarget(context, member, shooter, weapon) ?? areaTarget(context, member, shooter, weapon);
    if (!aim) {
      member.nextFireAt = t + 1;
      return;
    }
    if (launcher && considerGrenade(context, member, launcher, aim)) {
      grenade(context, volley, member, shooter, launcher, aim);
      return;
    }
    // His rifle's cadence holds across pauses (a burst is never early, whatever reset his turn).
    if (primary.readyAt > t + 1e-9 && primary.loaded > 0) {
      member.nextFireAt = primary.readyAt;
      return;
    }
    if (primary.loaded <= 0) {
      // Nothing loaded (out, or about to reload): nothing fired.
      if (!startReload(context, member, 0)) noteExhausted(context, member, 0);
      member.nextFireAt = left > 0 ? t + 1 : null;
      if (member.nextFireAt === null && grenades > 0) member.nextFireAt = t + 1;
      return;
    }
    burst(context, volley, member, shooter, weapon, primary, aim);
  });
  // Vehicles and anti-tank weapons fire in the same volley (docs/combined-arms.md §7).
  fireCombat(context, volley);
  for (const member of fof.soldiers) {
    const add = volley.suppression.get(member);
    if (add !== undefined) member.suppression = Math.min(1, member.suppression + add);
  }
  for (const { victim, by, force } of volley.down.values()) {
    victim.status = 'incapacitated';
    victim.orders = null;
    const victimMember = fof.soldiers[context.memberIndex.get(victim.id) ?? -1];
    if (victimMember) {
      victimMember.nextFireAt = null;
      victimMember.reactAt = null;
      victimMember.reloadUntil = null;
      victimMember.reloading = -1;
    }
    const shooterForce = fof.forces[force];
    const victimForce = victimMember ? fof.forces[victimMember.force] : undefined;
    // An enemy struck down (a friendly one, by a grenade, is not inflicted on the enemy).
    if (shooterForce && victimForce && shooterForce.side !== victimForce.side)
      shooterForce.stats.casualtiesInflicted += 1;
    events.push({
      type: 'soldierIncapacitated',
      tick,
      atSeconds: t,
      soldierId: victim.id,
      byId: by.id,
    });
  }
}

/** The nearest engageable contact the shooter can see, in range (fighting an ambush: in his sector first). */
function aimedTarget(
  context: FofContext,
  member: FofSoldier,
  shooter: Soldier,
  weapon: FofWeapon,
): Aim | null {
  const { fof } = context;
  const candidates: { track: FofTrack; target: Soldier; range: number }[] = [];
  for (const track of fof.tracks) {
    if (track.force !== member.force) continue;
    if (track.level !== 'detected' && track.level !== 'identified') continue;
    if (!engageable(context, track)) continue;
    const target = context.state.soldiers[context.soldierIndex.get(track.targetId) ?? -1];
    if (target?.status !== 'active') continue;
    const range = Math.hypot(
      target.position.x - shooter.position.x,
      target.position.y - shooter.position.y,
    );
    if (range <= weapon.maxEngagementRangeM) candidates.push({ track, target, range });
  }
  // Nearest first (then in soldier order), as sorting would give: taken one at a
  // time, since the first in sight is usually among the first few. Fighting an
  // ambush it sprang, each ambusher takes his own sector of the kill zone first.
  const order = (c: { target: Soldier; range: number }) =>
    context.soldierIndex.get(c.target.id) ?? 0;
  const force = fof.forces[member.force];
  const sector = force
    ? ambushSectors(
        context,
        force,
        shooter,
        candidates.map((c) => c.target),
      )
    : null;
  const key = (c: { target: Soldier; range: number }) => (sector ? sector(c.target) : c.range);
  for (let left = candidates.length; left > 0; left -= 1) {
    let best = 0;
    for (let k = 1; k < left; k += 1) {
      const a = candidates[k];
      const b = candidates[best];
      if (!a || !b) continue;
      const ka = key(a);
      const kb = key(b);
      if (
        ka < kb ||
        (ka === kb && (a.range < b.range || (a.range === b.range && order(a) < order(b))))
      )
        best = k;
    }
    const chosen = candidates[best];
    if (!chosen) break;
    // The chosen one is out of the remaining.
    candidates[best] = candidates[left - 1] ?? chosen;
    candidates[left - 1] = chosen;
    const { target, range } = chosen;
    const seen = exposure(context, shooter, target);
    if (seen <= 0) continue;
    const base =
      hitProbabilityAt(weapon, range) *
      context.setup.config.fire.postureHitMultipliers[target.posture] *
      dugInHit(context, target) *
      seen *
      shooterFactor(context, member);
    // An ambush's steady fire, in its first moments.
    const steady = ambushSteadiness(context, member);
    const pRound = steady > 1 ? Math.min(AMBUSH_MAX_P_ROUND, base * steady) : base;
    return { kind: 'aimed', target, point: target.position, rangeM: range, pRound, victim: target };
  }
  return null;
}

/** Area fire at the last known position of an engageable contact seen recently, in range and in sight. */
function areaTarget(
  context: FofContext,
  member: FofSoldier,
  shooter: Soldier,
  weapon: FofWeapon,
): Aim | null {
  const { fof, t, setup } = context;
  const memory = setup.config.fire.areaFireMemorySeconds;
  if (memory <= 0) return null;
  let best: { track: FofTrack; range: number } | null = null;
  for (const track of fof.tracks) {
    if (track.force !== member.force || !track.confirmed || !engageable(context, track)) continue;
    if (t - track.lastSeenAt > memory) continue;
    // A rifle's area fire is at soldiers (vehicles are anti-tank weapons' targets).
    if (!context.soldierIndex.has(track.targetId)) continue;
    const range = Math.hypot(
      track.lastKnown.x - shooter.position.x,
      track.lastKnown.y - shooter.position.y,
    );
    if (range > weapon.maxEngagementRangeM) continue;
    if (best === null || range < best.range) best = { track, range };
  }
  if (!best || !pointInSight(context, shooter, best.track.lastKnown)) return null;
  const point = best.track.lastKnown;
  // Who is near the aim point (truth: rounds land where they land), if anyone in sight.
  let near: Soldier | null = null;
  let nearD = weapon.suppressionRadiusM;
  for (const enemy of fof.soldiers) {
    if (!hostile(fof, member, enemy)) continue;
    const s = soldierOf(context, enemy);
    if (s.status !== 'active') continue;
    const d = Math.hypot(s.position.x - point.x, s.position.y - point.y);
    if (d <= nearD) {
      near = s;
      nearD = d;
    }
  }
  const seen = near ? exposure(context, shooter, near) : 0;
  const pRound =
    near && seen > 0
      ? hitProbabilityAt(weapon, best.range) *
        setup.config.fire.postureHitMultipliers[near.posture] *
        dugInHit(context, near) *
        setup.config.fire.areaFireHitFactor *
        seen *
        shooterFactor(context, member)
      : 0;
  const target = context.state.soldiers[context.soldierIndex.get(best.track.targetId) ?? -1];
  if (!target) return null;
  return { kind: 'area', target, point, rangeM: best.range, pRound, victim: near };
}

/** The shooter's own accuracy: suppression and moving. */
function shooterFactor(context: FofContext, member: FofSoldier): number {
  const { fire, suppression } = context.setup.config;
  const steady = 1 - suppression.accuracyLoss * member.suppression;
  return Math.max(0, steady) * (member.speed > 0.3 ? fire.movingShooterFactor : 1);
}

/** The force a burst lands on reacts, and its soldier aimed at is counted. */
function onTarget(context: FofContext, shooter: Soldier, aim: Aim): void {
  const targetMember = context.fof.soldiers[context.memberIndex.get(aim.target.id) ?? -1];
  if (targetMember && aim.kind === 'aimed') targetMember.stats.timesTargeted += 1;
  // The force fired on reacts to the fire, and learns roughly where it comes from.
  if (targetMember) underFire(context, targetMember.force, shooter);
}

/** The shooter's force has fired a burst (`rounds` > 0) or a grenade (statistics, opening fire). */
function fired(context: FofContext, member: FofSoldier, rounds: number, hit: boolean): void {
  const force = context.fof.forces[member.force];
  if (!force) return;
  if (rounds > 0) {
    force.stats.bursts += 1;
    force.stats.rounds += rounds;
  }
  if (hit) force.stats.hits += 1;
  force.lastFireAt = context.t;
  force.firstFireAt ??= context.t;
  // Exchanging fire.
  if (force.phase === 'contact') enter(context, force, 'engaged', 'opened fire');
}

/** Suppression of the enemies near an impact: full for the one aimed at, fading out to `radiusM`. */
function suppressAround(
  context: FofContext,
  volley: Volley,
  member: FofSoldier,
  impact: Vec2,
  aimedAt: SoldierId | null,
  perBurst: number,
  radiusM: number,
): void {
  const { fof, setup } = context;
  for (const enemy of fof.soldiers) {
    if (!hostile(fof, member, enemy)) continue;
    const s = soldierOf(context, enemy);
    if (s.status !== 'active') continue;
    const d = Math.hypot(s.position.x - impact.x, s.position.y - impact.y);
    const share = s.id === aimedAt ? 1 : d < radiusM ? 1 - d / radiusM : 0;
    if (share <= 0) continue;
    const prone = s.posture === 'prone' ? setup.config.suppression.proneSuppressionFactor : 1;
    // Dug in, less suppressed.
    const dug = dugInFactor(
      effectiveDugIn(fof.forces[enemy.force] ?? null),
      setup.config.force.dugInSuppressionFactor,
    );
    volley.suppression.set(
      enemy,
      (volley.suppression.get(enemy) ?? 0) + perBurst * share * prone * dug,
    );
  }
}

/** Resolves and records one burst of the primary weapon. */
function burst(
  context: FofContext,
  volley: Volley,
  member: FofSoldier,
  shooter: Soldier,
  weapon: FofWeapon,
  arm: FofWeaponState,
  aim: Aim,
): void {
  const { state, fof, t, events, tick } = context;
  const mode = fireMode(context, member, aim.rangeM);
  const rounds = Math.min(arm.loaded, drawRounds(context, weapon[mode]));
  const { victim } = aim;
  // The rounds of a burst are not independent shots (06 §3).
  const effective = 1 + (rounds - 1) * weapon.burstRoundWeight;
  const p = victim ? 1 - Math.pow(1 - Math.min(1, Math.max(0, aim.pRound)), effective) : 0;
  const hit = nextFloat(state.rng) < p;
  const drawn = hit && nextFloat(state.rng) < weapon.incapacitationProbabilityOnHit;
  // A soldier already struck down by an earlier burst of this volley falls only once.
  const incapacitated = drawn && victim !== null && !volley.down.has(victim.id);
  arm.loaded -= rounds;
  arm.fired += rounds;
  member.lastFiredAt = t;
  member.stats.bursts += 1;
  member.stats.rounds += rounds;
  if (hit) member.stats.hits += 1;
  fired(context, member, rounds, hit);
  const force = fof.forces[member.force];
  if (force && aim.kind === 'aimed') force.lastAimedFireAt = t;
  const dx = aim.point.x - shooter.position.x;
  const dy = aim.point.y - shooter.position.y;
  if (dx !== 0 || dy !== 0) shooter.azimuth = azimuthOf(dx, dy);
  events.push({
    type: 'fofFire',
    tick,
    atSeconds: t,
    shooterId: shooter.id,
    unitId: force?.unitId ?? '',
    side: shooter.side,
    kind: aim.kind,
    targetId: aim.target.id,
    aimPoint: { x: aim.point.x, y: aim.point.y },
    weapon: weapon.id,
    mode,
    rounds,
    rangeM: aim.rangeM,
    hitProbability: p,
    hit,
    hitId: hit && victim ? victim.id : null,
    incapacitated,
  });
  // Suppression where the burst lands.
  suppressAround(
    context,
    volley,
    member,
    aim.kind === 'aimed' ? aim.target.position : aim.point,
    aim.kind === 'aimed' ? aim.target.id : null,
    weapon.suppressionPerBurst,
    weapon.suppressionRadiusM,
  );
  if (hit && victim) {
    const victimMember = fof.soldiers[context.memberIndex.get(victim.id) ?? -1];
    if (victimMember) victimMember.stats.timesHit += 1;
  }
  if (incapacitated) volley.down.set(victim.id, { victim, by: shooter, force: member.force });
  onTarget(context, shooter, aim);
  // The burst that empties the feed starts the reload (or he is out).
  if (arm.loaded === 0 && !startReload(context, member, 0)) noteExhausted(context, member, 0);
  member.nextFireAt = t + nextInterval(context, member, weapon, mode, aim.kind);
  arm.readyAt = member.nextFireAt;
}

/** Seconds to the soldier's next burst: his weapon's mode, drawn, slower for leaders, suppressed or area fire. */
function nextInterval(
  context: FofContext,
  member: FofSoldier,
  weapon: FofWeapon,
  mode: 'sustained' | 'rapid',
  kind: 'aimed' | 'area',
): number {
  const { fire, suppression } = context.setup.config;
  return (
    drawSeconds(context, weapon[mode].secondsBetweenBursts) *
    (member.leader ? 1 / Math.max(1e-9, fire.leaderCadenceFactor) : 1) *
    (member.level !== 'none' ? suppression.suppressedCadenceFactor : 1) *
    (kind === 'area' ? fire.areaFireCadenceFactor : 1)
  );
}

// --- The grenade launcher (06 §4) ------------------------------------------------

/** The area effect of an arm, if it has one. */
function areaOf(context: FofContext, arm: FofWeaponState): AreaEffect | null {
  return weaponOf(context, arm).area;
}

/**
 * Whether the soldier fires his grenade launcher at `aim` now: loaded,
 * ready, the aim point in its envelope and in his sight, no friend near it,
 * and then by chance (never merely because an enemy is in range).
 */
function considerGrenade(
  context: FofContext,
  member: FofSoldier,
  arm: FofWeaponState,
  aim: Aim,
): boolean {
  const area = areaOf(context, arm);
  if (!area || arm.loaded <= 0 || context.t < arm.readyAt - 1e-9) return false;
  const weapon = weaponOf(context, arm);
  if (aim.rangeM < area.minRangeM || aim.rangeM > weapon.maxEngagementRangeM) return false;
  // Aimed fire has the target in sight; area fire's point was checked for sight.
  const { fof } = context;
  for (const friend of fof.soldiers) {
    if (friend === member || hostile(fof, member, friend)) continue;
    const s = soldierOf(context, friend);
    if (s.status !== 'active') continue;
    if (
      Math.hypot(s.position.x - aim.point.x, s.position.y - aim.point.y) < area.friendlyClearanceM
    )
      return false;
  }
  return nextFloat(context.state.rng) < area.employProbability[aim.kind];
}

/** Incapacitation probability of a soldier `d` metres from a burst (linear falloff, 06 §2). */
export function areaIncapacitation(area: AreaEffect, d: number): number {
  if (d >= area.maxEffectRadiusM) return 0;
  if (d <= area.casualtyRadiusM) {
    const k = area.casualtyRadiusM > 0 ? d / area.casualtyRadiusM : 1;
    return (
      area.incapacitationAtCentre +
      k * (area.incapacitationAtCasualtyRadius - area.incapacitationAtCentre)
    );
  }
  const span = area.maxEffectRadiusM - area.casualtyRadiusM;
  return (
    area.incapacitationAtCasualtyRadius * (span > 0 ? 1 - (d - area.casualtyRadiusM) / span : 0)
  );
}

/** Fires one grenade at `aim`: where it lands, whom it strikes down, whom it suppresses. */
function grenade(
  context: FofContext,
  volley: Volley,
  member: FofSoldier,
  shooter: Soldier,
  arm: FofWeaponState,
  aim: Aim,
): void {
  const { state, fof, t, events, tick, world } = context;
  const weapon = weaponOf(context, arm);
  const area = weapon.area;
  if (!area) return;
  // Where it lands: the aim point, displaced by its error (uniform in a disc).
  const spread = area.dispersionM.atZeroM + (aim.rangeM / 100) * area.dispersionM.per100M;
  const r = spread * Math.sqrt(nextFloat(state.rng));
  const angle = 2 * Math.PI * nextFloat(state.rng);
  const impact = { x: aim.point.x + r * Math.sin(angle), y: aim.point.y + r * Math.cos(angle) };
  arm.loaded -= 1;
  arm.fired += 1;
  arm.readyAt = t + area.minSecondsBetweenShots;
  member.lastFiredAt = t;
  member.stats.grenades += 1;
  fired(context, member, 0, false);
  const force = fof.forces[member.force];
  if (force) force.stats.grenades += 1;
  const dx = aim.point.x - shooter.position.x;
  const dy = aim.point.y - shooter.position.y;
  if (dx !== 0 || dy !== 0) shooter.azimuth = azimuthOf(dx, dy);
  // Everyone near the burst, of either side, unless cover stands between (a wall, a bank).
  const tracer = sightLineTracer(world.terrain);
  const burstZ = surfaceHeightAt(world.terrain, impact.x, impact.y) + 0.5;
  const casualties: SoldierId[] = [];
  let exposed = 0;
  for (const other of fof.soldiers) {
    const s = soldierOf(context, other);
    if (s.status !== 'active') continue;
    const d = Math.hypot(s.position.x - impact.x, s.position.y - impact.y);
    if (d >= area.maxEffectRadiusM) continue;
    const covered =
      d > 0.5 &&
      tracer.blocked(
        { x: impact.x, y: impact.y, z: burstZ },
        { x: s.position.x, y: s.position.y, z: s.position.z + 0.5 },
      );
    if (covered) continue;
    exposed += 1;
    const p =
      areaIncapacitation(area, d) *
      (s.posture === 'prone' ? area.proneFactor : 1) *
      dugInHit(context, s);
    if (nextFloat(state.rng) < p && !volley.down.has(s.id)) {
      casualties.push(s.id);
      other.stats.timesHit += 1;
      volley.down.set(s.id, { victim: s, by: shooter, force: member.force });
    }
  }
  events.push({
    type: 'fofGrenade',
    tick,
    atSeconds: t,
    shooterId: shooter.id,
    unitId: force?.unitId ?? '',
    side: shooter.side,
    kind: aim.kind,
    targetId: aim.target.id,
    aimPoint: { x: aim.point.x, y: aim.point.y },
    impact,
    weapon: weapon.id,
    rangeM: aim.rangeM,
    exposed,
    incapacitated: casualties,
  });
  suppressAround(
    context,
    volley,
    member,
    impact,
    null,
    weapon.suppressionPerBurst,
    weapon.suppressionRadiusM,
  );
  onTarget(context, shooter, aim);
  const index = member.arms.indexOf(arm);
  if (arm.loaded === 0 && !startReload(context, member, index))
    noteExhausted(context, member, index);
  const primary = member.arms[0];
  const rifle = primary ? weaponOf(context, primary) : weapon;
  member.nextFireAt =
    t + nextInterval(context, member, rifle, fireMode(context, member, aim.rangeM), aim.kind);
}

/**
 * Suppression recovers (halves every half-life), and crosses its thresholds
 * with hysteresis: reported, and a pinned soldier goes prone.
 */
export function updateSuppression(context: FofContext): void {
  const { fof, t, dt, setup, events, tick } = context;
  const config = setup.config.suppression;
  const decay = Math.pow(2, -dt / config.recoveryHalfLifeSeconds);
  for (const member of fof.soldiers) {
    const soldier = soldierOf(context, member);
    if (soldier.status !== 'active') continue;
    if (member.level !== 'none') member.stats.suppressedSeconds += dt;
    member.suppression *= decay;
    if (member.suppression < 1e-6) member.suppression = 0;
    const s = member.suppression;
    let level: SuppressionLevel = member.level;
    if (s >= config.pinnedAt) level = 'pinned';
    else if (level === 'pinned' && s < config.pinnedClearAt) {
      level = s >= config.suppressedClearAt ? 'suppressed' : 'none';
    } else if (level === 'none' && s >= config.suppressedAt) level = 'suppressed';
    else if (level === 'suppressed' && s < config.suppressedClearAt) level = 'none';
    if (level === member.level) continue;
    events.push({
      type: 'suppressionChanged',
      tick,
      atSeconds: t,
      soldierId: member.soldierId,
      from: member.level,
      to: level,
      suppression: s,
    });
    member.level = level;
    if (level === 'pinned') soldier.posture = 'prone';
  }
}
