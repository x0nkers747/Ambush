import type { DeepReadonly, SimState, Soldier } from '../state';
import type { SimWorld } from '../world';
import { routeAt, routePoint } from './route';
import { slotTarget, slotTargetAt, taskFrame } from './slots';
import { behaviorParams, desire, taskPace, type Desire, type TaskPace } from './system';
import type { AgentState, TaskPhase, UnitTask } from './types';

// Explanations of unit movement (docs/behavior-lab/03 §9): pure functions of
// the state, computed by the same functions the system steers with, so what
// a view draws from them is what the simulation decided. Nothing here is
// stored or changes the state.

export interface TaskDiagnostics {
  readonly taskId: string;
  readonly unitId: string;
  readonly phase: TaskPhase;
  readonly outcome: UnitTask['outcome'];
  /** The anchor: arc length, speed, position and heading (unit tangent). */
  readonly anchorS: number;
  readonly anchorSpeed: number;
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly tx: number;
    readonly ty: number;
  };
  readonly routeLength: number;
  readonly pace: TaskPace;
  /** Every occupied slot's target now. */
  readonly slots: readonly {
    readonly slotId: string;
    readonly soldierId: string;
    readonly x: number;
    readonly y: number;
  }[];
}

export interface AgentDiagnostics {
  readonly soldierId: string;
  readonly taskId: string;
  readonly slotId: string;
  readonly latched: boolean;
  readonly speed: number;
  readonly wantedSpeed: number;
  readonly desire: Desire;
}

export interface BehaviorDiagnostics {
  readonly tasks: readonly TaskDiagnostics[];
  readonly agents: readonly AgentDiagnostics[];
}

/** Explains the unit tasks and agents of `state` at simulation time `seconds` (its tick's). */
export function behaviorDiagnostics(
  state: DeepReadonly<SimState>,
  world: SimWorld,
  seconds: number,
): BehaviorDiagnostics {
  const behavior = state.behavior as SimState['behavior'] | undefined;
  if (!behavior) return { tasks: [], agents: [] };
  const params = behaviorParams(world);
  const soldiers = new Map<string, Soldier>(
    (state.soldiers as readonly Soldier[]).map((s) => [s.id, s]),
  );
  const agents = behavior.agents as readonly AgentState[];
  const tasks: TaskDiagnostics[] = [];
  const out: AgentDiagnostics[] = [];
  for (const task of behavior.tasks) {
    const frame = taskFrame(task, agents, seconds, params);
    const at = routeAt(task.route, task.anchorS, routePoint());
    const slots = agents
      .filter((a) => a.taskId === task.id)
      .map((a) => {
        const p = slotTargetAt(frame, frame.flat.indexOf.get(a.slotId) ?? 0, slotTarget());
        return { slotId: a.slotId, soldierId: a.soldierId, x: p.x, y: p.y };
      });
    tasks.push({
      taskId: task.id,
      unitId: task.unitId,
      phase: task.phase,
      outcome: task.outcome,
      anchorS: task.anchorS,
      anchorSpeed: task.anchorSpeed,
      anchor: { x: at.x, y: at.y, tx: at.tx, ty: at.ty },
      routeLength: task.route.length,
      pace: taskPace(frame, agents, soldiers, params),
      slots,
    });
    for (const agent of agents) {
      if (agent.taskId !== task.id) continue;
      const soldier = soldiers.get(agent.soldierId);
      if (!soldier) continue;
      const d = desire(agent, soldier, frame, params);
      out.push({
        soldierId: agent.soldierId,
        taskId: task.id,
        slotId: agent.slotId,
        latched: agent.latched,
        speed: Math.sqrt(agent.vx * agent.vx + agent.vy * agent.vy),
        wantedSpeed: Math.sqrt(d.wx * d.wx + d.wy * d.wy),
        desire: d,
      });
    }
  }
  return { tasks, agents: out };
}
