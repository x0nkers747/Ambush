import {
  azimuthOf,
  isOnTerrain,
  nearestClearPoint,
  planPath,
  pointProblem,
  type ScenarioVehicle,
  type Side,
  type TerrainDataset,
  type Vec2,
  type VehicleKind,
  VEHICLE_PLATFORMS,
} from '#sim';
import { CLEAR_START_SEARCH_M } from './battle';
import {
  describePathProblem,
  placeDestination,
  type BattleEdit,
  type BattleScenarioDefinition,
  type MapPoint,
  type ScenarioIssue,
} from './scenario';

// Vehicles of a battle scenario (docs/vehicles.md): placed in Scenario Setup,
// each facing a way, with a route of waypoints it drives through in turn. A
// prototype: an M113 armoured personnel carrier of either side, driving only
// (no crew, no weapons; nothing sees or shoots it). Its route can be edited in
// Scenario Setup and BLUEFOR Planning, and changed in combat.

/** A vehicle as the scenario holds it. */
export interface PlannedVehicle {
  /** Stable id: `V1`, `V2`…. */
  readonly id: string;
  readonly name: string;
  readonly side: Side;
  readonly kind: VehicleKind;
  readonly position: MapPoint;
  /** The way it faces at the start, degrees clockwise from north. */
  readonly facingDeg: number;
  /** Where it drives, in turn (each waypoint: Prefer roads on the way there, or not). */
  readonly route: readonly RouteWaypoint[];
}

/** A waypoint of a vehicle's route: where, and whether it prefers the roads on the way there. */
export type RouteWaypoint = MapPoint & { readonly followRoads?: true };

/** The vehicles a scenario can place: the catalog's platforms, in order. */
export const VEHICLE_KINDS: readonly VehicleKind[] = VEHICLE_PLATFORMS.map((p) => p.id);

/** Each platform's name, by id. */
export const VEHICLE_LABELS: Readonly<Record<string, string | undefined>> = Object.fromEntries(
  VEHICLE_PLATFORMS.map((p) => [p.id, p.name]),
);

/** A platform's name (its id when it is not the catalog's). */
export const vehicleLabel = (kind: VehicleKind): string => VEHICLE_LABELS[kind] ?? kind;

/** What a platform's vehicles are called on the map (`M113 1`, `Abrams 2`…). */
const SHORT_NAMES: Readonly<Record<string, string | undefined>> = {
  m113: 'M113',
  m1a1: 'Abrams',
  bmp2: 'BMP-2',
  t72b: 'T-72',
};
export const vehicleShortName = (kind: VehicleKind): string =>
  SHORT_NAMES[kind] ?? vehicleLabel(kind);

const toVec = (p: MapPoint): Vec2 => ({ x: p.east, y: p.north });
const toPoint = (p: Vec2): MapPoint => ({ east: p.x, north: p.y });
const ok = (definition: BattleScenarioDefinition): BattleEdit => ({ ok: true, definition });
const refused = (problem: string): BattleEdit => ({ ok: false, problem });

export const vehiclesOf = (d: BattleScenarioDefinition): readonly PlannedVehicle[] =>
  d.vehicles ?? [];
const vehicleOf = (d: BattleScenarioDefinition, id: string) =>
  vehiclesOf(d).find((v) => v.id === id);

/** `d` with its vehicles `list` (none: the field dropped, so saved files stay as they were). */
function withVehicles(
  d: BattleScenarioDefinition,
  list: readonly PlannedVehicle[],
): BattleScenarioDefinition {
  if (list.length > 0) return { ...d, vehicles: list };
  const rest = { ...d };
  delete rest.vehicles;
  return rest;
}

const withVehicle = (
  d: BattleScenarioDefinition,
  id: string,
  change: (v: PlannedVehicle) => PlannedVehicle,
): BattleScenarioDefinition =>
  withVehicles(
    d,
    vehiclesOf(d).map((v) => (v.id === id ? change(v) : v)),
  );

/** Where a vehicle placed at `point` stands: there if it is clear, else the nearest clear ground (with a note). */
function placeVehicle(
  terrain: TerrainDataset,
  point: Vec2,
): { readonly point: Vec2; readonly note?: string } | { readonly problem: string } {
  if (!isOnTerrain(terrain, point.x, point.y)) return { problem: 'A vehicle must be on the map.' };
  if (!pointProblem(terrain, point)) return { point };
  const clear = nearestClearPoint(terrain, point, undefined, CLEAR_START_SEARCH_M);
  if (!clear)
    return { problem: 'A vehicle cannot stand there, and there is no clear ground near.' };
  const moved = Math.round(Math.hypot(clear.x - point.x, clear.y - point.y));
  return {
    point: clear,
    note: `The vehicle was moved ${String(moved)} m, out of the water or building.`,
  };
}

const degreesToward = (from: Vec2, to: Vec2): number =>
  Math.round(((azimuthOf(to.x - from.x, to.y - from.y) * 180) / Math.PI) % 360);

/** Places a vehicle at `point`, facing `facingDeg` (default: north for BLUEFOR, south for OPFOR). */
export function addVehicle(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  side: Side,
  point: Vec2,
  facingDeg?: number,
  kind: VehicleKind = 'm113',
): BattleEdit & { readonly vehicleId?: string } {
  const placed = placeVehicle(terrain, point);
  if ('problem' in placed) return refused(placed.problem);
  let n = 1;
  while (vehiclesOf(d).some((v) => v.id === `V${String(n)}`)) n += 1;
  const id = `V${String(n)}`;
  const vehicle: PlannedVehicle = {
    id,
    name: `${side === 'BLUEFOR' ? '' : 'Enemy '}${vehicleShortName(kind)} ${String(n)}`,
    side,
    kind,
    position: toPoint(placed.point),
    facingDeg: Math.round(facingDeg ?? (side === 'BLUEFOR' ? 0 : 180)),
    route: [],
  };
  return {
    ok: true,
    definition: withVehicles(d, [...vehiclesOf(d), vehicle]),
    vehicleId: id,
    ...(placed.note !== undefined ? { note: placed.note } : {}),
  };
}

export function moveVehicle(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  id: string,
  point: Vec2,
): BattleEdit {
  if (!vehicleOf(d, id)) return refused(`There is no vehicle ${id}.`);
  const placed = placeVehicle(terrain, point);
  if ('problem' in placed) return refused(placed.problem);
  return {
    ok: true,
    definition: withVehicle(d, id, (v) => ({ ...v, position: toPoint(placed.point) })),
    ...(placed.note !== undefined ? { note: placed.note } : {}),
  };
}

export function setVehicleFacing(
  d: BattleScenarioDefinition,
  id: string,
  facingDeg: number,
): BattleEdit {
  if (!vehicleOf(d, id)) return refused(`There is no vehicle ${id}.`);
  if (!Number.isFinite(facingDeg)) return refused('The facing is a number of degrees.');
  const facing = ((Math.round(facingDeg) % 360) + 360) % 360;
  return ok(withVehicle(d, id, (v) => ({ ...v, facingDeg: facing })));
}

export function faceVehicleToward(
  d: BattleScenarioDefinition,
  id: string,
  point: Vec2,
): BattleEdit {
  const v = vehicleOf(d, id);
  if (!v) return refused(`There is no vehicle ${id}.`);
  const from = toVec(v.position);
  if (Math.hypot(point.x - from.x, point.y - from.y) < 1) return ok(d);
  return setVehicleFacing(d, id, degreesToward(from, point));
}

export function renameVehicle(d: BattleScenarioDefinition, id: string, name: string): BattleEdit {
  if (!vehicleOf(d, id)) return refused(`There is no vehicle ${id}.`);
  const trimmed = name.trim();
  if (trimmed === '') return refused('A vehicle needs a name.');
  return ok(withVehicle(d, id, (v) => ({ ...v, name: trimmed.slice(0, 40) })));
}

export function deleteVehicle(d: BattleScenarioDefinition, id: string): BattleEdit {
  if (!vehicleOf(d, id)) return refused(`There is no vehicle ${id}.`);
  return ok(
    withVehicles(
      d,
      vehiclesOf(d).filter((v) => v.id !== id),
    ),
  );
}

/** Adds a waypoint to a vehicle's route: at the end, or before waypoint `index`. */
export function addVehicleWaypoint(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  id: string,
  point: Vec2,
  index?: number,
): BattleEdit {
  const v = vehicleOf(d, id);
  if (!v) return refused(`There is no vehicle ${id}.`);
  const placed = placeDestination(terrain, point);
  if ('problem' in placed) return refused(placed.problem);
  const at = index === undefined ? v.route.length : Math.max(0, Math.min(index, v.route.length));
  return {
    ok: true,
    definition: withVehicle(d, id, (x) => ({
      ...x,
      route: [...x.route.slice(0, at), toPoint(placed.point), ...x.route.slice(at)],
    })),
    ...(placed.note !== undefined ? { note: placed.note } : {}),
  };
}

export function moveVehicleWaypoint(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  id: string,
  index: number,
  point: Vec2,
): BattleEdit {
  const v = vehicleOf(d, id);
  if (!v?.route[index]) return refused('There is no such waypoint.');
  const placed = placeDestination(terrain, point);
  if ('problem' in placed) return refused(placed.problem);
  return {
    ok: true,
    definition: withVehicle(d, id, (x) => ({
      ...x,
      route: x.route.map((p, k) =>
        k === index
          ? { ...toPoint(placed.point), ...(p.followRoads ? { followRoads: true as const } : {}) }
          : p,
      ),
    })),
    ...(placed.note !== undefined ? { note: placed.note } : {}),
  };
}

export function deleteVehicleWaypoint(
  d: BattleScenarioDefinition,
  id: string,
  index: number,
): BattleEdit {
  const v = vehicleOf(d, id);
  if (!v?.route[index]) return refused('There is no such waypoint.');
  return ok(withVehicle(d, id, (x) => ({ ...x, route: x.route.filter((_, k) => k !== index) })));
}

/** Turns Prefer roads on or off for the way to waypoint `index`. */
export function setVehicleWaypointRoads(
  d: BattleScenarioDefinition,
  id: string,
  index: number,
  on: boolean,
): BattleEdit {
  const v = vehicleOf(d, id);
  if (!v?.route[index]) return refused('There is no such waypoint.');
  return ok(
    withVehicle(d, id, (x) => ({
      ...x,
      route: x.route.map((p, k) =>
        k !== index
          ? p
          : on
            ? { east: p.east, north: p.north, followRoads: true as const }
            : { east: p.east, north: p.north },
      ),
    })),
  );
}

export function clearVehicleRoute(d: BattleScenarioDefinition, id: string): BattleEdit {
  if (!vehicleOf(d, id)) return refused(`There is no vehicle ${id}.`);
  return ok(withVehicle(d, id, (x) => ({ ...x, route: [] })));
}

/** The vehicles of the battle a scenario makes. */
export function vehicleSpecs(d: BattleScenarioDefinition): ScenarioVehicle[] {
  return vehiclesOf(d).map((v) => ({
    id: v.id,
    name: v.name,
    side: v.side,
    kind: v.kind,
    position: toVec(v.position),
    headingDeg: v.facingDeg,
    destinations: v.route.map((p) => ({
      ...toVec(p),
      ...(p.followRoads ? { followRoads: true } : {}),
    })),
  }));
}

/** What stops the scenario's vehicles from driving: off the map, in water or a building, a waypoint it cannot reach. */
export function vehicleIssues(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  paths: Map<string, string | null>,
): ScenarioIssue[] {
  const issues: ScenarioIssue[] = [];
  for (const v of vehiclesOf(d)) {
    const at = toVec(v.position);
    const problem = isOnTerrain(terrain, at.x, at.y)
      ? pointProblem(terrain, at)
      : ({ kind: 'offTerrain' } as const);
    if (problem) {
      issues.push({
        squadId: null,
        vehicleId: v.id,
        orderIndex: null,
        message: `${v.name}: it is ${describePathProblem(problem)}. Move it.`,
      });
      continue;
    }
    let from = at;
    v.route.forEach((p, k) => {
      const to = toVec(p);
      const roads = p.followRoads === true;
      const key = `${roads ? 'R' : ''}${String(from.x)},${String(from.y)}>${String(to.x)},${String(to.y)}`;
      let reach = paths.get(key);
      if (reach === undefined) {
        const path = planPath(terrain, from, to, { followRoads: roads });
        reach = path.ok ? null : describePathProblem(path.problem);
        paths.set(key, reach);
      }
      if (reach !== null)
        issues.push({
          squadId: null,
          vehicleId: v.id,
          orderIndex: k,
          message: `${v.name}, waypoint ${String(k + 1)}: the destination ${reach}.`,
        });
      from = to;
    });
  }
  return issues;
}

/** Reads a scenario file's vehicles (`fail` throws). */
export function parseVehicles(
  raw: unknown,
  squadIds: ReadonlySet<string>,
  point: (v: unknown, what: string) => MapPoint,
  fail: (message: string) => never,
): PlannedVehicle[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return fail('"vehicles" is not a list');
  const ids = new Set<string>();
  return (raw as unknown[]).map((item, i): PlannedVehicle => {
    const v = (item ?? {}) as Record<string, unknown>;
    const what = `vehicle ${String(i + 1)}`;
    const id = v['id'];
    if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(id))
      return fail(`${what} has no valid id`);
    if (ids.has(id) || squadIds.has(id)) fail(`vehicle id "${id}" is used twice`);
    ids.add(id);
    const name = v['name'];
    if (typeof name !== 'string' || name.trim() === '') return fail(`${what} has no name`);
    const side = v['side'];
    if (side !== 'BLUEFOR' && side !== 'OPFOR')
      return fail(`${what}'s side is not BLUEFOR or OPFOR`);
    const kind = v['kind'];
    if (typeof kind !== 'string' || !VEHICLE_KINDS.includes(kind))
      return fail(`${what}'s kind "${String(kind)}" is not a known vehicle`);
    const facing = v['facingDeg'];
    if (typeof facing !== 'number' || !Number.isFinite(facing))
      return fail(`${what}'s facing is not a number`);
    const route = v['route'];
    if (!Array.isArray(route)) return fail(`${what} has no route`);
    return {
      id,
      name,
      side,
      kind,
      position: point(v['position'], `${what}'s position`),
      facingDeg: facing,
      route: (route as unknown[]).map((p, k): RouteWaypoint => {
        const at = point(p, `${what}, waypoint ${String(k + 1)}`);
        const roads = (p as { followRoads?: unknown } | null)?.followRoads;
        if (roads !== undefined && roads !== true && roads !== false)
          fail(`${what}, waypoint ${String(k + 1)}: followRoads is not true or false`);
        return roads === true ? { ...at, followRoads: true } : at;
      }),
    };
  });
}
