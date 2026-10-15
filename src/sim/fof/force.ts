import { applyOrderUnit } from '../behavior/orders';
import { azimuthOf, type Vec2 } from '../geometry';
import { nextFloat } from '../rng';
import { orgUnitId, type Soldier } from '../state';
import type { UnitOrder } from '../behavior/types';
import { confidenceAt } from './detection';
import type { FofContext } from './system';
import { forceActive, glimpse, setLevel, soldierOf } from './system';
import type { FofForce, ForcePhase, ObservationLevel } from './types';

// Organizational contact behavior (docs/behavior-lab/force-on-force/03 §4).
// One small state machine per force, over its own picture (its tracks), never
// over the truth. The force decides; its soldiers carry it out (posture,
// facing, fire), each after his own reaction delay. Movement is the Behavior
// Lab's: halting cancels the force's unit task, resuming re-issues the
// movement order it was on.
//
//   moving / atObjective ─ possible or distant contact ─▶ possibleContact (halt, kneel, observe)
//   possibleContact ─ hold over, nothing close ─▶ moving (alert) / atObjective
//   any ─ confirmed contact within engageRangeM, or under fire ─▶ contact (halt, take cover, engage)
//   contact ─ fire exchanged ─▶ engaged
//   contact / engaged ─ no contact and no fire for contactLostSeconds ─▶ holding
//   holding ─ contact again ─▶ contact;  ─ resumeAfterSeconds ─▶ moving (mission)
//
// Withdrawal and combat ineffectiveness (terminal) are added by the
// engagement lifecycle (`lifecycle.ts`).

/** Phases in which the force is halted in place (no unit task). */
export function halted(phase: ForcePhase): boolean {
  return (
    phase === 'possibleContact' || phase === 'contact' || phase === 'engaged' || phase === 'holding'
  );
}

/** Each force's decision, in force order. */
export function updateForces(context: FofContext): void {
  const { t, setup } = context;
  const behavior = setup.config.force;
  context.fof.forces.forEach((force, i) => {
    if (!forceActive(force)) return;
    const picture = pictureOf(context, i);
    if (picture.confirmed) force.lastContactAt = t;
    if (picture.identified) force.hostile = true;
    force.threat = picture.threat;
    const close = picture.nearestConfirmed <= behavior.engageRangeM;
    switch (force.phase) {
      case 'moving':
      case 'atObjective':
        if (close) halt(context, force, 'contact', 'contact within engagement range');
        else if (
          picture.newSince(force.observedUntil) &&
          (force.observedUntil === 0 || t - force.observedUntil >= behavior.reobserveSeconds - 1e-9)
        ) {
          halt(
            context,
            force,
            'possibleContact',
            picture.confirmed ? 'distant contact' : 'possible contact',
          );
        } else if (force.phase === 'moving' && !runningTask(context, force)) {
          enter(context, force, 'atObjective', 'arrived');
        }
        break;
      case 'possibleContact':
        if (close) {
          halt(context, force, 'contact', 'contact within engagement range');
        } else if (t - force.phaseSince >= behavior.possibleContactHoldSeconds - 1e-9) {
          force.observedUntil = t;
          resume(
            context,
            force,
            picture.confirmed ? 'contact distant: carrying on' : 'nothing confirmed',
          );
        }
        break;
      case 'contact':
      case 'engaged': {
        const quiet = (at: number | null) =>
          at === null || t - at >= behavior.contactLostSeconds - 1e-9;
        if (quiet(force.lastContactAt) && quiet(force.lastFireAt) && quiet(force.lastFiredUponAt)) {
          enter(context, force, 'holding', 'contact lost');
        }
        break;
      }
      case 'holding':
        if (close) {
          halt(context, force, 'contact', 'contact regained');
        } else if (
          t - force.phaseSince >= behavior.resumeAfterSeconds - 1e-9 &&
          force.effectiveness >= behavior.resumeEffectiveness
        ) {
          force.observedUntil = t;
          resume(context, force, 'contact lost: resuming the mission');
        }
        break;
      case 'withdrawing':
      case 'withdrawn':
      case 'ineffective':
        break;
    }
  });
  context.fof.forces.forEach((force) => {
    if (forceActive(force)) carryOut(context, force);
  });
}

/** What a force believes: its contacts' nearest range, new possible contacts, and where the threat is. */
function pictureOf(context: FofContext, force: number) {
  const { fof, t } = context;
  const own = fof.forces[force];
  const centre = own ? centreOf(context, own) : null;
  let confirmed = false;
  let identified = false;
  let nearestConfirmed = Infinity;
  let sx = 0;
  let sy = 0;
  let n = 0;
  const firsts: number[] = [];
  for (const track of fof.tracks) {
    if (track.force !== force) continue;
    const current = track.level !== 'lost';
    if (track.level === 'detected' || track.level === 'identified') {
      confirmed = true;
      if (centre) {
        nearestConfirmed = Math.min(
          nearestConfirmed,
          Math.hypot(track.lastKnown.x - centre.x, track.lastKnown.y - centre.y),
        );
      }
    }
    if (track.level === 'identified') identified = true;
    if (current) {
      sx += track.lastKnown.x;
      sy += track.lastKnown.y;
      n += 1;
      firsts.push(track.firstAt);
    }
  }
  if (n === 0) {
    // Only lost contacts: the threat is where they were last seen.
    for (const track of fof.tracks) {
      if (track.force !== force) continue;
      sx += track.lastKnown.x;
      sy += track.lastKnown.y;
      n += 1;
    }
  }
  return {
    confirmed,
    identified,
    nearestConfirmed,
    threat: n > 0 ? { x: sx / n, y: sy / n } : null,
    newSince: (since: number) => firsts.some((f) => f > since + 1e-9) && t > since,
  };
}

/** Where a force's active soldiers are on average, or `null`. */
export function centreOf(context: FofContext, force: FofForce): Vec2 | null {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const id of force.memberIds) {
    const s = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (s?.status !== 'active') continue;
    x += s.position.x;
    y += s.position.y;
    n += 1;
  }
  return n > 0 ? { x: x / n, y: y / n } : null;
}

/** The force's running unit task, if any. */
export function runningTask(context: FofContext, force: FofForce) {
  return context.state.behavior?.tasks.find((t) => t.unitId === force.unitId && t.outcome === null);
}

/**
 * Halts the force in `phase`: its movement order is kept as its mission and
 * its unit task cancelled; each soldier will react after his own delay.
 */
export function halt(
  context: FofContext,
  force: FofForce,
  phase: ForcePhase,
  reason: string,
): void {
  const { state, t } = context;
  const task = runningTask(context, force);
  if (task && force.phase !== 'withdrawing') force.mission = task.order;
  cancelTask(context, force);
  const entering = phase === 'contact' && force.phase !== 'contact' && force.phase !== 'engaged';
  if (entering) force.contactCycles += 1;
  enter(context, force, phase, reason);
  // Reaction delays, drawn in soldier order.
  const delay = context.setup.config.force.reactionDelay;
  for (const id of force.memberIds) {
    const member = context.fof.soldiers[context.memberIndex.get(id) ?? -1];
    const soldier = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (!member || soldier?.status !== 'active') continue;
    member.reactAt =
      t + delay.minSeconds + nextFloat(state.rng) * (delay.maxSeconds - delay.minSeconds);
    member.reacted = false;
    member.nextFireAt = null;
  }
}

/** Cancels the force's unit task, if it has one (the movement engine's own cancel). */
export function cancelTask(context: FofContext, force: FofForce): void {
  if (!runningTask(context, force)) return;
  applyOrderUnit(
    context.state,
    context.world,
    { type: 'orderUnit', tick: context.state.tick, unitId: orgUnitId(force.unitId), order: null },
    context.t,
    context.events,
  );
}

/** Resumes the force's mission (or ends its halt where it is, without one). */
export function resume(context: FofContext, force: FofForce, reason: string): void {
  standUp(context, force);
  if (force.mission && issue(context, force, force.mission)) {
    enter(context, force, 'moving', reason);
  } else {
    enter(context, force, 'atObjective', reason);
  }
}

/** Issues a movement order to the force (as the movement engine's own `orderUnit`). Returns whether it took. */
export function issue(context: FofContext, force: FofForce, order: UnitOrder): boolean {
  const { state } = context;
  const before = state.behavior?.tasks.length ?? 0;
  const events: typeof context.events = [];
  applyOrderUnit(
    state,
    context.world,
    { type: 'orderUnit', tick: state.tick, unitId: orgUnitId(force.unitId), order },
    context.t,
    events,
  );
  context.events.push(...events);
  return (
    !events.some((e) => e.type === 'commandRejected') &&
    (state.behavior?.tasks.length ?? 0) >= before &&
    runningTask(context, force) !== undefined
  );
}

/** The force's soldiers stand, stop firing and are no longer held. */
export function standUp(context: FofContext, force: FofForce): void {
  for (const id of force.memberIds) {
    const member = context.fof.soldiers[context.memberIndex.get(id) ?? -1];
    const soldier = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (!member || soldier?.status !== 'active') continue;
    member.reactAt = null;
    member.reacted = false;
    member.nextFireAt = null;
    soldier.posture = 'standing';
  }
}

/**
 * The soldiers carry out their force's state: halted, each takes up his
 * posture once his reaction delay is over (kneeling to observe; prone in
 * contact, leaders kneeling to see and command; pinned soldiers prone), faces
 * the nearest contact he knows of, and (in contact) begins to fire. On the
 * move, a pinned soldier is held where he is until he recovers.
 */
function carryOut(context: FofContext, force: FofForce): void {
  const { t, fof } = context;
  const stopped = halted(force.phase);
  for (const id of force.memberIds) {
    const member = fof.soldiers[context.memberIndex.get(id) ?? -1];
    const soldier = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (!member || soldier?.status !== 'active') continue;
    hold(context, soldier, !stopped && member.level === 'pinned');
    if (!stopped) {
      if (member.level === 'pinned') soldier.posture = 'prone';
      else if (soldier.posture !== 'standing' && member.level === 'none')
        soldier.posture = 'standing';
      continue;
    }
    if (!member.reacted && member.reactAt !== null && t >= member.reactAt - 1e-9) {
      member.reacted = true;
      member.reactAt = null;
      if (force.phase !== 'possibleContact' && member.weapon !== null && member.rounds > 0) {
        member.nextFireAt = t;
      }
    }
    if (!member.reacted) continue;
    soldier.posture =
      member.level === 'pinned'
        ? 'prone'
        : force.phase === 'possibleContact' || member.leader
          ? 'kneeling'
          : 'prone';
    // Contact phases that began before he reacted: fire once reacted.
    if (
      (force.phase === 'contact' || force.phase === 'engaged') &&
      member.nextFireAt === null &&
      member.weapon !== null &&
      member.rounds > 0
    ) {
      member.nextFireAt = t;
    }
    const look = nearestKnown(context, member.force, soldier) ?? force.threat;
    if (look) {
      const dx = look.x - soldier.position.x;
      const dy = look.y - soldier.position.y;
      if (dx !== 0 || dy !== 0) soldier.azimuth = azimuthOf(dx, dy);
    }
  }
}

/** Holds (or releases) a soldier steered by a unit task in place. */
function hold(context: FofContext, soldier: Soldier, on: boolean): void {
  const agent = context.state.behavior?.agents.find((a) => a.soldierId === soldier.id);
  if (!agent) return;
  if (on && agent.override === null) agent.override = { kind: 'hold' };
  else if (!on && agent.override?.kind === 'hold') agent.override = null;
}

/** The last known position of the nearest contact (not lost) of the force, from a soldier. */
function nearestKnown(context: FofContext, force: number, from: Soldier): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const track of context.fof.tracks) {
    if (track.force !== force || track.level === 'lost') continue;
    const d = Math.hypot(track.lastKnown.x - from.position.x, track.lastKnown.y - from.position.y);
    if (d < bestD) {
      bestD = d;
      best = track.lastKnown;
    }
  }
  return best;
}

/**
 * A force comes under fire from `shooter`: hostile intent is established, it
 * gets a cue on the shooter (sound, impacts), and unless it is breaking
 * contact or done, it halts in contact.
 */
export function underFire(context: FofContext, force: number, shooter: Soldier): void {
  const own = context.fof.forces[force];
  if (!own || !forceActive(own)) return;
  own.lastFiredUponAt = context.t;
  own.hostile = true;
  const detection = context.setup.config.detection;
  const existing = context.fof.tracks.find(
    (tr) => tr.force === force && tr.targetId === shooter.id,
  );
  const now = existing ? confidenceAt(existing, context.t, detection.confidenceHalfLifeSeconds) : 0;
  if (now < detection.underFireConfidence) {
    const from: ObservationLevel = existing?.level ?? 'unaware';
    const track = glimpse(
      context,
      force,
      shooter,
      existing,
      detection.underFireConfidence - now,
      null,
    );
    setLevel(context, track, from, null, null);
  }
  if (
    own.phase === 'moving' ||
    own.phase === 'atObjective' ||
    own.phase === 'possibleContact' ||
    own.phase === 'holding'
  ) {
    halt(context, own, 'contact', 'under fire');
  }
}

/**
 * Effectiveness: surviving strength × (1 − weight × mean suppression) ×
 * ammunition (linear below the low share) × leadership (the share of leaders
 * still up, between `leaderlessFactor` and 1). Separate from strength: a
 * force with most of its soldiers can be ineffective.
 */
export function updateEffectiveness(context: FofContext): void {
  const { fof, setup } = context;
  const e = setup.config.effectiveness;
  fof.forces.forEach((force, i) => {
    let active = 0;
    let suppression = 0;
    let rounds = 0;
    for (const member of fof.soldiers) {
      if (member.force !== i) continue;
      rounds += member.rounds;
      if (soldierOf(context, member).status !== 'active') continue;
      active += 1;
      suppression += member.suppression;
    }
    const leadersUp = force.leaderIds.filter(
      (id) => context.state.soldiers[context.soldierIndex.get(id) ?? -1]?.status === 'active',
    ).length;
    const strength = force.memberIds.length > 0 ? active / force.memberIds.length : 0;
    force.meanSuppression = active > 0 ? suppression / active : 0;
    const ammunition =
      force.initialRounds > 0
        ? Math.min(1, rounds / force.initialRounds / Math.max(1e-9, e.ammunitionLowFraction))
        : 1;
    const leadership =
      force.leaderIds.length > 0
        ? e.leaderlessFactor + (1 - e.leaderlessFactor) * (leadersUp / force.leaderIds.length)
        : 1;
    force.lastingEffectiveness = strength * ammunition * leadership;
    force.effectiveness =
      force.lastingEffectiveness * (1 - e.suppressionWeight * force.meanSuppression);
  });
}

/** Moves a force to `to`, reporting why. */
export function enter(context: FofContext, force: FofForce, to: ForcePhase, reason: string): void {
  if (force.phase === to) return;
  const from = force.phase;
  force.phase = to;
  force.phaseSince = context.t;
  context.events.push({
    type: 'forcePhaseChanged',
    tick: context.tick,
    atSeconds: context.t,
    unitId: force.unitId,
    side: force.side,
    from,
    to,
    reason,
  });
}
