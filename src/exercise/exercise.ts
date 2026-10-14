import {
  azimuthFromDegrees,
  createSimulation,
  engagementAreaId,
  fingerprintPlainData,
  fingerprintWorld,
  summarizeEngagement,
  lineOfSight,
  normalizeAzimuth,
  pointInPolygon,
  nearestClearPoint,
  pointProblem,
  visibleCellsIn,
  soldierId,
  waypointId,
  type Azimuth,
  type CombatConfig,
  type DeepReadonly,
  type EngagementSummary,
  type EngagementAreaId,
  type LosResult,
  type Side,
  type SimConfig,
  type SimEvent,
  type SimState,
  type Simulation,
  type SoldierId,
  type Vec2,
  type Viewshed,
} from '#sim';
import { createMotionRecorder, type MotionLog } from './motion-log';
import { createStateRecorder, REPLAY_LEAD_IN_SECONDS, type ReplayRecording } from './replay';
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
  DEFAULT_FORMATION_SPACING_M,
  fireTeamsOf,
  formationGroupsOf,
  lineFormationPoints,
  type FireTeam,
} from './formation';
import {
  createPathCache,
  describePathProblem,
  planRoute,
  type PlannedLeg,
  type PlannedRoute,
} from './routes';
import { createFixedStepRunner, type FixedStepRunner } from './runner';
import { DEFAULT_COMBAT_CONFIG } from './combat';
import { primaryWeapon } from './weapon-display';

// The ambush exercise (docs/adr/0009, docs/adr/0010): phases, the trainee's
// draft plans and kill zone, committed plan revisions, the OPFOR start and the
// ambush trigger, the engagement that follows (docs/adr/0019), and the
// simulation they drive. No DOM, no rendering.

/**
 * The ambush sequence. The simulation runs only during `bluforOccupation`,
 * `opforApproach` and `engagement`, and only while not paused.
 *
 * - `bluforPlanning`: the trainee plans destinations, facings and the kill zone.
 * - `bluforOccupation`: BLUEFOR moves into position; OPFOR waits. Can pause and re-plan.
 * - `bluforReady`: every BLUEFOR soldier given a destination or facing has
 *   arrived and turned (soldiers without one never hold this up). Frozen until the
 *   trainee declares the ambush ready (START OPFOR) or re-plans and resumes.
 * - `opforApproach`: OPFOR follows its scenario routes; BLUEFOR holds.
 * - `engagement`: an OPFOR soldier entered the kill zone and the ambush is
 *   sprung; combat runs (docs/adr/0019) from the next tick.
 * - `engagementComplete`: the engagement has ended. Frozen; see `engagementResult`.
 */
export type ExercisePhase =
  | 'bluforPlanning'
  | 'bluforOccupation'
  | 'bluforReady'
  | 'opforApproach'
  | 'engagement'
  | 'engagementComplete';

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

/** Where an OPFOR soldier stood when the ambush was triggered. */
export interface OpforPositionAtTrigger {
  readonly soldierId: SoldierId;
  readonly point: Vec2;
  /** Active, not escaped, and inside the kill zone (boundary included). */
  readonly inKillZone: boolean;
}

/**
 * The trainee's TRIGGER AMBUSH action (docs/adr/0021). The engagement begins at
 * the start of tick `tick`, the tick the simulation was at when the trainee
 * pressed the button (or, if paused, the tick it resumes from).
 */
export interface AmbushTrigger {
  /** Tick at whose start the engagement begins. */
  readonly tick: number;
  /** Simulation time at which the engagement begins. */
  readonly atSeconds: number;
  /** Seconds since OPFOR began its approach. */
  readonly approachSeconds: number;
  /** Whether the trainee triggered while the simulation was paused. */
  readonly whilePaused: boolean;
  readonly killZoneId: EngagementAreaId;
  /** Active OPFOR in the kill zone at the trigger. */
  readonly opforInKillZone: number;
  /** Every OPFOR soldier of the scenario. */
  readonly opforTotal: number;
  /** Every OPFOR soldier's position at the trigger, in scenario order. */
  readonly opforPositions: readonly OpforPositionAtTrigger[];
}

/**
 * Whether the trainee can trigger the ambush now:
 *
 * - `unavailable`: before the OPFOR approach;
 * - `available`: during the approach, not yet triggered;
 * - `queued`: triggered; the engagement begins with the next tick (on resume, if paused);
 * - `triggered`: the engagement has begun.
 */
export type AmbushTriggerState = 'unavailable' | 'available' | 'queued' | 'triggered';

export type TriggerAmbushResult =
  | { readonly ok: true; readonly trigger: AmbushTrigger }
  | { readonly ok: false; readonly problem: string };

/** Active OPFOR inside the kill zone, out of every OPFOR soldier of the scenario. */
export interface KillZoneOccupancy {
  readonly inside: number;
  readonly total: number;
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
      /**
       * An active OPFOR soldier came into (or walked out of) the kill zone during the
       * approach or engagement, as seen at the end of a tick. Being incapacitated or
       * escaping inside it is not leaving it.
       */
      readonly type: 'killZoneEntered' | 'killZoneLeft';
      readonly tick: number;
      readonly timeSeconds: number;
      readonly soldierId: SoldierId;
    }
  | {
      readonly type: 'ambushTriggered';
      readonly tick: number;
      readonly timeSeconds: number;
      readonly trigger: AmbushTrigger;
    }
  | {
      readonly type: 'engagementEnded';
      readonly tick: number;
      readonly timeSeconds: number;
      readonly result: EngagementResult;
    };

/**
 * The facts of an engagement (docs/adr/0019), and what is needed to
 * reproduce it: the seed and tick rate, and the combat configuration's
 * identity and content fingerprint. No score or assessment.
 */
export interface EngagementResult extends EngagementSummary {
  readonly seed: number;
  readonly tickRateHz: number;
  readonly combatConfig: {
    readonly id: string;
    readonly version: string;
    /** `fingerprintPlainData` of the whole configuration. */
    readonly fingerprint: string;
  };
  readonly trigger: AmbushTrigger | null;
}

/** The simulation event types that make up the engagement's combat log. */
export type CombatEvent = Extract<
  SimEvent,
  {
    type:
      | 'engagementStarted'
      | 'opforReacted'
      | 'shotFired'
      | 'soldierIncapacitated'
      | 'soldierEscaped'
      | 'engagementEnded';
  }
>;

const COMBAT_EVENT_TYPES: ReadonlySet<SimEvent['type']> = new Set([
  'engagementStarted',
  'opforReacted',
  'shotFired',
  'soldierIncapacitated',
  'soldierEscaped',
  'engagementEnded',
]);

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
  /** The combat model's parameters; `DEFAULT_COMBAT_CONFIG` when not given. */
  readonly combat?: CombatConfig;
  /** Distance between neighbours in a fire-team line formation; `DEFAULT_FORMATION_SPACING_M` when not given. */
  readonly formationSpacingM?: number;
}

/**
 * A fire team's line formation (docs/adr/0022): the group placement that
 * generated its Marines' destinations and facings. Planning metadata only:
 * the Marines' own plans remain their orders.
 */
export interface FireTeamFormation {
  /** The fire team's template unit id. */
  readonly unitId: string;
  /** The middle of the line, map metres. */
  readonly centre: Vec2;
  /** The common facing, exactly as the Marines' plans store it (see `facingDegreesOf`). */
  readonly azimuth: Azimuth;
  readonly spacingM: number;
  /**
   * Every slot in member order, with the destination it generates: its place
   * on the line, or the nearest spot clear of a building when the line falls
   * in or against one (see `movedClear`), or on the bank when it falls in
   * water (see `movedAshore`).
   */
  readonly slots: readonly { readonly soldierId: SoldierId; readonly point: Vec2 }[];
  /** The Marines whose slot fell in or against a building and were moved clear of it. */
  readonly movedClear: readonly SoldierId[];
  /** The Marines whose slot fell in water and were moved to the nearest bank. */
  readonly movedAshore: readonly SoldierId[];
  /**
   * The Marines whose plans are still exactly the generated ones, in slot
   * order. Only they follow moves and turns of the formation; a Marine whose
   * plan is edited on its own is detached for good (until the team is placed
   * again with a new map click).
   */
  readonly linked: readonly SoldierId[];
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
  /** The trainee's TRIGGER AMBUSH action, from the moment it is requested. */
  readonly trigger: AmbushTrigger | null;
  readonly triggerState: AmbushTriggerState;
  /**
   * Active OPFOR (neither incapacitated nor escaped) inside the kill zone now,
   * boundary included, out of every OPFOR soldier; `null` without a valid kill zone.
   * Information only: it never gates the trigger.
   */
  killZoneOccupancy(): KillZoneOccupancy | null;
  /**
   * Simulation seconds since OPFOR began its approach (frozen at the
   * trigger); `null` before the approach.
   */
  readonly approachSeconds: number | null;
  /** The combat configuration in force. */
  readonly combatConfig: CombatConfig;
  /**
   * The weapon each soldier fires (the primary weapon of its resolved
   * loadout), by soldier id; `null` for a soldier without one.
   */
  readonly combatWeapons: Readonly<Record<string, string | null>>;
  /**
   * The engagement's facts so far, from the moment it begins (with `endSeconds`
   * `null` while it runs); `null` before the ambush.
   */
  readonly engagementResult: EngagementResult | null;
  /** Every combat event of the engagement, in the order they happened. */
  readonly combatLog: readonly CombatEvent[];
  readonly timeline: readonly ExerciseEvent[];
  /**
   * The After Action Review's recording (docs/adr/0026): the simulation state
   * at every tick from 5 s before TRIGGER AMBUSH (`REPLAY_LEAD_IN_SECONDS`; or
   * from the start of the OPFOR approach, if later) on; `null` before the
   * trigger. Complete once the engagement has ended.
   */
  readonly recording: ReplayRecording | null;
  /**
   * A read-only view of the exercise as it was at `frame` of the recording
   * (clamped to it): the simulation state, combat log, timeline, phase and
   * every query (statuses, routes, the engagement's result) as at that tick,
   * the trainee's plans as they are. Nothing is simulated to make it; every
   * change is refused with an `ExerciseError`. Throws without a recording.
   */
  replayAt(frame: number): Exercise;
  /**
   * Simulation seconds skipped because a frame exceeded the runner's catch-up
   * budget (docs/adr/0003), e.g. after the browser stalled. Diagnostic only.
   */
  readonly droppedSeconds: number;
  /**
   * Every soldier's motion at every tick since the exercise began
   * (`MotionLog`), its latest tick as the state is now. The 3D characters'
   * input; recording it never changes the simulation.
   */
  readonly motionLog: MotionLog;
  /**
   * The simulation time to draw now, in seconds: while the simulation runs,
   * one tick behind it plus the part of a tick the runner has accumulated
   * (so motion between ticks can be interpolated from recorded ticks);
   * otherwise the current tick's time.
   */
  readonly renderSeconds: number;

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
  /**
   * Where a trainee soldier will stand, and which way he will face, once his
   * displayed plan is carried out: the plan's destination (or where he stands
   * without one) and its facing (the trainee's, or the default: the direction
   * of arrival, or his current facing without a destination). The one source
   * of the planned pose for planning displays (visibility, engagement wedge).
   */
  plannedPose(
    soldierId: SoldierId,
  ): { readonly point: Vec2; readonly azimuth: Azimuth; readonly planned: boolean } | undefined;
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

  /** The trainee organization's fire teams, in template order (docs/adr/0022). */
  readonly fireTeams: readonly FireTeam[];
  /**
   * Everything that can be selected and placed as a formation, in template
   * order: the squad as a whole, then each fire team. The formation methods
   * below take any of their unit ids. A Marine can be in the squad's
   * formation and its fire team's; whichever was placed last gives its orders.
   */
  readonly formationGroups: readonly FireTeam[];
  /** The fire team a soldier belongs to, if any. */
  fireTeamOf(soldierId: SoldierId): FireTeam | undefined;
  /** The group's formation while editable and at least one Marine still follows it. */
  formation(unitId: string): FireTeamFormation | undefined;
  /**
   * Every formation as planned, also once the plan has been executed, in the
   * order they were last placed (so placing them again in this order gives
   * each Marine the same formation), with the Marines still following each.
   */
  plannedFormations(): readonly FireTeamFormation[];
  /**
   * Places the whole group (squad or fire team) in a line centred on `centre`, facing `azimuth`
   * (default: the formation's facing if it has one, else the direction from
   * the team's current centre to `centre`): a destination and explicit facing
   * for every Marine of the team, re-linking any detached ones. All or
   * nothing: refused with an `ExerciseError` naming each slot that cannot be
   * used (off the map, in or against a building, unreachable).
   */
  placeFormation(unitId: string, centre: Vec2, azimuth?: Azimuth): FireTeamFormation;
  /** Moves the formation's centre, keeping its facing; only linked Marines follow. All or nothing. */
  moveFormation(unitId: string, centre: Vec2): FireTeamFormation;
  /** Turns the formation round its centre; only linked Marines follow. All or nothing. */
  setFormationFacing(unitId: string, azimuth: Azimuth): FireTeamFormation;
  /** Deletes the formation: its linked Marines lose their destinations and facings. */
  clearFormation(unitId: string): void;
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
   * TRIGGER AMBUSH: from the start of the OPFOR approach, whether or not anyone
   * is in the kill zone. Submits the engagement-start command for the current
   * tick; while paused it waits there until the trainee resumes.
   */
  triggerAmbush(): TriggerAmbushResult;

  /**
   * Advances simulation time by `realDtSeconds × timeScale` (whole ticks) while
   * the simulation runs; does nothing otherwise. Phase changes that freeze it
   * (BLUEFOR in position, engagement complete) stop it at the end of the tick
   * in which they happen; the ambush trigger does not, as the engagement runs
   * on. Returns the simulation events produced.
   */
  advance(realDtSeconds: number, timeScale?: number): SimEvent[];
}

export function createExercise({
  config,
  scenario,
  combat = DEFAULT_COMBAT_CONFIG,
  formationSpacingM = DEFAULT_FORMATION_SPACING_M,
}: ExerciseOptions): Exercise {
  if (!(formationSpacingM > 0) || !Number.isFinite(formationSpacingM)) {
    throw new RangeError(
      `formation spacing must be a finite number of metres > 0, got ${String(formationSpacingM)}`,
    );
  }
  validateOpforRoutes(scenario, TRAINEE_SIDE);
  validateTraineeSetup(scenario, TRAINEE_SIDE);
  const roster = deepFreeze(rosterTree(scenario.organization));
  const members = new Map(rosterMembers(roster).map((m) => [m.soldierId, m]));
  // Every soldier fires the primary weapon of its resolved loadout: the same
  // rule as the engagement wedge (`primaryWeapon`), so the two cannot differ.
  const weaponOf = (loadout: Parameters<typeof primaryWeapon>[0] | undefined) => {
    const weapon = loadout ? primaryWeapon(loadout, combat) : null;
    return weapon?.kind === 'weapon' ? weapon.ref : null;
  };
  const combatWeapons: Record<string, string | null> = deepFreeze(
    Object.fromEntries(
      scenario.soldiers.map((s) => [
        s.id,
        weaponOf(members.get(s.id)?.loadout ?? scenario.opforLoadouts?.[s.id]),
      ]),
    ),
  );
  const sim = createSimulation(config, {
    ...scenario,
    combat: { config: combat, weapons: combatWeapons },
  });
  const motion = createMotionRecorder(config.tickRateHz);
  motion.record(sim.state);
  const terrain = sim.world.terrain;
  /**
   * The simulation state the exercise's queries read: the live state, or,
   * inside a replay view (`replayAt`), the recorded frame's. Changes always
   * act on the live simulation.
   */
  let frameState: DeepReadonly<SimState> | null = null;
  const simState = () => frameState ?? sim.state;
  const combatConfigIdentity = deepFreeze({
    id: combat.id,
    version: combat.version,
    fingerprint: fingerprintPlainData(combat),
  });
  const pathFor = createPathCache(terrain);
  /** OPFOR route legs, planned as their orders follow them: along the roads (docs/adr/0043). */
  const opforPathFor = createPathCache(terrain, 2000, { followRoads: true });

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
      opforPathFor,
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

  /** Trainee soldiers in roster order. */
  const trainee = rosterMembers(roster).map((m) => soldierId(m.soldierId));
  const traineeIds = new Set<SoldierId>(trainee);
  const scenarioFingerprint = fingerprintPlainData({
    scenarioId: scenario.id,
    // Terrain and movement only: plans do not depend on the combat model.
    world: fingerprintWorld({ terrain, movement: sim.world.movement }),
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

  const combatLog: CombatEvent[] = [];
  const now = () => ({ tick: sim.tick, timeSeconds: sim.timeSeconds });
  const running = () =>
    !paused &&
    (phase === 'bluforOccupation' || phase === 'opforApproach' || phase === 'engagement');

  const engagementResult = (): EngagementResult | null => {
    const engagement = simState().engagement;
    if (!engagement) return null;
    return {
      ...summarizeEngagement(engagement),
      seed: config.seed,
      tickRateHz: config.tickRateHz,
      combatConfig: combatConfigIdentity,
      trigger,
    };
  };

  const soldierState = (id: SoldierId) => {
    const soldier = simState().soldiers.find((s) => s.id === id);
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
  const commitPending = () => revisions.at(-1)?.tick === simState().tick;

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

  /** The kill zone OPFOR is approaching (or, before then, the one being planned), if valid. */
  const occupancyZone = (): readonly Vec2[] | null => {
    const zone = opforStart?.killZone ?? killZone;
    return zone && killZoneProblems(zone, []).length === 0 ? zone.vertices : null;
  };
  /** Every OPFOR soldier's position now, and whether it counts as in the kill zone. */
  const opforNow = (zone: readonly Vec2[]): OpforPositionAtTrigger[] => {
    const combatants = simState().engagement?.combatants;
    return simState()
      .soldiers.filter((s) => s.side === ENEMY_SIDE)
      .map((s) => {
        const behavior = combatants?.find((c) => c.soldierId === s.id)?.behavior;
        const point = { x: s.position.x, y: s.position.y };
        const out = s.status !== 'active' || behavior === 'escaped' || behavior === 'incapacitated';
        return { soldierId: s.id, point, inKillZone: !out && pointInPolygon(point, zone) };
      });
  };
  /** Who was in the kill zone at the end of the previous tick. */
  let inKillZone = new Set<SoldierId>();
  /** Records active OPFOR coming into and leaving the kill zone, for the timeline and AAR. */
  const trackKillZone = () => {
    const zone = opforStart?.killZone.vertices;
    if (!zone) return;
    const opfor = opforNow(zone);
    const inside = new Set(opfor.filter((o) => o.inKillZone).map((o) => o.soldierId));
    for (const id of inside) {
      if (!inKillZone.has(id)) timeline.push({ type: 'killZoneEntered', ...now(), soldierId: id });
    }
    for (const id of inKillZone) {
      // Incapacitated or escaped soldiers drop out of the count but did not walk out.
      const outside = opfor.some((o) => o.soldierId === id && !pointInPolygon(o.point, zone));
      if (!inside.has(id) && outside)
        timeline.push({ type: 'killZoneLeft', ...now(), soldierId: id });
    }
    inKillZone = inside;
  };

  const afterTick = (events: readonly SimEvent[]) => {
    if (phase === 'bluforOccupation' && movementComplete()) {
      phase = 'bluforReady';
      resetDrafts();
      timeline.push({ type: 'bluforInPosition', ...now() });
      return;
    }
    if (phase !== 'opforApproach' && phase !== 'engagement') return;
    // Entering or leaving the kill zone never starts combat: only the trainee's
    // TRIGGER AMBUSH does (docs/adr/0021).
    trackKillZone();
    if (phase === 'opforApproach' && events.some((e) => e.type === 'engagementStarted')) {
      phase = 'engagement';
    }
    if (phase === 'engagement') {
      for (const event of events) {
        if (COMBAT_EVENT_TYPES.has(event.type)) combatLog.push(event as CombatEvent);
      }
      if (events.some((e) => e.type === 'engagementEnded')) {
        phase = 'engagementComplete';
        const result = engagementResult();
        if (result)
          timeline.push({ type: 'engagementEnded', ...now(), result: deepFreeze(result) });
      }
    }
  };

  /** The recording's frames, from the trigger on (docs/adr/0026); `null` before it. */
  let frames: DeepReadonly<SimState>[] | null = null;
  /** How many of `frames` come before the trigger (the lead-in). */
  let leadInCount = 0;
  /** The simulation events of every tick from the trigger on (docs/adr/0026). */
  let recordedEvents: SimEvent[] = [];
  const record = createStateRecorder();
  /**
   * The approach's latest states, until the trigger: the recording's lead-in
   * (`REPLAY_LEAD_IN_SECONDS`). Recorded like the frames; nothing else reads it.
   */
  let leadIn: DeepReadonly<SimState>[] = [];
  const leadInTicks = Math.round(REPLAY_LEAD_IN_SECONDS * config.tickRateHz);
  const keepLeadIn = () => {
    const last = leadIn[leadIn.length - 1];
    if (last?.tick === sim.state.tick) leadIn.pop();
    leadIn.push(record(sim.state));
    // The ticks before the current one, and the current one (the trigger's, if it comes now).
    if (leadIn.length > leadInTicks + 1) leadIn.splice(0, leadIn.length - leadInTicks - 1);
  };

  const stepped: SimEvent[] = [];
  const stepper = {
    dtSeconds: 1 / config.tickRateHz,
    step: () => {
      // The runner may ask for several ticks per frame; stop as soon as the phase stops running.
      if (!running()) return;
      const events = sim.step();
      motion.record(sim.state);
      stepped.push(...events);
      afterTick(events);
      // Every tick from the trigger to the end of the engagement, as it is now.
      if (frames && trigger) {
        frames.push(record(sim.state));
        recordedEvents.push(...events);
      } else if (phase === 'opforApproach') keepLeadIn();
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

  // Fire-team formations (docs/adr/0022): the metadata of each team's last
  // group placement. The Marines' drafts stay the only plans.
  const fireTeams: readonly FireTeam[] = deepFreeze(fireTeamsOf(roster));
  /** The squad and its fire teams: the units a formation can be placed for. */
  const formationGroups: readonly FireTeam[] = deepFreeze(formationGroupsOf(roster));
  const teamOfSoldier = new Map(
    fireTeams.flatMap((t) => t.memberIds.map((id) => [id, t] as const)),
  );
  interface Formation {
    readonly unitId: string;
    readonly centre: Vec2;
    readonly azimuth: Azimuth;
    readonly spacingM: number;
    readonly slots: readonly { readonly soldierId: SoldierId; readonly point: Vec2 }[];
    readonly linked: Set<SoldierId>;
    readonly movedClear: readonly SoldierId[];
    readonly movedAshore: readonly SoldierId[];
  }
  const formations = new Map<string, Formation>();

  const fireTeam = (unitId: string): FireTeam => {
    const team = formationGroups.find((t) => t.unitId === unitId);
    if (!team) throw new ExerciseError(`"${unitId}" is not a squad or fire team`);
    return team;
  };
  /** The plan a formation generates for one of its slots. */
  const generatedPlan = (id: SoldierId, point: Vec2, azimuth: Azimuth): SoldierDeploymentPlan => ({
    soldierId: id,
    destination: toMapPoint(point),
    facingDegrees: facingDegreesOf(azimuth),
  });
  /**
   * The formation with every Marine whose draft is no longer the generated
   * plan detached for good; dropped once nobody follows it. Only while plans
   * are editable (otherwise the drafts are not what is shown).
   */
  const liveFormation = (unitId: string): Formation | undefined => {
    const formation = formations.get(unitId);
    if (!formation || !editable()) return undefined;
    for (const slot of formation.slots) {
      if (!formation.linked.has(slot.soldierId)) continue;
      const draft = drafts.get(slot.soldierId);
      const plan = generatedPlan(slot.soldierId, slot.point, formation.azimuth);
      if (!draft || !samePlan(draft, plan)) formation.linked.delete(slot.soldierId);
    }
    if (formation.linked.size === 0) {
      formations.delete(unitId);
      return undefined;
    }
    return formation;
  };
  /**
   * Every formation as planned, editable or not, in the order last placed,
   * with the Marines whose displayed plan is still the generated one; those
   * nobody follows are left out.
   */
  const plannedFormations = (): FireTeamFormation[] =>
    [...formations.values()].flatMap((f) => {
      const linked = f.slots
        .filter((slot) => {
          if (!f.linked.has(slot.soldierId)) return false;
          const plan = displayed(slot.soldierId);
          return !!plan && samePlan(plan, generatedPlan(slot.soldierId, slot.point, f.azimuth));
        })
        .map((slot) => slot.soldierId);
      return linked.length === 0 ? [] : [{ ...formationView(f), linked }];
    });
  const formationView = (f: Formation): FireTeamFormation =>
    deepFreeze({
      unitId: f.unitId,
      centre: { x: f.centre.x, y: f.centre.y },
      azimuth: f.azimuth,
      spacingM: f.spacingM,
      slots: f.slots.map((slot) => ({ soldierId: slot.soldierId, point: { ...slot.point } })),
      linked: f.slots.filter((slot) => f.linked.has(slot.soldierId)).map((slot) => slot.soldierId),
      movedClear: [...f.movedClear],
      movedAshore: [...f.movedAshore],
    });
  /**
   * Lays the team out on a line and gives every Marine in `follow` its slot's
   * destination and the common facing. A slot in or against a building moves
   * to the nearest spot clear of it that the Marine can reach (and no closer
   * than 2 m to another slot). Otherwise all or nothing: if any slot still
   * cannot be used, nothing changes and an `ExerciseError` names each one.
   */
  const layOut = (
    team: FireTeam,
    centre: Vec2,
    azimuthIn: Azimuth,
    follow: ReadonlySet<SoldierId>,
    what: string,
  ): FireTeamFormation => {
    requireEditable();
    if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y) || !Number.isFinite(azimuthIn)) {
      throw new ExerciseError(`${what}: not a map point and facing.`);
    }
    // The facing as plans store it, so the line and every Marine agree exactly.
    const azimuth = azimuthFromDegrees(facingDegreesOf(azimuthIn));
    const points = lineFormationPoints(centre, azimuth, team.memberIds.length, formationSpacingM);
    const slots: { soldierId: SoldierId; point: Vec2 }[] = [];
    const movedClear: SoldierId[] = [];
    const movedAshore: SoldierId[] = [];
    const problems: string[] = [];
    team.memberIds.forEach((soldierId, i) => {
      const onLine = points[i] ?? centre;
      if (!follow.has(soldierId)) {
        slots.push({ soldierId, point: onLine });
        return;
      }
      const kind = pointProblem(terrain, onLine)?.kind;
      if (kind === 'insideBuilding' || kind === 'tooCloseToBuilding' || kind === 'inWater') {
        const others = [...slots.map((s) => s.point), ...points.slice(i + 1)];
        const clear = nearestClearPoint(
          terrain,
          onLine,
          (q) =>
            destinationProblem(soldierId, q) === null &&
            others.every((o) => Math.hypot(o.x - q.x, o.y - q.y) >= 2),
        );
        if (clear) {
          slots.push({ soldierId, point: clear });
          if (kind === 'inWater') movedAshore.push(soldierId);
          else movedClear.push(soldierId);
          return;
        }
      }
      slots.push({ soldierId, point: onLine });
      const problem = destinationProblem(soldierId, onLine);
      if (problem)
        problems.push(`${members.get(soldierId)?.slot.label ?? soldierId} would be ${problem}`);
    });
    if (problems.length > 0) throw new ExerciseError(`${what}: ${problems.join('; ')}.`);
    for (const { soldierId: id, point } of slots) {
      if (follow.has(id)) drafts.set(id, generatedPlan(id, point, azimuth));
    }
    const formation: Formation = {
      unitId: team.unitId,
      centre: { x: centre.x, y: centre.y },
      azimuth,
      spacingM: formationSpacingM,
      slots,
      linked: new Set(follow),
      movedClear,
      movedAshore,
    };
    // Re-inserted, so `formations` stays in the order of the latest placements.
    formations.delete(team.unitId);
    formations.set(team.unitId, formation);
    return formationView(formation);
  };
  /** A formation to move or turn: refused when there is none (or nobody follows it). */
  const editableFormation = (unitId: string): Formation => {
    requireEditable();
    fireTeam(unitId);
    const formation = liveFormation(unitId);
    if (!formation) throw new ExerciseError('Formation not changed: place it first.');
    return formation;
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
        problems.push('BLUEFOR has not occupied its positions: press Move first.');
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
      case 'engagement':
      case 'engagementComplete':
        return ['OPFOR has already been started.'];
      case 'bluforReady':
        if (uncommittedChanges())
          problems.push('Plan changes have not been executed: press Resume to execute them.');
        break;
    }
    const opfor = simState().soldiers.filter((s) => s.side === ENEMY_SIDE);
    problems.push(...killZoneProblems(killZone, opfor));
    if (scenario.opforRoutes.length === 0) problems.push('The scenario defines no OPFOR route.');
    return problems;
  };

  const api: Exercise = {
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
    get triggerState(): AmbushTriggerState {
      if (phase === 'engagement' || phase === 'engagementComplete') return 'triggered';
      if (phase !== 'opforApproach') return 'unavailable';
      return trigger ? 'queued' : 'available';
    },
    killZoneOccupancy() {
      const zone = occupancyZone();
      if (!zone) return null;
      const opfor = opforNow(zone);
      return { inside: opfor.filter((o) => o.inKillZone).length, total: opfor.length };
    },
    get approachSeconds() {
      if (!opforStart) return null;
      return (trigger?.atSeconds ?? simState().tick / config.tickRateHz) - opforStart.timeSeconds;
    },
    combatConfig: combat,
    combatWeapons,
    get engagementResult() {
      return engagementResult();
    },
    combatLog,
    timeline,
    get motionLog() {
      // The latest tick as it is now (plans and placements change it between ticks).
      motion.record(sim.state);
      return motion;
    },
    get renderSeconds() {
      const rate = config.tickRateHz;
      return running() ? (sim.tick - 1 + runner.alpha) / rate : sim.tick / rate;
    },
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
    plannedPose(id) {
      const from = observer(id);
      const facing = from ? facingOf(id) : undefined;
      return from && facing
        ? { point: from.point, azimuth: facing.azimuth, planned: from.planned }
        : undefined;
    },
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

    fireTeams,
    formationGroups,
    fireTeamOf: (id) => teamOfSoldier.get(id),
    formation(unitId) {
      const formation = liveFormation(unitId);
      return formation && formationView(formation);
    },
    plannedFormations,
    placeFormation(unitId, centre, azimuth) {
      const team = fireTeam(unitId);
      requireEditable();
      let facing = azimuth ?? liveFormation(unitId)?.azimuth;
      if (facing === undefined) {
        // The way the team will walk: from its centre now to the new one.
        const here = team.memberIds.map(position);
        const x = here.reduce((sum, p) => sum + p.x, 0) / here.length;
        const y = here.reduce((sum, p) => sum + p.y, 0) / here.length;
        const dx = centre.x - x;
        const dy = centre.y - y;
        facing = Math.hypot(dx, dy) > 1e-9 ? normalizeAzimuth(Math.atan2(dx, dy)) : 0;
      }
      // A new placement is a new order for the whole team, detached Marines included.
      return layOut(team, centre, facing, new Set(team.memberIds), 'Formation not placed');
    },
    moveFormation(unitId, centre) {
      const formation = editableFormation(unitId);
      return layOut(
        fireTeam(unitId),
        centre,
        formation.azimuth,
        formation.linked,
        'Formation not moved',
      );
    },
    setFormationFacing(unitId, azimuth) {
      const formation = editableFormation(unitId);
      return layOut(
        fireTeam(unitId),
        formation.centre,
        azimuth,
        formation.linked,
        'Formation not turned',
      );
    },
    clearFormation(unitId) {
      const formation = editableFormation(unitId);
      for (const id of formation.linked) drafts.set(id, emptyPlan(id));
      formations.delete(unitId);
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
      if ((phase === 'opforApproach' || phase === 'engagement') && paused) {
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
            followRoads: true,
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
      leadIn = [];
      keepLeadIn();
      run();
      timeline.push({ type: 'opforStarted', ...now(), start });
      return { ok: true, start };
    },

    triggerAmbush() {
      if (phase !== 'opforApproach' || !opforStart) {
        return { ok: false, problem: `the ambush cannot be triggered during ${phase}` };
      }
      if (trigger) return { ok: false, problem: 'the ambush has already been triggered' };
      const opforPositions = opforNow(opforStart.killZone.vertices);
      // The simulation is at the start of tick `sim.tick` (it only ever steps
      // whole ticks, and is frozen while paused): the engagement begins there.
      sim.submit({ type: 'beginEngagement', tick: sim.tick });
      trigger = deepFreeze({
        tick: sim.tick,
        atSeconds: sim.timeSeconds,
        approachSeconds: sim.timeSeconds - opforStart.timeSeconds,
        whilePaused: paused,
        killZoneId: opforStart.killZone.id,
        opforInKillZone: opforPositions.filter((o) => o.inKillZone).length,
        opforTotal: opforPositions.length,
        opforPositions,
      });
      timeline.push({ type: 'ambushTriggered', ...now(), trigger });
      // The recording starts with the approach's last moments, then the state
      // at the trigger itself.
      const before = leadIn.filter((s) => s.tick < sim.tick);
      frames = [...before, record(sim.state)];
      leadInCount = before.length;
      leadIn = [];
      recordedEvents = [];
      return { ok: true, trigger };
    },

    advance(realDtSeconds, timeScale = 1) {
      if (!running()) return [];
      runner.timeScale = timeScale;
      runner.advance(realDtSeconds);
      return stepped.splice(0);
    },

    get recording() {
      if (!frames || !trigger) return null;
      const complete = phase === 'engagementComplete';
      return {
        tickRateHz: config.tickRateHz,
        triggerTick: trigger.tick,
        triggerSeconds: trigger.atSeconds,
        leadInFrames: leadInCount,
        frames,
        events: recordedEvents,
        complete,
        durationSeconds: (frames.length - 1) / config.tickRateHz,
      };
    },
    replayAt: (frame) => replayView(frame),
  };

  // --- Replay views (docs/adr/0026) ----------------------------------------
  /** Everything that would change the exercise: refused in a replay view. */
  const CHANGES = new Set<string | symbol>([
    'setDestination',
    'clearDestination',
    'setFacing',
    'clearFacing',
    'resetPlan',
    'placeFormation',
    'moveFormation',
    'setFormationFacing',
    'clearFormation',
    'loadDeploymentPlans',
    'addKillZoneVertex',
    'moveKillZoneVertex',
    'deleteKillZoneVertex',
    'clearKillZone',
    'execute',
    'pause',
    'resume',
    'startOpfor',
    'triggerAmbush',
    'advance',
  ]);
  const refuseChange = () => {
    throw new ExerciseError('The replay is a record of what happened: it cannot be changed.');
  };
  /** Events of `list` (in tick order) up to `tick`: before it, or up to and including it. */
  const upTo = <T extends { readonly tick: number }>(
    list: readonly T[],
    tick: number,
    inclusive: boolean,
  ): readonly T[] => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const t = list[mid]?.tick ?? 0;
      if (inclusive ? t <= tick : t < tick) lo = mid + 1;
      else hi = mid;
    }
    return list.slice(0, lo);
  };
  let lastView: { frame: number; length: number; view: Exercise } | null = null;
  const replayView = (requested: number): Exercise => {
    if (!frames || frames.length === 0)
      throw new ExerciseError('There is no recording: the ambush has not been triggered.');
    const index = Math.min(Math.max(Math.round(requested), 0), frames.length - 1);
    if (lastView?.frame === index && lastView.length === frames.length) return lastView.view;
    const state = frames[index];
    if (!state) throw new ExerciseError('There is no such frame.');
    const tick = state.tick;
    const engagement = state.engagement;
    // A tick's events come with the state after it; the timeline is stamped after each tick.
    const overrides = new Map<string | symbol, unknown>([
      [
        'simulation',
        Object.freeze({
          config: sim.config,
          world: sim.world,
          tick,
          timeSeconds: tick / config.tickRateHz,
          state,
        }),
      ],
      [
        'phase',
        engagement?.end ? 'engagementComplete' : engagement ? 'engagement' : 'opforApproach',
      ],
      ['paused', false],
      ['canEditPlans', false],
      ['hasUncommittedChanges', false],
      [
        'triggerState',
        engagement ? 'triggered' : tick < (trigger?.tick ?? 0) ? 'available' : 'queued',
      ],
      ['combatLog', upTo(combatLog, tick, false)],
      ['timeline', upTo(timeline, tick, true)],
      ['droppedSeconds', 0],
    ]);
    /** Runs `read` with the queries reading this frame's state. */
    const inFrame = <T>(read: () => T): T => {
      const before = frameState;
      frameState = state;
      try {
        return read();
      } finally {
        frameState = before;
      }
    };
    const view = new Proxy(api, {
      get(target, prop) {
        if (overrides.has(prop)) return overrides.get(prop);
        if (CHANGES.has(prop)) return refuseChange;
        const value = inFrame((): unknown => Reflect.get(target, prop, target));
        return typeof value === 'function'
          ? (...args: unknown[]) =>
              inFrame(() => (value as (...a: unknown[]) => unknown).apply(target, args))
          : value;
      },
      set() {
        return false;
      },
    });
    lastView = { frame: index, length: frames.length, view };
    return view;
  };

  return api;
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
