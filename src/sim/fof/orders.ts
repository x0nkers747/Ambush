import { nearestInArea } from '../behavior/slots';
import type { UnitOrder } from '../behavior/types';
import type { SimEvent } from '../events';
import { azimuthOf, type Vec2 } from '../geometry';
import type { SimState } from '../state';
import { isOnTerrain } from '../terrain';
import type { SimWorld } from '../world';
import { occupyAmbush } from './ambush';
import {
  cancelTask,
  centreOf,
  enter,
  forceArea,
  issue,
  pictureOf,
  recovered,
  runningTask,
  standUp,
} from './force';
import { orderSpecProblem } from './setup';
import type { FofContext } from './system';
import { fofStateOf } from './system';
import type { ActionsOn, FofForce, FofOrder, OrderKind, OrderSpec, OrderStatus } from './types';

// Squads' orders and plans (docs/constructive-simulation/02). An order is the
// commander's intent (move, attack, withdraw, to a destination); the squad's
// phase (`ForcePhase`) is what it is doing about it now. A plan is the
// squad's orders in turn: one active at a time; when it ends, the next
// pending one starts.
//
// Orders enter by the `orderSquad` command, applied at a tick boundary in
// the order commands were given: `replace` ends the active and pending orders
// (superseded; canceled when the new plan is empty) and the new ones follow;
// `append` adds them after the pending ones. A squad's initial plan comes
// from its setup.
//
// At each decision a planned squad's order is checked and moved on:
//
//   pending ─ its turn, the squad able ─▶ active
//   active move     ─ on its destination (within arrivalRadiusM) ─▶ completed
//   active attack   ─ on its objective, no enemy within reach for attackClearSeconds ─▶ completed
//                   ─ attackTimeoutSeconds since it began ─▶ failed
//   active withdraw ─ at its destination ─▶ completed
//   active ambush   ─ never ends by itself: at its position it lies in wait,
//                     springs the ambush, fights and waits there for new orders
//                     (docs/behavior-lab/force-on-force/08)
//   active          ─ no way to its destination ─▶ failed
//   active, pending ─ the squad combat ineffective ─▶ failed
//   active          ─ the squad spent, breaking contact on its own ─▶ failed
//                     (the next orders wait until it recovers, or a player orders it)
//
// Each order carries the squad's actions on contact while it is active
// (`ActionsOn`, docs/behavior-lab/force-on-force/07); by default its kind's:
// a move continues (fights, and presses on), an attack assaults, a
// withdrawal avoids contact.

/** Gives a squad orders (or, `replace` with none, clears its plan: it holds where it is). */
export interface OrderSquadCommand {
  readonly type: 'orderSquad';
  readonly tick: number;
  /** The squad's root unit (a force of the force-on-force setup). */
  readonly unitId: string;
  readonly mode: 'replace' | 'append';
  readonly orders: readonly OrderSpec[];
}

export type OrderSquadRejection =
  'noForceModel' | 'unknownUnit' | 'unitIneffective' | 'destinationOffTerrain';

/** Throws a RangeError for a malformed `orderSquad` command (its own shape only). */
export function validateOrderSquad(command: OrderSquadCommand): void {
  if (typeof command.unitId !== 'string' || command.unitId === '') {
    throw new RangeError('orderSquad unitId must be a non-empty string');
  }
  const mode: string = command.mode;
  if (mode !== 'replace' && mode !== 'append') {
    throw new RangeError(`orderSquad mode must be replace or append, got ${mode}`);
  }
  command.orders.forEach((order, k) => {
    const problem = orderSpecProblem(order);
    if (problem) throw new RangeError(`orderSquad order ${String(k + 1)}: ${problem}`);
  });
}

/** Applies an `orderSquad` command at the start of its tick (`startSeconds`). */
export function applyOrderSquad(
  state: SimState,
  world: SimWorld,
  command: OrderSquadCommand,
  startSeconds: number,
  events: SimEvent[],
): void {
  const reject = (reason: OrderSquadRejection) => {
    events.push({ type: 'commandRejected', tick: state.tick, command, reason });
  };
  const setup = world.fof;
  if (!setup) {
    reject('noForceModel');
    return;
  }
  const fof = fofStateOf(state, setup);
  const force = fof.forces.find((f) => f.unitId === command.unitId);
  if (!force) {
    reject('unknownUnit');
    return;
  }
  if (force.phase === 'ineffective') {
    reject('unitIneffective');
    return;
  }
  for (const order of command.orders) {
    const d = order.destination;
    if (!d) continue;
    // On the battlefield; whether there is a way there is found when the order starts.
    if (!isOnTerrain(world.terrain, d.x, d.y)) {
      reject('destinationOffTerrain');
      return;
    }
  }
  const change = (order: FofOrder, to: OrderStatus, reason: string) => {
    const from = order.status;
    order.status = to;
    order.endedAt = startSeconds;
    order.reason = reason;
    events.push(orderEvent(state.tick, startSeconds, force, order, from, reason));
  };
  if (command.mode === 'replace') {
    const ending: OrderStatus = command.orders.length === 0 ? 'canceled' : 'superseded';
    for (const order of force.orders) {
      if (order.status === 'active' || order.status === 'pending') {
        change(order, ending, ending === 'canceled' ? 'plan cleared' : 'replaced by a new plan');
      }
    }
    force.activeOrderId = null;
  }
  for (const spec of command.orders) {
    const sequence = force.nextOrderSequence;
    force.nextOrderSequence += 1;
    const order: FofOrder = {
      id: `${force.unitId}#${String(sequence)}`,
      unitId: force.unitId,
      sequence,
      kind: spec.kind,
      actionsOn: spec.actionsOn ?? actionsOnFor(spec.kind),
      destination: spec.destination ? { x: spec.destination.x, y: spec.destination.y } : null,
      killZone: spec.killZone ?? null,
      source: 'player',
      issuedTick: state.tick,
      issuedAt: startSeconds,
      activatedAt: null,
      endedAt: null,
      status: 'pending',
      reason: null,
    };
    force.orders.push(order);
    events.push(orderEvent(state.tick, startSeconds, force, order, null, 'issued'));
  }
  // A player's orders are carried out at once, recovered or not.
  force.planned = true;
  force.holdUntilRecovered = false;
}

/** A force's active order, or `null`. */
export function activeOrder(force: FofForce): FofOrder | null {
  if (force.activeOrderId === null) return null;
  return force.orders.find((o) => o.id === force.activeOrderId) ?? null;
}

/** The actions on contact of an order kind, by default. */
export function actionsOnFor(kind: OrderKind): ActionsOn {
  return kind === 'attack' ? 'attack' : kind === 'withdraw' ? 'withdraw' : 'continue';
}

/**
 * A planned force's plan at a decision (before its contact behaviour): the
 * active order checked for its end, and the next one started.
 */
export function updatePlan(context: FofContext, force: FofForce, fallback: ActionsOn): void {
  if (!force.planned || force.phase === 'ineffective') return;
  const order = activeOrder(force);
  if (order) checkActive(context, force, order);
  if (activeOrder(force) === null) startNext(context, force, fallback);
}

function checkActive(context: FofContext, force: FofForce, order: FofOrder): void {
  const { t, setup } = context;
  const behavior = setup.config.force;
  const centre = centreOf(context, force);
  const there =
    order.destination !== null &&
    centre !== null &&
    Math.hypot(order.destination.x - centre.x, order.destination.y - centre.y) <=
      behavior.arrivalRadiusM;
  const stopped = force.phase === 'atObjective';
  switch (order.kind) {
    case 'move':
      if (stopped && there) endOrder(context, force, order, 'completed', 'destination reached');
      else if (stopped)
        endOrder(context, force, order, 'failed', 'could not reach the destination');
      return;
    case 'attack': {
      if (t - (order.activatedAt ?? t) >= behavior.attackTimeoutSeconds - 1e-9) {
        endOrder(context, force, order, 'failed', 'attack not completed in time');
        return;
      }
      if (stopped && !there) {
        endOrder(context, force, order, 'failed', 'could not reach the objective');
        return;
      }
      const picture = pictureOf(context, context.fof.forces.indexOf(force));
      const clear = picture.nearestConfirmed > behavior.engageRangeM;
      if (!(stopped && there && clear)) {
        force.objectiveQuietSince = null;
        return;
      }
      force.objectiveQuietSince ??= t;
      if (t - force.objectiveQuietSince >= behavior.attackClearSeconds - 1e-9) {
        endOrder(context, force, order, 'completed', 'objective taken: no enemy within reach');
      }
      return;
    }
    case 'withdraw':
      if (stopped && there)
        endOrder(context, force, order, 'completed', 'withdrawal point reached');
      else if (stopped)
        endOrder(context, force, order, 'failed', 'could not reach the withdrawal point');
      return;
    case 'ambush':
      // At its position it lies in wait (`inAmbush`); stopped anywhere else, it could not get there.
      if (stopped && force.ambushSprungAt === null)
        endOrder(context, force, order, 'failed', 'could not reach the ambush position');
      return;
  }
}

/** Ends the force's active order (and, failing it, nothing else: the next starts in turn). */
export function endOrder(
  context: FofContext,
  force: FofForce,
  order: FofOrder,
  to: 'completed' | 'failed',
  reason: string,
): void {
  const from = order.status;
  order.status = to;
  order.endedAt = context.t;
  order.reason = reason;
  if (force.activeOrderId === order.id) force.activeOrderId = null;
  force.objectiveQuietSince = null;
  context.events.push(orderEvent(context.tick, context.t, force, order, from, reason));
}

/** Fails the active order and every pending one (the squad can carry out none). */
export function failPlan(context: FofContext, force: FofForce, reason: string): void {
  for (const order of force.orders) {
    if (order.status === 'active' || order.status === 'pending') {
      endOrder(context, force, order, 'failed', reason);
    }
  }
}

/**
 * Starts the next pending order, if the squad may: not while it is
 * recovering from breaking contact on its own (until it has `recovered`). With nothing left to do, it holds where it
 * is (on its last actions on contact, `fallback`).
 */
function startNext(context: FofContext, force: FofForce, fallback: ActionsOn): void {
  if (force.holdUntilRecovered) {
    if (!recovered(force, context.setup.config)) return;
    force.holdUntilRecovered = false;
  }
  const next = force.orders.find((o) => o.status === 'pending');
  if (!next) {
    force.actionsOn = fallback;
    // Nothing more to do: stop where it is (it holds and observes, defending).
    if (force.phase === 'moving' && runningTask(context, force)) {
      cancelTask(context, force);
      force.mission = null;
      enter(context, force, 'atObjective', 'no more orders: holding');
    } else if (force.phase === 'moving') {
      force.mission = null;
      enter(context, force, 'atObjective', 'no more orders: holding');
    }
    return;
  }
  next.status = 'active';
  next.activatedAt = context.t;
  force.activeOrderId = next.id;
  force.objectiveQuietSince = null;
  force.actionsOn = next.actionsOn;
  force.pressOnUntil = null;
  force.ambushSprungAt = null;
  force.killZoneInside = [];
  context.events.push(orderEvent(context.tick, context.t, force, next, 'pending', 'started'));
  if (!next.destination) return;
  const zone = next.killZone;
  // An ambush faces its kill zone at its position.
  const facing = zone
    ? azimuthOf(zone.centre.x - next.destination.x, zone.centre.y - next.destination.y)
    : undefined;
  const mission = missionTo(context, force, next.destination, facing);
  if (!mission) {
    endOrder(context, force, next, 'failed', 'no way to the destination');
    return;
  }
  force.mission = mission;
  if (next.kind === 'withdraw') {
    // Breaking contact at once, whatever it was doing.
    standUp(context, force);
    force.objective = null;
    force.assaultAt = null;
    force.bounding = [];
    force.boundUnit = null;
    if (!issue(context, force, mission)) {
      endOrder(context, force, next, 'failed', 'no way to the withdrawal point');
      return;
    }
    enter(context, force, 'withdrawing', 'ordered to withdraw');
    return;
  }
  switch (force.phase) {
    case 'moving':
    case 'atObjective':
    case 'inAmbush':
    case 'withdrawing':
      // On its way (or breaking contact on an order now ended): to the new destination.
      standUp(context, force);
      force.concealed = false;
      // An ambush already at its position occupies it.
      if (next.kind === 'ambush' && withinArrival(context, force, next.destination)) {
        cancelTask(context, force);
        occupyAmbush(context, force, next);
        return;
      }
      if (issue(context, force, mission))
        enter(context, force, 'moving', `ordered to ${next.kind}`);
      else endOrder(context, force, next, 'failed', 'no way to the destination');
      return;
    case 'contact':
    case 'engaged':
      // In contact: it fights on; attacking, it assaults once it has located the enemy.
      if (next.kind === 'attack') {
        force.assaultAt ??= context.t + context.setup.config.force.assaultAfterSeconds;
      }
      return;
    default:
      // Observing, holding or assaulting: it carries on, then resumes toward the new destination.
      return;
  }
}

/** Whether the force's centre is within the arrival radius of `point`. */
export function withinArrival(context: FofContext, force: FofForce, point: Vec2): boolean {
  const centre = centreOf(context, force);
  return (
    centre !== null &&
    Math.hypot(point.x - centre.x, point.y - centre.y) <= context.setup.config.force.arrivalRadiusM
  );
}

/** The movement order to `destination` in the force's formation (facing `finalFacing` there), or `null` when it cannot get there. */
function missionTo(
  context: FofContext,
  force: FofForce,
  destination: Vec2,
  finalFacing?: number,
): UnitOrder | null {
  const { world } = context;
  const forceSetup = context.setup.forces.find((f) => f.unitId === force.unitId);
  const formation = force.mission?.formation ?? forceSetup?.formation;
  const area = forceArea(context, force);
  if (!formation || area === 0 || !isOnTerrain(world.terrain, destination.x, destination.y)) {
    return null;
  }
  const point = nearestInArea(world.terrain, destination, area);
  if (!point) return null;
  return {
    kind: 'moveInFormation',
    destination: point,
    formation,
    ...(finalFacing !== undefined ? { finalFacing } : {}),
    ...(forceSetup?.pace !== undefined ? { pace: forceSetup.pace } : {}),
  };
}

function orderEvent(
  tick: number,
  atSeconds: number,
  force: FofForce,
  order: FofOrder,
  from: OrderStatus | null,
  reason: string,
): SimEvent {
  return {
    type: 'orderChanged',
    tick,
    atSeconds,
    unitId: force.unitId,
    side: force.side,
    orderId: order.id,
    kind: order.kind,
    from,
    to: order.status,
    reason,
  };
}
