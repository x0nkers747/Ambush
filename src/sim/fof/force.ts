import { applyOrderUnit } from '../behavior/orders';
import { nearestInArea } from '../behavior/slots';
import { azimuthOf, normalizeAzimuth, type Vec2 } from '../geometry';
import { navArea } from '../navigation';
import { nextFloat } from '../rng';
import { surfaceHeightAt } from '../bridge-navigation';
import { sightLineTracer } from '../sight-tracer';
import { isOnTerrain } from '../terrain';
import { orgUnitId, type Soldier, type SoldierId } from '../state';
import type { AgentState, FormationNode, FormationSpec, UnitOrder } from '../behavior/types';
import { fofWeapon } from './config';
import { confidenceAt, vegetationTransmission } from './detection';
import { occupyAmbush, springAmbush, updateAmbush } from './ambush';
import { activeOrder, updatePlan, withinArrival } from './orders';
import { roundsLeft } from './weapons';
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
// What "contact" leads to is the force's actions on contact (`ActionsOn`,
// docs/behavior-lab/force-on-force/07):
//
//   continue: as above, it fights where it halts and resumes its mission; with
//             no soldier able to fire at an enemy he sees for pressOnSeconds,
//             it presses on (moving, firing on the move, not halting for
//             contact for as long);
//   attack:   contact ─ assaultAfterSeconds, enemy located ─▶ assaulting (on
//             the enemy's believed position, by fire and movement, in its
//             assault formation, an extended line: one element bounds while
//             the others fire, in turn);
//             assaulting ─ closed with the enemy ─▶ contact;
//                        ─ on the objective, no contact ─▶ holding ─▶ mission;
//   hold:     it fights where it halts, and holds there until ordered on;
//   withdraw: avoiding contact: any confirmed contact ─▶ withdrawing at once
//             (in the lab, back to where it started; in a battle, back from
//             where it is), holding its fire unless fired upon; then it holds.
//
// Halted in contact, each soldier takes the lowest posture from which he
// sees an enemy his force knows of (prone, else kneeling), chosen again
// every few seconds.
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
/** How often a halted soldier's posture is chosen again (s), and how many known contacts he looks for. */
const POSTURE_CHECK_S = 3;
const POSTURE_CONTACTS = 3;
/** Where a soldier is aimed at, above the ground at his last known position (m). */
const CONTACT_HEIGHT_M = 0.6;

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

/** Whether the force is pressing on through contact now (actions on contact `continue`). */
export function pressingOn(context: FofContext, force: FofForce): boolean {
  return (
    force.phase === 'moving' && force.pressOnUntil !== null && context.t < force.pressOnUntil - 1e-9
  );
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
    // Contact lasts while the enemy is actually seen (a sighting), not while a remembered track lasts.
    if (picture.lastSeenAt !== null)
      force.lastContactAt = Math.max(force.lastContactAt ?? -Infinity, picture.lastSeenAt);
    if (picture.identified) force.hostile = true;
    force.threat = picture.threat;
    // Its orders first (a planned squad): the active one checked, the next started.
    updatePlan(context, force, setup.forces[i]?.actionsOn ?? 'continue');
    if (!forceActive(force)) return;
    if (force.phase !== 'inAmbush') force.concealed = false;
    // Avoiding contact, any confirmed contact is close enough to fall back from.
    const close =
      force.actionsOn === 'withdraw'
        ? picture.confirmed
        : picture.nearestConfirmed <= behavior.engageRangeM;
    switch (force.phase) {
      case 'moving':
      case 'atObjective':
        if (pressingOn(context, force)) break;
        if (force.phase === 'moving') force.pressOnUntil = null;
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
          // On an ambush order, at its position: it occupies it and lies in wait.
          const order = activeOrder(force);
          if (
            order?.kind === 'ambush' &&
            order.destination &&
            force.ambushSprungAt === null &&
            withinArrival(context, force, order.destination)
          ) {
            occupyAmbush(context, force, order);
          } else enter(context, force, 'atObjective', 'arrived');
        }
        break;
      case 'inAmbush':
        updateAmbush(context, force);
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
        } else if (force.actionsOn === 'continue' && nothingToEngage(context, force)) {
          // Nothing it can engage from here: it presses on, firing on the move.
          force.pressOnUntil = t + behavior.pressOnSeconds;
          force.observedUntil = t;
          resume(context, force, 'nothing to engage: pressing on');
          if ((force.phase as ForcePhase) !== 'moving') force.pressOnUntil = null;
        } else if (
          force.actionsOn === 'withdraw' &&
          (force.withdrawRetryAt === null || t >= force.withdrawRetryAt - 1e-9) &&
          !withdraw(
            context,
            force,
            'actions on contact: withdraw',
            force.planned ? null : force.start,
          )
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
          // Holding (or having fallen back from contact) it stays until ordered on.
          force.actionsOn !== 'hold' &&
          force.actionsOn !== 'withdraw' &&
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
  // Looked up once for all soldiers: who is steered by a task, and each force's current contacts.
  const agents = new Map(
    (context.state.behavior?.agents ?? []).map((a) => [a.soldierId as string, a]),
  );
  context.fof.forces.forEach((force, i) => {
    if (forceActive(force)) carryOut(context, force, agents, knownContacts(context, i));
  });
}

/** What a force believes: its contacts' nearest range, new possible contacts, and where the threat is. */
export function pictureOf(context: FofContext, force: number) {
  const { fof, t } = context;
  const own = fof.forces[force];
  const centre = own ? centreOf(context, own) : null;
  let confirmed = false;
  let identified = false;
  let lastSeenAt: number | null = null;
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
      lastSeenAt = Math.max(lastSeenAt ?? -Infinity, track.lastSeenAt);
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
    /** When a confirmed contact was last actually seen (`null`: none confirmed). */
    lastSeenAt,
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

/** The running unit task of the force or of one of its units (a bounding element), if any. */
export function runningTask(context: FofContext, force: FofForce) {
  return context.state.behavior?.tasks.find(
    (t) => t.outcome === null && inForce(context, force, t.unitId),
  );
}

/** Whether `unitId` is the force's unit or one below it. */
function inForce(context: FofContext, force: FofForce, unitId: string): boolean {
  for (let id: string | null = unitId; id !== null;) {
    if (id === force.unitId) return true;
    const at: string = id;
    id = context.state.units.find((u) => u.id === at)?.parentId ?? null;
  }
  return false;
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
  if (entering) {
    force.contactCycles += 1;
    force.contactAt = t;
  }
  force.pressOnUntil = null;
  enter(context, force, phase, reason);
  // Reaction delays, drawn in soldier order (after the surprise of being caught in an ambush).
  const delay = context.setup.config.force.reactionDelay;
  const from = Math.max(t, force.surprisedUntil ?? t);
  for (const id of force.memberIds) {
    const member = context.fof.soldiers[context.memberIndex.get(id) ?? -1];
    const soldier = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (!member || soldier?.status !== 'active') continue;
    member.reactAt =
      from + delay.minSeconds + nextFloat(state.rng) * (delay.maxSeconds - delay.minSeconds);
    member.reacted = false;
    member.nextFireAt = null;
  }
}

/** Cancels the running unit tasks of the force and its units (the movement engine's own cancel). */
export function cancelTask(context: FofContext, force: FofForce): void {
  for (let task = runningTask(context, force); task; task = runningTask(context, force)) {
    applyOrderUnit(
      context.state,
      context.world,
      { type: 'orderUnit', tick: context.state.tick, unitId: task.unitId, order: null },
      context.t,
      context.events,
    );
  }
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
    // The lab's forces go back to where they started; a battle's squads fall back from where they are.
    const home = force.planned ? null : force.start;
    if (withdraw(context, force, `actions on contact: withdraw (${reason})`, home)) {
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
    // A bound ends when the element reaches its destination (its route done:
    // a soldier pinned on the way goes down where he is), or, held up, after
    // twice its expected time.
    const expected = behavior.boundLengthM / behavior.boundPaceMps;
    const task = runningTask(context, force);
    if (task?.phase === 'moving' && t - force.boundSince < 2 * expected + 5 - 1e-9) return;
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
 * subordinate unit (ordered as itself, so that its route starts from its own
 * leader), then the force's leader and headquarters on their own, when it
 * has two or more; else its soldiers in two halves, in formation order (the
 * leader with the first).
 */
export function elementsOf(context: FofContext, force: FofForce, assault = false): Element[] {
  const forceSetup = context.setup.forces.find((f) => f.unitId === force.unitId);
  const formation =
    (assault ? forceSetup?.assaultFormation : undefined) ??
    force.mission?.formation ??
    forceSetup?.formation;
  if (!formation) return [];
  const root = formation.root;
  const soldiersOf = (n: FormationNode): SoldierId[] => [
    ...n.slots.map((s) => s.soldierId),
    ...n.children.flatMap(soldiersOf),
  ];
  if (root.children.length >= 2) {
    const teams = root.children.map((child) => ({
      unitId: child.unitId,
      formation: { interval: formation.interval, root: { ...child, back: 0, right: 0 } },
      memberIds: soldiersOf(child),
    }));
    if (root.slots.length === 0) return teams;
    return [
      ...teams,
      {
        unitId: root.unitId,
        formation: { interval: formation.interval, root: { ...root, children: [] } },
        memberIds: root.slots.map((s) => s.soldierId),
      },
    ];
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
  // Assaulting, in its assault formation (an extended line).
  const elements = elementsOf(context, force, true);
  for (const index of boundOrder(context, force, elements, target)) {
    const element = elements[index];
    if (!element) continue;
    const up = element.memberIds.filter(
      (id) => context.state.soldiers[context.soldierIndex.get(id) ?? -1]?.status === 'active',
    );
    const at = centreOfSoldiers(context, up);
    if (!at) continue;
    const to = firingPosition(context, force, at, target);
    if (!to) continue;
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

/** Distances tried for a bound, as shares of `boundLengthM`, and the spread of an element across its front (m). */
const BOUND_SHARES: readonly number[] = [1, 0.75, 0.5];
const ELEMENT_HALF_FRONT_M = 7;
/** A point seeing at least this share of what the best one sees counts as a firing position as good. */
const SIGHT_SHARE = 0.75;

/**
 * How much of the enemy its force knows of a prone soldier at a point would
 * see: the enemy positions (its current confirmed contacts; else `target`)
 * with a clear sight line, each weighted by the light through vegetation.
 */
function sightOfEnemy(context: FofContext, force: FofForce, target: Vec2): (from: Vec2) => number {
  const terrain = context.world.terrain;
  const index = context.fof.forces.indexOf(force);
  const known = context.fof.tracks
    .filter((tr) => tr.force === index && (tr.level === 'detected' || tr.level === 'identified'))
    .map((tr) => tr.lastKnown);
  const enemies = known.length > 0 ? known : [target];
  const tracer = sightLineTracer(terrain);
  const eyeHeight = context.setup.config.detection.eyeHeightM.prone;
  return (from) => {
    const eye = { x: from.x, y: from.y, z: surfaceHeightAt(terrain, from.x, from.y) + eyeHeight };
    let seen = 0;
    for (const e of enemies) {
      const aim = { x: e.x, y: e.y, z: surfaceHeightAt(terrain, e.x, e.y) + 0.5 };
      if (!tracer.blocked(eye, aim)) seen += vegetationTransmission(terrain, from, e);
    }
    return seen;
  };
}

/**
 * The order in which elements are tried for the next bound: from
 * `boundElement` on, in turn; but (searching for firing positions) an
 * element none of whose own soldiers sees the enemy from where it lies goes
 * first, since it adds nothing to the base of fire there. The element that
 * has just bounded never goes twice in a row unless it is the only one.
 */
function boundOrder(
  context: FofContext,
  force: FofForce,
  elements: readonly Element[],
  target: Vec2,
): number[] {
  const n = elements.length;
  const turn = Array.from({ length: n }, (_, k) => (force.boundElement + k) % n);
  if (context.setup.config.force.boundSearchDegrees <= 0 || n < 2) return turn;
  const sees = sightOfEnemy(context, force, target);
  const blind = (element: Element) =>
    element.memberIds.every((id) => {
      const s = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
      return s?.status !== 'active' || sees(s.position) <= 0;
    });
  const last = (force.boundElement - 1 + n) % n;
  const first = turn.filter((i) => {
    const element = elements[i];
    return i !== last && element !== undefined && blind(element);
  });
  return [...first, ...turn.filter((i) => !first.includes(i))];
}

/**
 * Where an element at `at` bounds to, toward `target`: the reachable point,
 * from half to the whole bound length and up to `boundSearchDegrees` either
 * side of straight at the target (never within half of `assaultRetargetM` of
 * it), from which the element, prone, would see most of the enemy positions
 * its force knows of (three points across its front, through buildings and
 * vegetation). Of the points that see at least `SIGHT_SHARE` of the best
 * (all of them, with no sight from anywhere): the farthest toward the
 * target, then the straightest. `null` when it is already close.
 */
function firingPosition(context: FofContext, force: FofForce, at: Vec2, target: Vec2): Vec2 | null {
  const { world, setup } = context;
  const behavior = setup.config.force;
  const d = Math.hypot(target.x - at.x, target.y - at.y);
  const length = Math.min(behavior.boundLengthM, d - behavior.assaultRetargetM / 2);
  if (length < 5) return null;
  const straight = azimuthOf(target.x - at.x, target.y - at.y);
  const ahead = (heading: number, m: number): Vec2 => ({
    x: at.x + Math.sin(heading) * m,
    y: at.y + Math.cos(heading) * m,
  });
  const search = behavior.boundSearchDegrees;
  if (search <= 0) return ahead(straight, length);
  const area = forceArea(context, force, at);
  if (area === 0) return ahead(straight, length);
  const terrain = world.terrain;
  const sees = sightOfEnemy(context, force, target);
  const step = Math.max(5, search / 3);
  const offsets = [0];
  for (let a = step; a <= search + 1e-9; a += step) offsets.push(a, -a);
  const candidates: { point: Vec2; score: number; progress: number }[] = [];
  for (const share of BOUND_SHARES) {
    for (const offset of offsets) {
      const heading = straight + (offset * Math.PI) / 180;
      const wanted = ahead(heading, length * share);
      if (!isOnTerrain(terrain, wanted.x, wanted.y)) continue;
      const point = nearestInArea(terrain, wanted, area);
      if (!point) continue;
      if (Math.hypot(target.x - point.x, target.y - point.y) < behavior.assaultRetargetM / 2) {
        continue;
      }
      // Three points across the element's front, square to the enemy.
      const fx = target.x - point.x;
      const fy = target.y - point.y;
      const fl = Math.hypot(fx, fy) || 1;
      const rx = (fy / fl) * ELEMENT_HALF_FRONT_M;
      const ry = (-fx / fl) * ELEMENT_HALF_FRONT_M;
      const score =
        sees(point) +
        sees({ x: point.x + rx, y: point.y + ry }) +
        sees({ x: point.x - rx, y: point.y - ry });
      const progress = d - fl;
      candidates.push({ point, score, progress });
    }
  }
  // Of the points that see nearly as much as the best, the farthest forward (then the straightest).
  const most = Math.max(0, ...candidates.map((c) => c.score));
  let best: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    if (c.score < SIGHT_SHARE * most - 1e-9) continue;
    if (!best || c.progress > best.progress + 1e-9) best = c;
  }
  return best?.point ?? null;
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
export function forceArea(context: FofContext, force: FofForce, from?: Vec2): number {
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
  // Driven by a plan, it resumes its active order; with none, it holds where it is.
  const mission = force.planned && activeOrder(force) === null ? null : force.mission;
  if (mission && issue(context, force, mission)) {
    enter(context, force, 'moving', reason);
  } else {
    enter(context, force, 'atObjective', reason);
  }
}

/**
 * Issues a movement order to the force, or to the unit of the force its
 * formation is for (a bounding element), as the movement engine's own
 * `orderUnit`. Returns whether it took.
 */
export function issue(context: FofContext, force: FofForce, order: UnitOrder): boolean {
  const { state } = context;
  const events: typeof context.events = [];
  const unitId = inForce(context, force, order.formation.root.unitId)
    ? order.formation.root.unitId
    : orgUnitId(force.unitId);
  applyOrderUnit(
    state,
    context.world,
    { type: 'orderUnit', tick: state.tick, unitId, order },
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
function carryOut(
  context: FofContext,
  force: FofForce,
  agents: ReadonlyMap<string, AgentState>,
  known: KnownContacts,
): void {
  const { t, fof } = context;
  const assaulting = force.phase === 'assaulting';
  for (const id of force.memberIds) {
    const member = fof.soldiers[context.memberIndex.get(id) ?? -1];
    const soldier = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (!member || soldier?.status !== 'active') continue;
    if (force.phase === 'inAmbush') {
      // Lying in wait (once deployed): prone, watching the kill zone, holding fire.
      holdAgent(agents.get(id), false);
      member.nextFireAt = null;
      member.reactAt = null;
      member.reacted = false;
      if (force.concealed) {
        soldier.posture = 'prone';
        const zone = activeOrder(force)?.killZone;
        if (zone) {
          const dx = zone.centre.x - soldier.position.x;
          const dy = zone.centre.y - soldier.position.y;
          if (dx !== 0 || dy !== 0) soldier.azimuth = azimuthOf(dx, dy);
        }
      } else soldier.posture = 'standing';
      continue;
    }
    // Assaulting, the bounding element moves; the rest are down, firing (the base of fire).
    const stopped = halted(force.phase) || (assaulting && !force.bounding.includes(id));
    holdAgent(agents.get(id), !stopped && member.level === 'pinned');
    if (!stopped) {
      // Assaulting or breaking contact, he fires on the move at what he can see
      // (after a moment to start off); breaking contact, he keeps his last rounds.
      if (
        (firingOnTheMove(force.phase) || pressingOn(context, force)) &&
        member.nextFireAt === null &&
        member.weapon !== null &&
        roundsLeft(member) > 0 &&
        (force.phase !== 'withdrawing' ||
          roundsLeft(member) >=
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
      if (force.phase !== 'possibleContact' && member.weapon !== null && roundsLeft(member) > 0) {
        member.nextFireAt = t;
      }
    }
    if (!member.reacted) continue;
    if (member.level === 'pinned') soldier.posture = 'prone';
    else if (force.phase === 'possibleContact') soldier.posture = 'kneeling';
    else if (t >= member.postureAt - 1e-9) {
      // In contact: the lowest posture he sees the enemy from (leaders kneel to see and command).
      member.postureAt = t + POSTURE_CHECK_S;
      soldier.posture = postureToSee(context, soldier, known, member.leader ? 'kneeling' : 'prone');
    }
    // Contact phases that began before he reacted: fire once reacted.
    if (
      (force.phase === 'contact' || force.phase === 'engaged' || assaulting) &&
      member.nextFireAt === null &&
      member.weapon !== null &&
      roundsLeft(member) > 0
    ) {
      member.nextFireAt = t;
    }
    const k = nearestKnown(known, soldier);
    const look = k >= 0 ? { x: known.x[k] ?? 0, y: known.y[k] ?? 0 } : force.threat;
    if (look) {
      const dx = look.x - soldier.position.x;
      const dy = look.y - soldier.position.y;
      if (dx !== 0 || dy !== 0) soldier.azimuth = azimuthOf(dx, dy);
    }
  }
}

/**
 * The lowest posture, from `lowest` up to kneeling, from which a soldier
 * sees one of the nearest contacts his force knows of; with none in sight
 * from any, `lowest` (in cover).
 */
export function postureToSee(
  context: FofContext,
  soldier: Soldier,
  known: KnownContacts,
  lowest: 'prone' | 'kneeling',
): 'prone' | 'kneeling' {
  if (known.count === 0) return lowest;
  const terrain = context.world.terrain;
  const tracer = sightLineTracer(terrain);
  const eyes = context.setup.config.detection.eyeHeightM;
  // The nearest few contacts (the first of equals), by squared distance.
  const fx = soldier.position.x;
  const fy = soldier.position.y;
  const order = Array.from({ length: known.count }, (_, k) => k)
    .map((k) => ({ k, d: ((known.x[k] ?? 0) - fx) ** 2 + ((known.y[k] ?? 0) - fy) ** 2 }))
    .sort((a, b) => a.d - b.d || a.k - b.k)
    .slice(0, POSTURE_CONTACTS);
  const sees = (posture: 'prone' | 'kneeling') => {
    const eye = { x: fx, y: fy, z: soldier.position.z + eyes[posture] };
    return order.some(({ k }) => {
      const x = known.x[k] ?? 0;
      const y = known.y[k] ?? 0;
      if (!isOnTerrain(terrain, x, y) || (x === fx && y === fy)) return false;
      return !tracer.blocked(eye, { x, y, z: surfaceHeightAt(terrain, x, y) + CONTACT_HEIGHT_M });
    });
  };
  if (lowest === 'prone' && sees('prone')) return 'prone';
  if (sees('kneeling')) return 'kneeling';
  return lowest;
}

/**
 * Whether a force halted in contact has nothing it can engage: none of its
 * soldiers has fired at an enemy he could see for `pressOnSeconds` since it
 * halted, and it is not pinned down.
 */
function nothingToEngage(context: FofContext, force: FofForce): boolean {
  const { t, setup } = context;
  const since = Math.max(force.contactAt ?? -Infinity, force.lastAimedFireAt ?? -Infinity);
  if (t - since < setup.config.force.pressOnSeconds - 1e-9) return false;
  return force.meanSuppression < setup.config.suppression.suppressedAt;
}

/** Holds (or releases) a soldier steered by a unit task in place. */
function hold(context: FofContext, soldier: Soldier, on: boolean): void {
  holdAgent(
    context.state.behavior?.agents.find((a) => a.soldierId === soldier.id),
    on,
  );
}

function holdAgent(agent: AgentState | undefined, on: boolean): void {
  if (!agent) return;
  if (on && agent.override === null) agent.override = { kind: 'hold' };
  else if (!on && agent.override?.kind === 'hold') agent.override = null;
}

/** A force's current contacts (not lost), in track order: their last known positions. */
export interface KnownContacts {
  readonly count: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
}

function knownContacts(context: FofContext, force: number): KnownContacts {
  const tracks = context.fof.tracks;
  const x = new Float64Array(tracks.length);
  const y = new Float64Array(tracks.length);
  let count = 0;
  for (const track of tracks) {
    if (track.force !== force || track.level === 'lost') continue;
    x[count] = track.lastKnown.x;
    y[count] = track.lastKnown.y;
    count += 1;
  }
  return { count, x, y };
}

/**
 * The nearest of the known contacts to a soldier (the first of equals), or −1:
 * by `Math.hypot`, which is computed only where the squared distance could
 * beat the best so far (a margin far above rounding), so the choice is
 * exactly the one comparing every distance gives.
 */
function nearestKnown(known: KnownContacts, from: Soldier): number {
  const fx = from.position.x;
  const fy = from.position.y;
  let best = -1;
  let bestD = Infinity;
  let bound = Infinity;
  for (let k = 0; k < known.count; k += 1) {
    const dx = (known.x[k] ?? 0) - fx;
    const dy = (known.y[k] ?? 0) - fy;
    if (dx * dx + dy * dy > bound) continue;
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = k;
      bound = d * d * (1 + 1e-9) + 1e-12;
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
  if (pressingOn(context, own)) return;
  if (own.phase === 'inAmbush') {
    springAmbush(context, own, activeOrder(own)?.killZone ?? null, 'ambush sprung: fired upon');
    return;
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
      rounds += roundsLeft(member);
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
