import {
  azimuthFromDegrees,
  createSimulation,
  engagementAreaId,
  lineOfSight,
  normalizeAzimuth,
  pointProblem,
  visibleCellsIn,
  soldierId,
  waypointId,
  type Azimuth,
  type EngagementAreaEnteredEvent,
  type EngagementAreaId,
  type LosResult,
  type Side,
  type SimConfig,
  type SimEvent,
  type Simulation,
  type SoldierId,
  type Vec2,
  type Viewshed,
  type WaypointId,
} from '#sim';
import { validateOpforRoutes, type AmbushScenario, type OpforRoute } from './ambush-scenario';
import {
  deleteVertex,
  insertVertex,
  KillZoneEditError,
  killZoneProblems,
  moveVertex,
  type KillZone,
} from './kill-zone';
import { remainingPlan, samePlan, validatePlan, type SoldierPlan } from './plan';
import {
  createPathCache,
  describePathProblem,
  planRoute,
  type PlannedLeg,
  type PlannedRoute,
} from './routes';
import { createFixedStepRunner, type FixedStepRunner } from './runner';

// The ambush exercise (docs/adr/0009, docs/adr/0010): phases, the trainee's
// draft plans and kill zone, committed plan revisions, the OPFOR start and the
// ambush trigger, and the simulation they drive. No DOM, no rendering.

/**
 * The ambush sequence. The simulation runs only during `bluforOccupation` and
 * `opforApproach`, and only while not paused.
 *
 * - `bluforPlanning`: the trainee plans routes, facings and the kill zone.
 * - `bluforOccupation`: BLUEFOR moves into position; OPFOR waits. Can pause and re-plan.
 * - `bluforReady`: every BLUEFOR soldier has completed its orders. Frozen until the
 *   trainee declares the ambush ready (START OPFOR) or re-plans and resumes.
 * - `opforApproach`: OPFOR follows its scenario routes; BLUEFOR holds.
 * - `ambushTriggered`: an OPFOR soldier entered the kill zone. Frozen; combat comes later.
 */
export type ExercisePhase =
  'bluforPlanning' | 'bluforOccupation' | 'bluforReady' | 'opforApproach' | 'ambushTriggered';

/** The side the trainee plans for. */
export const TRAINEE_SIDE: Side = 'BLUEFOR';
/** The side whose entry into the kill zone springs the ambush. */
export const ENEMY_SIDE: Side = 'OPFOR';

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
  /** The trainee's kill zone at the time, as drawn (possibly incomplete). */
  readonly killZone: KillZone | null;
}

/** The trainee's declaration that the ambush is ready, and what it was based on. */
export interface OpforStart {
  readonly tick: number;
  readonly timeSeconds: number;
  /** The kill zone as committed to the simulation. */
  readonly killZone: KillZone;
  /** The BLUEFOR plan revision in force. */
  readonly planRevision: number;
  /** The scenario routes OPFOR was sent along. */
  readonly routeIds: readonly string[];
}

/** The moment the ambush was sprung. */
export interface AmbushTrigger {
  /** Tick during which the entry happened; the simulation stops at its end. */
  readonly tick: number;
  /** Exact simulation time of the entry. */
  readonly atSeconds: number;
  readonly soldierId: SoldierId;
  readonly killZoneId: EngagementAreaId;
  /** Where the soldier crossed into the kill zone. */
  readonly point: Vec2;
}

/** Tick-stamped exercise milestones, for the event log and the future AAR. */
export type ExerciseEvent =
  | {
      readonly type: 'planCommitted';
      readonly tick: number;
      readonly timeSeconds: number;
      readonly revision: PlanRevision;
    }
  | { readonly type: 'paused' | 'resumed'; readonly tick: number; readonly timeSeconds: number }
  | { readonly type: 'bluforInPosition'; readonly tick: number; readonly timeSeconds: number }
  | {
      readonly type: 'opforStarted';
      readonly tick: number;
      readonly timeSeconds: number;
      readonly start: OpforStart;
    }
  | {
      readonly type: 'ambushTriggered';
      readonly tick: number;
      readonly timeSeconds: number;
      readonly trigger: AmbushTrigger;
    };

export type CommitResult =
  | { readonly ok: true; readonly revision: PlanRevision | null }
  | { readonly ok: false; readonly problems: readonly { soldierId: SoldierId; problem: string }[] };

export type StartOpforResult =
  | { readonly ok: true; readonly start: OpforStart }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Thrown for operations the current phase or soldier does not allow. */
export class ExerciseError extends Error {
  override name = 'ExerciseError';
}

/**
 * The share of the kill zone a viewshed sees: of the viewshed grid cells whose
 * centres lie inside or on the kill-zone polygon, the number visible.
 */
export interface KillZoneCoverage {
  readonly cells: number;
  readonly visibleCells: number;
  /** `visibleCells / cells × 100`. */
  readonly percent: number;
}

export interface ExerciseOptions {
  readonly config: SimConfig;
  readonly scenario: AmbushScenario;
}

export interface Exercise {
  readonly phase: ExercisePhase;
  /** Simulation frozen by the trainee (only during occupation or approach). */
  readonly paused: boolean;
  /** Read-only access to the simulation. Only the exercise steps it or submits commands. */
  readonly simulation: Pick<Simulation, 'config' | 'world' | 'state' | 'tick' | 'timeSeconds'>;
  /** The scenario's OPFOR routes: administrator data, never editable here. */
  readonly opforRoutes: readonly OpforRoute[];
  /** Where the scenario placed a soldier at the start of the exercise. */
  scenarioStart(soldierId: string): Vec2 | undefined;
  readonly revisions: readonly PlanRevision[];
  readonly opforStart: OpforStart | null;
  readonly trigger: AmbushTrigger | null;
  readonly timeline: readonly ExerciseEvent[];
  /**
   * Simulation seconds skipped because a frame exceeded the runner's catch-up
   * budget (docs/adr/0003), e.g. after the browser stalled. Diagnostic only.
   */
  readonly droppedSeconds: number;

  /** Whether the soldier belongs to the trainee and so can be planned for. */
  isPlannable(soldierId: SoldierId): boolean;
  /** Whether plans and the kill zone can be edited now: Planning, Ready, or occupation paused. */
  readonly canEditPlans: boolean;
  /** The trainee's editable draft, or `undefined` when not editable or not a trainee soldier. */
  draft(soldierId: SoldierId): SoldierPlan | undefined;
  /**
   * The plan to show for a soldier: the draft while editable, otherwise what is
   * left of the soldier's active orders.
   */
  displayedPlan(soldierId: SoldierId): SoldierPlan | undefined;
  /** Whether any draft differs from what the soldiers are doing (edits not yet executed). */
  readonly hasUncommittedChanges: boolean;
  /**
   * The displayed plan with the walkable path of each leg: generated turn points
   * (not trainee intent) between the trainee's waypoints, from the soldier's
   * current position.
   */
  displayedRoute(soldierId: SoldierId): PlannedRoute | undefined;
  /** The walkable path of each scenario OPFOR route, by route id, from its soldier's start. */
  readonly opforRoutePaths: ReadonlyMap<string, PlannedRoute>;

  /**
   * Where a trainee soldier will observe from: its planned final position (the
   * last waypoint of the displayed plan), or where it stands if it has none.
   */
  observer(soldierId: SoldierId): { readonly point: Vec2; readonly planned: boolean } | undefined;
  /** Line of sight from the soldier's observation point (see `observer`) to a map point. */
  lineOfSightFrom(soldierId: SoldierId, target: Vec2): LosResult | undefined;
  /**
   * How much of the kill zone a viewshed sees (see `KillZoneCoverage`), or
   * `undefined` without a complete kill zone or when no viewshed cell centre
   * lies inside it.
   */
  killZoneCoverage(viewshed: Viewshed): KillZoneCoverage | undefined;

  addWaypoint(soldierId: SoldierId, point: Vec2, index?: number): WaypointId;
  moveWaypoint(soldierId: SoldierId, waypoint: WaypointId, point: Vec2): void;
  deleteWaypoint(soldierId: SoldierId, waypoint: WaypointId): void;
  clearRoute(soldierId: SoldierId): void;
  setFinalFacing(soldierId: SoldierId, azimuth: Azimuth): void;

  /** The trainee's kill zone as drawn so far, or `null`. */
  readonly killZone: KillZone | null;
  /** Inserts a corner at `index` (default: last), starting a new zone if there is none. */
  addKillZoneVertex(point: Vec2, index?: number): void;
  moveKillZoneVertex(index: number, point: Vec2): void;
  deleteKillZoneVertex(index: number): void;
  clearKillZone(): void;

  /**
   * Whether every active BLUEFOR soldier has completed its committed orders
   * (or has none). Computed from simulation state; distinct from the trainee's
   * declaration that the ambush is ready, which is `startOpfor`.
   */
  readonly bluforMovementComplete: boolean;
  /** Why START OPFOR is not available now; empty when it is. */
  startOpforProblems(): string[];

  /** BLUEFOR Planning → BLUEFOR Occupation: commits the initial plans. */
  execute(): CommitResult;
  /** Freezes the simulation during occupation or approach, at the current tick boundary. */
  pause(): void;
  /**
   * Continues after a pause. During occupation (or from Ready) changed plans are
   * committed first; Ready then returns to occupation.
   */
  resume(): CommitResult;
  /** BLUEFOR Ready → OPFOR Approach: the trainee declares the ambush ready. */
  startOpfor(): StartOpforResult;

  /**
   * Advances simulation time by `realDtSeconds × timeScale` (whole ticks) while
   * the simulation runs; does nothing otherwise. Phase changes (BLUEFOR in
   * position, ambush triggered) stop it at the end of the tick in which they
   * happen. Returns the simulation events produced.
   */
  advance(realDtSeconds: number, timeScale?: number): SimEvent[];
}

export function createExercise({ config, scenario }: ExerciseOptions): Exercise {
  validateOpforRoutes(scenario, TRAINEE_SIDE);
  const sim = createSimulation(config, scenario);
  const terrain = sim.world.terrain;
  const pathFor = createPathCache(terrain);

  let phase: ExercisePhase = 'bluforPlanning';
  let paused = false;
  const revisions: PlanRevision[] = [];
  const timeline: ExerciseEvent[] = [];
  let opforStart: OpforStart | null = null;
  let trigger: AmbushTrigger | null = null;
  let killZone: KillZone | null = null;
  let killZoneCount = 0;

  const starts = new Map<string, Vec2>(
    sim.state.soldiers.map((s) => [s.id, Object.freeze({ x: s.position.x, y: s.position.y })]),
  );
  const opforRoutePaths = new Map<string, PlannedRoute>();
  for (const route of scenario.opforRoutes) {
    const planned = planRoute(
      pathFor,
      starts.get(route.soldierId) ?? { x: 0, y: 0 },
      route.waypoints,
    );
    const bad = planned.legs.find((l) => l.problem !== null);
    if (bad) {
      throw new Error(
        `Scenario "${scenario.id}": route waypoint "${bad.waypointId}" is ${bad.problem ?? ''}`,
      );
    }
    opforRoutePaths.set(route.id, planned);
  }
  const trainee = sim.state.soldiers.filter((s) => s.side === TRAINEE_SIDE).map((s) => s.id);
  const traineeIds = new Set<SoldierId>(trainee);
  /** Next number for generated waypoint ids, per soldier; never reused. */
  const waypointCounters = new Map<SoldierId, number>(trainee.map((id) => [id, 1]));
  const drafts = new Map<SoldierId, SoldierPlan>();

  const now = () => ({ tick: sim.tick, timeSeconds: sim.timeSeconds });
  const running = () => !paused && (phase === 'bluforOccupation' || phase === 'opforApproach');

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

  const editable = () =>
    phase === 'bluforPlanning' ||
    phase === 'bluforReady' ||
    (phase === 'bluforOccupation' && paused);
  const requireEditable = () => {
    if (!editable())
      throw new ExerciseError(`plans cannot be edited during ${phase}${paused ? ' (paused)' : ''}`);
  };

  const movementComplete = (): boolean => {
    if (phase === 'bluforPlanning') return false;
    // Orders committed this tick have not reached the soldiers yet.
    if (revisions.at(-1)?.tick === sim.tick) return false;
    return trainee.every((id) => {
      const s = soldierState(id);
      return s.status !== 'active' || s.orders === null || s.orders.behavior === 'inPosition';
    });
  };

  const uncommittedChanges = () =>
    trainee.some((id) => {
      const draft = drafts.get(id);
      return draft !== undefined && !samePlan(draft, currentPlan(id));
    });

  const afterTick = (events: readonly SimEvent[]) => {
    if (phase === 'bluforOccupation' && movementComplete()) {
      phase = 'bluforReady';
      resetDrafts();
      timeline.push({ type: 'bluforInPosition', ...now() });
    } else if (phase === 'opforApproach' && opforStart) {
      const zoneId = opforStart.killZone.id;
      // Entries arrive in the order they happened, so the first is the trigger.
      const entry = events.find(
        (e): e is EngagementAreaEnteredEvent =>
          e.type === 'engagementAreaEntered' && e.areaId === zoneId,
      );
      if (entry) {
        trigger = deepFreeze({
          tick: entry.tick,
          atSeconds: entry.atSeconds,
          soldierId: entry.soldierId,
          killZoneId: zoneId,
          point: { ...entry.point },
        });
        phase = 'ambushTriggered';
        timeline.push({ type: 'ambushTriggered', ...now(), trigger });
      }
    }
  };

  const stepped: SimEvent[] = [];
  const stepper = {
    dtSeconds: 1 / config.tickRateHz,
    step: () => {
      // The runner may ask for several ticks per frame; stop as soon as the phase stops running.
      if (!running()) return;
      const events = sim.step();
      stepped.push(...events);
      afterTick(events);
    },
  };
  let runner: FixedStepRunner = createFixedStepRunner(stepper);
  /** Dropped time of runners already replaced. */
  let droppedBefore = 0;
  /** Starts the simulation running with no partial tick carried over from before. */
  const run = () => {
    paused = false;
    droppedBefore += runner.droppedSeconds;
    runner = createFixedStepRunner(stepper);
  };

  const editableDraft = (id: SoldierId): SoldierPlan => {
    requireEditable();
    const draft = drafts.get(id);
    if (!draft) throw new ExerciseError(`soldier "${id}" cannot be planned for`);
    return draft;
  };
  const position = (id: SoldierId): Vec2 => {
    const { x, y } = soldierState(id).position;
    return { x, y };
  };
  /** The soldier's planned final position, or where it stands if it has no waypoints. */
  const observer = (id: SoldierId) => {
    if (!traineeIds.has(id)) return undefined;
    const plan = editable() ? drafts.get(id) : currentPlan(id);
    const last = plan?.waypoints.at(-1);
    return last
      ? { point: { x: last.x, y: last.y }, planned: true }
      : { point: position(id), planned: false };
  };

  /**
   * Refuses a waypoint at `point` that is not a place to stand or that cannot be
   * walked to from the point before it, or on to the point after it. `index` is
   * the waypoint's position in the route; `replacing` when it moves an existing one.
   */
  const checkPlacement = (draft: SoldierPlan, index: number, point: Vec2, replacing: boolean) => {
    const problem = pointProblem(terrain, point);
    if (problem) throw new ExerciseError(`Waypoint not placed: ${describePathProblem(problem)}.`);
    const before = index === 0 ? position(draft.soldierId) : draft.waypoints[index - 1];
    const after = draft.waypoints[replacing ? index + 1 : index];
    for (const [a, b] of [
      [before, point],
      [point, after],
    ] as const) {
      if (a && b && !pathFor(a, b).ok) {
        throw new ExerciseError(
          `Waypoint not placed: ${describePathProblem({ kind: 'unreachable' })}.`,
        );
      }
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
  const editKillZone = (edit: () => KillZone | null) => {
    requireEditable();
    try {
      killZone = edit();
    } catch (error) {
      if (error instanceof KillZoneEditError) throw new ExerciseError(error.message);
      throw error;
    }
  };

  const commit = (trigger: PlanRevision['trigger']): CommitResult => {
    const plans = trainee.map((id) => drafts.get(id) ?? currentPlan(id));
    const problems = plans.flatMap((plan) => [
      ...validatePlan(plan, terrain).map((problem) => ({ soldierId: plan.soldierId, problem })),
      ...planRoute(pathFor, position(plan.soldierId), plan.waypoints).legs.flatMap((leg, i) =>
        leg.problem === null
          ? []
          : [{ soldierId: plan.soldierId, problem: `waypoint ${String(i + 1)} is ${leg.problem}` }],
      ),
    ]);
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
      ...now(),
      plans: plans.map((p) => ({ ...p, waypoints: p.waypoints.map((w) => ({ ...w })) })),
      changedSoldierIds: changed.map((p) => p.soldierId),
      killZone: killZone && { id: killZone.id, vertices: killZone.vertices.map((v) => ({ ...v })) },
    });
    revisions.push(revision);
    timeline.push({ type: 'planCommitted', ...now(), revision });
    phase = 'bluforOccupation';
    run();
    return { ok: true, revision };
  };

  const startOpforProblems = (): string[] => {
    const problems: string[] = [];
    switch (phase) {
      case 'bluforPlanning':
        problems.push('BLUEFOR has not occupied its positions: Execute the plan first.');
        break;
      case 'bluforOccupation': {
        const moving = trainee.filter((id) => {
          const s = soldierState(id);
          return s.orders !== null && s.orders.behavior !== 'inPosition';
        }).length;
        problems.push(
          paused
            ? 'Occupation is paused: Resume until BLUEFOR is in position.'
            : `BLUEFOR is still moving into position (${String(moving)} soldier${moving === 1 ? '' : 's'}).`,
        );
        break;
      }
      case 'opforApproach':
      case 'ambushTriggered':
        return ['OPFOR has already been started.'];
      case 'bluforReady':
        if (uncommittedChanges())
          problems.push('Route changes have not been executed: press Resume to execute them.');
        break;
    }
    const opfor = sim.state.soldiers.filter((s) => s.side === ENEMY_SIDE);
    problems.push(...killZoneProblems(killZone, opfor));
    if (scenario.opforRoutes.length === 0) problems.push('The scenario defines no OPFOR route.');
    return problems;
  };

  return {
    get phase() {
      return phase;
    },
    get paused() {
      return paused;
    },
    simulation: sim,
    opforRoutes: deepFreeze(
      scenario.opforRoutes.map((r) => ({ ...r, waypoints: r.waypoints.map((w) => ({ ...w })) })),
    ),
    scenarioStart: (id) => starts.get(id),
    revisions,
    get opforStart() {
      return opforStart;
    },
    get trigger() {
      return trigger;
    },
    timeline,
    get droppedSeconds() {
      return droppedBefore + runner.droppedSeconds;
    },

    isPlannable: (id) => traineeIds.has(id),
    get canEditPlans() {
      return editable();
    },
    draft: (id) => (editable() ? drafts.get(id) : undefined),
    displayedPlan(id) {
      if (!traineeIds.has(id)) return undefined;
      return editable() ? drafts.get(id) : currentPlan(id);
    },
    get hasUncommittedChanges() {
      return uncommittedChanges();
    },
    displayedRoute(id) {
      if (!traineeIds.has(id)) return undefined;
      const soldier = soldierState(id);
      const plan = editable() ? drafts.get(id) : currentPlan(id);
      if (!plan) return undefined;
      const active = soldier.orders;
      const pending = revisions.at(-1)?.tick === sim.tick;
      // While the plan is what the soldier is already doing, show the paths it is
      // actually walking; otherwise plan them as the simulation will on commit.
      if (active && !pending && samePlan(plan, remainingPlan(soldier))) {
        const legs: PlannedLeg[] = active.orders.waypoints
          .slice(active.nextWaypointIndex)
          .map((w, k) => {
            const turns = active.legPaths[active.nextWaypointIndex + k] ?? [];
            return {
              waypointId: w.id,
              to: { x: w.x, y: w.y },
              turns: k === 0 ? turns.slice(active.nextTurnIndex) : turns,
              problem: null,
            };
          });
        return { start: position(id), legs, ok: true };
      }
      return planRoute(pathFor, position(id), plan.waypoints);
    },
    opforRoutePaths,

    observer,
    lineOfSightFrom(id, target) {
      const from = observer(id);
      if (!from || pointProblem(terrain, target)?.kind === 'offTerrain') return undefined;
      return lineOfSight(terrain, from.point, target);
    },
    killZoneCoverage(viewshed) {
      if (!killZone || killZoneProblems(killZone, []).length > 0) return undefined;
      const { cells, visible } = visibleCellsIn(viewshed, killZone.vertices);
      return cells === 0
        ? undefined
        : { cells, visibleCells: visible, percent: (100 * visible) / cells };
    },

    addWaypoint(id, point, index) {
      const draft = editableDraft(id);
      const at = index ?? draft.waypoints.length;
      if (!Number.isInteger(at) || at < 0 || at > draft.waypoints.length) {
        throw new ExerciseError(`waypoint index ${String(at)} is out of range`);
      }
      checkPlacement(draft, at, point, false);
      const n = waypointCounters.get(id) ?? 1;
      waypointCounters.set(id, n + 1);
      const newId = waypointId(`${id}.${String(n)}`);
      replaceWaypoints(draft, (w) => w.splice(at, 0, { id: newId, x: point.x, y: point.y }));
      return newId;
    },
    moveWaypoint(id, waypoint, point) {
      const draft = editableDraft(id);
      const index = indexOf(draft, waypoint);
      checkPlacement(draft, index, point, true);
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

    get killZone() {
      return killZone;
    },
    addKillZoneVertex(point, index) {
      editKillZone(() => {
        if (killZone === null) killZoneCount += 1;
        const zone = killZone ?? {
          id: engagementAreaId(`KZ-${String(killZoneCount)}`),
          vertices: [],
        };
        return insertVertex(zone, point, index ?? zone.vertices.length, terrain);
      });
    },
    moveKillZoneVertex(index, point) {
      editKillZone(() => {
        if (!killZone) throw new KillZoneEditError('there is no kill zone');
        return moveVertex(killZone, index, point, terrain);
      });
    },
    deleteKillZoneVertex(index) {
      editKillZone(() => {
        if (!killZone) throw new KillZoneEditError('there is no kill zone');
        return deleteVertex(killZone, index);
      });
    },
    clearKillZone() {
      editKillZone(() => null);
    },

    get bluforMovementComplete() {
      return movementComplete();
    },
    startOpforProblems,

    execute() {
      if (phase !== 'bluforPlanning') throw new ExerciseError(`cannot execute during ${phase}`);
      return commit('execute');
    },
    pause() {
      if (!running())
        throw new ExerciseError(`cannot pause during ${phase}${paused ? ' (paused)' : ''}`);
      // `advance` only ever steps whole ticks, so the simulation is at a tick boundary.
      paused = true;
      timeline.push({ type: 'paused', ...now() });
      if (phase === 'bluforOccupation') resetDrafts();
    },
    resume() {
      if (phase === 'opforApproach' && paused) {
        run();
        timeline.push({ type: 'resumed', ...now() });
        return { ok: true, revision: null };
      }
      if (!(phase === 'bluforOccupation' && paused) && phase !== 'bluforReady') {
        throw new ExerciseError(`cannot resume during ${phase}`);
      }
      const result = commit('resume');
      if (result.ok) timeline.push({ type: 'resumed', ...now() });
      return result;
    },
    startOpfor() {
      const problems = startOpforProblems();
      const zone = killZone;
      const latest = revisions.at(-1);
      if (problems.length > 0 || !zone || !latest) return { ok: false, problems };

      sim.submit({
        type: 'setEngagementArea',
        tick: sim.tick,
        area: { id: zone.id, vertices: zone.vertices, monitoredSide: ENEMY_SIDE },
      });
      for (const route of scenario.opforRoutes) {
        sim.submit({
          type: 'setOrders',
          tick: sim.tick,
          soldierId: soldierId(route.soldierId),
          orders: {
            waypoints: route.waypoints.map((w) => ({ id: waypointId(w.id), x: w.x, y: w.y })),
            finalFacing: azimuthFromDegrees(route.finalFacingDeg),
          },
        });
      }
      const start: OpforStart = deepFreeze({
        ...now(),
        killZone: { id: zone.id, vertices: zone.vertices.map((v) => ({ ...v })) },
        planRevision: latest.revision,
        routeIds: scenario.opforRoutes.map((r) => r.id),
      });
      opforStart = start;
      phase = 'opforApproach';
      run();
      timeline.push({ type: 'opforStarted', ...now(), start });
      return { ok: true, start };
    },

    advance(realDtSeconds, timeScale = 1) {
      if (!running()) return [];
      runner.timeScale = timeScale;
      runner.advance(realDtSeconds);
      return stepped.splice(0);
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
