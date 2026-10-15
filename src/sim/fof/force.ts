import { applyOrderUnit } from '../behavior/orders';
import { nearestInArea } from '../behavior/slots';
import { azimuthOf, normalizeAzimuth, type Vec2 } from '../geometry';
import { navArea } from '../navigation';
import { nextFloat } from '../rng';
import { isOnTerrain } from '../terrain';
import { orgUnitId, type Soldier, type SoldierId } from '../state';
import type { FormationNode, FormationSpec, UnitOrder } from '../behavior/types';
import { fofWeapon } from './config';
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
// What "contact" leads to is the force's actions on contact (`ActionsOn`):
//
//   continue: as above, it fights where it halts and resumes its mission;
//   attack:   contact ─ assaultAfterSeconds, enemy located ─▶ assaulting (on
//             the enemy's believed position, by fire and movement: one
//             element bounds while the others fire, in turn);
//             assaulting ─ closed with the enemy ─▶ contact;
//                        ─ on the objective, no contact ─▶ holding ─▶ mission;
//   withdraw: contact ─▶ withdrawing (back to where it started) at once.
//
// Withdrawal of a spent force and combat ineffectiveness (terminal) are
// added by the engagement lifecycle (`lifecycle.ts`).

/** Seconds from the start of a move under fire to a soldier's first burst on the move. */
const MOVING_FIRE_DELAY_S = 2;
/** Headings tried for a withdrawal, in degrees from straight away from the threat. */
const WITHDRAW_OFFSETS_DEG: readonly number[] = [0, 30, -30, 60, -60, 90, -90];
/** After a withdrawal found no way, how long before trying again (s). */
export const WITHDRAW_RETRY_S = 10;
/** A start closer than this to the force (m) is no place to go back to: it withdraws away from the threat. */
const HOME_MIN_DISTANCE_M = 25;

/** Phases in which the force is halted in place (no unit task). */
export function halted(phase: ForcePhase): boolean {
  return (
    phase === 'possibleContact' || phase === 'contact' || phase === 'engaged' || phase === 'holding'
  );
}

/** Phases in which the force moves under fire, its soldiers firing on the move. */
export function firingOnTheMove(phase: ForcePhase): boolean {
  return phase === 'withdrawing';
}

/** Phases in which the force's movement is its own (contact behaviour), not its mission. */
function ownMovement(phase: ForcePhase): boolean {
  return phase === 'withdrawing' || phase === 'assaulting';
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
        if (close) onContact(context, force, 'contact within engagement range');
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
          onContact(context, force, 'contact within engagement range');
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
        } else if (force.actionsOn === 'attack') {
          beginAssault(context, force, picture.enemy);
        } else if (
          force.actionsOn === 'withdraw' &&
          (force.withdrawRetryAt === null || t >= force.withdrawRetryAt - 1e-9) &&
          !withdraw(context, force, 'actions on contact: withdraw', force.start)
        ) {
          force.withdrawRetryAt = t + WITHDRAW_RETRY_S;
        }
        break;
      }
      case 'assaulting':
        updateAssault(context, force, picture.enemy);
        break;
      case 'holding':
        if (close) {
          onContact(context, force, 'contact regained');
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
  let ex = 0;
  let ey = 0;
  let en = 0;
  const firsts: number[] = [];
  for (const track of fof.tracks) {
    if (track.force !== force) continue;
    const current = track.level !== 'lost';
    if (track.level === 'detected' || track.level === 'identified') {
      confirmed = true;
      ex += track.lastKnown.x;
      ey += track.lastKnown.y;
      en += 1;
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
    /** Where it believes the enemy is: the centre of its current confirmed contacts. */
    enemy: en > 0 ? { x: ex / en, y: ey / en } : null,
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
  if (task && !ownMovement(force.phase)) force.mission = task.order;
  cancelTask(context, force);
  force.bounding = [];
  force.boundUnit = null;
  const entering =
    phase === 'contact' &&
    force.phase !== 'contact' &&
    force.phase !== 'engaged' &&
    force.phase !== 'assaulting';
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

/**
 * The force comes into contact (a confirmed contact within the engagement
 * range, or fire on it), and does what its actions on contact say: halts to
 * fight (`continue`; `attack`, which assaults once it has located the enemy),
 * or breaks contact at once back to where it started (`withdraw`; with no way
 * back it halts to fight and tries again).
 */
function onContact(context: FofContext, force: FofForce, reason: string): void {
  const { t } = context;
  if (force.actionsOn === 'withdraw') {
    if (withdraw(context, force, `actions on contact: withdraw (${reason})`, force.start)) {
      force.contactCycles += 1;
      return;
    }
    force.withdrawRetryAt = t + WITHDRAW_RETRY_S;
  }
  halt(context, force, 'contact', reason);
  if (force.actionsOn === 'attack') {
    force.assaultAt = t + context.setup.config.force.assaultAfterSeconds;
  }
}

/**
 * Attacking, halted in contact: once it has returned fire and located the
 * enemy (`assaultAfterSeconds`), it assaults where it believes the enemy is,
 * by fire and movement. A believed position within `assaultRetargetM` it
 * fights from where it is.
 */
function beginAssault(context: FofContext, force: FofForce, enemy: Vec2 | null): void {
  const { t } = context;
  const behavior = context.setup.config.force;
  if (force.assaultAt === null || t < force.assaultAt - 1e-9 || !enemy) return;
  const centre = centreOf(context, force);
  if (!centre || Math.hypot(enemy.x - centre.x, enemy.y - centre.y) <= behavior.assaultRetargetM) {
    return;
  }
  force.objective = enemy;
  force.objectiveAt = t;
  if (!bound(context, force, enemy)) {
    // No element can move now: it fights on where it is and tries again later.
    force.objective = null;
    force.assaultAt = t + behavior.assaultAfterSeconds;
    return;
  }
  force.assaultAt = null;
  enter(context, force, 'assaulting', 'actions on contact: attack');
}

/**
 * Assaulting, by fire and movement: one element bounds (rushes) toward
 * where the force believes the enemy is while the others stay down and
 * fire; when it arrives it goes down, and once it has been firing for
 * `boundRestSeconds`, the next element bounds. Within `assaultRetargetM`
 * of the enemy it halts and fights; on the objective with no contact it
 * holds, then resumes its mission.
 */
function updateAssault(context: FofContext, force: FofForce, enemy: Vec2 | null): void {
  const { t } = context;
  const behavior = context.setup.config.force;
  if (enemy) {
    force.objective = enemy;
    force.objectiveAt = t;
  }
  if (force.bounding.length > 0) {
    // A bound ends when the element arrives (or, held up, after twice its expected time).
    const expected = behavior.boundLengthM / behavior.boundPaceMps;
    if (runningTask(context, force) && t - force.boundSince < 2 * expected + 5 - 1e-9) return;
    endBound(context, force);
    return;
  }
  const target = force.objective;
  const centre = centreOf(context, force);
  if (!target || !centre) return;
  if (Math.hypot(target.x - centre.x, target.y - centre.y) <= behavior.assaultRetargetM) {
    force.objective = null;
    if (enemy) {
      halt(context, force, 'contact', 'closed with the enemy');
      force.assaultAt = t + behavior.assaultAfterSeconds;
    } else {
      halt(context, force, 'holding', 'on the objective: no contact');
    }
    return;
  }
  if (t - force.boundSince < behavior.boundRestSeconds - 1e-9) return;
  if (!bound(context, force, target)) {
    // No element can move (all close, or no way): it fights where it is.
    force.objective = null;
    halt(context, force, 'contact', enemy ? 'closed with the enemy' : 'no way forward');
    force.assaultAt = t + behavior.assaultAfterSeconds;
  }
}

/** One element of a force for fire and movement: its formation and soldiers. */
interface Element {
  readonly unitId: string;
  readonly formation: FormationSpec;
  readonly memberIds: readonly SoldierId[];
}

/**
 * The force's elements for fire and movement, from its formation: each
 * subordinate unit (with the force's own leader and headquarters moving
 * with it, a little behind) when it has two or more; else its soldiers in
 * two halves, in formation order (the leader with the first).
 */
export function elementsOf(context: FofContext, force: FofForce): Element[] {
  const forceSetup = context.setup.forces.find((f) => f.unitId === force.unitId);
  const formation = force.mission?.formation ?? forceSetup?.formation;
  if (!formation) return [];
  const root = formation.root;
  const soldiersOf = (n: FormationNode): SoldierId[] => [
    ...n.slots.map((s) => s.soldierId),
    ...n.children.flatMap(soldiersOf),
  ];
  if (root.children.length >= 2) {
    const behind = Math.max(0, ...root.children.flatMap((c) => c.slots.map((s) => s.back)));
    const headquarters = root.slots.map((s) => ({ ...s, back: s.back + behind }));
    return root.children.map((child) => ({
      unitId: child.unitId,
      formation: {
        interval: formation.interval,
        root: { ...root, slots: headquarters, children: [{ ...child, back: 0, right: 0 }] },
      },
      memberIds: [...headquarters.map((s) => s.soldierId), ...soldiersOf(child)],
    }));
  }
  const slots = root.slots;
  if (slots.length < 2 || root.children.length > 0) {
    return [{ unitId: root.unitId, formation, memberIds: soldiersOf(root) }];
  }
  const half = Math.ceil(slots.length / 2);
  return [slots.slice(0, half), slots.slice(half)].map((part) => ({
    unitId: root.unitId,
    formation: { interval: formation.interval, root: { ...root, slots: part, children: [] } },
    memberIds: part.map((s) => s.soldierId),
  }));
}

/**
 * Starts the next bound: the first element, from `boundElement` on, that
 * has soldiers up and is not already close, rushes `boundLengthM` toward
 * `target`. Returns whether one did.
 */
function bound(context: FofContext, force: FofForce, target: Vec2): boolean {
  const { t } = context;
  const behavior = context.setup.config.force;
  const elements = elementsOf(context, force);
  for (let k = 0; k < elements.length; k += 1) {
    const index = (force.boundElement + k) % elements.length;
    const element = elements[index];
    if (!element) continue;
    const up = element.memberIds.filter(
      (id) => context.state.soldiers[context.soldierIndex.get(id) ?? -1]?.status === 'active',
    );
    const at = centreOfSoldiers(context, up);
    if (!at) continue;
    const d = Math.hypot(target.x - at.x, target.y - at.y);
    const step = Math.min(behavior.boundLengthM, d - behavior.assaultRetargetM / 2);
    if (step < 5) continue;
    const to = {
      x: at.x + ((target.x - at.x) / d) * step,
      y: at.y + ((target.y - at.y) / d) * step,
    };
    if (!moveTo(context, force, to, element.formation, behavior.boundPaceMps, at)) continue;
    // The bounding soldiers get up and go; the others stay down, firing.
    for (const id of up) {
      const member = context.fof.soldiers[context.memberIndex.get(id) ?? -1];
      const soldier = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
      if (!member || !soldier) continue;
      member.reactAt = null;
      member.reacted = false;
      member.nextFireAt = null;
      soldier.posture = 'standing';
    }
    force.bounding = up;
    force.boundUnit = element.unitId;
    force.boundElement = (index + 1) % elements.length;
    force.boundSince = t;
    return true;
  }
  return false;
}

/** The bounding element arrives (or is held up): it goes down and, after its reaction delays, fires. */
function endBound(context: FofContext, force: FofForce): void {
  const { state, t } = context;
  cancelTask(context, force);
  const delay = context.setup.config.force.reactionDelay;
  for (const id of force.bounding) {
    const member = context.fof.soldiers[context.memberIndex.get(id) ?? -1];
    const soldier = state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (!member || soldier?.status !== 'active') continue;
    member.reactAt =
      t + delay.minSeconds + nextFloat(state.rng) * (delay.maxSeconds - delay.minSeconds);
    member.reacted = false;
    member.nextFireAt = null;
  }
  force.bounding = [];
  force.boundUnit = null;
  force.boundSince = t;
}

/** Where some soldiers (those still up) are on average, or `null`. */
function centreOfSoldiers(context: FofContext, ids: readonly SoldierId[]): Vec2 | null {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const id of ids) {
    const s = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (s?.status !== 'active') continue;
    x += s.position.x;
    y += s.position.y;
    n += 1;
  }
  return n > 0 ? { x: x / n, y: y / n } : null;
}

/**
 * Orders the force, in its formation (or `formation`, an element's), to the
 * reachable point nearest `to` (in the navigation area of `from`, by
 * default its centre, where the movement engine plans from). Returns whether
 * the order took.
 */
function moveTo(
  context: FofContext,
  force: FofForce,
  to: Vec2,
  formation?: FormationSpec,
  pace?: number,
  from?: Vec2,
): boolean {
  const { world } = context;
  const area = forceArea(context, force, from);
  const forceSetup = context.setup.forces.find((f) => f.unitId === force.unitId);
  const shape = formation ?? force.mission?.formation ?? forceSetup?.formation;
  if (area === 0 || !shape || !isOnTerrain(world.terrain, to.x, to.y)) return false;
  const point = nearestInArea(world.terrain, to, area);
  if (!point) return false;
  const speed = pace ?? forceSetup?.pace;
  return issue(context, force, {
    kind: 'moveInFormation',
    destination: point,
    formation: shape,
    ...(speed !== undefined ? { pace: speed } : {}),
  });
}

/** The navigation area the force's route is planned from: `from`'s (default its centre), else a member's on routable ground (0: none). */
function forceArea(context: FofContext, force: FofForce, from?: Vec2): number {
  const terrain = context.world.terrain;
  const centre = from ?? centreOf(context, force);
  if (!centre) return 0;
  let area = navArea(terrain, centre);
  for (const id of area > 0 ? [] : force.memberIds) {
    const s = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (s?.status !== 'active') continue;
    area = navArea(terrain, s.position);
    if (area > 0) break;
  }
  return area;
}

/**
 * Breaks contact: orders the force back to `home` (where it started) if
 * given and not where it stands, else `withdrawDistanceM` away from the
 * threat it knows of (the first heading of `WITHDRAW_OFFSETS_DEG` with
 * ground it can reach), in its formation, through the movement engine. With
 * nowhere to go it stays where it is (returns `false`).
 */
export function withdraw(
  context: FofContext,
  force: FofForce,
  reason: string,
  home: Vec2 | null = null,
): boolean {
  const { setup } = context;
  const centre = centreOf(context, force);
  if (!centre) return false;
  // The movement order it is on (if any) stays its mission.
  const task = runningTask(context, force);
  if (task && !ownMovement(force.phase)) force.mission = task.order;
  const going = (): true => {
    standUp(context, force);
    force.objective = null;
    force.assaultAt = null;
    force.bounding = [];
    force.boundUnit = null;
    enter(context, force, 'withdrawing', reason);
    force.withdrawRetryAt = null;
    return true;
  };
  if (
    home &&
    Math.hypot(home.x - centre.x, home.y - centre.y) > HOME_MIN_DISTANCE_M &&
    moveTo(context, force, home)
  ) {
    return going();
  }
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
    const to = {
      x: centre.x + Math.sin(heading) * distance,
      y: centre.y + Math.cos(heading) * distance,
    };
    if (moveTo(context, force, to)) return going();
  }
  return false;
}

/** Releases the soldiers of a force held in place (pinned on the move). */
export function releaseHolds(context: FofContext, force: FofForce): void {
  for (const id of force.memberIds) {
    const soldier = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (soldier) hold(context, soldier, false);
  }
}

/** Resumes the force's mission (or ends its halt where it is, without one). */
export function resume(context: FofContext, force: FofForce, reason: string): void {
  force.objective = null;
  force.assaultAt = null;
  force.bounding = [];
  force.boundUnit = null;
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
  const events: typeof context.events = [];
  applyOrderUnit(
    state,
    context.world,
    { type: 'orderUnit', tick: state.tick, unitId: orgUnitId(force.unitId), order },
    context.t,
    events,
  );
  // A refused attempt changes nothing and is not reported: it is the force's
  // own planning (the caller tries elsewhere or later), not an outside command.
  if (events.some((e) => e.type === 'commandRejected')) return false;
  context.events.push(...events);
  return runningTask(context, force) !== undefined;
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
 * move, a pinned soldier is held where he is until he recovers. Assaulting,
 * the bounding element rushes without firing and the others are halted, in
 * contact (the base of fire).
 */
function carryOut(context: FofContext, force: FofForce): void {
  const { t, fof } = context;
  const assaulting = force.phase === 'assaulting';
  for (const id of force.memberIds) {
    const member = fof.soldiers[context.memberIndex.get(id) ?? -1];
    const soldier = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (!member || soldier?.status !== 'active') continue;
    // Assaulting, the bounding element moves; the rest are down, firing (the base of fire).
    const stopped = halted(force.phase) || (assaulting && !force.bounding.includes(id));
    hold(context, soldier, !stopped && member.level === 'pinned');
    if (!stopped) {
      // Assaulting or breaking contact, he fires on the move at what he can see
      // (after a moment to start off); breaking contact, he keeps his last rounds.
      if (
        firingOnTheMove(force.phase) &&
        member.nextFireAt === null &&
        member.weapon !== null &&
        member.rounds > 0 &&
        (force.phase !== 'withdrawing' ||
          member.rounds >=
            (fofWeapon(context.setup.config, member.weapon)?.basicLoadRounds ?? 0) *
              context.setup.config.force.withdrawAmmunitionFraction)
      ) {
        member.nextFireAt = t + MOVING_FIRE_DELAY_S;
      }
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
      (force.phase === 'contact' || force.phase === 'engaged' || assaulting) &&
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
    onContact(context, own, 'under fire');
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
