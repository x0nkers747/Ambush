import {
  azimuthFromDegrees,
  azimuthOf,
  createSimulation,
  flattenFormation,
  hashSimState,
  orgUnitId,
  smoothNoise,
  validateFofConfig,
  type FofConfig,
  type FofForceSetup,
  type FofOutcome,
  type FormationSpec,
  type Scenario,
  type Side,
  type SimCommand,
  type SimEvent,
  type Simulation,
  type TerrainDataset,
  type VisibilityClass,
  type Vec2,
} from '#sim';
import { LAB_ORGANIZATIONS, labTerrain, type LabOrganization } from '../behavior-lab/run';
import { urbanFeatures } from '../behavior-lab/urban';
import {
  buildFormationSpec,
  formationsFor,
  type FormationTemplate,
} from '../formations/formations';
import {
  instantiateOrganization,
  type OrganizationTemplate,
  type TemplateSlot,
  type TraineeOrganization,
} from '../organization';
import defaultConfig from './fof-v1.json';
import { woodsFeatures } from './woods';

// A Force-on-Force Lab run (docs/behavior-lab/force-on-force): the real
// simulation with two organizations, BLUEFOR and OPFOR, each on its own
// movement order, on open, wooded or urban ground, with the force-on-force
// model in the world. Everything that makes it is plain data (`FofRunSpec`):
// the same spec gives the same run. Headless: the lab page, the experiments
// and the sweeps all use it.

/** The default experimental configuration (validated). */
export const FOF_DEFAULT_CONFIG: FofConfig = validateFofConfig(defaultConfig);

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
}

/** A force of a run: its organization and ids. */
export interface FofRunForce {
  readonly side: Side;
  readonly unitId: string;
  readonly organization: TraineeOrganization;
  readonly formation: FormationSpec;
  readonly soldierIds: readonly string[];
  /** Weapon category (simulation) and model (display) of each soldier. */
  readonly weapons: Readonly<Record<string, string | null>>;
  readonly displayWeapons: Readonly<Record<string, string | null>>;
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
  readonly outcome: FofOutcome | null;
}

export const LAB_ORGANIZATION_NAMES: Readonly<Record<LabOrganization, string>> = {
  element3: '3-Marine element',
  fireTeam: '4-Marine fire team',
  squad: '13-Marine squad',
};

/** The formations an organization of the lab can take. */
export function formationsForLab(organization: LabOrganization): readonly FormationTemplate[] {
  const template = LAB_ORGANIZATIONS[organization];
  const echelon = template.units.find((u) => u.parentId === null)?.echelon ?? '';
  return formationsFor(echelon, template.slots.length);
}

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

/** The simulation weapon category of a slot (from its primary weapon), or `null`. */
function weaponCategory(template: OrganizationTemplate, slot: TemplateSlot): string | null {
  const role = template.roles.find((r) => r.id === slot.roleId);
  const refs = (slot.loadout ?? role?.defaultLoadout)?.weaponProfileRefs ?? [];
  if (refs.includes('squad-automatic-weapon')) return 'automaticRifle';
  if (refs.some((r) => r.includes('rifle'))) return 'rifle';
  return null;
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
  }));
  const scenario: Scenario = {
    id: 'force-on-force-lab',
    terrain,
    movement: { speed: Math.max(spec.blufor.pace, spec.opfor.pace), maxTurnRate: Math.PI / 2 },
    units: [...blue.units, ...red.units],
    soldiers: [...blue.soldiers, ...red.soldiers],
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
    get outcome() {
      return sim.state.fof?.outcome ?? null;
    },
  };
}

function buildForce(side: Side, spec: FofForceSpec, seed: number) {
  const template = LAB_ORGANIZATIONS[spec.organization];
  const root = template.units.find((u) => u.parentId === null)?.id ?? '';
  const prefix = side === 'BLUEFOR' ? 'B' : 'O';
  const unitIdPrefix = `${prefix}-`;
  const members = template.slots.map((slot, i) => ({
    soldierId: `${prefix}${String(i + 1).padStart(2, '0')}`,
    slotId: slot.id,
  }));
  const organization: TraineeOrganization = { template, unitIdPrefix, members };
  const unitId = `${unitIdPrefix}${root}`;
  const formation = buildFormationSpec(organization, root, spec.formation, {
    interval: spec.interval,
    elementSpacing: spec.elementSpacing,
  });
  const heading = spec.destination
    ? azimuthOf(spec.destination.x - spec.start.x, spec.destination.y - spec.start.y)
    : azimuthFromDegrees(spec.facingDeg ?? 0);
  const flat = flattenFormation(formation);
  const meanBack = flat.back.reduce((a, b) => a + b, 0) / flat.back.length;
  const meanRight = flat.right.reduce((a, b) => a + b, 0) / flat.right.length;
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  const startOf = (member: { soldierId: string }) => {
    const i = flat.soldierIds.indexOf(member.soldierId);
    const jitter = Math.min(2, 0.15 * spec.interval);
    const salt = side === 'BLUEFOR' ? 0 : 50;
    const jx = smoothNoise(seed, i + salt, 2, 0.5, 1) * jitter;
    const jy = smoothNoise(seed, i + salt, 3, 0.5, 1) * jitter;
    const r = (flat.right[i] ?? 0) - meanRight;
    const b = (flat.back[i] ?? 0) - meanBack;
    // Right is (fy, −fx) of forward (fx, fy).
    return {
      east: spec.start.x + r * fy - b * fx + jx,
      north: spec.start.y - r * fx - b * fy + jy,
    };
  };
  const instance = {
    templateId: template.id,
    templateVersion: template.version,
    side,
    unitIdPrefix,
    facingDeg: (heading * 180) / Math.PI,
    posture: spec.posture ?? ('standing' as const),
    members,
  };
  const { units, soldiers } = instantiateOrganization(template, instance, startOf);
  const weapons: Record<string, string | null> = {};
  const displayWeapons: Record<string, string | null> = {};
  for (const m of members) {
    const slot = template.slots.find((s) => s.id === m.slotId);
    const category = slot ? weaponCategory(template, slot) : null;
    weapons[m.soldierId] = category;
    displayWeapons[m.soldierId] =
      category === null
        ? null
        : side === 'OPFOR'
          ? 'ak-assault-rifle'
          : category === 'automaticRifle'
            ? 'squad-automatic-weapon'
            : 'm16-rifle';
  }
  const force: FofRunForce = {
    side,
    unitId,
    organization,
    formation,
    soldierIds: members.map((m) => m.soldierId),
    weapons,
    displayWeapons,
  };
  return { force, units, soldiers, spec };
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
