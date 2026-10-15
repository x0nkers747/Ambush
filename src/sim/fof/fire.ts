import { surfaceHeightAt } from '../bridge-navigation';
import { hitProbabilityAt } from '../combat-config';
import { azimuthOf, type Vec2 } from '../geometry';
import { nextFloat } from '../rng';
import { sightLineTracer } from '../sight-tracer';
import type { Soldier } from '../state';
import { fofWeapon, type FofWeapon } from './config';
import { vegetationTransmission } from './detection';
import { enter, firingOnTheMove, underFire } from './force';
import type { FofContext } from './system';
import { soldierOf } from './system';
import type { FofSoldier, FofTrack, SuppressionLevel } from './types';

// Abstract fire (docs/behavior-lab/force-on-force/03 §5): a burst is a fire
// event, not a bullet. A soldier whose force is in contact (or assaulting or
// breaking contact, firing on the move at what he can see) fires when his
// next burst is due: aimed, at the nearest contact of his force he can see
// (within his weapon's range and the rules of engagement), or else area fire
// at the last known position of a contact seen recently. One draw decides
// whether the burst hits (the chance that any of its rounds does) and one
// more whether a hit incapacitates. Every burst suppresses the soldiers it
// lands near, hit or not.

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
  const { terrain } = context.world;
  const detection = context.setup.config.detection;
  const tracer = sightLineTracer(terrain);
  const eye = {
    x: shooter.position.x,
    y: shooter.position.y,
    z:
      surfaceHeightAt(terrain, shooter.position.x, shooter.position.y) +
      detection.eyeHeightM[shooter.posture],
  };
  const ground = surfaceHeightAt(terrain, target.position.x, target.position.y);
  const heights = detection.targetSampleHeightsM[target.posture];
  const clear = tracer.clearCount(
    eye,
    target.position.x,
    target.position.y,
    heights.map((h) => ground + h),
  );
  if (clear === 0) return 0;
  return (
    (clear / heights.length) * vegetationTransmission(terrain, shooter.position, target.position)
  );
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

/** Phases in which a force's soldiers fire. */
function firing(phase: string): boolean {
  return (
    phase === 'contact' ||
    phase === 'engaged' ||
    phase === 'holding' ||
    phase === 'withdrawing' ||
    phase === 'assaulting'
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
    { readonly victim: Soldier; readonly by: Soldier; readonly force: number }
  >;
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
      (!member.reacted && !firingOnTheMove(force.phase))
    ) {
      member.nextFireAt = null;
      return;
    }
    const weapon =
      member.weapon === null ? undefined : fofWeapon(context.setup.config, member.weapon);
    if (!weapon || member.rounds <= 0) {
      member.nextFireAt = null;
      return;
    }
    // Breaking contact, a soldier keeps his last rounds (below the withdrawal share of his load).
    if (
      force.phase === 'withdrawing' &&
      member.rounds < weapon.basicLoadRounds * context.setup.config.force.withdrawAmmunitionFraction
    ) {
      member.nextFireAt = null;
      return;
    }
    // Pinned: no fire; look again shortly.
    if (member.level === 'pinned') {
      member.nextFireAt = t + 1;
      return;
    }
    if (aimedBurst(context, volley, member, shooter, weapon)) return;
    if (areaBurst(context, volley, member, shooter, weapon)) return;
    member.nextFireAt = t + 1;
  });
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
    }
    const shooterForce = fof.forces[force];
    if (shooterForce) shooterForce.stats.casualtiesInflicted += 1;
    events.push({
      type: 'soldierIncapacitated',
      tick,
      atSeconds: t,
      soldierId: victim.id,
      byId: by.id,
    });
  }
}

/** The nearest engageable contact the shooter can see, in range: fire at him. */
function aimedBurst(
  context: FofContext,
  volley: Volley,
  member: FofSoldier,
  shooter: Soldier,
  weapon: FofWeapon,
): boolean {
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
  candidates.sort(
    (a, b) =>
      a.range - b.range ||
      (context.soldierIndex.get(a.target.id) ?? 0) - (context.soldierIndex.get(b.target.id) ?? 0),
  );
  for (const { target, range } of candidates) {
    const seen = exposure(context, shooter, target);
    if (seen <= 0) continue;
    const pRound =
      hitProbabilityAt(weapon, range) *
      context.setup.config.fire.postureHitMultipliers[target.posture] *
      seen *
      shooterFactor(context, member);
    burst(
      context,
      volley,
      member,
      shooter,
      weapon,
      'aimed',
      target,
      target.position,
      range,
      pRound,
      target,
    );
    return true;
  }
  return false;
}

/** Area fire at the last known position of an engageable contact seen recently, in range and in sight. */
function areaBurst(
  context: FofContext,
  volley: Volley,
  member: FofSoldier,
  shooter: Soldier,
  weapon: FofWeapon,
): boolean {
  const { fof, t, setup } = context;
  const memory = setup.config.fire.areaFireMemorySeconds;
  if (memory <= 0) return false;
  let best: { track: FofTrack; range: number } | null = null;
  for (const track of fof.tracks) {
    if (track.force !== member.force || !track.confirmed || !engageable(context, track)) continue;
    if (t - track.lastSeenAt > memory) continue;
    const range = Math.hypot(
      track.lastKnown.x - shooter.position.x,
      track.lastKnown.y - shooter.position.y,
    );
    if (range > weapon.maxEngagementRangeM) continue;
    if (best === null || range < best.range) best = { track, range };
  }
  if (!best || !pointInSight(context, shooter, best.track.lastKnown)) return false;
  const aim = best.track.lastKnown;
  // Who is near the aim point (truth: rounds land where they land), if anyone in sight.
  let near: Soldier | null = null;
  let nearD = weapon.suppressionRadiusM;
  for (const enemy of fof.soldiers) {
    if (enemy.force === member.force) continue;
    const s = soldierOf(context, enemy);
    if (s.status !== 'active') continue;
    const d = Math.hypot(s.position.x - aim.x, s.position.y - aim.y);
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
        setup.config.fire.areaFireHitFactor *
        seen *
        shooterFactor(context, member)
      : 0;
  const target = context.state.soldiers[context.soldierIndex.get(best.track.targetId) ?? -1];
  if (!target) return false;
  burst(context, volley, member, shooter, weapon, 'area', target, aim, best.range, pRound, near);
  return true;
}

/** The shooter's own accuracy: suppression and moving. */
function shooterFactor(context: FofContext, member: FofSoldier): number {
  const { fire, suppression } = context.setup.config;
  const steady = 1 - suppression.accuracyLoss * member.suppression;
  return Math.max(0, steady) * (member.speed > 0.3 ? fire.movingShooterFactor : 1);
}

/** Resolves and records one burst. */
function burst(
  context: FofContext,
  volley: Volley,
  member: FofSoldier,
  shooter: Soldier,
  weapon: FofWeapon,
  kind: 'aimed' | 'area',
  target: Soldier,
  aimPoint: Vec2,
  rangeM: number,
  pRound: number,
  victim: Soldier | null,
): void {
  const { state, fof, t, setup, events, tick } = context;
  const rounds = Math.min(member.rounds, weapon.roundsPerBurst);
  const p = victim ? 1 - Math.pow(1 - Math.min(1, Math.max(0, pRound)), rounds) : 0;
  const hit = nextFloat(state.rng) < p;
  const drawn = hit && nextFloat(state.rng) < weapon.incapacitationProbabilityOnHit;
  // A soldier already struck down by an earlier burst of this volley falls only once.
  const incapacitated = drawn && victim !== null && !volley.down.has(victim.id);
  member.rounds -= rounds;
  member.lastFiredAt = t;
  member.stats.bursts += 1;
  member.stats.rounds += rounds;
  if (hit) member.stats.hits += 1;
  const force = fof.forces[member.force];
  if (force) {
    force.stats.bursts += 1;
    force.stats.rounds += rounds;
    if (hit) force.stats.hits += 1;
    force.lastFireAt = t;
    force.firstFireAt ??= t;
    if (force.phase === 'contact') {
      // Exchanging fire.
      enter(context, force, 'engaged', 'opened fire');
    }
  }
  const dx = aimPoint.x - shooter.position.x;
  const dy = aimPoint.y - shooter.position.y;
  if (dx !== 0 || dy !== 0) shooter.azimuth = azimuthOf(dx, dy);
  const targetMember = fof.soldiers[context.memberIndex.get(target.id) ?? -1];
  if (targetMember && kind === 'aimed') targetMember.stats.timesTargeted += 1;
  events.push({
    type: 'fofFire',
    tick,
    atSeconds: t,
    shooterId: shooter.id,
    unitId: force?.unitId ?? '',
    side: shooter.side,
    kind,
    targetId: target.id,
    aimPoint: { x: aimPoint.x, y: aimPoint.y },
    weapon: weapon.id,
    rounds,
    rangeM,
    hitProbability: p,
    hit,
    hitId: hit && victim ? victim.id : null,
    incapacitated,
  });
  // Suppression where the burst lands.
  const impact = kind === 'aimed' ? target.position : aimPoint;
  for (const enemy of fof.soldiers) {
    if (enemy.force === member.force) continue;
    const s = soldierOf(context, enemy);
    if (s.status !== 'active') continue;
    const d = Math.hypot(s.position.x - impact.x, s.position.y - impact.y);
    const share =
      kind === 'aimed' && s.id === target.id
        ? 1
        : d < weapon.suppressionRadiusM
          ? 1 - d / weapon.suppressionRadiusM
          : 0;
    if (share <= 0) continue;
    const prone = s.posture === 'prone' ? setup.config.suppression.proneSuppressionFactor : 1;
    volley.suppression.set(
      enemy,
      (volley.suppression.get(enemy) ?? 0) + weapon.suppressionPerBurst * share * prone,
    );
  }
  if (hit && victim) {
    const victimMember = fof.soldiers[context.memberIndex.get(victim.id) ?? -1];
    if (victimMember) victimMember.stats.timesHit += 1;
  }
  if (incapacitated) volley.down.set(victim.id, { victim, by: shooter, force: member.force });
  // The force fired on reacts to the fire, and learns roughly where it comes from.
  const targetForce = targetMember ? targetMember.force : -1;
  if (targetForce >= 0) underFire(context, targetForce, shooter);
  member.nextFireAt = t + nextInterval(context, member, weapon, kind);
}

/** Seconds to the soldier's next burst: the weapon's cadence, varied, slower for leaders, suppressed or area fire. */
function nextInterval(
  context: FofContext,
  member: FofSoldier,
  weapon: FofWeapon,
  kind: 'aimed' | 'area',
): number {
  const { fire, suppression } = context.setup.config;
  const jitter =
    fire.cadenceJitter.min +
    nextFloat(context.state.rng) * (fire.cadenceJitter.max - fire.cadenceJitter.min);
  return (
    weapon.secondsBetweenBursts *
    jitter *
    (member.leader ? 1 / Math.max(1e-9, fire.leaderCadenceFactor) : 1) *
    (member.level !== 'none' ? suppression.suppressedCadenceFactor : 1) *
    (kind === 'area' ? fire.areaFireCadenceFactor : 1)
  );
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
