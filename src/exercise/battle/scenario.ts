import {
  azimuthOf,
  isOnTerrain,
  nearestClearPoint,
  ORDER_KINDS,
  planPath,
  pointProblem,
  terrainModelId,
  type OrderKind,
  type Side,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import {
  formationsForOrganization,
  SQUAD_ORGANIZATIONS,
  type SquadOrganization,
} from '../forces/forces';
import { describePathProblem } from '../routes';
import {
  parseScenarioDefinition,
  SCENARIO_SCHEMA,
  type ScenarioDefinition,
} from '../scenario-definition';
import type { MapPoint } from '../deployment';
import {
  battleScenario,
  CLEAR_START_SEARCH_M,
  squadSoldierStarts,
  type BattleSpec,
  type ClearedStart,
} from './battle';

// Battle scenarios (docs/constructive-simulation/03): what Scenario Setup
// and BLUEFOR Planning make on a battlefield. A scenario is any number of
// squads of both sides, each placed, facing a way, with its plan of orders
// (OPFOR's from Scenario Setup, BLUEFOR's from planning). It is plain data,
// saved with the battlefield (schema `ambush.scenario` version 2); a
// version 1 scenario (the ambush: an ORP and an OPFOR patrol on a route) is
// migrated when read. `battleSpecOf` turns it into the battle the Combat
// stage runs.
//
// Edits return a new definition, or the reason they were refused (the
// definition unchanged). A soldier whose start would be in water or in a
// building stands on the nearest clear ground instead, the rest of his
// squad where its formation puts them (the battle lays the squads out so,
// `clearStarts`); a destination in water or a building is moved out of it.
// Edits that move soldiers so say so in a note. Only a placement off the
// map, or with no clear ground near, is refused. `scenarioIssues` lists what still stops a
// scenario from being played; edits never refuse what only that would
// report, so work in progress can be saved.

export const BATTLE_SCHEMA_VERSION = 2;

/** An order of a plan, as the scenario holds it. */
export interface PlannedOrder {
  readonly kind: OrderKind;
  readonly destination: MapPoint;
}

export interface ScenarioSquad {
  /** Stable id: letters and digits (`B1`, `O2`…); its soldiers are `<id>-01`…. */
  readonly id: string;
  readonly name: string;
  readonly side: Side;
  readonly organization: SquadOrganization;
  /** Formation template id (absent: the organization's first). */
  readonly formation?: string;
  /** Where its centre stands at the start. */
  readonly position: MapPoint;
  /** The way it faces at the start, degrees clockwise from north. */
  readonly facingDeg: number;
  readonly plan: readonly PlannedOrder[];
}

export interface BattleScenarioDefinition {
  readonly schema: typeof SCENARIO_SCHEMA;
  readonly schemaVersion: typeof BATTLE_SCHEMA_VERSION;
  readonly id: string;
  /** The battlefield it belongs to; its coordinates are that battlefield's local metres. */
  readonly battlefieldId: string;
  readonly name: string;
  /** The model of the ground it was made on (`terrainModelId`); absent when unknown. */
  readonly terrainModel?: string;
  /** The battle's random seed. */
  readonly seed: number;
  readonly squads: readonly ScenarioSquad[];
}

export type BattleEdit =
  | {
      readonly ok: true;
      readonly definition: BattleScenarioDefinition;
      /** What the edit did beyond what was asked (e.g. moved a squad out of a building), to tell the user. */
      readonly note?: string;
    }
  | { readonly ok: false; readonly problem: string };

const ok = (definition: BattleScenarioDefinition): BattleEdit => ({ ok: true, definition });
const refused = (problem: string): BattleEdit => ({ ok: false, problem });

export const ORGANIZATION_LABELS: Readonly<Record<SquadOrganization, string>> = {
  squad: 'Squad',
  fireTeam: 'Fire team',
  element3: 'Element',
};

export const ORDER_LABELS: Readonly<Record<OrderKind, string>> = {
  move: 'Move',
  attack: 'Attack',
  withdraw: 'Withdraw',
};

/** The id of a battlefield's battle scenario (one per battlefield; the ambush's is `<id>/1`). */
export const battleScenarioId = (battlefieldId: string): string => `${battlefieldId}/battle`;

/** A new scenario on a battlefield: no squads yet. */
export function newBattleScenario(
  terrain: TerrainDataset,
  battlefieldId: string,
  name = 'Scenario 1',
): BattleScenarioDefinition {
  return {
    schema: SCENARIO_SCHEMA,
    schemaVersion: BATTLE_SCHEMA_VERSION,
    id: battleScenarioId(battlefieldId),
    battlefieldId,
    name,
    terrainModel: terrainModelId(terrain),
    seed: 1,
    squads: [],
  };
}

const toVec = (p: MapPoint): Vec2 => ({ x: p.east, y: p.north });
const toPoint = (p: Vec2): MapPoint => ({ east: p.x, north: p.y });
const degreesToward = (from: MapPoint, to: MapPoint): number => {
  const deg = (azimuthOf(to.east - from.east, to.north - from.north) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
};

/**
 * A version 1 (ambush) scenario as a battle scenario: the trainee's squad
 * at the ORP becomes BLUEFOR's 1st Squad, with no plan yet (BLUEFOR
 * Planning gives it one); the OPFOR patrol becomes a three-man OPFOR
 * element where its route starts, with a Move order to each later point of
 * the route. Both face the other side's start.
 */
export function migrateAmbushScenario(v1: ScenarioDefinition): BattleScenarioDefinition {
  const squads: ScenarioSquad[] = [];
  const [start, ...route] = v1.opfor.route;
  if (v1.orp) {
    squads.push({
      id: 'B1',
      name: '1st Squad',
      side: 'BLUEFOR',
      organization: 'squad',
      position: v1.orp,
      facingDeg: start ? degreesToward(v1.orp, start) : 0,
      plan: [],
    });
  }
  if (start) {
    const toward = route[0] ?? v1.orp;
    squads.push({
      id: 'O1',
      name: 'Enemy patrol',
      side: 'OPFOR',
      organization: 'element3',
      position: start,
      facingDeg: toward ? degreesToward(start, toward) : 180,
      plan: route.map((destination) => ({ kind: 'move', destination })),
    });
  }
  return {
    schema: SCENARIO_SCHEMA,
    schemaVersion: BATTLE_SCHEMA_VERSION,
    id: battleScenarioId(v1.battlefieldId),
    battlefieldId: v1.battlefieldId,
    name: v1.name,
    ...(v1.terrainModel !== undefined ? { terrainModel: v1.terrainModel } : {}),
    seed: 1,
    squads,
  };
}

export class BattleScenarioError extends Error {
  override name = 'BattleScenarioError';
}

/**
 * Reads a stored scenario of either version: version 2 is checked, version
 * 1 is checked and migrated (`migrateAmbushScenario`). Throws a
 * `BattleScenarioError` saying what is wrong.
 */
export function parseBattleScenario(data: unknown): BattleScenarioDefinition {
  const fail = (message: string): never => {
    throw new BattleScenarioError(`Scenario not loaded: ${message}.`);
  };
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return fail('the data is not an object');
  const d = data as Record<string, unknown>;
  if (d['schema'] !== SCENARIO_SCHEMA) fail(`the schema is not "${SCENARIO_SCHEMA}"`);
  if (d['schemaVersion'] === 1) {
    try {
      return migrateAmbushScenario(parseScenarioDefinition(data));
    } catch (error) {
      return fail(
        error instanceof Error
          ? error.message.replace(/^Scenario not loaded: |\.$/g, '')
          : String(error),
      );
    }
  }
  if (d['schemaVersion'] !== BATTLE_SCHEMA_VERSION) {
    fail(`schema version ${JSON.stringify(d['schemaVersion'])} is not supported`);
  }
  for (const key of ['id', 'battlefieldId', 'name']) {
    if (typeof d[key] !== 'string' || d[key] === '') fail(`"${key}" is missing`);
  }
  const seed = d['seed'];
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    fail('the seed is not an integer from 0 to 4294967295');
  }
  const point = (v: unknown, what: string): MapPoint => {
    const p = v as { east?: unknown; north?: unknown } | null;
    if (
      !p ||
      typeof p.east !== 'number' ||
      typeof p.north !== 'number' ||
      !Number.isFinite(p.east) ||
      !Number.isFinite(p.north)
    ) {
      return fail(`${what} is not a map point`);
    }
    return { east: p.east, north: p.north };
  };
  if (!Array.isArray(d['squads'])) return fail('"squads" is missing');
  const ids = new Set<string>();
  const squads = (d['squads'] as unknown[]).map((raw, i): ScenarioSquad => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const what = `squad ${String(i + 1)}`;
    const id = s['id'];
    if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(id))
      return fail(`${what} has no valid id`);
    if (ids.has(id)) fail(`squad id "${id}" is used twice`);
    ids.add(id);
    const name = s['name'];
    if (typeof name !== 'string' || name.trim() === '') return fail(`${what} has no name`);
    const side = s['side'];
    if (side !== 'BLUEFOR' && side !== 'OPFOR')
      return fail(`${what}'s side is not BLUEFOR or OPFOR`);
    const organization = s['organization'];
    if (typeof organization !== 'string' || !(organization in SQUAD_ORGANIZATIONS))
      return fail(`${what}'s organization is unknown`);
    const org = organization as SquadOrganization;
    const formation = s['formation'];
    if (
      formation !== undefined &&
      (typeof formation !== 'string' ||
        !formationsForOrganization(org).some((f) => f.id === formation))
    )
      fail(`${what}'s formation is unknown`);
    const facing = s['facingDeg'];
    if (typeof facing !== 'number' || !Number.isFinite(facing))
      return fail(`${what}'s facing is not a number`);
    if (!Array.isArray(s['plan'])) return fail(`${what} has no plan`);
    const plan = (s['plan'] as unknown[]).map((rawOrder, k): PlannedOrder => {
      const o = (rawOrder ?? {}) as Record<string, unknown>;
      const kind = o['kind'];
      if (typeof kind !== 'string' || !(ORDER_KINDS as readonly string[]).includes(kind))
        return fail(`${what}, order ${String(k + 1)}: the kind is unknown`);
      return {
        kind: kind as OrderKind,
        destination: point(o['destination'], `${what}, order ${String(k + 1)}'s destination`),
      };
    });
    return {
      id,
      name,
      side,
      organization: org,
      ...(typeof formation === 'string' ? { formation } : {}),
      position: point(s['position'], `${what}'s position`),
      facingDeg: facing,
      plan,
    };
  });
  return {
    schema: SCENARIO_SCHEMA,
    schemaVersion: BATTLE_SCHEMA_VERSION,
    id: d['id'] as string,
    battlefieldId: d['battlefieldId'] as string,
    name: d['name'] as string,
    ...(typeof d['terrainModel'] === 'string' ? { terrainModel: d['terrainModel'] } : {}),
    seed: seed as number,
    squads,
  };
}

// --- Squads -----------------------------------------------------------------

const ORDINALS = ['1st', '2nd', '3rd'];
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${String(n)}th`;

/** A new squad's id and name: the first free `B<n>` / `O<n>`, named by side and organization. */
function newSquadIdentity(
  d: BattleScenarioDefinition,
  side: Side,
  organization: SquadOrganization,
): { id: string; name: string } {
  const prefix = side === 'BLUEFOR' ? 'B' : 'O';
  let n = 1;
  while (d.squads.some((s) => s.id === `${prefix}${String(n)}`)) n += 1;
  const label = ORGANIZATION_LABELS[organization];
  return {
    id: `${prefix}${String(n)}`,
    name:
      side === 'BLUEFOR' ? `${ordinal(n)} ${label}` : `Enemy ${label.toLowerCase()} ${String(n)}`,
  };
}

const squadOf = (d: BattleScenarioDefinition, id: string) => d.squads.find((s) => s.id === id);
const withSquad = (
  d: BattleScenarioDefinition,
  id: string,
  change: (s: ScenarioSquad) => ScenarioSquad,
): BattleScenarioDefinition => ({
  ...d,
  squads: d.squads.map((s) => (s.id === id ? change(s) : s)),
});

/** Why a squad's centre cannot be at `point`, or `null` (its soldiers' spots are checked by `scenarioIssues`). */
export function squadPlacementProblem(terrain: TerrainDataset, point: Vec2): string | null {
  if (!isOnTerrain(terrain, point.x, point.y)) return 'A squad must be on the map.';
  const problem = pointProblem(terrain, point);
  return problem ? `A squad cannot stand there: it is ${describePathProblem(problem)}.` : null;
}

/** The squad spec of `squad` standing at `point` (for laying out its soldiers). */
const specAt = (squad: Omit<ScenarioSquad, 'position'>, point: Vec2) => ({
  id: squad.id,
  name: squad.name,
  side: squad.side,
  organization: squad.organization,
  ...(squad.formation !== undefined ? { formation: squad.formation } : {}),
  position: point,
  facingDeg: squad.facingDeg,
  plan: [],
});

/** What a placement moved soldiers or a destination off: "out of the water", "clear of the buildings". */
function clearedWhat(kinds: ReadonlySet<'water' | 'building'>): string {
  if (kinds.has('water'))
    return kinds.has('building') ? 'out of water and clear of buildings' : 'out of the water';
  return 'clear of the buildings';
}

/**
 * Where squad `index` of `d` (as `squad` would make it) has its soldiers
 * start, each one who would stand in water or a building moved clear
 * (`clearStarts`), and a note saying how many were.
 */
function squadStarts(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  squad: ScenarioSquad,
  index: number,
): { readonly starts: readonly ClearedStart[]; readonly note?: string } {
  const starts = squadSoldierStarts(specAt(squad, toVec(squad.position)), index, d.seed, terrain);
  const moved = starts.filter((m) => m.movedFrom !== null);
  if (moved.length === 0) return { starts };
  const kinds = new Set(moved.flatMap((m) => (m.movedFrom ? [m.movedFrom] : [])));
  const who =
    moved.length === starts.length
      ? `All ${String(starts.length)} of ${squad.name}'s soldiers were`
      : moved.length === 1
        ? `1 of ${squad.name}'s soldiers was`
        : `${String(moved.length)} of ${squad.name}'s soldiers were`;
  return { starts, note: `${who} moved ${clearedWhat(kinds)}.` };
}

/** An edit of squad `id`, with the note of its soldiers moved clear (if any). */
function squadEdit(terrain: TerrainDataset, d: BattleScenarioDefinition, id: string): BattleEdit {
  const index = d.squads.findIndex((s) => s.id === id);
  const squad = d.squads[index];
  const note = squad ? squadStarts(terrain, d, squad, index).note : undefined;
  return { ok: true, definition: d, ...(note !== undefined ? { note } : {}) };
}

/**
 * Squad `index` of `d` standing at its position: refused off the map, or
 * where some of its soldiers would have no clear ground near them;
 * otherwise accepted, those in water or a building moved clear.
 */
function placedSquad(terrain: TerrainDataset, d: BattleScenarioDefinition, id: string): BattleEdit {
  const index = d.squads.findIndex((s) => s.id === id);
  const squad = d.squads[index];
  if (!squad) return refused(`There is no squad ${id}.`);
  const { east, north } = squad.position;
  if (!isOnTerrain(terrain, east, north)) return refused('A squad must be on the map.');
  const { starts } = squadStarts(terrain, d, squad, index);
  const stuck = starts.filter((m) => m.stuck).length;
  if (stuck > 0)
    return refused(
      `There is no clear ground within ${String(CLEAR_START_SEARCH_M)} m for ${String(stuck)} of ${squad.name}'s soldiers there: they would stand in water, in a building or off the map.`,
    );
  return squadEdit(terrain, d, id);
}

/** Adds a squad at `point`, facing `facingDeg` (default: toward the nearest enemy squad, else north for BLUEFOR, south for OPFOR). */
export function addSquad(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  side: Side,
  organization: SquadOrganization,
  point: Vec2,
  facingDeg?: number,
): BattleEdit & { readonly squadId?: string } {
  if (!isOnTerrain(terrain, point.x, point.y)) return refused('A squad must be on the map.');
  const { id, name } = newSquadIdentity(d, side, organization);
  const enemy = d.squads
    .filter((s) => s.side !== side)
    .sort(
      (a, b) =>
        Math.hypot(a.position.east - point.x, a.position.north - point.y) -
        Math.hypot(b.position.east - point.x, b.position.north - point.y),
    )[0];
  const facing = Math.round(
    facingDeg ??
      (enemy ? degreesToward(toPoint(point), enemy.position) : side === 'BLUEFOR' ? 0 : 180),
  );
  const squad: ScenarioSquad = {
    id,
    name,
    side,
    organization,
    position: toPoint(point),
    facingDeg: facing,
    plan: [],
  };
  const placed = placedSquad(terrain, { ...d, squads: [...d.squads, squad] }, id);
  return placed.ok ? { ...placed, squadId: id } : placed;
}

export function moveSquad(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  id: string,
  point: Vec2,
): BattleEdit {
  if (!squadOf(d, id)) return refused(`There is no squad ${id}.`);
  return placedSquad(
    terrain,
    withSquad(d, id, (s) => ({ ...s, position: toPoint(point) })),
    id,
  );
}

/**
 * Turns a squad to face `facingDeg` (degrees from north; kept in [0, 360)).
 * Soldiers the turn puts in water or a building are moved clear (with a note).
 */
export function setSquadFacing(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  id: string,
  facingDeg: number,
): BattleEdit {
  if (!squadOf(d, id)) return refused(`There is no squad ${id}.`);
  if (!Number.isFinite(facingDeg)) return refused('The facing must be a number of degrees.');
  const facing = ((Math.round(facingDeg) % 360) + 360) % 360;
  return squadEdit(
    terrain,
    withSquad(d, id, (s) => ({ ...s, facingDeg: facing })),
    id,
  );
}

/** Turns a squad to face a map point (`setSquadFacing`). */
export function faceSquadToward(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  id: string,
  point: Vec2,
): BattleEdit {
  const squad = squadOf(d, id);
  if (!squad) return refused(`There is no squad ${id}.`);
  if (Math.hypot(point.x - squad.position.east, point.y - squad.position.north) < 1) return ok(d);
  return setSquadFacing(terrain, d, id, degreesToward(squad.position, toPoint(point)));
}

export function renameSquad(d: BattleScenarioDefinition, id: string, name: string): BattleEdit {
  if (!squadOf(d, id)) return refused(`There is no squad ${id}.`);
  const trimmed = name.trim();
  if (trimmed === '') return refused('A squad needs a name.');
  if (trimmed.length > 40) return refused('A squad name is at most 40 characters.');
  return ok(withSquad(d, id, (s) => ({ ...s, name: trimmed })));
}

/**
 * Changes a squad's organization (its formation back to the organization's
 * first). Soldiers then in water or a building are moved clear (with a note).
 */
export function setSquadOrganization(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  id: string,
  organization: SquadOrganization,
): BattleEdit {
  if (!squadOf(d, id)) return refused(`There is no squad ${id}.`);
  if (!(organization in SQUAD_ORGANIZATIONS)) return refused('Unknown organization.');
  const next = withSquad(d, id, (s) => {
    const rest = { ...s };
    delete rest.formation;
    return { ...rest, organization };
  });
  return squadEdit(terrain, next, id);
}

/** Changes a squad's formation; soldiers then in water or a building are moved clear (with a note). */
export function setSquadFormation(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  id: string,
  formation: string,
): BattleEdit {
  const squad = squadOf(d, id);
  if (!squad) return refused(`There is no squad ${id}.`);
  if (!formationsForOrganization(squad.organization).some((f) => f.id === formation))
    return refused(
      `A ${ORGANIZATION_LABELS[squad.organization].toLowerCase()} has no formation "${formation}".`,
    );
  return squadEdit(
    terrain,
    withSquad(d, id, (s) => ({ ...s, formation })),
    id,
  );
}

export function deleteSquad(d: BattleScenarioDefinition, id: string): BattleEdit {
  if (!squadOf(d, id)) return refused(`There is no squad ${id}.`);
  return ok({ ...d, squads: d.squads.filter((s) => s.id !== id) });
}

// --- Plans ------------------------------------------------------------------

/** Why an order's destination cannot be `point`, or `null`. */
export function destinationProblem(terrain: TerrainDataset, point: Vec2): string | null {
  if (!isOnTerrain(terrain, point.x, point.y)) return 'A destination must be on the map.';
  const problem = pointProblem(terrain, point);
  return problem ? `The destination is ${describePathProblem(problem)}.` : null;
}

/**
 * Where a destination given at `point` ends up: `point` when a soldier can
 * stand there, otherwise the nearest point out of the water or building
 * (`nearestClearPoint`), with a note; or why there is none.
 */
function placeDestination(
  terrain: TerrainDataset,
  point: Vec2,
): { readonly point: Vec2; readonly note?: string } | { readonly problem: string } {
  if (!isOnTerrain(terrain, point.x, point.y))
    return { problem: 'A destination must be on the map.' };
  const problem = pointProblem(terrain, point);
  if (!problem) return { point };
  const clear = nearestClearPoint(terrain, point, undefined, CLEAR_START_SEARCH_M);
  if (!clear)
    return {
      problem:
        `${destinationProblem(terrain, point) ?? ''} There is no clear ground near it.`.trim(),
    };
  const moved = Math.round(Math.hypot(clear.x - point.x, clear.y - point.y));
  return {
    point: clear,
    note: `The destination was moved ${String(moved)} m, ${clearedWhat(new Set([problem.kind === 'inWater' ? 'water' : 'building']))}.`,
  };
}

/** Adds an order to a squad's plan: at the end, or before order `index`. */
export function addOrder(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  id: string,
  kind: OrderKind,
  point: Vec2,
  index?: number,
): BattleEdit {
  const squad = squadOf(d, id);
  if (!squad) return refused(`There is no squad ${id}.`);
  const placed = placeDestination(terrain, point);
  if ('problem' in placed) return refused(placed.problem);
  const at =
    index === undefined ? squad.plan.length : Math.max(0, Math.min(index, squad.plan.length));
  const order: PlannedOrder = { kind, destination: toPoint(placed.point) };
  return {
    ok: true,
    definition: withSquad(d, id, (s) => ({
      ...s,
      plan: [...s.plan.slice(0, at), order, ...s.plan.slice(at)],
    })),
    ...(placed.note !== undefined ? { note: placed.note } : {}),
  };
}

const orderAt = (d: BattleScenarioDefinition, id: string, index: number) =>
  squadOf(d, id)?.plan[index];

export function moveOrder(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  id: string,
  index: number,
  point: Vec2,
): BattleEdit {
  if (!orderAt(d, id, index)) return refused('There is no such order.');
  const placed = placeDestination(terrain, point);
  if ('problem' in placed) return refused(placed.problem);
  return {
    ok: true,
    definition: withSquad(d, id, (s) => ({
      ...s,
      plan: s.plan.map((o, k) => (k === index ? { ...o, destination: toPoint(placed.point) } : o)),
    })),
    ...(placed.note !== undefined ? { note: placed.note } : {}),
  };
}

export function setOrderKind(
  d: BattleScenarioDefinition,
  id: string,
  index: number,
  kind: OrderKind,
): BattleEdit {
  if (!orderAt(d, id, index)) return refused('There is no such order.');
  if (!ORDER_KINDS.includes(kind)) return refused('Unknown order kind.');
  return ok(
    withSquad(d, id, (s) => ({
      ...s,
      plan: s.plan.map((o, k) => (k === index ? { ...o, kind } : o)),
    })),
  );
}

export function deleteOrder(d: BattleScenarioDefinition, id: string, index: number): BattleEdit {
  if (!orderAt(d, id, index)) return refused('There is no such order.');
  return ok(withSquad(d, id, (s) => ({ ...s, plan: s.plan.filter((_, k) => k !== index) })));
}

/** Moves order `index` one place earlier (`-1`) or later (`+1`) in the plan. */
export function reorderOrder(
  d: BattleScenarioDefinition,
  id: string,
  index: number,
  by: -1 | 1,
): BattleEdit {
  const squad = squadOf(d, id);
  const to = index + by;
  if (!squad?.plan[index] || to < 0 || to >= squad.plan.length)
    return refused('The order cannot move there.');
  const plan = [...squad.plan];
  const [order] = plan.splice(index, 1);
  if (order) plan.splice(to, 0, order);
  return ok(withSquad(d, id, (s) => ({ ...s, plan })));
}

export function clearPlan(d: BattleScenarioDefinition, id: string): BattleEdit {
  if (!squadOf(d, id)) return refused(`There is no squad ${id}.`);
  return ok(withSquad(d, id, (s) => ({ ...s, plan: [] })));
}

export function setSeed(d: BattleScenarioDefinition, seed: number): BattleEdit {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    return refused('The seed is an integer from 0 to 4294967295.');
  return ok({ ...d, seed });
}

// --- Checks -----------------------------------------------------------------

/** Something that stops a scenario from being played, and where. */
export interface ScenarioIssue {
  readonly squadId: string | null;
  /** The order it is about (index in the squad's plan), or `null` for the squad itself. */
  readonly orderIndex: number | null;
  readonly message: string;
}

/** The battle a scenario makes (`createBattle`'s spec). */
export function battleSpecOf(d: BattleScenarioDefinition, tickRateHz: number): BattleSpec {
  return {
    seed: d.seed,
    tickRateHz,
    squads: d.squads.map((s) => ({
      id: s.id,
      name: s.name,
      side: s.side,
      organization: s.organization,
      ...(s.formation !== undefined ? { formation: s.formation } : {}),
      position: toVec(s.position),
      facingDeg: s.facingDeg,
      plan: s.plan.map((o) => ({ kind: o.kind, destination: toVec(o.destination) })),
    })),
  };
}

/** Where each soldier of each squad starts, by squad id (as the battle lays them out). */
export function soldierStarts(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
): ReadonlyMap<string, readonly { readonly id: string; readonly position: Vec2 }[]> {
  const starts = new Map<string, { id: string; position: Vec2 }[]>();
  if (d.squads.length === 0) return starts;
  const { scenario } = battleScenario(battleSpecOf(d, 30), terrain);
  for (const soldier of scenario.soldiers) {
    const squadId = soldier.id.split('-')[0] ?? '';
    const list = starts.get(squadId) ?? [];
    list.push({ id: soldier.id, position: soldier.position });
    starts.set(squadId, list);
  }
  return starts;
}

/**
 * What stops the scenario from being played: a side with no squad; a
 * soldier whose starting spot is in water, a building or off the map; a
 * destination that cannot be stood on or walked to from the previous one.
 * `paths` memoizes reachability between edits (keyed by its two points).
 */
export function scenarioIssues(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  paths = new Map<string, string | null>(),
): ScenarioIssue[] {
  const issues: ScenarioIssue[] = [];
  for (const side of ['BLUEFOR', 'OPFOR'] as const) {
    if (!d.squads.some((s) => s.side === side))
      issues.push({
        squadId: null,
        orderIndex: null,
        message: `Place at least one ${side} squad.`,
      });
  }
  const starts = soldierStarts(terrain, d);
  for (const squad of d.squads) {
    // Its centre is no soldier: only off the map is it a problem.
    if (!isOnTerrain(terrain, squad.position.east, squad.position.north)) {
      issues.push({
        squadId: squad.id,
        orderIndex: null,
        message: `${squad.name}: A squad must be on the map.`,
      });
      continue;
    }
    const blocked = (starts.get(squad.id) ?? []).filter(
      (s) => pointProblem(terrain, s.position) !== null,
    );
    if (blocked.length > 0) {
      issues.push({
        squadId: squad.id,
        orderIndex: null,
        message: `${squad.name}: ${String(blocked.length)} of its soldiers would start in water, in a building or off the map, with no clear ground within ${String(CLEAR_START_SEARCH_M)} m. Move or turn it.`,
      });
    }
    let from = toVec(squad.position);
    squad.plan.forEach((order, k) => {
      const to = toVec(order.destination);
      const label = `${squad.name}, order ${String(k + 1)} (${ORDER_LABELS[order.kind]})`;
      const spot = destinationProblem(terrain, to);
      if (spot) issues.push({ squadId: squad.id, orderIndex: k, message: `${label}: ${spot}` });
      else {
        const key = `${String(from.x)},${String(from.y)}>${String(to.x)},${String(to.y)}`;
        let reach = paths.get(key);
        if (reach === undefined) {
          const path = planPath(terrain, from, to);
          reach = path.ok ? null : describePathProblem(path.problem);
          paths.set(key, reach);
        }
        if (reach !== null)
          issues.push({
            squadId: squad.id,
            orderIndex: k,
            message: `${label}: the destination ${reach}.`,
          });
      }
      from = to;
    });
  }
  return issues;
}

/** One line describing a scenario, e.g. "2 BLUEFOR squads, 3 OPFOR squads". */
export function scenarioSummary(d: BattleScenarioDefinition): string {
  const count = (side: Side) => d.squads.filter((s) => s.side === side).length;
  const part = (n: number, side: Side) => `${String(n)} ${side} squad${n === 1 ? '' : 's'}`;
  return `${part(count('BLUEFOR'), 'BLUEFOR')}, ${part(count('OPFOR'), 'OPFOR')}`;
}
