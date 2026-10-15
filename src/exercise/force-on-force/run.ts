import {
  type ActionsOn,
  azimuthFromDegrees,
  azimuthOf,
  createSimulation,
  DEFAULT_BEHAVIOR_PARAMS,
  hashSimState,
  orgUnitId,
  type FofConfig,
  type FofForceSetup,
  type FofOutcome,
  type Scenario,
  type Side,
  type SimCommand,
  type SimEvent,
  type Simulation,
  type TerrainDataset,
  type VisibilityClass,
  type Vec2,
} from '#sim';
import { labTerrain, type LabOrganization } from '../behavior-lab/run';
import {
  FOF_DEFAULT_CONFIG,
  formationsForOrganization,
  instantiateForce,
  type SquadForce,
} from '../forces/forces';
import { urbanFeatures } from '../behavior-lab/urban';
import { woodsFeatures } from './woods';

// A Force-on-Force Lab run (docs/behavior-lab/force-on-force): the real
// simulation with two organizations, BLUEFOR and OPFOR, each on its own
// movement order, on open, wooded or urban ground, with the force-on-force
// model in the world. Everything that makes it is plain data (`FofRunSpec`):
// the same spec gives the same run. Headless: the lab page, the experiments
// and the sweeps all use it.

/** How long the lab plays on after the outcome while the forces carry on moving (s). */
export const CARRY_ON_SECONDS = 600;

export { FOF_DEFAULT_CONFIG, instantiateForce, weaponCategory } from '../forces/forces';
export type { ForceInstance } from '../forces/forces';

/** A force of a run: its organization and ids. */
export type FofRunForce = SquadForce;

/** The formations an organization of the lab can take. */
export const formationsForLab = formationsForOrganization;

export type FofTerrainKind = 'open' | 'wooded' | 'urban';
export const FOF_TERRAINS: readonly FofTerrainKind[] = ['open', 'wooded', 'urban'];

/** One side's organization, where it starts and where it is ordered. */
export interface FofForceSpec {
  readonly organization: LabOrganization;
  readonly formation: string;
  /** Its centre at the start. */
  readonly start: Vec2;
  /** Where it is ordered to (it faces there at the start); `null`: it stays, facing `facingDeg`. */
  readonly destination: Vec2 | null;
  readonly facingDeg?: number;
  /** Pace (m/s), individual interval and element spacing (m). */
  readonly pace: number;
  readonly interval: number;
  readonly elementSpacing: number;
  /** Start in this posture (default standing). */
  readonly posture?: 'standing' | 'kneeling' | 'prone';
  /** What it does on contact (default `continue`). */
  readonly actionsOn?: ActionsOn;
  /**
   * How many of the organization (default 1). More than one: copies under
   * one parent unit (`B-GRP` / `O-GRP`, no leader), in a block of
   * `ceil(√count)` abreast, `groupSpacingM` apart (default 60 m), each
   * copy in `formation`. Soldier ids get the copy's number (`B0105`).
   */
  readonly count?: number;
  readonly groupSpacingM?: number;
}

export interface FofRunSpec {
  readonly blufor: FofForceSpec;
  readonly opfor: FofForceSpec;
  readonly terrain: FofTerrainKind;
  /** Observation conditions; default: the terrain's own class. */
  readonly visibility?: VisibilityClass;
  readonly seed: number;
  readonly tickRateHz: number;
  /** The model's configuration; default `FOF_DEFAULT_CONFIG`. */
  readonly config?: FofConfig;
  /**
   * The movement engine's integration rate (Hz; default 120). Lower is
   * cheaper and less exact (docs/behavior-lab/force-on-force/04 §5.1).
   */
  readonly substepHz?: number;
}

/** Who issued a command: the run's own setup, or the user (the lab). */
export type FofCommandOrigin = 'setup' | 'user';

export interface FofRun {
  readonly spec: FofRunSpec;
  readonly sim: Simulation;
  readonly forces: readonly [FofRunForce, FofRunForce];
  readonly commands: SimCommand[];
  readonly origins: FofCommandOrigin[];
  submit(command: SimCommand, origin?: FofCommandOrigin): void;
  step(): readonly SimEvent[];
  /** The experiment has an outcome. */
  readonly done: boolean;
  /**
   * The experiment has an outcome and the forces have finished carrying on
   * (no movement order running), or `CARRY_ON_SECONDS` have passed since.
   */
  readonly settled: boolean;
  readonly outcome: FofOutcome | null;
}

export const LAB_ORGANIZATION_NAMES: Readonly<Record<LabOrganization, string>> = {
  element3: '3-Marine element',
  fireTeam: '4-Marine fire team',
  squad: '13-Marine squad',
};

/** The visibility class a terrain is observed under by default. */
export function defaultVisibility(terrain: FofTerrainKind): VisibilityClass {
  return terrain;
}

const terrains = new Map<string, TerrainDataset>();

/** The ground of a run (memoized: the same spec ground is the same object). */
export function fofTerrainFor(spec: FofRunSpec): TerrainDataset {
  if (spec.terrain === 'open') return labTerrain();
  const keepClear = [spec.blufor.start, spec.opfor.start];
  for (const d of [spec.blufor.destination, spec.opfor.destination]) if (d) keepClear.push(d);
  const key = JSON.stringify({ t: spec.terrain, seed: spec.seed, keepClear });
  const known = terrains.get(key);
  if (known) return known;
  const terrain = labTerrain(
    spec.terrain === 'urban'
      ? urbanFeatures({ seed: spec.seed, keepClear, clearRadius: 34 })
      : woodsFeatures({ seed: spec.seed, keepClear, clearRadius: 30 }),
  );
  terrains.set(key, terrain);
  if (terrains.size > 6) terrains.delete(terrains.keys().next().value ?? '');
  return terrain;
}

/** Commands to give instead of the setup's own orders (replay, branching). */
export interface FofReplay {
  readonly commands: readonly SimCommand[];
  readonly origins: readonly FofCommandOrigin[];
}

/**
 * Builds a run: both organizations loosely in formation at their starts, both
 * ordered at tick 0 (or, replaying, given `replay`'s commands instead).
 */
export function createFofRun(
  spec: FofRunSpec,
  terrain: TerrainDataset = fofTerrainFor(spec),
  replay?: FofReplay,
): FofRun {
  const config = spec.config ?? FOF_DEFAULT_CONFIG;
  const built = (['BLUEFOR', 'OPFOR'] as const).map((side) =>
    buildForce(side, side === 'BLUEFOR' ? spec.blufor : spec.opfor, spec.seed),
  );
  const [blue, red] = built;
  if (!blue || !red) throw new Error('force-on-force run needs two forces');
  const forceSetups: FofForceSetup[] = built.map((f) => ({
    unitId: f.force.unitId,
    side: f.force.side,
    weapons: f.force.weapons,
    formation: f.force.formation,
    pace: f.spec.pace,
    ...(f.spec.actionsOn !== undefined ? { actionsOn: f.spec.actionsOn } : {}),
    start: f.spec.start,
  }));
  const scenario: Scenario = {
    id: 'force-on-force-lab',
    terrain,
    movement: { speed: Math.max(spec.blufor.pace, spec.opfor.pace), maxTurnRate: Math.PI / 2 },
    units: [...blue.units, ...red.units],
    soldiers: [...blue.soldiers, ...red.soldiers],
    ...(spec.substepHz !== undefined
      ? { behavior: { ...DEFAULT_BEHAVIOR_PARAMS, substepHz: spec.substepHz } }
      : {}),
    fof: {
      config,
      visibility: spec.visibility ?? defaultVisibility(spec.terrain),
      forces: forceSetups,
    },
  };
  const sim = createSimulation({ tickRateHz: spec.tickRateHz, seed: spec.seed }, scenario);
  const commands: SimCommand[] = [];
  const origins: FofCommandOrigin[] = [];
  const submit = (command: SimCommand, origin: FofCommandOrigin = 'user') => {
    sim.submit(command);
    commands.push(command);
    origins.push(origin);
  };
  if (replay) {
    replay.commands.forEach((c, i) => {
      submit(c, replay.origins[i] ?? 'user');
    });
  }
  for (const f of replay ? [] : built) {
    if (!f.spec.destination) continue;
    submit(
      {
        type: 'orderUnit',
        tick: 0,
        unitId: orgUnitId(f.force.unitId),
        order: {
          kind: 'moveInFormation',
          destination: f.spec.destination,
          formation: f.force.formation,
          pace: f.spec.pace,
        },
      },
      'setup',
    );
  }
  return {
    spec,
    sim,
    forces: [blue.force, red.force],
    commands,
    origins,
    submit,
    step: () => sim.step(),
    get done() {
      return sim.state.fof?.outcome != null;
    },
    get settled() {
      const outcome = sim.state.fof?.outcome;
      if (!outcome) return false;
      const moving = sim.state.behavior?.tasks.some((t) => t.outcome === null) ?? false;
      return !moving || sim.timeSeconds >= outcome.atSeconds + CARRY_ON_SECONDS;
    },
    get outcome() {
      return sim.state.fof?.outcome ?? null;
    },
  };
}

/** A formation node with its slot ids (and its children's) prefixed: unique across copies. */
function buildForce(side: Side, spec: FofForceSpec, seed: number) {
  const prefix = side === 'BLUEFOR' ? 'B' : 'O';
  const heading = spec.destination
    ? azimuthOf(spec.destination.x - spec.start.x, spec.destination.y - spec.start.y)
    : azimuthFromDegrees(spec.facingDeg ?? 0);
  const built = instantiateForce({
    side,
    spec,
    seed,
    heading,
    salt: side === 'BLUEFOR' ? 0 : 50,
    groupId: `${prefix}-GRP`,
    unitIdPrefix: (k, grouped) => (grouped ? `${prefix}${String(k + 1)}-` : `${prefix}-`),
    soldierId: (k, i, grouped) =>
      grouped
        ? `${prefix}${String(k + 1).padStart(2, '0')}${String(i + 1).padStart(2, '0')}`
        : `${prefix}${String(i + 1).padStart(2, '0')}`,
  });
  return { ...built, spec };
}

/** The state hash at every whole second of a run (for replay checks). */
export function fofSecondHashes(run: FofRun, seconds: number): string[] {
  const hashes: string[] = [];
  const rate = run.spec.tickRateHz;
  for (let tick = 0; tick < seconds * rate && !run.done; tick += 1) {
    if (run.sim.tick % rate === 0) hashes.push(hashSimState(run.sim.state));
    run.step();
  }
  return hashes;
}
