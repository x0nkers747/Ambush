import type { Side } from '../state';
import {
  cancelTask,
  enter,
  halted,
  releaseHolds,
  resume,
  runningTask,
  standUp,
  withdraw,
  WITHDRAW_RETRY_S,
} from './force';
import { activeOrder, endOrder, failPlan } from './orders';
import { fofWeapon } from './config';
import type { FofContext } from './system';
import { roundsLeft } from './weapons';
import { forceActive, soldierOf } from './system';
import type { FofForce, FofOutcome, FofOutcomeKind } from './types';

// The engagement lifecycle (docs/behavior-lab/force-on-force/03 §7): when a
// force breaks contact or is spent, and how every experiment ends. Every run
// ends, by the stated rules, within `maxDurationSeconds`; no hit or casualty
// is ever invented to end it.

/** Each force's lifecycle decision: withdraw, withdrawn, ineffective. */
export function updateLifecycle(context: FofContext): void {
  const { t, setup } = context;
  const behavior = setup.config.force;
  const manual = setup.termination === 'manual';
  context.fof.forces.forEach((force) => {
    if (!forceActive(force)) return;
    const active = force.memberIds.some(
      (id) => context.state.soldiers[context.soldierIndex.get(id) ?? -1]?.status === 'active',
    );
    // Combat ineffective: terminal (once: a player may order it on again). In
    // a battle it is judged on lasting effectiveness (losses, ammunition,
    // leaders), not on suppression, which wears off.
    const judged = manual ? force.lastingEffectiveness : force.effectiveness;
    if (
      !active ||
      (!force.combatIneffective && judged < behavior.ineffectiveEffectiveness - 1e-12)
    ) {
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
      if (manual) {
        // No experiment to end: an ordered withdrawal goes to its point (its
        // order then ends), and so does a broken force's; one avoiding
        // contact ends once clear, holding.
        if (activeOrder(force)?.kind === 'withdraw') {
          if (!task) enter(context, force, 'atObjective', 'reached the withdrawal point');
        } else if (!task || (clear && quiet && !force.brokenWithdrawal)) {
          if (task) cancelTask(context, force);
          const why = task ? 'broke contact' : 'reached its withdrawal point';
          // Combat ineffective, fallen back: it stays down there until ordered on.
          if (force.combatIneffective && force.brokenWithdrawal) stayDown(context, force, why);
          else enter(context, force, 'holding', why);
        }
        return;
      }
      // Withdrawn (it carries on to its withdrawal point: the outcome is decided).
      if (!task || (clear && quiet)) {
        enter(context, force, 'withdrawn', task ? 'broke contact' : 'reached its withdrawal point');
      }
      return;
    }
    if (
      (!halted(force.phase) && force.phase !== 'assaulting') ||
      force.phase === 'possibleContact'
    ) {
      return;
    }
    // Holding clear of the enemy (it has broken contact): nothing to break off from.
    if (
      force.phase === 'holding' &&
      (force.lastContactAt === null ||
        t - force.lastContactAt >= behavior.withdrawnClearSeconds - 1e-9) &&
      (force.lastFiredUponAt === null ||
        t - force.lastFiredUponAt >= behavior.withdrawnClearSeconds - 1e-9)
    ) {
      return;
    }
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
    if (reason && (force.withdrawRetryAt === null || t >= force.withdrawRetryAt - 1e-9)) {
      // Nowhere to go now: it fights on where it is and tries again later.
      const home = force.actionsOn === 'withdraw' && !force.planned ? force.start : null;
      const order = force.planned ? activeOrder(force) : null;
      if (withdraw(context, force, reason, home, true)) {
        // Spent, breaking contact on its own: its order has failed; the next waits until it recovers.
        if (order) endOrder(context, force, order, 'failed', `broke contact: ${reason}`);
        if (force.planned) force.holdUntilRecovered = true;
      } else {
        force.withdrawRetryAt = t + WITHDRAW_RETRY_S;
        // An assault that cannot break off halts to fight where it is.
        if (force.phase === 'assaulting') {
          cancelTask(context, force);
          enter(context, force, 'contact', 'no way to break contact');
        }
      }
    }
  });
}

/** Share of the basic load a force has left. */
export function ammunitionShare(context: FofContext, force: FofForce): number {
  if (force.initialRounds <= 0) return 0;
  let rounds = 0;
  for (const member of context.fof.soldiers) {
    if (context.fof.forces[member.force] === force) rounds += roundsLeft(member);
  }
  return rounds / force.initialRounds;
}

/** Ends a force's movement where it is. */
function halt(context: FofContext, force: FofForce): void {
  cancelTask(context, force);
}

/**
 * The force is spent. In an experiment it stops, stays down and no longer
 * fires. In a battle, with soldiers left, it falls back out of the enemy's
 * reach first (`brokenWithdrawDistanceM`, holding its fire unless fired
 * upon), carrying on with a withdrawal it has begun; then it stays down there
 * (`stayDown`). With nowhere to go, it stays down where it is.
 */
function ineffective(context: FofContext, force: FofForce, reason: string): void {
  if (force.planned) failPlan(context, force, `squad combat ineffective (${reason})`);
  force.combatIneffective = true;
  if (context.setup.termination === 'manual' && reason !== 'no soldier left') {
    if (force.phase === 'withdrawing' && runningTask(context, force)) {
      force.brokenWithdrawal = true;
      return;
    }
    if (withdraw(context, force, `combat ineffective (${reason}): falling back`, null, true))
      return;
  }
  halt(context, force);
  stayDown(context, force, reason);
}

/** A combat-ineffective force where it is: down, holding its fire, until ordered on. */
function stayDown(context: FofContext, force: FofForce, reason: string): void {
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
 * Whether the experiment has ended, and how (checked after every decision,
 * in this order):
 *
 * 1. an invariant failed: `invalid`;
 * 2. a force combat ineffective: the other side's victory (both: mutual);
 * 3. a force withdrawn: its withdrawal (both, or the other withdrawing too:
 *    mutual disengagement);
 * 3b. never in contact, both done moving for `disengagementSeconds`: `noContact`;
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
  const problem = invariantProblem(context);
  if (problem) {
    end(context, 'invalid', 'invalid', problem);
    return;
  }
  // Ended by the player, not by rule: only an invariant ends it.
  if (setup.termination === 'manual') return;
  const [a, b] = fof.forces;
  if (!a || !b) return;
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
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) {
    if (x.phase !== 'withdrawn') continue;
    if (y.phase === 'withdrawing') {
      end(context, 'mutualDisengagement', 'decisive', 'both forces broke contact');
    } else {
      end(context, withdrawal(x.side), 'decisive', `${x.side} withdrew`);
    }
    return;
  }
  const contactEver = a.contactCycles + b.contactCycles > 0;
  // Both have done all their moving without ever coming into contact.
  if (
    !contactEver &&
    a.phase === 'atObjective' &&
    b.phase === 'atObjective' &&
    t - Math.max(a.phaseSince, b.phaseSince) >= term.disengagementSeconds - 1e-9
  ) {
    end(context, 'noContact', 'decisive', 'both forces completed their movement without contact');
    return;
  }
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
    else
      end(
        context,
        'noContact',
        'decisive',
        'maximum duration reached; neither force came into contact',
      );
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
    for (const arm of member.arms) {
      const weapon = fofWeapon(context.setup.config, arm.id);
      const counts = [arm.loaded, arm.reserve, arm.fired];
      if (!weapon || counts.some((n) => !(n >= 0) || !Number.isInteger(n))) {
        return `soldier ${member.soldierId} has ${String(arm.loaded)} + ${String(arm.reserve)} rounds of ${arm.id}`;
      }
      // Ammunition is conserved: nothing made or lost by firing and reloading.
      if (
        arm.loaded > weapon.capacity ||
        arm.loaded + arm.reserve + arm.fired !== weapon.basicLoadRounds
      ) {
        return `soldier ${member.soldierId}'s ${arm.id} has ${String(arm.loaded)} loaded, ${String(arm.reserve)} in reserve and ${String(arm.fired)} fired of ${String(weapon.basicLoadRounds)}`;
      }
    }
    if (member.reloadUntil !== null && !member.arms[member.reloading]) {
      return `soldier ${member.soldierId} reloads a weapon he does not have`;
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
  carryOn(context);
  context.events.push({ type: 'fofEnded', tick, atSeconds: t, outcome: record });
}

/**
 * The outcome decided, the forces carry on (no longer looking or firing):
 * a force withdrawing goes on to its withdrawal point; a force still in the
 * field resumes its movement order (an attacker, the one it had before
 * contact); a combat-ineffective force stays down.
 */
function carryOn(context: FofContext): void {
  for (const force of context.fof.forces) {
    releaseHolds(context, force);
    if (force.phase === 'ineffective') continue;
    if (force.phase === 'withdrawing' || force.phase === 'withdrawn') {
      standUp(context, force);
      continue;
    }
    if (force.phase === 'moving' || force.phase === 'atObjective') {
      standUp(context, force);
      continue;
    }
    cancelTask(context, force);
    resume(context, force, 'outcome decided: resuming its movement order');
  }
}
