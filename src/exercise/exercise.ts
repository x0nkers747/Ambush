import {
  createSimulation,
  isOnTerrain,
  normalizeAzimuth,
  waypointId,
  type Azimuth,
  type Scenario,
  type Side,
  type SimConfig,
  type SimEvent,
  type Simulation,
  type SoldierId,
  type Vec2,
  type WaypointId,
} from '#sim';
import { remainingPlan, samePlan, validatePlan, type SoldierPlan } from './plan';
import { createFixedStepRunner, type FixedStepRunner } from './runner';

// The exercise: phases, the trainee's draft plans, committed plan revisions,
// and the simulation they drive (docs/adr/0009). No DOM, no rendering.

/** `executing` runs the simulation; `planning` and `paused` freeze it and allow plan edits. */
export type ExercisePhase = 'planning' | 'executing' | 'paused';

/** The side the trainee plans for. */
export const TRAINEE_SIDE: Side = 'BLUEFOR';

/** An immutable record of the plans committed at one Execute or Resume. */
export interface PlanRevision {
  /** 1 for the first commit, then 2, 3, … */
  readonly revision: number;
  readonly trigger: 'execute' | 'resume';
  /** Tick at which the resulting orders take effect (the simulation's tick at commit). */
  readonly tick: number;
  readonly timeSeconds: number;
  /** The committed plan of every trainee soldier, from that soldier's position at the time. */
  readonly plans: readonly SoldierPlan[];
  /** Soldiers whose plans changed and were sent new orders. */
  readonly changedSoldierIds: readonly SoldierId[];
}

export type CommitResult =
  | { readonly ok: true; readonly revision: PlanRevision }
  | { readonly ok: false; readonly problems: readonly { soldierId: SoldierId; problem: string }[] };

/** Thrown for operations the current phase or soldier does not allow. */
export class ExerciseError extends Error {
  override name = 'ExerciseError';
}

export interface ExerciseOptions {
  readonly config: SimConfig;
  readonly scenario: Scenario;
}

export interface Exercise {
  readonly phase: ExercisePhase;
  /** Read-only access to the simulation. Only the exercise steps it or submits commands. */
  readonly simulation: Pick<Simulation, 'config' | 'world' | 'state' | 'tick' | 'timeSeconds'>;
  readonly revisions: readonly PlanRevision[];

  /** Whether the soldier belongs to the trainee and so can be planned for. */
  isPlannable(soldierId: SoldierId): boolean;
  /** Whether plans can be edited now (Planning or Paused). */
  readonly canEditPlans: boolean;
  /** The trainee's editable draft (Planning or Paused), or `undefined` for other soldiers. */
  draft(soldierId: SoldierId): SoldierPlan | undefined;
  /**
   * The plan to show for a soldier: the draft while editable, otherwise what is
   * left of the soldier's active orders.
   */
  displayedPlan(soldierId: SoldierId): SoldierPlan | undefined;

  /** Inserts a waypoint at `index` (default: the end of the route) and returns its new id. */
  addWaypoint(soldierId: SoldierId, point: Vec2, index?: number): WaypointId;
  moveWaypoint(soldierId: SoldierId, waypoint: WaypointId, point: Vec2): void;
  deleteWaypoint(soldierId: SoldierId, waypoint: WaypointId): void;
  clearRoute(soldierId: SoldierId): void;
  setFinalFacing(soldierId: SoldierId, azimuth: Azimuth): void;

  /** Planning → Executing: commits the initial plans. */
  execute(): CommitResult;
  /** Executing → Paused, at the current tick boundary. */
  pause(): void;
  /** Paused → Executing: commits changed plans. */
  resume(): CommitResult;

  /**
   * Advances simulation time by `realDtSeconds × timeScale` (whole ticks) while
   * Executing; does nothing otherwise. Returns the simulation events produced.
   */
  advance(realDtSeconds: number, timeScale?: number): SimEvent[];
}

export function createExercise({ config, scenario }: ExerciseOptions): Exercise {
  const sim = createSimulation(config, scenario);
  const events: SimEvent[] = [];
  const stepper = {
    dtSeconds: sim.dtSeconds,
    step: () => {
      events.push(...sim.step());
    },
  };
  let runner: FixedStepRunner = createFixedStepRunner(stepper);
  let phase: ExercisePhase = 'planning';
  const revisions: PlanRevision[] = [];

  const trainee = sim.state.soldiers.filter((s) => s.side === TRAINEE_SIDE).map((s) => s.id);
  const traineeIds = new Set<SoldierId>(trainee);
  /** Next number for generated waypoint ids, per soldier; never reused. */
  const waypointCounters = new Map<SoldierId, number>(trainee.map((id) => [id, 1]));
  const drafts = new Map<SoldierId, SoldierPlan>();

  const soldierState = (id: SoldierId) => {
    const soldier = sim.state.soldiers.find((s) => s.id === id);
    if (!soldier) throw new ExerciseError(`unknown soldier "${id}"`);
    return soldier;
  };

  /**
   * What the soldier is going to do: the remaining active orders, or, until the
   * simulation has stepped past the latest commit, that commit's plan (its
   * orders are queued for the current tick but not yet applied).
   */
  const currentPlan = (id: SoldierId): SoldierPlan => {
    const latest = revisions.at(-1);
    const committed =
      latest?.tick === sim.tick ? latest.plans.find((p) => p.soldierId === id) : undefined;
    return committed ?? remainingPlan(soldierState(id));
  };

  /** Drafts restart from what each soldier still has to do. */
  const resetDrafts = () => {
    for (const id of trainee) drafts.set(id, currentPlan(id));
  };
  resetDrafts();

  const editableDraft = (id: SoldierId): SoldierPlan => {
    if (phase === 'executing') throw new ExerciseError('plans cannot be edited while executing');
    const draft = drafts.get(id);
    if (!draft) throw new ExerciseError(`soldier "${id}" cannot be planned for`);
    return draft;
  };
  const checkPoint = ({ x, y }: Vec2) => {
    if (!isOnTerrain(sim.world.terrain, x, y)) {
      throw new ExerciseError(`(${String(x)}, ${String(y)}) is off the map`);
    }
  };
  const indexOf = (draft: SoldierPlan, waypoint: WaypointId) => {
    const index = draft.waypoints.findIndex((w) => w.id === waypoint);
    if (index < 0) throw new ExerciseError(`no waypoint "${waypoint}" for "${draft.soldierId}"`);
    return index;
  };
  const replaceWaypoints = (
    draft: SoldierPlan,
    edit: (w: SoldierPlan['waypoints'][number][]) => void,
  ) => {
    const waypoints = [...draft.waypoints];
    edit(waypoints);
    drafts.set(draft.soldierId, { ...draft, waypoints });
  };

  const commit = (trigger: PlanRevision['trigger']): CommitResult => {
    const plans = trainee.map((id) => drafts.get(id) ?? currentPlan(id));
    const problems = plans.flatMap((plan) =>
      validatePlan(plan, sim.world.terrain).map((problem) => ({
        soldierId: plan.soldierId,
        problem,
      })),
    );
    if (problems.length > 0) return { ok: false, problems };

    const changed = plans.filter((plan) => !samePlan(plan, currentPlan(plan.soldierId)));
    for (const plan of changed) {
      sim.submit({
        type: 'setOrders',
        tick: sim.tick,
        soldierId: plan.soldierId,
        orders: { waypoints: plan.waypoints, finalFacing: plan.finalFacing },
      });
    }
    const revision: PlanRevision = deepFreeze({
      revision: revisions.length + 1,
      trigger,
      tick: sim.tick,
      timeSeconds: sim.timeSeconds,
      plans: plans.map((p) => ({ ...p, waypoints: p.waypoints.map((w) => ({ ...w })) })),
      changedSoldierIds: changed.map((p) => p.soldierId),
    });
    revisions.push(revision);
    phase = 'executing';
    runner = createFixedStepRunner(stepper);
    return { ok: true, revision };
  };

  return {
    get phase() {
      return phase;
    },
    simulation: sim,
    revisions,
    isPlannable: (id) => traineeIds.has(id),
    get canEditPlans() {
      return phase !== 'executing';
    },
    draft: (id) => (phase === 'executing' ? undefined : drafts.get(id)),
    displayedPlan(id) {
      if (!traineeIds.has(id)) return undefined;
      return phase === 'executing' ? currentPlan(id) : drafts.get(id);
    },

    addWaypoint(id, point, index) {
      const draft = editableDraft(id);
      checkPoint(point);
      const at = index ?? draft.waypoints.length;
      if (!Number.isInteger(at) || at < 0 || at > draft.waypoints.length) {
        throw new ExerciseError(`waypoint index ${String(at)} is out of range`);
      }
      const n = waypointCounters.get(id) ?? 1;
      waypointCounters.set(id, n + 1);
      const newId = waypointId(`${id}.${String(n)}`);
      replaceWaypoints(draft, (w) => w.splice(at, 0, { id: newId, x: point.x, y: point.y }));
      return newId;
    },
    moveWaypoint(id, waypoint, point) {
      const draft = editableDraft(id);
      checkPoint(point);
      const index = indexOf(draft, waypoint);
      replaceWaypoints(draft, (w) => {
        w[index] = { id: waypoint, x: point.x, y: point.y };
      });
    },
    deleteWaypoint(id, waypoint) {
      const draft = editableDraft(id);
      const index = indexOf(draft, waypoint);
      replaceWaypoints(draft, (w) => w.splice(index, 1));
    },
    clearRoute(id) {
      const draft = editableDraft(id);
      drafts.set(id, { ...draft, waypoints: [] });
    },
    setFinalFacing(id, azimuth) {
      const draft = editableDraft(id);
      if (!Number.isFinite(azimuth))
        throw new ExerciseError(`facing must be finite, got ${String(azimuth)}`);
      drafts.set(id, { ...draft, finalFacing: normalizeAzimuth(azimuth) });
    },

    execute() {
      if (phase !== 'planning') throw new ExerciseError(`cannot execute while ${phase}`);
      return commit('execute');
    },
    pause() {
      if (phase !== 'executing') throw new ExerciseError(`cannot pause while ${phase}`);
      // `advance` only ever steps whole ticks, so the simulation is at a tick boundary.
      phase = 'paused';
      resetDrafts();
    },
    resume() {
      if (phase !== 'paused') throw new ExerciseError(`cannot resume while ${phase}`);
      return commit('resume');
    },

    advance(realDtSeconds, timeScale = 1) {
      if (phase !== 'executing') return [];
      runner.timeScale = timeScale;
      runner.advance(realDtSeconds);
      return events.splice(0);
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
