import {
  azimuthOf,
  isOnTerrain,
  planPath,
  pointProblem,
  type ScenarioSoldier,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import { deployInOrp, type AmbushScenario, type OpforRoute } from './ambush-scenario';
import { AUTO_ORP_RADIUS_M, placeOrp } from './battlefield-scenario';
import { toMapPoint, toVec2, type MapPoint } from './deployment';
import { layoutOrp, orpProblems, type ObjectiveRallyPoint } from './orp';
import { describePathProblem } from './routes';
import { DEFAULT_MOVEMENT, squadInstance, USMC_RIFLE_SQUAD_TEMPLATE } from './squad';

// Scenario definitions (docs/adr/0015): what the scenario editor sets up on a
// battlefield, kept apart from the battlefield's geography (an immutable
// package) and from any exercise played on it. A definition holds the ORP and
// the OPFOR (its force and route, whose first point is where it starts) in
// the battlefield's local metres. `buildScenario` turns it into an ordinary
// `AmbushScenario`, so the exercise, simulation and map need nothing new.
//
// Every edit is validated with the same placement rules as the rest of the
// game (no ORP where the squad cannot stand, no OPFOR in buildings or water,
// no waypoint OPFOR could not walk to); a refused edit returns the reason and
// leaves the definition unchanged.

export const SCENARIO_SCHEMA = 'ambush.scenario';
export const SCENARIO_SCHEMA_VERSION = 1;

/**
 * The OPFOR forces a scenario can use. `patrol-3` is the demo's patrol: three
 * soldiers (EN-1 leading, EN-2, EN-3) in a file 12 m apart, one fire team,
 * each carrying the same loadout (docs/adr/0019).
 */
export const OPFOR_FORCES = {
  'patrol-3': {
    soldiers: ['EN-1', 'EN-2', 'EN-3'],
    unitId: 'EN-TM',
    echelon: 'fireTeam',
    spacingM: 12,
    loadout: { weaponProfileRefs: ['ak-assault-rifle'] },
  },
} as const;
export type OpforForce = keyof typeof OPFOR_FORCES;

export interface ScenarioDefinition {
  readonly schema: typeof SCENARIO_SCHEMA;
  readonly schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  /** Stable id of this scenario (one per battlefield for now). */
  readonly id: string;
  /** The battlefield package it belongs to; its coordinates are that battlefield's local metres. */
  readonly battlefieldId: string;
  readonly name: string;
  /** Centre of the ORP (a circle of `AUTO_ORP_RADIUS_M`), or `null` when not placed. */
  readonly orp: MapPoint | null;
  readonly opfor: {
    readonly force: OpforForce;
    /** The route, starting where the OPFOR starts. Empty: no OPFOR placed yet. */
    readonly route: readonly MapPoint[];
  };
}

export class ScenarioDefinitionError extends Error {
  override name = 'ScenarioDefinitionError';
}

export type EditResult =
  | { readonly ok: true; readonly definition: ScenarioDefinition }
  | { readonly ok: false; readonly problem: string };

const ok = (definition: ScenarioDefinition): EditResult => ({ ok: true, definition });
const refused = (problem: string): EditResult => ({ ok: false, problem });

/**
 * A new scenario on a battlefield: the ORP on open ground nearest the centre
 * (as the minimal scenario places it), no OPFOR yet.
 */
export function defaultScenarioDefinition(
  terrain: TerrainDataset,
  battlefieldId: string,
  name = 'Scenario 1',
): ScenarioDefinition {
  const orp = (() => {
    try {
      return placeOrp(terrain, USMC_RIFLE_SQUAD_TEMPLATE.slots.length).centre;
    } catch {
      return null;
    }
  })();
  return {
    schema: SCENARIO_SCHEMA,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: `${battlefieldId}/1`,
    battlefieldId,
    name,
    orp,
    opfor: { force: 'patrol-3', route: [] },
  };
}

const orpAt = (centre: MapPoint): ObjectiveRallyPoint => ({
  id: 'ORP-1',
  name: 'ORP',
  centre,
  shape: { kind: 'circle', radiusM: AUTO_ORP_RADIUS_M },
});

/** Why the squad cannot assemble at an ORP centred on `point`, or `null`. */
export function orpPlacementProblem(terrain: TerrainDataset, point: Vec2): string | null {
  if (!isOnTerrain(terrain, point.x, point.y)) return 'The ORP must be on the map.';
  const centre = pointProblem(terrain, point);
  if (centre) return `The ORP's centre is ${describePathProblem(centre)}.`;
  const orp = orpAt(toMapPoint(point));
  const problems = orpProblems(orp, terrain);
  if (problems.length > 0) return `The ORP does not fit here: ${problems.join('; ')}.`;
  try {
    layoutOrp(orp, terrain, USMC_RIFLE_SQUAD_TEMPLATE.slots.length);
  } catch {
    return 'There is not enough open ground here for the squad to assemble (buildings or water in the way).';
  }
  return null;
}

/** Why OPFOR cannot stand at `point`, or `null`. */
function standProblem(terrain: TerrainDataset, point: Vec2): string | null {
  const p = pointProblem(terrain, point);
  return p ? `That point is ${describePathProblem(p)}.` : null;
}

/** Why OPFOR cannot walk from `from` to `to`, or `null`. */
function legProblem(terrain: TerrainDataset, from: Vec2, to: Vec2): string | null {
  const path = planPath(terrain, from, to);
  return path.ok
    ? null
    : `OPFOR cannot walk there: the point is ${describePathProblem(path.problem)}.`;
}

/** Checks a whole route: every point standable, every leg walkable. */
function routeProblem(terrain: TerrainDataset, route: readonly MapPoint[]): string | null {
  for (let i = 0; i < route.length; i += 1) {
    const p = route[i];
    if (!p) continue;
    const stand = standProblem(terrain, toVec2(p));
    if (stand) return stand;
    const prev = route[i - 1];
    if (prev) {
      const leg = legProblem(terrain, toVec2(prev), toVec2(p));
      if (leg) return leg;
    }
  }
  return null;
}

const withRoute = (d: ScenarioDefinition, route: readonly MapPoint[]): ScenarioDefinition => ({
  ...d,
  opfor: { ...d.opfor, route },
});

/** Places (or moves) the ORP. */
export function setOrp(terrain: TerrainDataset, d: ScenarioDefinition, point: Vec2): EditResult {
  const problem = orpPlacementProblem(terrain, point);
  return problem ? refused(problem) : ok({ ...d, orp: toMapPoint(point) });
}

/** Places (or moves) the OPFOR's start: the route's first point. */
export function setOpforStart(
  terrain: TerrainDataset,
  d: ScenarioDefinition,
  point: Vec2,
): EditResult {
  return moveRouteWaypoint(
    terrain,
    d.opfor.route.length === 0 ? withRoute(d, [toMapPoint(point)]) : d,
    0,
    point,
  );
}

/** Adds a waypoint at the end of the route (the first one sets the OPFOR start). */
export function addRouteWaypoint(
  terrain: TerrainDataset,
  d: ScenarioDefinition,
  point: Vec2,
): EditResult {
  const route = [...d.opfor.route, toMapPoint(point)];
  const problem = routeProblem(terrain, route.slice(-2));
  return problem ? refused(problem) : ok(withRoute(d, route));
}

/** Moves a route point (index 0 is the OPFOR start). */
export function moveRouteWaypoint(
  terrain: TerrainDataset,
  d: ScenarioDefinition,
  index: number,
  point: Vec2,
): EditResult {
  if (index < 0 || index >= d.opfor.route.length) return refused('There is no such waypoint.');
  const route = d.opfor.route.map((p, i) => (i === index ? toMapPoint(point) : p));
  // The point itself and the legs into and out of it.
  const problem = routeProblem(terrain, route.slice(Math.max(0, index - 1), index + 2));
  return problem ? refused(problem) : ok(withRoute(d, route));
}

/** Deletes a route point; deleting the start makes the next point the start. */
export function deleteRouteWaypoint(
  terrain: TerrainDataset,
  d: ScenarioDefinition,
  index: number,
): EditResult {
  if (index < 0 || index >= d.opfor.route.length) return refused('There is no such waypoint.');
  const route = d.opfor.route.filter((_, i) => i !== index);
  // The new leg joining the neighbours must be walkable.
  const problem = routeProblem(terrain, route.slice(Math.max(0, index - 1), index + 1));
  return problem
    ? refused(`The route cannot join up without that waypoint. ${problem}`)
    : ok(withRoute(d, route));
}

/** Removes the route's waypoints, keeping the OPFOR where it starts. */
export function clearRoute(d: ScenarioDefinition): ScenarioDefinition {
  return withRoute(d, d.opfor.route.slice(0, 1));
}

/**
 * What stops the scenario being played, for the Continue button: an ORP, an
 * OPFOR start and at least one waypoint are needed, all valid on the terrain.
 */
export function scenarioProblems(terrain: TerrainDataset, d: ScenarioDefinition): string[] {
  const problems: string[] = [];
  if (!d.orp) problems.push('Place the ORP.');
  else {
    const p = orpPlacementProblem(terrain, toVec2(d.orp));
    if (p) problems.push(p);
  }
  if (d.opfor.route.length === 0) problems.push('Place the OPFOR.');
  else if (d.opfor.route.length < 2)
    problems.push('Give the OPFOR a route: at least one waypoint after its start.');
  const route = routeProblem(terrain, d.opfor.route);
  if (route) problems.push(route);
  return problems;
}

/** Where each OPFOR soldier starts: the leader on the route's start, the rest in file behind it. */
function opforStarts(terrain: TerrainDataset, d: ScenarioDefinition): Vec2[] {
  const force = OPFOR_FORCES[d.opfor.force];
  const start = d.opfor.route[0];
  if (!start) return [];
  const s = toVec2(start);
  const next = d.opfor.route[1];
  // "Behind" is opposite the first leg; north of the start when there is no route yet.
  const az = next ? azimuthOf(next.east - s.x, next.north - s.y) : Math.PI;
  const back = { x: -Math.sin(az), y: -Math.cos(az) };
  const usable = (p: Vec2) =>
    pointProblem(terrain, p) === null && (!next || planPath(terrain, p, toVec2(next)).ok);
  return force.soldiers.map((_, k) => {
    if (k === 0) return s;
    // In file behind the leader; otherwise the nearest usable spot round the start; else on it.
    const candidates = [
      { x: s.x + back.x * force.spacingM * k, y: s.y + back.y * force.spacingM * k },
      ...[1, 2, 3].flatMap((r) =>
        [0, 1, 2, 3, 4, 5, 6, 7].map((a) => ({
          x: s.x + Math.sin((a * Math.PI) / 4) * 4 * r * k,
          y: s.y + Math.cos((a * Math.PI) / 4) * 4 * r * k,
        })),
      ),
    ];
    return candidates.find(usable) ?? s;
  });
}

/**
 * The playable scenario: the squad in the ORP, the OPFOR patrol on its route.
 * Throws a `ScenarioDefinitionError` when there is no valid ORP. Without an
 * OPFOR (or with no waypoint yet) the scenario simply has none (for previews).
 */
export function buildScenario(terrain: TerrainDataset, d: ScenarioDefinition): AmbushScenario {
  if (!d.orp) throw new ScenarioDefinitionError('The scenario has no ORP.');
  const orpProblem = orpPlacementProblem(terrain, toVec2(d.orp));
  if (orpProblem) throw new ScenarioDefinitionError(orpProblem);
  const route = routeProblem(terrain, d.opfor.route);
  if (route) throw new ScenarioDefinitionError(route);
  const orp = orpAt(d.orp);
  const squad = deployInOrp(USMC_RIFLE_SQUAD_TEMPLATE, squadInstance(), orp, terrain);
  const force = OPFOR_FORCES[d.opfor.force];
  const starts = opforStarts(terrain, d);
  const waypoints = d.opfor.route.slice(1);
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  const before = waypoints.length >= 2 ? waypoints[waypoints.length - 2] : d.opfor.route[0];
  const facingDeg = (from: MapPoint | undefined, to: MapPoint | undefined, fallback: number) =>
    from && to && (from.east !== to.east || from.north !== to.north)
      ? (azimuthOf(to.east - from.east, to.north - from.north) * 180) / Math.PI
      : fallback;
  const soldiers: ScenarioSoldier[] = starts.map((p, k) => ({
    id: force.soldiers[k] ?? `EN-${String(k + 1)}`,
    side: 'OPFOR',
    unitId: force.unitId,
    position: p,
    azimuthDeg: facingDeg(toMapPoint(p), first, 180),
    posture: 'standing',
  }));
  const opforRoutes: OpforRoute[] =
    waypoints.length === 0
      ? []
      : soldiers.map((s) => ({
          id: `${s.id}-route`,
          soldierId: s.id,
          waypoints: waypoints.map((w, i) => ({
            id: `${s.id}-route.${String(i + 1)}`,
            x: w.east,
            y: w.north,
          })),
          finalFacingDeg: facingDeg(before, last, 0),
          shownToTrainee: true,
        }));
  return {
    id: `scenario-${d.id}`,
    terrain,
    movement: DEFAULT_MOVEMENT,
    units: [
      ...squad.units,
      ...(soldiers.length > 0
        ? [
            {
              id: force.unitId,
              echelon: force.echelon,
              parentId: null,
              leaderId: soldiers[0]?.id ?? null,
            },
          ]
        : []),
    ],
    soldiers: [...squad.soldiers, ...soldiers],
    opforRoutes,
    orp,
    organization: squad.organization,
    opforLoadouts: Object.fromEntries(soldiers.map((s) => [s.id, force.loadout])),
  };
}

/**
 * Reads a stored definition: checks the schema, version and shape. Throws a
 * `ScenarioDefinitionError` saying what is wrong.
 */
export function parseScenarioDefinition(data: unknown): ScenarioDefinition {
  const fail = (message: string): never => {
    throw new ScenarioDefinitionError(`Scenario not loaded: ${message}.`);
  };
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return fail('the data is not an object');
  const d = data as Record<string, unknown>;
  if (d['schema'] !== SCENARIO_SCHEMA) fail(`the schema is not "${SCENARIO_SCHEMA}"`);
  if (d['schemaVersion'] !== SCENARIO_SCHEMA_VERSION) {
    fail(`schema version ${JSON.stringify(d['schemaVersion'])} is not supported`);
  }
  for (const key of ['id', 'battlefieldId', 'name']) {
    if (typeof d[key] !== 'string' || d[key] === '') fail(`"${key}" is missing`);
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
  const orp = d['orp'] === null ? null : point(d['orp'], 'the ORP');
  const opfor = d['opfor'] as { force?: unknown; route?: unknown } | undefined;
  if (!opfor || typeof opfor !== 'object') return fail('"opfor" is missing');
  if (typeof opfor.force !== 'string' || !(opfor.force in OPFOR_FORCES))
    fail('the OPFOR force is unknown');
  if (!Array.isArray(opfor.route)) return fail('the OPFOR route is missing');
  const route = (opfor.route as unknown[]).map((p, i) => point(p, `route point ${String(i + 1)}`));
  return {
    schema: SCENARIO_SCHEMA,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: d['id'] as string,
    battlefieldId: d['battlefieldId'] as string,
    name: d['name'] as string,
    orp,
    opfor: { force: opfor.force as OpforForce, route },
  };
}
