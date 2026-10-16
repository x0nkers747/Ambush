import {
  assaultFormationId,
  battleSpecOf,
  squadSoldierStarts,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import type { TerrainDataset, Vec2, ViewSector } from '#sim';
import { BATTLE_TICK_RATE_HZ } from './planner';

// What a selected squad can see, for planning (docs/constructive-simulation/03):
// the union of its soldiers' viewsheds (`ViewshedService.requestUnion`), all
// round, as far as anyone can be detected in clear air. From where its
// soldiers start; or, with one of its waypoints selected, from where the
// formation will put them on arriving there, facing the way they came (an
// ambush: its firing line, facing its kill zone).

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
