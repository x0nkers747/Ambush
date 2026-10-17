import { surfaceHeightAt } from '../bridge-navigation';
import type { SimEvent } from '../events';
import { isSegmentWalkable, navArea, planPath, pointProblem } from '../navigation';
import { azimuthDelta, azimuthOf, turnToward } from '../geometry';
import type { TickTime } from '../movement';
import type { SimState, Soldier } from '../state';
import type { SimWorld } from '../world';
import { flattenFormation } from './formation-spec';
import { DEFAULT_BEHAVIOR_PARAMS, type BehaviorParams } from './params';
import { createCrowd, CROWD_CELL_M, fillCrowd, separation, type Crowd } from './crowd';
import { maxCurvature } from './route';
import {
  nearestInArea,
  slotTarget,
  slotTargetAt,
  taskFrame,
  type SlotTarget,
  type TaskFrame,
} from './slots';
import type { AgentState, BehaviorState, TaskOutcome, TaskPhase, UnitTask } from './types';
import { catalogOf, platformOf } from '../combat/registry';

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

/** A vehicle as the soldiers keep out of its way: where it is, which way it faces and goes, its size. */
interface VehicleFootprint {
  readonly x: number;
  readonly y: number;
  /** Its heading (unit vector). */
  readonly hx: number;
  readonly hy: number;
  /** Its velocity (m/s). */
  readonly vx: number;
  readonly vy: number;
  readonly halfLength: number;
  readonly halfWidth: number;
}

/** A soldier keeps this clear of a vehicle's hull (m). */
const VEHICLE_SPACE_M = 1.2;
/** He looks this far ahead (s) for a vehicle coming at him, and steps aside up to this fast (m/s). */
const VEHICLE_HORIZON_S = 1.5;
const STEP_ASIDE_SPEED = 2.5;

/** The vehicles' footprints now (none destroyed is skipped: a wreck is in the way too). */
function vehicleFootprints(state: SimState, world: SimWorld): VehicleFootprint[] {
  const vehicles = state.vehicles;
  if (!vehicles || vehicles.length === 0) return [];
  const catalog = catalogOf(world);
  return vehicles.map((v) => {
    const size = platformOf(catalog, v.kind).dimensions;
    const hx = Math.sin(v.heading);
    const hy = Math.cos(v.heading);
    return {
      x: v.position.x,
      y: v.position.y,
      hx,
      hy,
      vx: hx * v.speed,
      vy: hy * v.speed,
      halfLength: size.lengthM / 2,
      halfWidth: size.widthM / 2,
    };
  });
}

/**
 * Adds to `push` the velocity stepping a soldier at `p`, going at `v`, out
 * of the way of the vehicles: of each whose hull (with `VEHICLE_SPACE_M`
 * round it) he is in, or will be within `VEHICLE_HORIZON_S` as both go on,
 * he steps aside, away from its centreline (out of its path), the sooner the
 * faster; one standing still he walks round as round an obstacle.
 */
function stepAside(
  vehicles: readonly VehicleFootprint[],
  p: { readonly x: number; readonly y: number },
  v: { readonly x: number; readonly y: number },
  push: { x: number; y: number },
): void {
  for (const car of vehicles) {
    const reach = car.halfLength + VEHICLE_SPACE_M + 3 * VEHICLE_HORIZON_S * 4;
    if (Math.abs(p.x - car.x) > reach || Math.abs(p.y - car.y) > reach) continue;
    let w = 0;
    let side = 0;
    for (const tau of [0, 0.5, 1, 1.5]) {
      if (tau > VEHICLE_HORIZON_S) break;
      const qx = p.x + v.x * tau - (car.x + car.vx * tau);
      const qy = p.y + v.y * tau - (car.y + car.vy * tau);
      const along = qx * car.hx + qy * car.hy;
      const across = qx * car.hy - qy * car.hx;
      if (
        Math.abs(along) < car.halfLength + VEHICLE_SPACE_M &&
        Math.abs(across) < car.halfWidth + VEHICLE_SPACE_M
      ) {
        w = 1 - tau / (2 * VEHICLE_HORIZON_S);
        // Away from its centreline, as he stands now (on it: to its right).
        const now = (p.x - car.x) * car.hy - (p.y - car.y) * car.hx;
        side = now >= 0 ? 1 : -1;
        break;
      }
    }
    if (w <= 0) continue;
    // Its right is (hy, −hx).
    push.x += car.hy * side * STEP_ASIDE_SPEED * w;
    push.y += -car.hx * side * STEP_ASIDE_SPEED * w;
  }
}

/** Moves every soldier steered by a unit task through the tick. */
export function updateBehavior(
  state: SimState,
  world: SimWorld,
  time: TickTime,
  events: SimEvent[],
): void {
  const behavior = state.behavior;
  if (!behavior) return;
  const params = behaviorParams(world);

  // Soldiers who were given individual orders (or fell) leave their tasks.
  const { soldiers, index, crowd } = lookups(state.soldiers, CROWD_CELL_M);
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
  if (active.length === 0) return;
  // The vehicles, as the soldiers step out of their way (where they are this tick).
  const vehicles = vehicleFootprints(state, world);

  // Each task's agents (in soldier order), gathered once: agents change only between ticks.
  const members = active.map((task) => behavior.agents.filter((a) => a.taskId === task.id));
  const velocities = new Float64Array(2 * state.soldiers.length);
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
        taskFrame(task, agents, t, params, world.terrain),
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
    velocities.fill(0);
    for (const agent of behavior.agents) {
      const k = index.get(agent.soldierId);
      if (k === undefined) continue;
      velocities[2 * k] = agent.vx;
      velocities[2 * k + 1] = agent.vy;
    }
    fillCrowd(crowd, state.soldiers, (k, out) => {
      out.x = velocities[2 * k] ?? 0;
      out.y = velocities[2 * k + 1] ?? 0;
    });
    for (let j = 0; j < active.length; j += 1) {
      const task = active[j];
      if (!task || !isRunning(task)) continue;
      const agents = members[j] ?? [];
      const frame = taskFrame(task, agents, tEnd, params, world.terrain);
      for (const agent of agents) {
        const soldier = soldiers.get(agent.soldierId);
        if (!soldier) continue;
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
          vehicles,
        );
      }
    }
  }
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
  return task.phase === 'moving' || task.phase === 'settling';
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
  readonly limitedBy: 'pace' | 'joining' | 'cohesion' | 'bend' | 'arrival';
  /** Marines still falling in. */
  readonly joining: number;
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
  const d = task.formation.interval;
  let worstDistance = 0;
  let worstLag = 0;
  let worstLagId: string | null = null;
  let bend = 1;
  let members = 0;
  let latched = 0;
  let stopped = 0;
  let joining = 0;
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
    if (!agent.joined) joining += 1;
    // A Marine still falling in, a straggler or a stuck Marine does not hold the others back.
    if (!agent.joined || agent.straggling || agent.stuck) continue;
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
  // While Marines fall in, an easier pace lets them catch up.
  if (
    joining > 0 &&
    frame.t - task.startedAt < params.joinTimeout &&
    params.joinPace * task.pace < want
  ) {
    want = params.joinPace * task.pace;
    limitedBy = 'joining';
  }
  const bendLimit = Math.max(
    params.minBendPace * task.pace,
    (params.bendSpeedFactor * task.pace) / bend,
  );
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
    joining,
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
  /** Dead band in force (m), the speed cap (m/s), and the turning factor (0.05–1). */
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
    | 'displaced'
    | 'fallingIn'
    | 'detouring';
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
  const band = settling ? 0 : params.deadBand * task.formation.interval;
  let cap = params.maxSpeedFactor * task.pace;
  if (agent.latched) return standing(t, e, along, across, band, cap, 'inPosition');
  if (agent.override?.kind === 'hold') return standing(t, e, along, across, band, cap, 'held');
  const via = agent.detour?.[agent.detourIndex];
  if (agent.override?.kind === 'goTo') {
    // Sent elsewhere: walk there at pace (round obstacles), stopping on the point.
    const gx = (via?.x ?? agent.override.x) - soldier.position.x;
    const gy = (via?.y ?? agent.override.y) - soldier.position.y;
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
  // Round an obstacle: the same speed, toward the next point of his way round.
  if (via) {
    const speed = Math.max(Math.min(w, cap), Math.min(cap, task.pace));
    const vx = via.x - soldier.position.x;
    const vy = via.y - soldier.position.y;
    const l = Math.sqrt(vx * vx + vy * vy);
    if (l > 1e-9) {
      wx = (vx / l) * speed + push.x;
      wy = (vy / l) * speed + push.y;
      w = Math.sqrt(wx * wx + wy * wy);
      if (w > cap) {
        wx *= cap / w;
        wy *= cap / w;
        w = cap;
      }
    }
  }
  // Turning before walking: full speed only toward where he faces.
  let turnFactor = 1;
  if (w > 1e-9) {
    const cos = (wx * Math.sin(soldier.azimuth) + wy * Math.cos(soldier.azimuth)) / w;
    // Full speed within about 35° of his facing; at 90° or more, a few
    // centimetres a second while he turns (people turn, then walk).
    turnFactor = Math.min(1, Math.max(0.05, (cos - 0.2) / 0.6));
    wx *= turnFactor;
    wy *= turnFactor;
  }
  const slotSpeed = Math.sqrt(t.vx * t.vx + t.vy * t.vy);
  const state: Desire['state'] = via
    ? 'detouring'
    : settling
      ? 'arriving'
      : !agent.joined
        ? 'fallingIn'
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
  vehicles: readonly VehicleFootprint[] = [],
): void {
  const { task } = frame;
  if (task.phase === 'settling' && agent.override === null) {
    const i = frame.flat.indexOf.get(agent.slotId) ?? 0;
    slotTargetAt(frame, i, target);
    const ex = target.x - soldier.position.x;
    const ey = target.y - soldier.position.y;
    const e = Math.sqrt(ex * ex + ey * ey);
    // In position: at his slot, or as close as he can get to it (stuck:
    // another Marine stands there, or an obstacle is in the way).
    if (
      !agent.latched &&
      frame.settle >= 1 &&
      (e <= params.latchRadius || agent.stuck) &&
      speedOf(agent) <= params.latchSpeed
    ) {
      agent.latched = true;
    } else if (agent.latched && e > params.unlatchRadius && !agent.stuck) {
      agent.latched = false;
    }
  }
  keepDetour(agent, soldier, frame, world, params, t);
  let push: { x: number; y: number } =
    me >= 0 ? separation(crowd, me, params.personalSpace, params.separationSpeed, pushed) : NO_PUSH;
  if (vehicles.length > 0) {
    if (push === NO_PUSH) push = { x: 0, y: 0 };
    stepAside(vehicles, soldier.position, { x: agent.vx, y: agent.vy }, push);
  }
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

  moveClear(soldier, agent, world, h);
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

  // Fallen in once he first reaches his slot.
  if (!agent.joined && wanted.error <= params.joinBand * task.formation.interval) {
    agent.joined = true;
  }
  // A Marine sent elsewhere rejoins once there.
  if (agent.override?.kind === 'goTo') {
    const gx = agent.override.x - soldier.position.x;
    const gy = agent.override.y - soldier.position.y;
    if (gx * gx + gy * gy <= 1 && speed <= params.latchSpeed) agent.override = null;
  }
  // Out of contact for long enough: a straggler.
  const d = task.formation.interval;
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
    // The first window only takes the reference (`checkError` < 0: none yet).
    // Walking a way round counts as progress: stuck means barely moving too.
    agent.stuck =
      agent.checkError >= 0 &&
      speedOf(agent) < 0.3 &&
      agent.override === null &&
      !agent.latched &&
      e > 2 * wanted.band + params.latchRadius &&
      agent.checkError - e < params.stuckProgress;
    agent.checkError = e;
    agent.checkAt = t;
  }
}

/**
 * His way to his slot (or the point he was sent to): every
 * `detourCheckSeconds` (staggered by slot), if the straight way is blocked
 * he plans a short way round with the navigation's A* (`planPath`), and
 * drops it once the straight way is open; in between he works along it,
 * point by point.
 */
function keepDetour(
  agent: AgentState,
  soldier: Soldier,
  frame: TaskFrame,
  world: SimWorld,
  params: BehaviorParams,
  t: number,
): void {
  if (agent.latched || agent.override?.kind === 'hold') {
    agent.detour = null;
    return;
  }
  const from = { x: soldier.position.x, y: soldier.position.y };
  const i = frame.flat.indexOf.get(agent.slotId) ?? 0;
  const period = Math.max(1, Math.round(params.detourCheckSeconds * params.substepHz));
  const n = Math.round(t * params.substepHz);
  // Also at once when, without a way round, his present course would take
  // him into an obstacle within `LOOK_AHEAD_S`: he turns before the wall.
  const ahead = {
    x: from.x + agent.vx * LOOK_AHEAD_S,
    y: from.y + agent.vy * LOOK_AHEAD_S,
  };
  const headingIn =
    agent.detour === null &&
    (agent.vx !== 0 || agent.vy !== 0) &&
    !isSegmentWalkable(world.terrain, from, ahead);
  if (headingIn || (n + i * 7) % period === 0) {
    const slot = slotTargetAt(frame, i, target);
    const goal =
      agent.override?.kind === 'goTo'
        ? { x: agent.override.x, y: agent.override.y }
        : { x: slot.x, y: slot.y };
    // A way round he has is kept while it still works (its next point in
    // sight, and it still ends near his goal): replanning from a slightly
    // different spot can give another way, and he would turn to and fro.
    const next = agent.detour?.[agent.detourIndex];
    const end = agent.detour?.at(-1);
    const keep =
      next !== undefined &&
      end !== undefined &&
      Math.hypot(end.x - goal.x, end.y - goal.y) < DETOUR_DRIFT_M &&
      isSegmentWalkable(world.terrain, from, next);
    if (isSegmentWalkable(world.terrain, from, goal)) {
      agent.detour = null;
    } else if (!keep) {
      const path = planPath(world.terrain, from, goal);
      if (path.ok) {
        agent.detour = [...path.turns.map((p) => ({ x: p.x, y: p.y })), goal];
      } else {
        // Somewhere the navigation cannot route from (a gap or yard reached
        // between buildings): back the way he came, to where he last stood on
        // routable ground; failing that, the nearest ground of his goal's area.
        const area = navArea(world.terrain, goal);
        const back =
          agent.lastRoutable ?? (area > 0 ? nearestInArea(world.terrain, from, area) : null);
        agent.detour = back ? [{ x: back.x, y: back.y }, goal] : null;
      }
      agent.detourIndex = 0;
    }
  }
  if (navArea(world.terrain, from) > 0) {
    agent.lastRoutable = from;
  }
  // Points reached in turn; past the last, the detour is done.
  while (agent.detour) {
    const next = agent.detour[agent.detourIndex];
    if (!next) {
      agent.detour = null;
      break;
    }
    if (Math.hypot(next.x - from.x, next.y - from.y) > params.detourReach) break;
    agent.detourIndex += 1;
  }
}

/**
 * Moves the soldier by his velocity, but not into a building's clearance or
 * water: such a step is turned along the edge instead (he slides along the
 * wall), or stopped. Within a clearance already, he may move on but never
 * into the building.
 */
function moveClear(soldier: Soldier, agent: AgentState, world: SimWorld, h: number): void {
  const x0 = soldier.position.x;
  const y0 = soldier.position.y;
  const problem = (x: number, y: number) => {
    const p = pointProblem(world.terrain, { x, y });
    return p === null || p.kind === 'offTerrain' ? null : p.kind;
  };
  // Within an obstacle's clearance already (pushed there), he may move on,
  // but never into a building or water.
  const here = problem(x0, y0);
  const blocked = (x: number, y: number) => {
    const p = problem(x, y);
    return p !== null && (here === null || p !== 'tooCloseToBuilding');
  };
  const vx = agent.vx;
  const vy = agent.vy;
  if (!blocked(x0 + vx * h, y0 + vy * h)) {
    soldier.position.x = x0 + vx * h;
    soldier.position.y = y0 + vy * h;
    return;
  }
  // Against an obstacle: the clear direction nearest the one he wanted,
  // turned at most 75° either way (left first at each angle), slower the
  // more it turns: he slides along the wall.
  for (const deg of SLIDE_ANGLES) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    // Rotated by a (clockwise for positive), slowed by cos² a: the more he
    // has to turn, the slower he goes (people sidestep slowly).
    const k = c * c;
    const rx = (vx * c + vy * sn) * k;
    const ry = (-vx * sn + vy * c) * k;
    if (!blocked(x0 + rx * h, y0 + ry * h)) {
      agent.vx = rx;
      agent.vy = ry;
      soldier.position.x = x0 + rx * h;
      soldier.position.y = y0 + ry * h;
      return;
    }
  }
  agent.vx = 0;
  agent.vy = 0;
}

/** A way round is replanned once its end is this far from where his goal has moved to (m). */
const DETOUR_DRIFT_M = 8;

/** How far ahead (s at his present velocity) a Marine looks for an obstacle in his way. */
const LOOK_AHEAD_S = 1.5;

/** Directions tried when sliding along an obstacle (degrees from the wanted one). */
const SLIDE_ANGLES = [-15, 15, -30, 30, -45, 45, -60, 60, -75, 75] as const;

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
