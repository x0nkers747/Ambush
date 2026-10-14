import { surfaceHeightAt } from '../bridge-navigation';
import type { SimEvent } from '../events';
import { azimuthDelta, azimuthOf, turnToward } from '../geometry';
import type { PathSegment, TickTime } from '../movement';
import type { SimState, Soldier } from '../state';
import type { SimWorld } from '../world';
import { flattenFormation } from './formation-spec';
import { DEFAULT_BEHAVIOR_PARAMS, type BehaviorParams } from './params';
import { createCrowd, fillCrowd, separation, type Crowd } from './crowd';
import { maxCurvature } from './route';
import { slotTarget, slotTargetAt, taskFrame, type SlotTarget, type TaskFrame } from './slots';
import type { AgentState, BehaviorState, TaskOutcome, TaskPhase, UnitTask } from './types';

// The unit-movement system (docs/behavior-lab/03 §4.3, §8): runs each tick
// before `moveSoldiers`, in fixed substeps of 1/substepHz s, so every tick
// rate dividing substepHz gives identical results. In each substep:
//
//   1. tasks, in issue order: the anchor's pace and position, and the phase;
//   2. agents, in soldier order: steer toward the slot, limited acceleration
//      and turning, then move.
//
// Positions and facings are written to the soldiers: they are the only
// output, and what the motion log and the 3D characters read.

/** The tick's unit-movement parameters. */
export function behaviorParams(world: SimWorld): BehaviorParams {
  return world.behavior ?? DEFAULT_BEHAVIOR_PARAMS;
}

/** Substeps per tick and their length, for a tick rate. */
export function substeps(
  tickRateHz: number,
  params: BehaviorParams,
): { n: number; exact: boolean } {
  const exact = params.substepHz % tickRateHz === 0;
  return {
    n: exact ? params.substepHz / tickRateHz : Math.ceil(params.substepHz / tickRateHz),
    exact,
  };
}

const target = slotTarget();
const pushed = { x: 0, y: 0 };
const NO_PUSH = Object.freeze({ x: 0, y: 0 });

/**
 * Moves every soldier steered by a unit task through the tick and returns
 * the straight pieces they travelled (one per substep), like `moveSoldiers`.
 */
export function updateBehavior(
  state: SimState,
  world: SimWorld,
  time: TickTime,
  events: SimEvent[],
): PathSegment[] {
  const behavior = state.behavior;
  if (!behavior) return [];
  const params = behaviorParams(world);
  const path: PathSegment[] = [];

  // Soldiers who were given individual orders (or fell) leave their tasks.
  const { soldiers, index, crowd } = lookups(state.soldiers, params.personalSpace);
  for (let i = behavior.agents.length - 1; i >= 0; i -= 1) {
    const agent = behavior.agents[i];
    if (!agent) continue;
    const soldier = soldiers.get(agent.soldierId);
    const reason = !soldier
      ? 'cancelled'
      : soldier.status === 'incapacitated'
        ? 'incapacitated'
        : soldier.orders !== null
          ? 'individualOrders'
          : null;
    if (reason) releaseAgent(behavior, i, reason, time.tick, time.startSeconds, events);
  }

  const active = behavior.tasks.filter(isRunning);
  if (active.length === 0) return path;

  // Each task's agents (in soldier order), gathered once: agents change only between ticks.
  const members = active.map((task) => behavior.agents.filter((a) => a.taskId === task.id));
  const tickRateHz = Math.round(1 / time.dtSeconds);
  const { n, exact } = substeps(tickRateHz, params);
  const h = 1 / (tickRateHz * n);
  for (let k = 0; k < n; k += 1) {
    // Substep times from whole substep counts, so they are the same numbers at every exact rate.
    const t = exact ? (time.tick * n + k) / params.substepHz : time.startSeconds + k * h;
    const tEnd = exact ? (time.tick * n + k + 1) / params.substepHz : t + h;
    for (let j = 0; j < active.length; j += 1) {
      const task = active[j];
      if (!task || !isRunning(task)) continue;
      const agents = members[j] ?? [];
      stepTask(
        task,
        taskFrame(task, agents, t, params),
        agents,
        soldiers,
        params,
        h,
        t,
        tEnd,
        time.tick,
        events,
      );
    }
    // Everyone's positions at the start of the substep: who steps first changes nothing.
    fillCrowd(crowd, state.soldiers);
    for (let j = 0; j < active.length; j += 1) {
      const task = active[j];
      if (!task || !isRunning(task)) continue;
      const agents = members[j] ?? [];
      const frame = taskFrame(task, agents, tEnd, params);
      for (const agent of agents) {
        const soldier = soldiers.get(agent.soldierId);
        if (!soldier) continue;
        const fromX = soldier.position.x;
        const fromY = soldier.position.y;
        stepAgent(
          agent,
          soldier,
          frame,
          world,
          params,
          h,
          crowd,
          index.get(soldier.id) ?? -1,
          tEnd,
        );
        if (soldier.position.x !== fromX || soldier.position.y !== fromY) {
          path.push({
            soldierId: soldier.id,
            from: { x: fromX, y: fromY },
            to: { x: soldier.position.x, y: soldier.position.y },
            startSeconds: t,
            endSeconds: tEnd,
          });
        }
      }
    }
  }
  return path;
}

/**
 * Soldiers by id, their indices, and a crowd buffer, kept per soldiers array
 * (soldiers are never added or removed during a simulation; a restored state
 * has a new array, and so new lookups). Derived data only, never state.
 */
const lookupCache = new WeakMap<
  readonly Soldier[],
  { soldiers: Map<string, Soldier>; index: Map<string, number>; crowd: Crowd; space: number }
>();

function lookups(all: readonly Soldier[], space: number) {
  let known = lookupCache.get(all);
  if (known?.space !== space || known.soldiers.size !== all.length) {
    known = {
      soldiers: new Map(all.map((s) => [s.id as string, s])),
      index: new Map(all.map((s, i) => [s.id as string, i])),
      crowd: createCrowd(all.length, space),
      space,
    };
    lookupCache.set(all, known);
  }
  return known;
}

function isRunning(task: UnitTask): boolean {
  return task.phase === 'forming' || task.phase === 'moving' || task.phase === 'settling';
}

/** What the anchor's pace law saw and decided (pure; also for diagnostics). */
export interface TaskPace {
  /** Participating agents, how many are in position, and how many stand still. */
  readonly members: number;
  readonly latched: number;
  readonly stopped: number;
  /** Largest distance of a Marine from his slot (m). */
  readonly worstDistance: number;
  /** Largest lag of a Marine behind his slot along the route (m), and whose. */
  readonly worstLag: number;
  readonly worstLagId: string | null;
  /** Fraction of pace kept for the worst lag (1: full pace, 0: wait). */
  readonly keep: number;
  /** Largest bend factor ahead (outermost slot's speed ÷ anchor speed). */
  readonly bend: number;
  /** Speed the anchor wants (m/s): the least of the pace law, the bend limit and the arrival limit. */
  readonly want: number;
  readonly limitedBy: 'pace' | 'cohesion' | 'bend' | 'arrival';
}

/**
 * The pace law for a task now: the anchor keeps the task's pace while every
 * Marine is near his slot, slows as the worst one falls behind and stops
 * before losing him; it slows before bends so the outermost slot keeps to
 * `bendSpeedFactor` × pace, and brakes to stop exactly at the route's end.
 */
export function taskPace(
  frame: TaskFrame,
  agents: readonly AgentState[],
  soldiers: ReadonlyMap<string, Pick<Soldier, 'position'>>,
  params: BehaviorParams,
): TaskPace {
  const { task, flat } = frame;
  const d = task.order.formation.interval;
  let worstDistance = 0;
  let worstLag = 0;
  let worstLagId: string | null = null;
  let bend = 1;
  let members = 0;
  let latched = 0;
  let stopped = 0;
  const lookAhead = task.anchorSpeed * 3 + 5;
  for (const agent of agents) {
    if (agent.taskId !== task.id) continue;
    const soldier = soldiers.get(agent.soldierId);
    const i = flat.indexOf.get(agent.slotId);
    if (!soldier || i === undefined) continue;
    slotTargetAt(frame, i, target);
    const ex = target.x - soldier.position.x;
    const ey = target.y - soldier.position.y;
    members += 1;
    if (agent.latched) latched += 1;
    if (agent.vx === 0 && agent.vy === 0) stopped += 1;
    // A straggler or a stuck Marine no longer holds the others back.
    if (agent.straggling || agent.stuck) continue;
    worstDistance = Math.max(worstDistance, Math.sqrt(ex * ex + ey * ey));
    const lag = ex * target.tx + ey * target.ty;
    if (lag > worstLag) {
      worstLag = lag;
      worstLagId = agent.soldierId;
    }
    const right = Math.abs((flat.right[i] ?? 0) - frame.rightCentre);
    const sSlot = task.anchorS - ((flat.back[i] ?? 0) - frame.backCentre);
    bend = Math.max(bend, 1 + maxCurvature(task.route, sSlot, sSlot + lookAhead) * right);
  }
  const span = (params.lagStop - params.lagStart) * d;
  const keep = Math.min(1, Math.max(0, 1 - (worstLag - params.lagStart * d) / span));
  const remaining = task.route.length - task.anchorS;
  let want = task.pace * keep;
  let limitedBy: TaskPace['limitedBy'] = keep < 1 ? 'cohesion' : 'pace';
  const bendLimit = (params.bendSpeedFactor * task.pace) / bend;
  if (bendLimit < want) {
    want = bendLimit;
    limitedBy = 'bend';
  }
  const arrivalLimit = Math.sqrt(2 * params.anchorArriveDecel * remaining) + 0.05;
  if (arrivalLimit < want) {
    want = arrivalLimit;
    limitedBy = 'arrival';
  }
  return {
    members,
    latched,
    stopped,
    worstDistance,
    worstLag,
    worstLagId,
    keep,
    bend,
    want,
    limitedBy,
  };
}

/** One substep of a task: its phase, and its anchor by the pace law. */
function stepTask(
  task: UnitTask,
  frame: TaskFrame,
  agents: readonly AgentState[],
  soldiers: ReadonlyMap<string, Soldier>,
  params: BehaviorParams,
  h: number,
  t: number,
  tEnd: number,
  tick: number,
  events: SimEvent[],
): void {
  const pace = taskPace(frame, agents, soldiers, params);
  if (pace.members === 0) {
    endTask(task, 'failed', 'noMembers', tick, t, events);
    return;
  }
  switch (task.phase) {
    case 'forming':
      if (
        pace.worstDistance <= params.formingBand * task.order.formation.interval ||
        t - task.phaseSince >= params.formingTimeout
      ) {
        setPhase(task, 'moving', tick, t, events);
      }
      return;
    case 'moving': {
      const dv = pace.want - task.anchorSpeed;
      task.anchorSpeed += Math.max(-params.anchorDecel * h, Math.min(params.anchorAccel * h, dv));
      const s = task.anchorS + task.anchorSpeed * h;
      if (s >= task.route.length) {
        task.anchorS = task.route.length;
        task.anchorSpeed = 0;
        setPhase(task, 'settling', tick, tEnd, events);
      } else {
        task.anchorS = s;
      }
      return;
    }
    case 'settling':
      if (pace.latched === pace.members && pace.stopped === pace.members) {
        endTask(task, 'complete', 'arrived', tick, tEnd, events);
      } else if (t - task.phaseSince >= params.settleTimeout) {
        endTask(task, 'complete', 'arrivedIncomplete', tick, tEnd, events);
      }
      return;
    default:
      return;
  }
}

/** What a Marine wants to do (pure; also for diagnostics). */
export interface Desire {
  /** His slot's target and its velocity. */
  readonly target: Readonly<SlotTarget>;
  /** Error to the slot (m), and its parts along the route (+: he is behind) and across it (+: slot to his right). */
  readonly error: number;
  readonly along: number;
  readonly across: number;
  /** Wanted velocity (m/s) after the caps and the turning factor. */
  readonly wx: number;
  readonly wy: number;
  /** Dead band in force (m), the speed cap (m/s), and the turning factor (0.1–1). */
  readonly band: number;
  readonly cap: number;
  readonly turnFactor: number;
  readonly state:
    | 'inPosition'
    | 'onStation'
    | 'correcting'
    | 'catchingUp'
    | 'easingOff'
    | 'arriving'
    | 'held'
    | 'displaced';
}

/**
 * A Marine's wanted velocity: the slot's own velocity plus a correction
 * toward it (gentle inside the dead band while on the move, so small errors
 * are not chased), capped at `maxSpeedFactor` × pace and, while settling, at
 * the speed from which he can stop at the slot. He turns toward where he
 * wants to go before walking fast (slowly while facing away).
 */
export function desire(
  agent: AgentState,
  soldier: Pick<Soldier, 'position' | 'azimuth'>,
  frame: TaskFrame,
  params: BehaviorParams,
  into: SlotTarget = slotTarget(),
  push: Readonly<{ x: number; y: number }> = NO_PUSH,
): Desire {
  const { task, flat } = frame;
  const i = flat.indexOf.get(agent.slotId) ?? 0;
  const t = slotTargetAt(frame, i, into);
  const ex = t.x - soldier.position.x;
  const ey = t.y - soldier.position.y;
  const e = Math.sqrt(ex * ex + ey * ey);
  const along = ex * t.tx + ey * t.ty;
  const across = ex * t.ty - ey * t.tx;
  const settling = task.phase === 'settling' || task.phase === 'complete';
  const band = settling ? 0 : params.deadBand * task.order.formation.interval;
  let cap = params.maxSpeedFactor * task.pace;
  if (agent.latched) return standing(t, e, along, across, band, cap, 'inPosition');
  if (agent.override?.kind === 'hold') return standing(t, e, along, across, band, cap, 'held');
  if (agent.override?.kind === 'goTo') {
    // Sent elsewhere: walk there at pace, stopping on the point.
    const gx = agent.override.x - soldier.position.x;
    const gy = agent.override.y - soldier.position.y;
    const g = Math.sqrt(gx * gx + gy * gy);
    const v = Math.min(task.pace, Math.sqrt(2 * params.decel * 0.25 * g));
    const f = g > 1e-9 ? v / g : 0;
    return {
      ...standing(t, e, along, across, band, cap, 'displaced'),
      wx: gx * f + push.x,
      wy: gy * f + push.y,
    };
  }
  // Correction speed: K·(e − band/2) beyond the band; inside it a gentle
  // K·e²/(2·band), so small errors fade without being chased (no
  // micro-corrections) and none is held for good.
  const correction =
    e > band
      ? params.trackingGain * (e - band / 2)
      : band > 0
        ? (params.trackingGain * e * e) / (2 * band)
        : 0;
  const gain = e > 1e-9 ? correction / e : 0;
  let wx = t.vx + ex * gain + push.x;
  let wy = t.vy + ey * gain + push.y;
  if (settling) cap = Math.min(cap, Math.sqrt(2 * params.decel * 0.25 * e));
  let w = Math.sqrt(wx * wx + wy * wy);
  if (w > cap) {
    wx *= cap / w;
    wy *= cap / w;
    w = cap;
  }
  // Turning before walking: full speed only toward where he faces.
  let turnFactor = 1;
  if (w > 1e-9) {
    const cos = (wx * Math.sin(soldier.azimuth) + wy * Math.cos(soldier.azimuth)) / w;
    turnFactor = Math.min(1, Math.max(0.1, (cos + 0.3) / 1.3));
    wx *= turnFactor;
    wy *= turnFactor;
  }
  const slotSpeed = Math.sqrt(t.vx * t.vx + t.vy * t.vy);
  const state: Desire['state'] = settling
    ? 'arriving'
    : e <= band
      ? 'onStation'
      : along > band && w > slotSpeed + 0.05
        ? 'catchingUp'
        : along < -band
          ? 'easingOff'
          : 'correcting';
  return { target: t, error: e, along, across, wx, wy, band, cap, turnFactor, state };
}

/** A wanted velocity of zero (in position, or held). */
function standing(
  target: Readonly<SlotTarget>,
  error: number,
  along: number,
  across: number,
  band: number,
  cap: number,
  state: Desire['state'],
): Desire {
  return { target, error, along, across, wx: 0, wy: 0, band, cap, turnFactor: 1, state };
}

/**
 * One substep of a Marine: latching in position while settling, then his
 * velocity toward the wanted one within the acceleration, braking and
 * turning limits (no jumps, no instant reversals, no sideways sliding),
 * then the move and his facing.
 */
function stepAgent(
  agent: AgentState,
  soldier: Soldier,
  frame: TaskFrame,
  world: SimWorld,
  params: BehaviorParams,
  h: number,
  crowd: Crowd,
  me: number,
  t: number,
): void {
  const { task } = frame;
  if (task.phase === 'settling' && agent.override === null) {
    const i = frame.flat.indexOf.get(agent.slotId) ?? 0;
    slotTargetAt(frame, i, target);
    const ex = target.x - soldier.position.x;
    const ey = target.y - soldier.position.y;
    const e = Math.sqrt(ex * ex + ey * ey);
    if (
      !agent.latched &&
      frame.settle >= 1 &&
      e <= params.latchRadius &&
      speedOf(agent) <= params.latchSpeed
    ) {
      agent.latched = true;
    } else if (agent.latched && e > params.unlatchRadius) {
      agent.latched = false;
    }
  }
  const push =
    me >= 0 ? separation(crowd, me, params.personalSpace, params.separationSpeed, pushed) : NO_PUSH;
  const wanted = desire(agent, soldier, frame, params, target, push);
  const { wx, wy } = wanted;

  // Velocity toward the wanted one within the limits: along the current
  // direction (accelerate, brake) and across it (turn).
  const v = speedOf(agent);
  let dx = wx - agent.vx;
  let dy = wy - agent.vy;
  if (v > 1e-9) {
    const ux = agent.vx / v;
    const uy = agent.vy / v;
    const along = Math.max(-params.decel * h, Math.min(params.accel * h, dx * ux + dy * uy));
    let acx = dx - (dx * ux + dy * uy) * ux;
    let acy = dy - (dx * ux + dy * uy) * uy;
    const across = Math.sqrt(acx * acx + acy * acy);
    const maxAcross = params.lateralAccel * h;
    if (across > maxAcross) {
      acx *= maxAcross / across;
      acy *= maxAcross / across;
    }
    const nx = agent.vx + along * ux + acx;
    const ny = agent.vy + along * uy + acy;
    // Braking through zero stops; it does not reverse in the same substep.
    if (nx * ux + ny * uy < 0) {
      agent.vx = 0;
      agent.vy = 0;
    } else {
      agent.vx = nx;
      agent.vy = ny;
    }
  } else {
    const dv = Math.sqrt(dx * dx + dy * dy);
    const max = params.accel * h;
    if (dv > max) {
      dx *= max / dv;
      dy *= max / dv;
    }
    agent.vx = dx;
    agent.vy = dy;
  }

  soldier.position.x += agent.vx * h;
  soldier.position.y += agent.vy * h;
  soldier.position.z = surfaceHeightAt(world.terrain, soldier.position.x, soldier.position.y);

  // Facing: toward travel when walking; toward where he means to go when
  // starting off; the final facing once in position.
  const speed = speedOf(agent);
  const turn = world.movement.maxTurnRate * h;
  if (speed > params.facingSpeed) {
    soldier.azimuth = turnToward(soldier.azimuth, azimuthOf(agent.vx, agent.vy), turn);
  } else if (Math.sqrt(wx * wx + wy * wy) > 0.05) {
    soldier.azimuth = turnToward(soldier.azimuth, azimuthOf(wx, wy), turn);
  } else if (agent.latched && azimuthDelta(soldier.azimuth, task.finalFacing) !== 0) {
    soldier.azimuth = turnToward(soldier.azimuth, task.finalFacing, turn);
  }

  // A Marine sent elsewhere rejoins once there.
  if (agent.override?.kind === 'goTo') {
    const gx = agent.override.x - soldier.position.x;
    const gy = agent.override.y - soldier.position.y;
    if (gx * gx + gy * gy <= 1 && speed <= params.latchSpeed) agent.override = null;
  }
  // Out of contact for long enough: a straggler.
  const d = task.order.formation.interval;
  const e = wanted.error;
  if (e > Math.max(params.contactRadius * d, params.contactMinimum)) {
    agent.farSince ??= t;
    agent.straggling = t - agent.farSince >= params.stragglerSeconds;
  } else {
    agent.farSince = null;
    agent.straggling = false;
  }
  // Stuck: over each window, too little progress toward a slot he is not near.
  if (t - agent.checkAt >= params.stuckSeconds) {
    agent.stuck =
      agent.override === null &&
      !agent.latched &&
      e > 2 * wanted.band + params.latchRadius &&
      agent.checkError - e < params.stuckProgress;
    agent.checkError = e;
    agent.checkAt = t;
  }
}

function speedOf(agent: AgentState): number {
  return Math.sqrt(agent.vx * agent.vx + agent.vy * agent.vy);
}

function setPhase(
  task: UnitTask,
  phase: TaskPhase,
  tick: number,
  at: number,
  events: SimEvent[],
): void {
  task.phase = phase;
  task.phaseSince = at;
  events.push({
    type: 'unitPhaseChanged',
    tick,
    taskId: task.id,
    unitId: task.unitId,
    phase,
    atSeconds: at,
  });
}

/** Ends a task; Marines who arrived stay with it (standing in position) until given another order. */
export function endTask(
  task: UnitTask,
  phase: 'complete' | 'failed',
  outcome: TaskOutcome,
  tick: number,
  at: number,
  events: SimEvent[],
): void {
  task.phase = phase;
  task.phaseSince = at;
  task.endedAt = at;
  task.outcome = outcome;
  task.anchorSpeed = 0;
  events.push({
    type: 'unitTaskEnded',
    tick,
    taskId: task.id,
    unitId: task.unitId,
    outcome,
    atSeconds: at,
  });
}

/**
 * Removes agent `index`: the soldier keeps his position and facing and is no
 * longer steered. A task left without agents ends (`noMembers`) unless it
 * has already ended.
 */
export function releaseAgent(
  behavior: BehaviorState,
  index: number,
  reason: 'reordered' | 'individualOrders' | 'incapacitated' | 'cancelled',
  tick: number,
  at: number,
  events: SimEvent[],
  outcome: 'cancelled' | 'superseded' = 'cancelled',
): void {
  const agent = behavior.agents[index];
  if (!agent) return;
  behavior.agents.splice(index, 1);
  events.push({
    type: 'memberReleased',
    tick,
    taskId: agent.taskId,
    soldierId: agent.soldierId,
    reason,
  });
  const task = behavior.tasks.find((t) => t.id === agent.taskId);
  if (task && isRunning(task) && !behavior.agents.some((a) => a.taskId === task.id)) {
    endTask(
      task,
      'failed',
      reason === 'cancelled' || reason === 'reordered' ? outcome : 'noMembers',
      tick,
      at,
      events,
    );
  }
}

/** The formation's slot table, for callers outside the system. */
export { flattenFormation };
