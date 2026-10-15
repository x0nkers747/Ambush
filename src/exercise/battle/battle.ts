import {
  azimuthFromDegrees,
  createSimulation,
  DEFAULT_BEHAVIOR_PARAMS,
  orgUnitId,
  type FofConfig,
  type FofForceSetup,
  type OrderSpec,
  type Scenario,
  type ScenarioSoldier,
  type ScenarioUnit,
  type Side,
  type SimCommand,
  type SimEvent,
  type Simulation,
  type TerrainDataset,
  type Vec2,
  type VisibilityClass,
} from '#sim';
import {
  FOF_DEFAULT_CONFIG,
  formationsForOrganization,
  instantiateForce,
  type SquadForce,
  type SquadOrganization,
} from '../forces/forces';

// A battle (docs/constructive-simulation): squads of both sides on a
// battlefield, each with its own plan of orders, in one simulation. Each
// squad is a force of the force-on-force model, with its own picture of the
// enemy, contact behaviour and plan; the battle has no automatic end (the
// player ends it). Everything that makes a battle is plain data
// (`BattleSpec`): the same spec and commands give the same run.

/** A squad as the scenario defines it. */
export interface SquadSpec {
  /** Stable id (letters, digits, `-`): its units are `<id>-SQD`…, its soldiers `<id>-01`…. */
  readonly id: string;
  readonly name: string;
  readonly side: Side;
  readonly organization: SquadOrganization;
  /** Formation template id (default: the organization's first). */
  readonly formation?: string;
  /** Where its centre stands at the start, and the way it faces (degrees from north). */
  readonly position: { readonly x: number; readonly y: number };
  readonly facingDeg: number;
  readonly posture?: 'standing' | 'kneeling' | 'prone';
  /** Its initial plan (OPFOR's from the scenario, BLUEFOR's from planning). */
  readonly plan: readonly OrderSpec[];
}

export interface BattleSpec {
  readonly squads: readonly SquadSpec[];
  readonly seed: number;
  readonly tickRateHz: number;
  /** Observation conditions; default `open` (clear air). */
  readonly visibility?: VisibilityClass;
  /** The model's configuration; default the lab's `FOF_DEFAULT_CONFIG`. */
  readonly config?: FofConfig;
  /** The movement engine's integration rate (Hz); default 120. */
  readonly substepHz?: number;
}

/** Spacing and pace of an organization's formation (m, m/s). */
const LAYOUT: Readonly<
  Record<SquadOrganization, { interval: number; elementSpacing: number; pace: number }>
> = {
  squad: { interval: 10, elementSpacing: 20, pace: 1.4 },
  fireTeam: { interval: 8, elementSpacing: 16, pace: 1.4 },
  element3: { interval: 6, elementSpacing: 12, pace: 1.4 },
};

/** A squad of a battle: its spec and what it is in the simulation. */
export interface BattleSquad extends SquadForce {
  readonly spec: SquadSpec;
  readonly name: string;
}

/** Who issued a command: the battle's own setup, or the player. */
export type BattleCommandOrigin = 'setup' | 'user';

export interface Battle {
  readonly spec: BattleSpec;
  readonly sim: Simulation;
  readonly squads: readonly BattleSquad[];
  /** Every command submitted, in order, and who gave it. */
  readonly commands: SimCommand[];
  readonly origins: BattleCommandOrigin[];
  submit(command: SimCommand, origin?: BattleCommandOrigin): void;
  step(): readonly SimEvent[];
}

/** Commands to give (replay, branching): every command of an earlier run. */
export interface BattleReplay {
  readonly commands: readonly SimCommand[];
  readonly origins: readonly BattleCommandOrigin[];
}

/** Throws an Error naming the first problem of a battle spec's squads (ids, organizations, formations). */
export function validateBattleSpec(spec: BattleSpec): void {
  const ids = new Set<string>();
  for (const squad of spec.squads) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(squad.id)) {
      throw new Error(`squad id "${squad.id}" must be letters and digits, starting with a letter`);
    }
    if (ids.has(squad.id)) throw new Error(`squad id "${squad.id}" is used twice`);
    ids.add(squad.id);
    const formations = formationsForOrganization(squad.organization);
    if (formations.length === 0) throw new Error(`unknown organization "${squad.organization}"`);
    if (squad.formation !== undefined && !formations.some((f) => f.id === squad.formation)) {
      throw new Error(
        `squad "${squad.id}": no formation "${squad.formation}" for its organization`,
      );
    }
  }
}

/** The units, soldiers and force of one squad. */
function buildSquad(spec: SquadSpec, index: number, seed: number) {
  const layout = LAYOUT[spec.organization];
  const formation = spec.formation ?? formationsForOrganization(spec.organization)[0]?.id ?? '';
  const built = instantiateForce({
    side: spec.side,
    spec: {
      organization: spec.organization,
      formation,
      interval: layout.interval,
      elementSpacing: layout.elementSpacing,
      start: spec.position,
      ...(spec.posture ? { posture: spec.posture } : {}),
    },
    seed,
    heading: azimuthFromDegrees(spec.facingDeg),
    salt: 50 * index,
    groupId: `${spec.id}-GRP`,
    unitIdPrefix: () => `${spec.id}-`,
    soldierId: (_, i) => `${spec.id}-${String(i + 1).padStart(2, '0')}`,
  });
  const squad: BattleSquad = { ...built.force, spec, name: spec.name };
  return { squad, units: built.units, soldiers: built.soldiers, pace: layout.pace };
}

/**
 * Where a squad's soldiers start, as a battle lays it out when it is squad
 * `index` of the spec (the index varies the small jitter of the starts).
 */
export function squadSoldierStarts(
  spec: SquadSpec,
  index: number,
  seed: number,
): { readonly id: string; readonly position: Vec2 }[] {
  return buildSquad(spec, index, seed).soldiers.map((s) => ({ id: s.id, position: s.position }));
}

/** The simulation scenario of a battle on `terrain`. */
export function battleScenario(
  spec: BattleSpec,
  terrain: TerrainDataset,
): { scenario: Scenario; squads: BattleSquad[] } {
  validateBattleSpec(spec);
  const built = spec.squads.map((s, i) => buildSquad(s, i, spec.seed));
  const units: ScenarioUnit[] = built.flatMap((b) => b.units);
  const soldiers: ScenarioSoldier[] = built.flatMap((b) => b.soldiers);
  const forces: FofForceSetup[] = built.map((b) => ({
    unitId: b.squad.unitId,
    side: b.squad.side,
    name: b.squad.name,
    weapons: b.squad.weapons,
    formation: b.squad.formation,
    pace: b.pace,
    start: b.squad.spec.position,
    plan: b.squad.spec.plan,
  }));
  const speed = Math.max(1.4, ...built.map((b) => b.pace));
  const scenario: Scenario = {
    id: 'battle',
    terrain,
    movement: { speed, maxTurnRate: Math.PI / 2 },
    units,
    soldiers,
    ...(spec.substepHz !== undefined
      ? { behavior: { ...DEFAULT_BEHAVIOR_PARAMS, substepHz: spec.substepHz } }
      : {}),
    fof: {
      config: spec.config ?? FOF_DEFAULT_CONFIG,
      visibility: spec.visibility ?? 'open',
      forces,
      termination: 'manual',
    },
  };
  return { scenario, squads: built.map((b) => b.squad) };
}

/**
 * A battle on `terrain`: the simulation of its squads, each starting on its
 * plan. Replaying, `replay`'s commands are given instead (they hold every
 * command of the earlier run, from tick 0).
 */
export function createBattle(
  spec: BattleSpec,
  terrain: TerrainDataset,
  replay?: BattleReplay,
): Battle {
  const { scenario, squads } = battleScenario(spec, terrain);
  const sim = createSimulation({ tickRateHz: spec.tickRateHz, seed: spec.seed }, scenario);
  const commands: SimCommand[] = [];
  const origins: BattleCommandOrigin[] = [];
  const submit = (command: SimCommand, origin: BattleCommandOrigin = 'user') => {
    sim.submit(command);
    commands.push(command);
    origins.push(origin);
  };
  replay?.commands.forEach((c, i) => {
    submit(c, replay.origins[i] ?? 'user');
  });
  return {
    spec,
    sim,
    squads,
    commands,
    origins,
    submit,
    step: () => sim.step(),
  };
}

/** The `orderSquad` command giving `squad` these orders (replacing or after its plan) now. */
export function orderSquad(
  battle: Battle,
  squadId: string,
  mode: 'replace' | 'append',
  orders: readonly OrderSpec[],
): SimCommand {
  const squad = battle.squads.find((s) => s.spec.id === squadId);
  if (!squad) throw new Error(`no squad "${squadId}"`);
  return {
    type: 'orderSquad',
    tick: battle.sim.tick,
    unitId: orgUnitId(squad.unitId),
    mode,
    orders,
  };
}
