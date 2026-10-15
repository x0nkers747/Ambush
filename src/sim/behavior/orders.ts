import type { SimEvent } from '../events';
import { azimuthOf, type Vec2 } from '../geometry';
import { planPath, pointProblem } from '../navigation';
import { canonicalEncode, clonePlainData } from '../plain-data';
import { nextUint32 } from '../rng';
import type { OrgUnitId, SimState, SoldierId } from '../state';
import type { SimWorld } from '../world';
import { flattenFormation, validateFormationSpec } from './formation-spec';
import { behaviorParams, endTask, releaseAgent } from './system';
import { arrangeFormation } from './arrange';
import { buildGroupRoute, routeAt, routePoint } from './route';
import type {
  AgentOverride,
  FormationSpec,
  AgentState,
  BehaviorState,
  GroupRoute,
  UnitOrder,
  UnitTask,
} from './types';

// Unit orders (docs/behavior-lab/03 §4.2): `orderUnit` gives an organization
// one task. Its Marines stop following individual orders and are steered by
// the task until it ends, they are given other orders, or they fall.

/**
 * Gives an organization (fire team, squad, …) an order, or cancels its task
 * (`order: null`): its Marines then stand where they are.
 */
export interface OrderUnitCommand {
  readonly type: 'orderUnit';
  readonly tick: number;
  readonly unitId: OrgUnitId;
  readonly order: UnitOrder | null;
}

/**
 * Disturbs a Marine steered by a unit task, for testing how a formation
 * recovers (the Behavior Lab): `hold` keeps him where he stands, `goTo`
 * sends him to a point, after which he rejoins his slot; `null` releases a
 * hold or recalls him at once. Rejected (`notSteered`) for a soldier no task steers.
 */
export interface DisturbAgentCommand {
  readonly type: 'disturbAgent';
  readonly tick: number;
  readonly soldierId: SoldierId;
  readonly disturbance: AgentOverride | null;
}

/** Throws a RangeError for a malformed disturbance. */
export function validateDisturbance(disturbance: AgentOverride | null): void {
  if (disturbance === null) return;
  const kind: string = disturbance.kind;
  if (kind === 'hold') return;
  if (kind !== 'goTo') throw new RangeError(`unknown disturbance kind "${kind}"`);
  if (
    disturbance.kind === 'goTo' &&
    (!Number.isFinite(disturbance.x) || !Number.isFinite(disturbance.y))
  ) {
    throw new RangeError('disturbance point must be finite');
  }
}

/** Applies a disturbance at the start of its tick. */
export function applyDisturbAgent(
  state: SimState,
  command: DisturbAgentCommand,
  events: SimEvent[],
): void {
  const agent = state.behavior?.agents.find((a) => a.soldierId === command.soldierId);
  if (!agent) {
    events.push({ type: 'commandRejected', tick: state.tick, command, reason: 'notSteered' });
    return;
  }
  agent.override = command.disturbance && { ...command.disturbance };
  agent.latched = false;
  // A disturbance is not a stall: restart the contact and progress windows.
  agent.farSince = null;
  agent.straggling = false;
  agent.stuck = false;
  agent.checkError = -1;
}

export type OrderUnitRejection =
  | 'unknownUnit'
  | 'formationMismatch'
  | 'noActiveMembers'
  | 'destinationOffTerrain'
  | 'destinationBlocked'
  | 'destinationUnreachable';

/** Throws a RangeError for a malformed order (shape only; see `applyOrderUnit`). */
export function validateUnitOrder(order: UnitOrder | null): void {
  if (order === null) return;
  const kind: string = order.kind;
  if (kind !== 'moveInFormation') {
    throw new RangeError(`unknown unit order kind "${kind}"`);
  }
  const { destination, finalFacing, pace } = order;
  if (!Number.isFinite(destination.x) || !Number.isFinite(destination.y)) {
    throw new RangeError('order destination must be finite');
  }
  if (finalFacing !== undefined && !(finalFacing >= 0 && finalFacing < 2 * Math.PI)) {
    throw new RangeError(`finalFacing must be an azimuth in [0, 2π), got ${String(finalFacing)}`);
  }
  if (pace !== undefined && !(Number.isFinite(pace) && pace > 0)) {
    throw new RangeError(`pace must be a finite number > 0, got ${String(pace)}`);
  }
  validateFormationSpec(order.formation);
}

/**
 * Applies a unit order at the start of its tick:
 *
 * 1. the unit must exist, and the formation must be its (root `unitId`), with
 *    every slot held by a soldier of the unit or its subordinate units;
 * 2. the participants are those soldiers who are active;
 * 3. the destination must be a place to stand that the route reaches;
 * 4. the unit's earlier tasks are cancelled, and participants leave any
 *    other task they were in (`reordered`); their individual orders are cleared;
 * 5. one route is planned from the participants' centre to the destination,
 *    the anchor starts at its start, and one agent per participant is created.
 *
 * A rejected order changes nothing.
 */
export function applyOrderUnit(
  state: SimState,
  world: SimWorld,
  command: OrderUnitCommand,
  startSeconds: number,
  events: SimEvent[],
): void {
  const reject = (reason: OrderUnitRejection) => {
    events.push({ type: 'commandRejected', tick: state.tick, command, reason });
  };
  const unit = state.units.find((u) => u.id === command.unitId);
  if (!unit) {
    reject('unknownUnit');
    return;
  }
  const { order } = command;
  if (order === null) {
    cancelUnitTasks(state, command.unitId, startSeconds, events);
    return;
  }
  if (order.formation.root.unitId !== command.unitId) {
    reject('formationMismatch');
    return;
  }

  // The unit and its subordinate units.
  const inUnit = new Set<string>([unit.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const u of state.units) {
      if (u.parentId !== null && inUnit.has(u.parentId) && !inUnit.has(u.id)) {
        inUnit.add(u.id);
        grew = true;
      }
    }
  }
  const flat = flattenFormation(order.formation);
  const slotOf = new Map<string, string>();
  flat.soldierIds.forEach((id, i) => slotOf.set(id, flat.slotIds[i] ?? ''));
  for (const id of flat.soldierIds) {
    const soldier = state.soldiers.find((s) => s.id === id);
    if (!soldier || !inUnit.has(soldier.unitId)) {
      reject('formationMismatch');
      return;
    }
  }
  const members = state.soldiers.filter((s) => slotOf.has(s.id) && s.status === 'active');
  if (members.length === 0) {
    reject('noActiveMembers');
    return;
  }

  // The route points and the destination must be places to stand.
  const stops = [...(order.via ?? []), order.destination];
  for (const stop of stops) {
    const problem = pointProblem(world.terrain, stop);
    if (problem) {
      reject(problem.kind === 'offTerrain' ? 'destinationOffTerrain' : 'destinationBlocked');
      return;
    }
  }

  // A unit already on the move goes straight on (consecutive waypoints, or
  // a new formation, without stopping): the new route begins with the
  // stretch of the old one its Marines still occupy, and the anchor keeps
  // its place and speed. In the same formation the Marines keep their
  // slots; in a new one they make for their new slots on the move, as when
  // falling in.
  const previous = state.behavior?.tasks.find(
    (t) => t.unitId === command.unitId && (t.phase === 'moving' || t.phase === 'settling'),
  );
  const sameFormation =
    previous !== undefined &&
    canonicalEncode(previous.order.formation) === canonicalEncode(order.formation);
  // The unit's leader, when he takes part, steps off first; the formation is
  // arranged (which team leads, which side) to ask the least walking of the
  // rest from where they stand. A continued order keeps its arrangement.
  const leader = members.find((s) => s.id === unit.leaderId);
  const firstStop = stops[0] ?? order.destination;
  let fromX = 0;
  let fromY = 0;
  for (const s of members) {
    fromX += s.position.x / members.length;
    fromY += s.position.y / members.length;
  }
  if (leader) {
    fromX = leader.position.x;
    fromY = leader.position.y;
  }
  const hx = firstStop.x - fromX;
  const hy = firstStop.y - fromY;
  const hl = Math.sqrt(hx * hx + hy * hy);
  const facing = leader?.azimuth ?? members[0]?.azimuth ?? 0;
  const heading =
    hl > 1e-6 ? { x: hx / hl, y: hy / hl } : { x: Math.sin(facing), y: Math.cos(facing) };
  const positions = new Map(
    members.map((s) => [s.id as string, { x: s.position.x, y: s.position.y }]),
  );
  let formation: FormationSpec;
  if (previous && sameFormation) {
    formation = previous.formation;
  } else if (previous) {
    // A new formation on the move: arranged round the Marines' centre,
    // facing along the route where the anchor is.
    const along = routeAt(previous.route, previous.anchorS, routePoint());
    formation = arrangeFormation(order.formation, positions, { x: along.tx, y: along.ty }, null);
  } else {
    formation = arrangeFormation(order.formation, positions, heading, leader?.id ?? null);
  }
  const laid = flattenFormation(formation);
  let rc = 0;
  let bc = 0;
  for (let i = 0; i < laid.right.length; i += 1) {
    rc += laid.right[i] ?? 0;
    bc += laid.back[i] ?? 0;
  }
  rc /= laid.right.length;
  bc /= laid.back.length;
  let halfWidth = 0;
  let behind = 0;
  for (let i = 0; i < laid.right.length; i += 1) {
    halfWidth = Math.max(halfWidth, Math.abs((laid.right[i] ?? 0) - rc));
    behind = Math.max(behind, (laid.back[i] ?? 0) - bc);
  }
  // Continuing, the new route keeps the old one from just behind the rear
  // Marine through to the old destination, and turns there: Marines ahead
  // of the anchor keep their slots (turning at the anchor would swing them
  // round the corner), and the corner is rounded like any route point.
  // Where the leader's slot is in the formation.
  const leaderSlot = leader ? laid.soldierIds.indexOf(leader.id) : -1;
  const leaderAt =
    leader && leaderSlot >= 0
      ? {
          soldier: leader,
          back: (laid.back[leaderSlot] ?? 0) - bc,
          right: (laid.right[leaderSlot] ?? 0) - rc,
        }
      : null;
  let tail: Vec2[] = [];
  let start: Vec2;
  let anchorPoint: Vec2 | null = null;
  let anchorWithin = 0;
  if (previous) {
    const from = Math.max(0, previous.anchorS - behind - 10);
    tail = routeStretch(previous.route, from, previous.route.length);
    start = tail.pop() ?? { x: 0, y: 0 };
    const at = routeAt(previous.route, previous.anchorS, routePoint());
    anchorPoint = { x: at.x, y: at.y };
    anchorWithin = previous.route.length - from + 1;
  } else if (leaderAt) {
    // The leader steps off at once: the route starts where his slot puts
    // him, and the others fall in round him on the move.
    const ux = heading.x;
    const uy = heading.y;
    // The route's right is (uy, −ux); his slot is `right` metres to that side of it.
    start = {
      x: leaderAt.soldier.position.x - uy * leaderAt.right,
      y: leaderAt.soldier.position.y + ux * leaderAt.right,
    };
  } else {
    let cx = 0;
    let cy = 0;
    for (const s of members) {
      cx += s.position.x;
      cy += s.position.y;
    }
    start = { x: cx / members.length, y: cy / members.length };
  }
  const points: Vec2[] = [...tail, start];
  let from = start;
  for (const stop of stops) {
    const path = planPath(world.terrain, from, stop);
    if (!path.ok) {
      reject(
        path.problem.kind === 'offTerrain'
          ? 'destinationOffTerrain'
          : path.problem.kind === 'unreachable'
            ? 'destinationUnreachable'
            : 'destinationBlocked',
      );
      return;
    }
    for (const p of path.turns) points.push({ x: p.x, y: p.y });
    points.push({ x: stop.x, y: stop.y });
    from = stop;
  }

  const behavior = (state.behavior ??= { tasks: [], agents: [], nextTaskSeq: 0 });
  const carriedSpeed = previous?.anchorSpeed ?? 0;
  const carried = new Map<string, { vx: number; vy: number }>();
  for (const agent of behavior.agents) {
    if (agent.taskId === previous?.id) {
      carried.set(agent.soldierId, { vx: agent.vx, vy: agent.vy });
    }
  }
  cancelUnitTasks(
    state,
    command.unitId,
    startSeconds,
    events,
    previous ? 'superseded' : 'cancelled',
  );
  for (let i = behavior.agents.length - 1; i >= 0; i -= 1) {
    if (slotOf.has(behavior.agents[i]?.soldierId ?? '')) {
      releaseAgent(behavior, i, 'reordered', state.tick, startSeconds, events);
    }
  }
  pruneEndedTasks(behavior);

  // Corners are rounded to the formation's half-width (about its centre) plus a margin.
  const params = behaviorParams(world);
  const firstFacing = members[0]?.azimuth ?? 0;
  const route = buildGroupRoute(world.terrain, points, halfWidth + params.cornerMargin, {
    x: Math.sin(firstFacing),
    y: Math.cos(firstFacing),
  });
  const last = route.x.length - 1;
  const finalFacing = order.finalFacing ?? azimuthOf(route.tx[last] ?? 0, route.ty[last] ?? 1);
  const anchorS = anchorPoint
    ? nearestArcLength(route, anchorPoint, anchorWithin)
    : (leaderAt?.back ?? 0);

  const task: UnitTask = {
    id: `${command.unitId}#${String(behavior.nextTaskSeq)}`,
    unitId: command.unitId,
    order: clonePlainData(order),
    formation: clonePlainData(formation),
    route,
    finalFacing,
    pace: order.pace ?? world.movement.speed,
    seed: nextUint32(state.rng),
    phase: 'moving',
    phaseSince: startSeconds,
    anchorS,
    anchorSpeed: carriedSpeed,
    startedAt: startSeconds,
    endedAt: null,
    outcome: null,
  };
  behavior.nextTaskSeq += 1;
  behavior.tasks.push(task);

  const soldierIndex = new Map(state.soldiers.map((s, i) => [s.id as string, i]));
  for (const soldier of members) {
    soldier.orders = null;
    const agent: AgentState = {
      soldierId: soldier.id,
      taskId: task.id,
      slotId: slotOf.get(soldier.id) ?? '',
      vx: carried.get(soldier.id)?.vx ?? 0,
      vy: carried.get(soldier.id)?.vy ?? 0,
      latched: false,
      // Marines already in formation (a continued order) have fallen in.
      joined: sameFormation && carried.has(soldier.id),
      override: null,
      farSince: null,
      straggling: false,
      checkError: -1,
      checkAt: startSeconds,
      stuck: false,
      detour: null,
      detourIndex: 0,
      lastRoutable: null,
    };
    insertAgent(soldierIndex, behavior, agent);
  }
  events.push({
    type: 'unitOrdered',
    tick: state.tick,
    unitId: command.unitId,
    taskId: task.id,
    memberIds: members.map((s) => s.id),
  });
}

/** Keeps agents in soldier order. */
function insertAgent(
  index: ReadonlyMap<string, number>,
  behavior: BehaviorState,
  agent: AgentState,
): void {
  const at = index.get(agent.soldierId) ?? 0;
  const i = behavior.agents.findIndex((a) => (index.get(a.soldierId) ?? 0) > at);
  if (i < 0) behavior.agents.push(agent);
  else behavior.agents.splice(i, 0, agent);
}

/** Cancels the running tasks of `unitId`; their Marines stand where they are. */
function cancelUnitTasks(
  state: SimState,
  unitId: OrgUnitId,
  at: number,
  events: SimEvent[],
  outcome: 'cancelled' | 'superseded' = 'cancelled',
): void {
  const behavior = state.behavior;
  if (!behavior) return;
  for (const task of behavior.tasks) {
    if (task.unitId !== unitId) continue;
    for (let i = behavior.agents.length - 1; i >= 0; i -= 1) {
      if (behavior.agents[i]?.taskId === task.id) {
        releaseAgent(
          behavior,
          i,
          outcome === 'cancelled' ? 'cancelled' : 'reordered',
          state.tick,
          at,
          events,
          outcome,
        );
      }
    }
    if (task.outcome === null) endTask(task, 'failed', outcome, state.tick, at, events);
  }
}

/** Drops ended tasks no agent refers to any more (their record is in the events and the recording). */
function pruneEndedTasks(behavior: BehaviorState): void {
  behavior.tasks = behavior.tasks.filter(
    (t) => t.outcome === null || behavior.agents.some((a) => a.taskId === t.id),
  );
}

/** Points of `route` from arc length `s0` to `s1` (both ends included, `s0` clamped to the start). */
function routeStretch(route: GroupRoute, s0: number, s1: number): Vec2[] {
  const a = Math.max(0, Math.min(s0, s1));
  const out: Vec2[] = [];
  const p = routeAt(route, a, routePoint());
  out.push({ x: p.x, y: p.y });
  for (let i = 0; i < route.cum.length; i += 1) {
    const s = route.cum[i] ?? 0;
    if (s > a + 1e-6 && s < s1 - 1e-6) out.push({ x: route.x[i] ?? 0, y: route.y[i] ?? 0 });
  }
  const q = routeAt(route, s1, routePoint());
  out.push({ x: q.x, y: q.y });
  return out;
}

/** Arc length of the point of `route` nearest `p`, among its first `within` metres. */
function nearestArcLength(route: GroupRoute, p: Vec2, within: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < route.cum.length && (route.cum[i] ?? 0) <= within; i += 1) {
    const ax = route.x[i] ?? 0;
    const ay = route.y[i] ?? 0;
    const dx = (route.x[i + 1] ?? ax) - ax;
    const dy = (route.y[i + 1] ?? ay) - ay;
    const l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / l2)) : 0;
    const qx = ax + dx * u - p.x;
    const qy = ay + dy * u - p.y;
    const d = qx * qx + qy * qy;
    if (d < bestD) {
      bestD = d;
      best = (route.cum[i] ?? 0) + u * Math.sqrt(l2);
    }
  }
  return best;
}
