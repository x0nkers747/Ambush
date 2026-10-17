import {
  assaultFormationId,
  battleSpecOf,
  squadSoldierStarts,
  vehicleRangeRings,
  type BattleScenarioDefinition,
  type PlannedOrder,
} from '#exercise/battle';
import {
  VEHICLE_PLATFORMS,
  type TerrainDataset,
  type Vec2,
  type VehicleKind,
  type ViewSector,
} from '#sim';
import { BATTLE_TICK_RATE_HZ } from './planner';

// What a squad or vehicle can see (docs/adr/0055): a squad's, the union of
// its soldiers' viewsheds (`ViewshedService.requestUnion`), all round, as far
// as anyone can be detected in clear air. From where its soldiers start (in a
// battle, where they are); or from one of its waypoints, where the formation
// will put them on arriving there, facing the way they came (an ambush: its
// firing line, facing its kill zone). A vehicle's, from its turret, at its
// sights' height, all round as far as its sights see.

/** How far the viewshed reaches: the detection model's longest observation range (open, clear air), metres. */
export const SQUAD_VIEWSHED_RANGE_M = 1200;
/**
 * Its cells, metres: a quick first look, every cell decided; then each finer
 * grid refined from the one before (`ViewshedService.requestRefined`), down
 * to full detail.
 */
export const SQUAD_VIEWSHED_CELLS_M = [32, 16, 8, 4] as const;

/** All round, out to `SQUAD_VIEWSHED_RANGE_M`. */
export const SQUAD_VIEWSHED_SECTOR: ViewSector = {
  azimuth: 0,
  halfWidth: Math.PI,
  rangeM: SQUAD_VIEWSHED_RANGE_M,
};

/**
 * Where squad `squadId`'s soldiers stand to look from: at the start
 * (`orderIndex` null) or on arriving at order `orderIndex`'s destination.
 * `null` when there is no such squad or order.
 */
export function viewshedObservers(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  squadId: string,
  orderIndex: number | null,
): Vec2[] | null {
  const spec = battleSpecOf(d, BATTLE_TICK_RATE_HZ);
  const index = spec.squads.findIndex((s) => s.id === squadId);
  const squad = spec.squads[index];
  if (!squad) return null;
  // As the battle lays them out: soldiers who would stand in water or a building moved clear.
  const starts = (s: typeof squad) =>
    squadSoldierStarts(s, index, d.seed, terrain).map((x) => x.position);
  if (orderIndex === null) return starts(squad);
  const order = squad.plan[orderIndex];
  const at = order?.destination;
  if (!order || !at) return null;
  const before = orderIndex > 0 ? squad.plan[orderIndex - 1]?.destination : undefined;
  const from = before ?? squad.position;
  const zone = order.killZone;
  // Facing the kill zone; else the way it came (else as it started).
  const toward = zone ? zone.centre : at;
  const fromPoint = zone ? at : from;
  const dx = toward.x - fromPoint.x;
  const dy = toward.y - fromPoint.y;
  const facingDeg =
    Math.hypot(dx, dy) > 1e-6 ? (Math.atan2(dx, dy) * 180) / Math.PI : squad.facingDeg;
  const formation =
    order.kind === 'ambush' ? (assaultFormationId(squad.organization) ?? undefined) : undefined;
  return starts({
    ...squad,
    position: { x: at.x, y: at.y },
    facingDeg,
    ...(formation !== undefined ? { formation } : {}),
  });
}

/** What a unit's viewshed is worked out from: its observers, each one's sector (with its eye height), and its reach. */
export interface ViewshedLook {
  readonly observers: readonly Vec2[];
  readonly sectors: readonly ViewSector[];
  /** How far it reaches (m). */
  readonly rangeM: number;
}

/** A squad's look: its soldiers, standing, all round to `SQUAD_VIEWSHED_RANGE_M`. */
export function squadLook(observers: readonly Vec2[]): ViewshedLook {
  return {
    observers,
    sectors: observers.map(() => SQUAD_VIEWSHED_SECTOR),
    rangeM: SQUAD_VIEWSHED_RANGE_M,
  };
}

/**
 * A vehicle's look, standing at `at` heading `heading` (radians clockwise
 * from north): from its turret (its first mount on the hull, where it pivots;
 * the hull's centre without one), at its sights' height
 * (`sensors.eyeHeightM`), all round as far as its sights see (its range
 * rings' detection: open ground, a clear day).
 */
export function vehicleLook(kind: VehicleKind, at: Vec2, heading: number): ViewshedLook {
  const platform = VEHICLE_PLATFORMS.find((p) => p.id === kind);
  const turret = platform?.mounts.find((m) => m.parent === null);
  const forward = turret?.pivot.forward ?? 0;
  const right = turret?.pivot.right ?? 0;
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  const rangeM = vehicleRangeRings(kind).detectionM;
  return {
    observers: [{ x: at.x + forward * sin + right * cos, y: at.y + forward * cos - right * sin }],
    sectors: [
      {
        azimuth: 0,
        halfWidth: Math.PI,
        rangeM,
        ...(platform ? { eyeHeightM: platform.sensors.eyeHeightM } : {}),
      },
    ],
    rangeM,
  };
}

/** The way from `a` to `b` (radians clockwise from north), or `fallback` when they are the same point. */
function headingFrom(a: Vec2, b: Vec2, fallback: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dx, dy) : fallback;
}

/**
 * A vehicle's look in a route: from `start` (heading `heading`) when
 * `orderIndex` is null, else from waypoint `orderIndex`, heading the way it
 * came. `null` when there is no such waypoint.
 */
export function vehicleRouteLook(
  kind: VehicleKind,
  start: Vec2,
  heading: number,
  route: readonly Vec2[],
  orderIndex: number | null,
): ViewshedLook | null {
  if (orderIndex === null) return vehicleLook(kind, start, heading);
  const at = route[orderIndex];
  if (!at) return null;
  const from = orderIndex > 0 ? (route[orderIndex - 1] ?? start) : start;
  return vehicleLook(kind, at, headingFrom(from, at, heading));
}

/** A planned vehicle's look: from its start, or from one of its waypoints. */
export function plannedVehicleLook(
  d: BattleScenarioDefinition,
  vehicleId: string,
  orderIndex: number | null,
): ViewshedLook | null {
  const v = d.vehicles?.find((x) => x.id === vehicleId);
  if (!v) return null;
  const point = (p: { readonly east: number; readonly north: number }) => ({
    x: p.east,
    y: p.north,
  });
  return vehicleRouteLook(
    v.kind,
    point(v.position),
    (v.facingDeg * Math.PI) / 180,
    v.route.map(point),
    orderIndex,
  );
}

/**
 * Where a squad's soldiers would stand at waypoint `orderIndex` of `plan`
 * (in a battle: its plan as it stands), coming from `centre` (where it is
 * now): as `viewshedObservers`, the squad's start being where it is.
 */
export function liveSquadWaypointObservers(
  terrain: TerrainDataset,
  d: BattleScenarioDefinition,
  squadId: string,
  centre: Vec2,
  plan: readonly PlannedOrder[],
  orderIndex: number,
): Vec2[] | null {
  const live: BattleScenarioDefinition = {
    ...d,
    squads: d.squads.map((s) =>
      s.id === squadId ? { ...s, position: { east: centre.x, north: centre.y }, plan } : s,
    ),
  };
  return viewshedObservers(terrain, live, squadId, orderIndex);
}
