import {
  createSimulation,
  createSyntheticTerrain,
  DEFAULT_BEHAVIOR_PARAMS,
  flattenFormation,
  flatElevation,
  hashSimState,
  orgUnitId,
  smoothNoise,
  soldierId,
  type AgentOverride,
  type BehaviorParams,
  type FormationSpec,
  type Scenario,
  type SimCommand,
  type SimEvent,
  type Simulation,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import { buildFormationSpec } from '../formations/formations';
import {
  instantiateOrganization,
  validateOrganizationTemplate,
  type OrganizationTemplate,
  type TraineeOrganization,
} from '../organization';
import elementTemplate from '../organizations/three-marine-element.json';
import fireTeamTemplate from '../organizations/usmc-fire-team-mcwp-3-11-2.json';
import { USMC_RIFLE_SQUAD_TEMPLATE } from '../squad';

// A Behavior Lab run (docs/behavior-lab/04): the real simulation, one
// organization on synthetic or real terrain, its orders and disturbances as
// commands, and everything needed to reproduce it: scenario, organization,
// formation, parameters, seed, tick rate and the commands submitted. Headless:
// the lab page, the scenario tests and the seed sweeps all use it.

export type LabOrganization = 'element3' | 'fireTeam' | 'squad';

export const LAB_ORGANIZATIONS: Readonly<Record<LabOrganization, OrganizationTemplate>> = {
  element3: validateOrganizationTemplate(elementTemplate),
  fireTeam: validateOrganizationTemplate(fireTeamTemplate),
  squad: USMC_RIFLE_SQUAD_TEMPLATE,
};

/** A disturbance by slot (e.g. "FT2.AR"), at a time. */
export interface LabDisturbance {
  readonly atSeconds: number;
  readonly slotId: string;
  readonly disturbance: AgentOverride | null;
}

/** Everything a run is made from (plain data: saved and loaded as JSON). */
export interface LabRunSpec {
  readonly organization: LabOrganization;
  readonly formation: string;
  /** Individual interval and element spacing (m). */
  readonly interval: number;
  readonly elementSpacing: number;
  /** Commanded pace (m/s). */
  readonly pace: number;
  /** Where the organization stands at the start (its centre), facing north. */
  readonly start: Vec2;
  /**
   * Waypoints in order: the first is ordered at the start; each next one is
   * ordered as the unit nears the previous (it carries on without stopping).
   */
  readonly waypoints: readonly Vec2[];
  /** Route points on the way to the first waypoint. */
  readonly via?: readonly Vec2[];
  readonly disturbances?: readonly LabDisturbance[];
  readonly seed: number;
  readonly tickRateHz: number;
  /** Tuning overrides (absent: the defaults). */
  readonly params?: BehaviorParams;
}

/**
 * How far before the end of a leg (m) the next waypoint is ordered, beyond
 * the formation's own reach: the turn's rounded corner (about the
 * formation's half-width) must still lie ahead of its leading Marine, or
 * his slot would swing round it at once.
 */
const NEXT_LEG_MARGIN_M = 10;

export interface LabRun {
  readonly spec: LabRunSpec;
  readonly sim: Simulation;
  readonly organization: TraineeOrganization;
  /** The ordered unit's simulation id. */
  readonly unitId: string;
  /** The formation last commanded (the spec's, until an order changes it). */
  readonly formation: FormationSpec;
  /** Every command submitted, in order (with any added later by the lab). */
  readonly commands: SimCommand[];
  /** Where each command came from: the scenario's script (legs, disturbances) or the user. */
  readonly origins: CommandOrigin[];
  /** Soldier id holding an organization slot. */
  soldierOf(slotId: string): string | undefined;
  /** Submits a command and records it. */
  submit(command: SimCommand, origin?: CommandOrigin): void;
  /** One tick: scripted orders and disturbances due, then the step. Returns the tick's events. */
  step(): readonly SimEvent[];
  /** Whether the run has nothing left to do: every waypoint ordered and the last task ended. */
  readonly done: boolean;
  /** Index of the next waypoint to order. */
  readonly nextWaypoint: number;
}

/** Flat ground for lab runs: 2.4 km square, 10 m above the datum. */
export function labTerrain(): TerrainDataset {
  return createSyntheticTerrain(
    { originX: -1200, originY: -1200, cellSize: 40, columns: 61, rows: 61 },
    flatElevation(10),
  );
}

/** Starts a run: builds the organization, lays it out loosely at the start, orders the first waypoint. */
/** Who issued a command of a run. */
export type CommandOrigin = 'leg' | 'disturbance' | 'user';

/**
 * A run rebuilt from commands (replay, branching): these are submitted as
 * they are instead of the script's first leg and disturbances, and the
 * script's later legs continue from `legsIssued`.
 */
export interface LabReplay {
  readonly commands: readonly SimCommand[];
  readonly origins: readonly CommandOrigin[];
  readonly legsIssued: number;
}

export function createLabRun(
  spec: LabRunSpec,
  terrain: TerrainDataset = labTerrain(),
  replay?: LabReplay,
): LabRun {
  const template = LAB_ORGANIZATIONS[spec.organization];
  const root = template.units.find((u) => u.parentId === null)?.id ?? '';
  // Members fill slots in template order; ids by organization.
  const prefix = { element3: 'T', fireTeam: 'F', squad: 'M' }[spec.organization];
  const instance = {
    templateId: template.id,
    templateVersion: template.version,
    side: 'BLUEFOR' as const,
    unitIdPrefix: '',
    facingDeg: 0,
    posture: 'standing' as const,
    members: template.slots.map((slot, i) => ({
      soldierId: `${prefix}${String(i + 1).padStart(2, '0')}`,
      slotId: slot.id,
    })),
  };
  const organization: TraineeOrganization = {
    template,
    unitIdPrefix: '',
    members: instance.members,
  };
  const formation = buildFormationSpec(organization, root, spec.formation, {
    interval: spec.interval,
    elementSpacing: spec.elementSpacing,
  });
  // Loosely in formation at the start (facing north), each Marine a little off his slot (seeded).
  const flat = flattenFormation(formation);
  const meanBack = flat.back.reduce((a, b) => a + b, 0) / flat.back.length;
  const meanRight = flat.right.reduce((a, b) => a + b, 0) / flat.right.length;
  const startOf = (member: { soldierId: string }) => {
    const i = flat.soldierIds.indexOf(member.soldierId);
    // Up to 2 m off his slot, and never more than 15 % of the interval (no two start together).
    const jitter = Math.min(2, 0.15 * spec.interval);
    const jx = smoothNoise(spec.seed, i, 2, 0.5, 1) * jitter;
    const jy = smoothNoise(spec.seed, i, 3, 0.5, 1) * jitter;
    return {
      east: spec.start.x + ((flat.right[i] ?? 0) - meanRight) + jx,
      north: spec.start.y - ((flat.back[i] ?? 0) - meanBack) + jy,
    };
  };
  const built = instantiateOrganization(template, instance, startOf);
  const scenario: Scenario = {
    id: `behavior-lab-${spec.organization}`,
    terrain,
    movement: { speed: spec.pace, maxTurnRate: Math.PI / 2 },
    units: built.units,
    soldiers: built.soldiers,
    ...(spec.params ? { behavior: spec.params } : {}),
  };
  const sim = createSimulation({ tickRateHz: spec.tickRateHz, seed: spec.seed }, scenario);
  const unitId = orgUnitId(root);
  const centreBack = flat.back.reduce((a, b) => a + b, 0) / flat.back.length;
  const centreRight = flat.right.reduce((a, b) => a + b, 0) / flat.right.length;
  const ahead = Math.max(...flat.back.map((b) => centreBack - b));
  const halfWidth = Math.max(...flat.right.map((r) => Math.abs(r - centreRight)));
  const nextLegAt =
    ahead + halfWidth + (spec.params ?? DEFAULT_BEHAVIOR_PARAMS).cornerMargin + NEXT_LEG_MARGIN_M;
  const commands: SimCommand[] = [];
  const origins: CommandOrigin[] = [];
  const slotHolder = new Map(instance.members.map((m) => [m.slotId, m.soldierId]));
  let next = 0;
  /** The formation last ordered to the unit (later legs keep it), else the spec's. */
  const commanded = (): FormationSpec =>
    sim.state.behavior?.tasks.filter((t) => t.unitId === unitId).at(-1)?.order.formation ??
    formation;

  const submit = (command: SimCommand, origin: CommandOrigin = 'user') => {
    sim.submit(command);
    commands.push(command);
    origins.push(origin);
  };
  const orderLeg = (tick: number) => {
    const destination = spec.waypoints[next];
    if (!destination) return;
    submit(
      {
        type: 'orderUnit',
        tick,
        unitId,
        order: {
          kind: 'moveInFormation',
          destination,
          ...(next === 0 && spec.via ? { via: spec.via } : {}),
          formation: commanded(),
          pace: spec.pace,
        },
      },
      'leg',
    );
    next += 1;
  };
  if (replay) {
    replay.commands.forEach((c, i) => {
      submit(c, replay.origins[i] ?? 'user');
    });
    next = replay.legsIssued;
  } else {
    orderLeg(0);
    for (const d of spec.disturbances ?? []) {
      const id = slotHolder.get(d.slotId);
      if (id === undefined) continue;
      submit(
        {
          type: 'disturbAgent',
          tick: Math.round(d.atSeconds * spec.tickRateHz),
          soldierId: soldierId(id),
          disturbance: d.disturbance,
        },
        'disturbance',
      );
    }
  }

  const current = () =>
    sim.state.behavior?.tasks.find((t) => t.unitId === unitId && t.outcome === null);
  return {
    spec,
    sim,
    organization,
    unitId,
    get formation() {
      return commanded();
    },
    commands,
    origins,
    soldierOf: (slotId) => slotHolder.get(slotId),
    submit,
    step() {
      // The next waypoint, as the unit nears the end of this leg.
      const task = current();
      if (
        next > 0 &&
        next < spec.waypoints.length &&
        task &&
        (task.phase === 'settling' || task.route.length - task.anchorS < nextLegAt)
      ) {
        orderLeg(sim.tick);
      }
      return sim.step();
    },
    get done() {
      const tasks = sim.state.behavior?.tasks.filter((t) => t.unitId === unitId) ?? [];
      return (
        next >= spec.waypoints.length && tasks.length > 0 && tasks.every((t) => t.outcome !== null)
      );
    },
    get nextWaypoint() {
      return next;
    },
  };
}

/** The state hash at every whole second of a run (for replay checks). */
export function secondHashes(run: LabRun, seconds: number): string[] {
  const hashes: string[] = [];
  const rate = run.spec.tickRateHz;
  for (let tick = 0; tick < seconds * rate; tick += 1) {
    if (run.sim.tick % rate === 0) hashes.push(hashSimState(run.sim.state));
    run.step();
  }
  return hashes;
}
