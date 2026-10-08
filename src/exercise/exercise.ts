import {
  azimuthFromDegrees,
  createSimulation,
  engagementAreaId,
  fingerprintPlainData,
  fingerprintWorld,
  lineOfSight,
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
} from '#sim';
import {
  validateOpforRoutes,
  validateTraineeSetup,
  type AmbushScenario,
  type OpforRoute,
} from './ambush-scenario';
import {
  emptyPlan,
  facingDegreesOf,
  resolvedFacing,
  samePlan,
  toMapPoint,
  toVec2,
  validateDeploymentPlan,
  type DeploymentPlanSet,
  type SoldierDeploymentPlan,
} from './deployment';
import {
  deleteVertex,
  insertVertex,
  KillZoneEditError,
  killZoneProblems,
  moveVertex,
  type KillZone,
} from './kill-zone';
import { rosterMembers, rosterTree, type RosterMember, type RosterUnit } from './organization';
import { orpContains, type ObjectiveRallyPoint } from './orp';
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
 * - `bluforPlanning`: the trainee plans destinations, facings and the kill zone.
 * - `bluforOccupation`: BLUEFOR moves into position; OPFOR waits. Can pause and re-plan.
 * - `bluforReady`: every BLUEFOR soldier given a destination or facing has
 *   arrived and turned (soldiers without one never hold this up). Frozen until the
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
  /** The committed plan of every trainee soldier, in roster order. */
  readonly plans: readonly SoldierDeploymentPlan[];
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

/**
 * Where a trainee soldier stands in the deployment, for the roster. Neutral
 * descriptions of state, not assessments:
 *
 * - `atOrp`: no destination, standing in the ORP;
 * - `destinationAssigned`: has a destination it has not reached (or changes not yet executed);
 * - `moving`: walking to its destination or turning to its facing;
 * - `inPosition`: at its destination with its facing applied;
 * - `holding`: no destination, standing outside the ORP (e.g. its destination
 *   was cleared on the way).
 */
export type DeploymentStatus =
  'atOrp' | 'destinationAssigned' | 'moving' | 'inPosition' | 'holding';

/** A soldier's facing as shown: the trainee's choice, or the default it would take. */
export interface DisplayedFacing {
  readonly azimuth: Azimuth;
  /** Whether the trainee set it (otherwise it is the default, see `defaultFacing`). */
  readonly explicit: boolean;
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
  /** The trainee organization's objective rally point. */
  readonly orp: ObjectiveRallyPoint;
  /** The trainee organization as a tree, in template order. */
  readonly roster: RosterUnit;
  /** A trainee soldier's slot and role, or `undefined` for anyone else. */
  rosterMember(soldierId: SoldierId): RosterMember | undefined;
  /**
   * Fingerprint of everything plans depend on: the scenario id and world, the
   * organization template's id, version and content, who fills which slot, the
   * ORP, starting positions and OPFOR routes (docs/adr/0012).
   */
  readonly scenarioFingerprint: string;
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
  draft(soldierId: SoldierId): SoldierDeploymentPlan | undefined;
  /** The plan to show for a soldier: the draft while editable, otherwise the committed plan. */
  displayedPlan(soldierId: SoldierId): SoldierDeploymentPlan | undefined;
  /** Whether any draft differs from the committed plans (edits not yet executed). */
  readonly hasUncommittedChanges: boolean;
  /**
   * The walkable path from the soldier's current position to the displayed
   * plan's destination: generated turn points, not trainee intent. No legs
   * without a destination. While the soldier carries out the committed plan,
   * this is the path it is actually walking.
   */
  displayedRoute(soldierId: SoldierId): PlannedRoute | undefined;
  /** The facing the displayed plan gives the soldier on arrival (or in place). */
  displayedFacing(soldierId: SoldierId): DisplayedFacing | undefined;
  /** See `DeploymentStatus`; `undefined` for soldiers that are not the trainee's. */
  deploymentStatus(soldierId: SoldierId): DeploymentStatus | undefined;
  /** The walkable path of each scenario OPFOR route, by route id, from its soldier's start. */
  readonly opforRoutePaths: ReadonlyMap<string, PlannedRoute>;

  /**
   * Where a trainee soldier will observe from: the displayed plan's destination,
   * or where it stands if it has none.
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

  /**
   * Sets (or moves) the soldier's single destination, keeping its facing. Refused
   * off the map, in or against a building, or where the soldier cannot walk to
   * from its current position.
   */
  setDestination(soldierId: SoldierId, point: Vec2): void;
  /** Removes the destination: the soldier stays where it is. Keeps its facing. */
  clearDestination(soldierId: SoldierId): void;
  /** Sets the facing explicitly; it then survives destination changes. */
  setFacing(soldierId: SoldierId, azimuth: Azimuth): void;
  /** Returns to the default facing (see `defaultFacing`). */
  clearFacing(soldierId: SoldierId): void;
  /** Discards uncommitted edits for the soldier: back to its last committed plan. */
  resetPlan(soldierId: SoldierId): void;
  /** The displayed plans of every trainee soldier, in roster order, for saving. */
  deploymentPlans(): DeploymentPlanSet;
  /**
   * Replaces the drafts with saved plans (see `parseDeploymentPlans`). All or
   * nothing: refused with an `ExerciseError` if any plan is invalid now.
   */
  loadDeploymentPlans(set: DeploymentPlanSet): void;

  /** The trainee's kill zone as drawn so far, or `null`. */
  readonly killZone: KillZone | null;
  /** Inserts a corner at `index` (default: last), starting a new zone if there is none. */
  addKillZoneVertex(point: Vec2, index?: number): void;
  moveKillZoneVertex(index: number, point: Vec2): void;
  deleteKillZoneVertex(index: number): void;
  clearKillZone(): void;

  /**
   * Whether every active BLUEFOR soldier has completed its committed orders:
   * arrived at its destination and turned to its facing. Soldiers without
   * orders count as complete. Computed from simulation state; distinct from the
   * trainee's declaration that the ambush is ready, which is `startOpfor`.
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
  validateTraineeSetup(scenario, TRAINEE_SIDE);
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

  const roster = deepFreeze(rosterTree(scenario.organization));
  const members = new Map(rosterMembers(roster).map((m) => [m.soldierId, m]));
  /** Trainee soldiers in roster order. */
  const trainee = rosterMembers(roster).map((m) => soldierId(m.soldierId));
  const traineeIds = new Set<SoldierId>(trainee);
  const scenarioFingerprint = fingerprintPlainData({
    scenarioId: scenario.id,
    world: fingerprintWorld(sim.world),
    organizationTemplate: {
      id: scenario.organization.template.id,
      version: scenario.organization.template.version,
      content: fingerprintPlainData(scenario.organization.template),
    },
    unitIdPrefix: scenario.organization.unitIdPrefix,
    members: scenario.organization.members.map((m) => ({
      soldierId: m.soldierId,
      slotId: m.slotId,
    })),
    orp: scenario.orp,
    units: scenario.units,
    soldiers: scenario.soldiers,
    opforRoutes: scenario.opforRoutes,
  });

  /** The plan each trainee soldier was last committed to (empty before Execute). */
  const committed = new Map<SoldierId, SoldierDeploymentPlan>(
    trainee.map((id) => [id, emptyPlan(id)]),
  );
  const drafts = new Map<SoldierId, SoldierDeploymentPlan>(committed);

  const now = () => ({ tick: sim.tick, timeSeconds: sim.timeSeconds });
  const running = () => !paused && (phase === 'bluforOccupation' || phase === 'opforApproach');

  const soldierState = (id: SoldierId) => {
    const soldier = sim.state.soldiers.find((s) => s.id === id);
    if (!soldier) throw new ExerciseError(`unknown soldier "${id}"`);
    return soldier;
  };
  const committedPlan = (id: SoldierId) => committed.get(id) ?? emptyPlan(id);

  /** Drafts restart from the committed plans. */
  const resetDrafts = () => {
    for (const id of trainee) drafts.set(id, committedPlan(id));
  };

  const editable = () =>
    phase === 'bluforPlanning' ||
    phase === 'bluforReady' ||
    (phase === 'bluforOccupation' && paused);
  const requireEditable = () => {
    if (!editable())
      throw new ExerciseError(`plans cannot be edited during ${phase}${paused ? ' (paused)' : ''}`);
  };
  /** Orders committed this tick have not reached the soldiers yet. */
  const commitPending = () => revisions.at(-1)?.tick === sim.tick;

  const movementComplete = (): boolean => {
    if (phase === 'bluforPlanning') return false;
    if (commitPending()) return false;
    return trainee.every((id) => {
      const s = soldierState(id);
      return s.status !== 'active' || s.orders === null || s.orders.behavior === 'inPosition';
    });
  };

  const changed = (id: SoldierId) => {
    const draft = drafts.get(id);
    return draft !== undefined && !samePlan(draft, committedPlan(id));
  };
  const uncommittedChanges = () => trainee.some(changed);

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

  const editableDraft = (id: SoldierId): SoldierDeploymentPlan => {
    requireEditable();
    const draft = drafts.get(id);
    if (!draft) throw new ExerciseError(`soldier "${id}" cannot be planned for`);
    return draft;
  };
  const position = (id: SoldierId): Vec2 => {
    const { x, y } = soldierState(id).position;
    return { x, y };
  };
  const displayed = (id: SoldierId) => (editable() ? drafts.get(id) : committed.get(id));

  /** The soldier's displayed destination, or where it stands if it has none. */
  const observer = (id: SoldierId) => {
    if (!traineeIds.has(id)) return undefined;
    const destination = displayed(id)?.destination;
    return destination
      ? { point: toVec2(destination), planned: true }
      : { point: position(id), planned: false };
  };

  /** Why a destination at `point` cannot be used by the soldier now, or `null`. */
  const destinationProblem = (id: SoldierId, point: Vec2): string | null => {
    const problem = pointProblem(terrain, point);
    if (problem) return describePathProblem(problem);
    return pathFor(position(id), point).ok ? null : describePathProblem({ kind: 'unreachable' });
  };

  /**
   * The route the displayed plan leads to. While the plan is what the soldier is
   * already doing, the path it is actually walking; otherwise the path the
   * simulation will plan on commit, from where the soldier stands now.
   */
  const routeOf = (id: SoldierId): PlannedRoute | undefined => {
    const plan = displayed(id);
    if (!plan) return undefined;
    const soldier = soldierState(id);
    const active = soldier.orders;
    if (active && !commitPending() && samePlan(plan, committedPlan(id))) {
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
    const waypoints = plan.destination
      ? [{ id: `${id}.destination`, ...toVec2(plan.destination) }]
      : [];
    return planRoute(pathFor, position(id), waypoints);
  };

  const facingOf = (id: SoldierId): DisplayedFacing | undefined => {
    const plan = displayed(id);
    if (!plan) return undefined;
    const soldier = soldierState(id);
    const active = soldier.orders;
    // A committed default facing was fixed when the orders were given.
    if (active && !commitPending() && samePlan(plan, committedPlan(id))) {
      return { azimuth: active.orders.finalFacing, explicit: plan.facingDegrees !== null };
    }
    const route = routeOf(id);
    const leg = route?.legs[0];
    const path = route && leg ? [route.start, ...(leg.turns ?? []), leg.to] : [];
    return resolvedFacing(plan, path, soldier.azimuth);
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
    const plans = trainee.map((id) => drafts.get(id) ?? committedPlan(id));
    const problems = plans.flatMap((plan) => {
      const own = validateDeploymentPlan(plan, terrain);
      const reach =
        own.length === 0 && plan.destination
          ? destinationProblem(plan.soldierId, toVec2(plan.destination))
          : null;
      return [...own, ...(reach ? [`destination is ${reach}`] : [])].map((problem) => ({
        soldierId: plan.soldierId,
        problem,
      }));
    });
    if (problems.length > 0) return { ok: false, problems };

    const number = revisions.length + 1;
    const changedPlans = plans.filter((plan) => !samePlan(plan, committedPlan(plan.soldierId)));
    for (const plan of changedPlans) {
      const id = plan.soldierId;
      const facing = facingOf(id)?.azimuth ?? soldierState(id).azimuth;
      // One destination becomes one waypoint of the simulation's orders; the
      // path to it is planned by the simulation when the orders arrive.
      const waypoints = plan.destination
        ? [{ id: waypointId(`${id}.dest.${String(number)}`), ...toVec2(plan.destination) }]
        : [];
      sim.submit({
        type: 'setOrders',
        tick: sim.tick,
        soldierId: id,
        orders: { waypoints, finalFacing: facing },
      });
    }
    for (const plan of plans) committed.set(plan.soldierId, plan);
    const revision: PlanRevision = deepFreeze({
      revision: number,
      trigger,
      ...now(),
      plans: plans.map((p) => ({ ...p, destination: p.destination && { ...p.destination } })),
      changedSoldierIds: changedPlans.map((p) => p.soldierId),
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
          problems.push('Plan changes have not been executed: press Resume to execute them.');
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
    orp: deepFreeze(structuredCopy(scenario.orp)),
    roster,
    rosterMember: (id) => members.get(id),
    scenarioFingerprint,
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
    displayedPlan: (id) => (traineeIds.has(id) ? displayed(id) : undefined),
    get hasUncommittedChanges() {
      return uncommittedChanges();
    },
    displayedRoute: (id) => (traineeIds.has(id) ? routeOf(id) : undefined),
    displayedFacing: (id) => (traineeIds.has(id) ? facingOf(id) : undefined),
    deploymentStatus(id) {
      if (!traineeIds.has(id)) return undefined;
      const soldier = soldierState(id);
      const plan = displayed(id) ?? emptyPlan(id);
      const active = soldier.orders;
      if (active && active.behavior !== 'inPosition' && !(editable() && changed(id))) {
        return 'moving';
      }
      if (plan.destination) {
        const there =
          Math.hypot(
            soldier.position.x - plan.destination.east,
            soldier.position.y - plan.destination.north,
          ) < 1e-6;
        return there && !changed(id) && !commitPending() ? 'inPosition' : 'destinationAssigned';
      }
      return orpContains(scenario.orp, soldier.position) ? 'atOrp' : 'holding';
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

    setDestination(id, point) {
      const draft = editableDraft(id);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new ExerciseError('Destination not set: not a map point.');
      }
      const problem = destinationProblem(id, point);
      if (problem) throw new ExerciseError(`Destination not set: ${problem}.`);
      drafts.set(id, { ...draft, destination: toMapPoint(point) });
    },
    clearDestination(id) {
      const draft = editableDraft(id);
      drafts.set(id, { ...draft, destination: null });
    },
    setFacing(id, azimuth) {
      const draft = editableDraft(id);
      if (!Number.isFinite(azimuth))
        throw new ExerciseError(`facing must be finite, got ${String(azimuth)}`);
      drafts.set(id, { ...draft, facingDegrees: facingDegreesOf(azimuth) });
    },
    clearFacing(id) {
      const draft = editableDraft(id);
      drafts.set(id, { ...draft, facingDegrees: null });
    },
    resetPlan(id) {
      editableDraft(id);
      drafts.set(id, committedPlan(id));
    },
    deploymentPlans() {
      return {
        scenarioFingerprint,
        plans: trainee.map((id) => displayed(id) ?? committedPlan(id)),
      };
    },
    loadDeploymentPlans(set) {
      requireEditable();
      if (set.scenarioFingerprint !== scenarioFingerprint) {
        throw new ExerciseError('Plans not loaded: they were made for a different scenario.');
      }
      const problems = set.plans.flatMap((plan) => {
        if (!traineeIds.has(plan.soldierId)) return [`unknown soldier "${plan.soldierId}"`];
        const own = validateDeploymentPlan(plan, terrain);
        if (own.length > 0 || !plan.destination) return own.map((p) => `${plan.soldierId}: ${p}`);
        const reach = destinationProblem(plan.soldierId, toVec2(plan.destination));
        return reach ? [`${plan.soldierId}: destination is ${reach}`] : [];
      });
      if (problems.length > 0) throw new ExerciseError(`Plans not loaded: ${problems.join('; ')}.`);
      for (const plan of set.plans) {
        drafts.set(plan.soldierId, {
          soldierId: plan.soldierId,
          destination: plan.destination && { ...plan.destination },
          facingDegrees: plan.facingDegrees,
        });
      }
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

/** A deep copy of plain JSON-like data. */
function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
