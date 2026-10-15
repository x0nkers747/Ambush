import type { Vec2 } from '../geometry';
import { navArea } from '../navigation';
import type { TerrainDataset } from '../terrain';
import type { BehaviorParams } from './params';
import { flattenFormation, type FlatFormation } from './formation-spec';
import { smoothNoise } from './noise';
import { routeAt, routePoint } from './route';
import type { AgentState, UnitTask } from './types';

// Where each slot of a task's formation is (docs/behavior-lab/03 §6.3): the
// same functions drive the Marines and explain them (diagnostics), so what
// is drawn is what was decided.
//
// A slot `back` metres behind and `right` metres to the right of the
// formation's reference point lies `back` metres behind the anchor along
// the route, `right` metres to its side:
//
//   s_slot = anchorS − back,   target = P(s_slot) + right · N(s_slot)
//
// so Marines follow the route through bends ("follow me and do as I do")
// instead of pivoting as a rigid body. On the inside of a bend tighter than
// the slot's offset, the offset is limited to 90 % of the bend's radius. At
// the destination the slots blend into the final layout: the formation as
// it stands, faced to the final facing.

/** A slot's target point, its velocity (m/s), and the route's tangent there. */
export interface SlotTarget {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
}

export function slotTarget(): SlotTarget {
  return { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 1 };
}

/** Per task and time: what every slot of it depends on besides its own offsets. */
export interface TaskFrame {
  readonly task: UnitTask;
  readonly flat: FlatFormation;
  /** Centre of the occupied slots (Millington's drift offset): the formation does not lean toward missing Marines. */
  readonly backCentre: number;
  readonly rightCentre: number;
  /** 0 → 1 while settling into the final layout. */
  readonly settle: number;
  /** Time (s), for personal drift. */
  readonly t: number;
  /** Personal drift: largest offset per axis (m) and how often it changes course (s). */
  readonly drift: number;
  readonly driftSeconds: number;
  /** The ground: a slot in or against an obstacle is moved to the nearest point a Marine can stand on. */
  readonly terrain: TerrainDataset | null;
}

/** The frame of `task` at time `t`, for its current agents (those with `taskId` = task's). */
export function taskFrame(
  task: UnitTask,
  agents: readonly AgentState[],
  t: number,
  params: BehaviorParams,
  terrain: TerrainDataset | null = null,
): TaskFrame {
  const flat = flattenFormation(task.formation);
  let b = 0;
  let r = 0;
  let n = 0;
  for (const agent of agents) {
    if (agent.taskId !== task.id) continue;
    const i = flat.indexOf.get(agent.slotId);
    if (i === undefined) continue;
    b += flat.back[i] ?? 0;
    r += flat.right[i] ?? 0;
    n += 1;
  }
  const settling = task.phase === 'settling' || task.phase === 'complete';
  const settle = settling
    ? params.settleBlend > 0
      ? Math.min(1, Math.max(0, (t - task.phaseSince) / params.settleBlend))
      : 1
    : 0;
  return {
    task,
    flat,
    backCentre: n > 0 ? b / n : 0,
    rightCentre: n > 0 ? r / n : 0,
    settle,
    t,
    drift: params.driftRadius * task.formation.interval * Math.SQRT1_2,
    driftSeconds: params.driftSeconds,
    terrain,
  };
}

const p = routePoint();
/** How far a blocked slot looks for standable ground (m). */
const CLEAR_SEARCH_M = 30;

/** The target of slot `i` of the frame's formation, written into `out`. */
export function slotTargetAt(frame: TaskFrame, i: number, out: SlotTarget): SlotTarget {
  const { task, flat } = frame;
  // Each Marine drifts about his slot (seeded, smooth): a formation, not a rigid shape.
  let back = (flat.back[i] ?? 0) - frame.backCentre;
  let right = (flat.right[i] ?? 0) - frame.rightCentre;
  if (frame.drift > 0) {
    back += smoothNoise(task.seed, i, 0, frame.t, frame.driftSeconds) * frame.drift;
    right += smoothNoise(task.seed, i, 1, frame.t, frame.driftSeconds) * frame.drift;
  }
  routeAt(task.route, task.anchorS - back, p);
  // Inside a bend tighter than the offset, keep within 90 % of its radius.
  if (p.k * right > 0.9) right = 0.9 / p.k;
  const nx = p.ty;
  const ny = -p.tx;
  let x = p.x + nx * right;
  let y = p.y + ny * right;
  const speed = task.anchorSpeed * Math.max(0.1, 1 - p.k * right);
  out.vx = p.tx * speed;
  out.vy = p.ty * speed;
  out.tx = p.tx;
  out.ty = p.ty;
  const w = frame.settle;
  if (w > 0) {
    // The final layout: around the route's end, faced to the final facing.
    const end = routeAt(task.route, task.route.length, p);
    const fx = Math.sin(task.finalFacing);
    const fy = Math.cos(task.finalFacing);
    const rx = fy;
    const ry = -fx;
    const finalBack = (flat.back[i] ?? 0) - frame.backCentre;
    const finalRight = (flat.right[i] ?? 0) - frame.rightCentre;
    const gx = end.x - fx * finalBack + rx * finalRight;
    const gy = end.y - fy * finalBack + ry * finalRight;
    x += (gx - x) * w;
    y += (gy - y) * w;
    out.vx *= 1 - w;
    out.vy *= 1 - w;
  }
  // As close as he can get: a slot in a building, against one, in water, or
  // in a yard the streets do not reach (another connected area of the
  // navigation than the route's here) is moved to the nearest point of the
  // route's area: ground he can be routed to, and on from.
  const terrain = frame.terrain;
  if (terrain) {
    const area = navArea(terrain, p);
    if (area > 0 && navArea(terrain, { x, y }) !== area) {
      const clear = nearestInArea(terrain, { x, y }, area);
      if (clear) {
        x = clear.x;
        y = clear.y;
        // The point stands in for a slot it cannot follow: it does not move
        // with the route, so he waits there rather than walking into the wall.
        out.vx = 0;
        out.vy = 0;
      }
    }
  }
  out.x = x;
  out.y = y;
  return out;
}

/**
 * The point of navigation area `area` nearest `p`: on rings round it, 0.5 m
 * apart, up to `CLEAR_SEARCH_M` (the first found, clockwise from north on
 * the smallest ring); `null` when there is none. Deterministic.
 */
export function nearestInArea(terrain: TerrainDataset, p: Vec2, area: number): Vec2 | null {
  for (let r = 0.5; r <= CLEAR_SEARCH_M; r += 0.5) {
    const steps = Math.max(8, Math.ceil((2 * Math.PI * r) / 0.75));
    for (let k = 0; k < steps; k += 1) {
      const a = (2 * Math.PI * k) / steps;
      const q = { x: p.x + r * Math.sin(a), y: p.y + r * Math.cos(a) };
      if (navArea(terrain, q) === area) return q;
    }
  }
  return null;
}
