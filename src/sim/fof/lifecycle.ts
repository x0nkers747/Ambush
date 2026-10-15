import { nearestInArea } from '../behavior/slots';
import { azimuthOf, normalizeAzimuth, type Vec2 } from '../geometry';
import { navArea } from '../navigation';
import { isOnTerrain } from '../terrain';
import type { Side } from '../state';
import { cancelTask, centreOf, enter, halted, issue, runningTask, standUp } from './force';
import type { FofContext } from './system';
import { forceActive, soldierOf } from './system';
import type { FofForce, FofOutcome, FofOutcomeKind } from './types';

// The engagement lifecycle (docs/behavior-lab/force-on-force/03 §7): when a
// force breaks contact or is spent, and how every experiment ends. Every run
// ends, by the stated rules, within `maxDurationSeconds`; no hit or casualty
// is ever invented to end it.

/** Headings tried for a withdrawal, in degrees from straight away from the threat. */
const WITHDRAW_OFFSETS_DEG: readonly number[] = [0, 30, -30, 60, -60, 90, -90];

/** Each force's lifecycle decision: withdraw, withdrawn, ineffective. */
export function updateLifecycle(context: FofContext): void {
  const { t, setup } = context;
  const behavior = setup.config.force;
  context.fof.forces.forEach((force) => {
    if (!forceActive(force)) return;
    const active = force.memberIds.some(
      (id) => context.state.soldiers[context.soldierIndex.get(id) ?? -1]?.status === 'active',
    );
    // Combat ineffective: terminal.
    if (!active || force.effectiveness < behavior.ineffectiveEffectiveness - 1e-12) {
      ineffective(
        context,
        force,
        active ? 'effectiveness below the ineffective threshold' : 'no soldier left',
      );
      return;
    }
    // Suppressed over time.
    if (force.meanSuppression >= behavior.withdrawSuppression) force.suppressedSince ??= t;
    else force.suppressedSince = null;
    if (force.phase === 'withdrawing') {
      const task = runningTask(context, force);
      const clear =
        force.lastContactAt === null ||
        t - force.lastContactAt >= behavior.withdrawnClearSeconds - 1e-9;
      const quiet =
        force.lastFiredUponAt === null ||
        t - force.lastFiredUponAt >= behavior.withdrawnClearSeconds - 1e-9;
      if (!task || (clear && quiet)) {
        if (task) halt(context, force);
        enter(context, force, 'withdrawn', task ? 'broke contact' : 'reached its withdrawal point');
      }
      return;
    }
    if (!halted(force.phase) || force.phase === 'possibleContact') return;
    const ammunition = ammunitionShare(context, force);
    const reason =
      force.effectiveness < behavior.withdrawEffectiveness
        ? 'effectiveness below the withdrawal threshold'
        : force.suppressedSince !== null &&
            t - force.suppressedSince >= behavior.withdrawSuppressedSeconds - 1e-9
          ? 'suppressed too long'
          : ammunition < behavior.withdrawAmmunitionFraction
            ? 'ammunition low'
            : null;
    if (reason) withdraw(context, force, reason);
  });
}

/** Share of the basic load a force has left. */
export function ammunitionShare(context: FofContext, force: FofForce): number {
  if (force.initialRounds <= 0) return 0;
  let rounds = 0;
  for (const member of context.fof.soldiers) {
    if (context.fof.forces[member.force] === force) rounds += member.rounds;
  }
  return rounds / force.initialRounds;
}

/** Ends a force's movement where it is. */
function halt(context: FofContext, force: FofForce): void {
  cancelTask(context, force);
}

/** The force is spent: it stops, stays down and no longer fires. */
function ineffective(context: FofContext, force: FofForce, reason: string): void {
  halt(context, force);
  for (const id of force.memberIds) {
    const member = context.fof.soldiers[context.memberIndex.get(id) ?? -1];
    const soldier = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (!member || soldier?.status !== 'active') continue;
    member.nextFireAt = null;
    member.reactAt = null;
    soldier.posture = 'prone';
  }
  enter(context, force, 'ineffective', reason);
}

/**
 * Breaks contact: orders the force `withdrawDistanceM` away from the threat
 * it knows of (the first heading of `WITHDRAW_OFFSETS_DEG` with ground it
 * can reach), in its formation, through the movement engine. With nowhere
 * to go it stays where it is.
 */
function withdraw(context: FofContext, force: FofForce, reason: string): void {
  const { world, setup } = context;
  const centre = centreOf(context, force);
  if (!centre) return;
  const forceSetup = setup.forces.find((f) => f.unitId === force.unitId);
  const formation = force.mission?.formation ?? forceSetup?.formation;
  if (!formation) return;
  // A member standing on routable ground: the withdrawal must be reachable from there.
  let area = 0;
  for (const id of force.memberIds) {
    const s = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (s?.status !== 'active') continue;
    area = navArea(world.terrain, s.position);
    if (area > 0) break;
  }
  if (area === 0) return;
  // Away from the threat it knows of; without one, back the way it faces.
  const threat = force.threat;
  const facing = context.state.soldiers[context.soldierIndex.get(force.memberIds[0] ?? '') ?? -1];
  const away =
    threat && (threat.x !== centre.x || threat.y !== centre.y)
      ? azimuthOf(centre.x - threat.x, centre.y - threat.y)
      : normalizeAzimuth((facing?.azimuth ?? 0) + Math.PI);
  const distance = setup.config.force.withdrawDistanceM;
  for (const offset of WITHDRAW_OFFSETS_DEG) {
    const heading = away + (offset * Math.PI) / 180;
    const to: Vec2 = {
      x: centre.x + Math.sin(heading) * distance,
      y: centre.y + Math.cos(heading) * distance,
    };
    if (!isOnTerrain(world.terrain, to.x, to.y)) continue;
    const point = nearestInArea(world.terrain, to, area);
    if (!point) continue;
    standUp(context, force);
    const ok = issue(context, force, {
      kind: 'moveInFormation',
      destination: point,
      formation,
      ...(forceSetup?.pace !== undefined ? { pace: forceSetup.pace } : {}),
    });
    if (!ok) continue;
    enter(context, force, 'withdrawing', reason);
    return;
  }
}

/**
 * Whether the experiment has ended, and how (checked after every decision,
 * in this order):
 *
 * 1. an invariant failed: `invalid`;
 * 2. a force combat ineffective: the other side's victory (both: mutual);
 * 3. a force withdrawn: its withdrawal (both: mutual disengagement);
 * 4. after contact, neither in contact nor firing for `disengagementSeconds`:
 *    mutual disengagement;
 * 5. both nearly out of ammunition: stalemate (adjudicated);
 * 6. a stalemate window with no casualties, lasting effectiveness (without
 *    suppression, which comes and goes) flat, and both
 *    suppressed, or no hits, or repeated contact cycles: stalemate (adjudicated);
 * 7. the time limit: `timeLimit` (adjudicated), or `noContact` if there never was any.
 */
export function adjudicate(context: FofContext): void {
  const { fof, t, setup } = context;
  const term = setup.config.termination;
  const [a, b] = fof.forces;
  if (!a || !b) return;
  const problem = invariantProblem(context);
  if (problem) {
    end(context, 'invalid', 'invalid', problem);
    return;
  }
  const sideOf = (f: FofForce) => f.side;
  const victory = (winner: Side): FofOutcomeKind =>
    winner === 'BLUEFOR' ? 'blueforVictory' : 'opforVictory';
  const withdrawal = (side: Side): FofOutcomeKind =>
    side === 'BLUEFOR' ? 'blueforWithdrawal' : 'opforWithdrawal';
  if (a.phase === 'ineffective' && b.phase === 'ineffective') {
    end(context, 'mutualIneffective', 'decisive', 'both forces combat ineffective');
    return;
  }
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) {
    if (x.phase === 'ineffective') {
      end(context, victory(sideOf(y)), 'decisive', `${x.side} combat ineffective`);
      return;
    }
  }
  if (a.phase === 'withdrawn' && b.phase === 'withdrawn') {
    end(context, 'mutualDisengagement', 'decisive', 'both forces withdrew');
    return;
  }
  for (const x of [a, b]) {
    if (x.phase === 'withdrawn') {
      end(context, withdrawal(x.side), 'decisive', `${x.side} withdrew`);
      return;
    }
  }
  const contactEver = a.contactCycles + b.contactCycles > 0;
  const quietSince = (f: FofForce) =>
    Math.max(
      f.lastContactAt ?? -Infinity,
      f.lastFireAt ?? -Infinity,
      f.lastFiredUponAt ?? -Infinity,
    );
  const inContact = (f: FofForce) => f.phase === 'contact' || f.phase === 'engaged';
  if (
    contactEver &&
    !inContact(a) &&
    !inContact(b) &&
    t - Math.max(quietSince(a), quietSince(b)) >= term.disengagementSeconds - 1e-9
  ) {
    end(context, 'mutualDisengagement', 'decisive', 'contact broken off on both sides');
    return;
  }
  if (
    contactEver &&
    ammunitionShare(context, a) < term.ammunitionExhaustedFraction &&
    ammunitionShare(context, b) < term.ammunitionExhaustedFraction
  ) {
    end(context, 'stalemate', 'adjudicated', 'ammunition exhausted on both sides');
    return;
  }
  if (stalemate(context)) return;
  if (t >= term.maxDurationSeconds - 1e-9) {
    if (contactEver) end(context, 'timeLimit', 'adjudicated', 'maximum duration reached');
    else end(context, 'noContact', 'decisive', 'maximum duration reached without contact');
  }
}

/** The stalemate window: evaluated each time it is full, then started again. */
function stalemate(context: FofContext): boolean {
  const { fof, t, setup } = context;
  const term = setup.config.termination;
  const forces = fof.forces;
  if (!forces.some((f) => f.contactCycles > 0)) return false;
  const casualties = countCasualties(context);
  const hits = forces.reduce((s, f) => s + f.stats.hits, 0);
  const cycles = forces.reduce((s, f) => s + f.contactCycles, 0);
  const start = () => {
    fof.stalemate = {
      startAt: t,
      effectiveness: forces.map((f) => f.lastingEffectiveness),
      casualties,
      hits,
      contactCycles: cycles,
    };
  };
  const span = fof.stalemate;
  if (!span) {
    start();
    return false;
  }
  if (t - span.startAt < term.stalemateWindowSeconds - 1e-9) return false;
  const flat = forces.every(
    (f, i) =>
      Math.abs(f.lastingEffectiveness - (span.effectiveness[i] ?? 0)) <
      term.stalemateEffectivenessChange,
  );
  const noCasualties = casualties === span.casualties;
  const bothSuppressed = forces.every((f) => f.meanSuppression >= term.stalemateSuppression);
  const noHits = hits === span.hits;
  const cycling = cycles - span.contactCycles >= term.stalemateContactCycles;
  if (noCasualties && flat && (bothSuppressed || noHits || cycling)) {
    const why = bothSuppressed
      ? 'both forces suppressed'
      : noHits
        ? 'no hits'
        : 'contact repeatedly regained and lost';
    end(
      context,
      'stalemate',
      'adjudicated',
      `no casualties and no change in effectiveness for ${String(term.stalemateWindowSeconds)} s; ${why}`,
    );
    return true;
  }
  start();
  return false;
}

function countCasualties(context: FofContext): number {
  let n = 0;
  for (const member of context.fof.soldiers) {
    if (soldierOf(context, member).status !== 'active') n += 1;
  }
  return n;
}

/** A broken invariant, in words, or `null`. */
function invariantProblem(context: FofContext): string | null {
  const { fof } = context;
  for (const member of fof.soldiers) {
    const soldier = soldierOf(context, member);
    if (!(member.rounds >= 0) || !Number.isInteger(member.rounds)) {
      return `soldier ${member.soldierId} has ${String(member.rounds)} rounds`;
    }
    if (!(member.suppression >= 0 && member.suppression <= 1)) {
      return `soldier ${member.soldierId} has suppression ${String(member.suppression)}`;
    }
    if (soldier.status !== 'active' && member.nextFireAt !== null) {
      return `incapacitated soldier ${member.soldierId} has a burst due`;
    }
  }
  for (const force of fof.forces) {
    if (!Number.isFinite(force.effectiveness))
      return `force ${force.unitId} effectiveness is not finite`;
    if (halted(force.phase) && runningTask(context, force)) {
      return `force ${force.unitId} is halted (${force.phase}) but has a movement task`;
    }
  }
  return null;
}

/** Records the outcome and ends the experiment. */
function end(
  context: FofContext,
  outcome: FofOutcomeKind,
  basis: FofOutcome['basis'],
  reason: string,
): void {
  const { fof, t, tick, setup } = context;
  const effectiveness = { BLUEFOR: 0, OPFOR: 0 };
  const casualties = { BLUEFOR: 0, OPFOR: 0 };
  for (const force of fof.forces) effectiveness[force.side] = force.effectiveness;
  for (const member of fof.soldiers) {
    const soldier = soldierOf(context, member);
    if (soldier.status !== 'active') casualties[soldier.side] += 1;
  }
  const margin = setup.config.termination.advantageMargin;
  const lead = effectiveness.BLUEFOR - effectiveness.OPFOR;
  const advantage: Side | null =
    basis !== 'adjudicated' ? null : lead >= margin ? 'BLUEFOR' : -lead >= margin ? 'OPFOR' : null;
  const record: FofOutcome = {
    outcome,
    basis,
    reason,
    tick,
    atSeconds: t,
    advantage,
    casualties,
    effectiveness,
  };
  fof.outcome = record;
  for (const member of fof.soldiers) member.nextFireAt = null;
  context.events.push({ type: 'fofEnded', tick, atSeconds: t, outcome: record });
}
