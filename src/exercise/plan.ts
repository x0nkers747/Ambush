import {
  isOnTerrain,
  type Azimuth,
  type DeepReadonly,
  type Soldier,
  type SoldierId,
  type TerrainDataset,
  type Waypoint,
} from '#sim';

/**
 * A soldier's tactical plan as the trainee sees it: a route of map points and
 * a final facing. The same shape is used for editable drafts and for committed
 * plans; committed plans are deep-frozen.
 */
export interface SoldierPlan {
  readonly soldierId: SoldierId;
  readonly waypoints: readonly Waypoint[];
  readonly finalFacing: Azimuth;
}

/**
 * The part of a soldier's active orders still to be carried out: waypoints not
 * yet reached (with their original ids) and the final facing. A soldier without
 * orders has an empty route and keeps its current facing.
 */
export function remainingPlan(soldier: DeepReadonly<Soldier>): SoldierPlan {
  const active = soldier.orders;
  if (active === null)
    return { soldierId: soldier.id, waypoints: [], finalFacing: soldier.azimuth };
  return {
    soldierId: soldier.id,
    waypoints: active.orders.waypoints.slice(active.nextWaypointIndex),
    finalFacing: active.orders.finalFacing,
  };
}

/** Whether two plans would give the soldier the same orders. */
export function samePlan(a: SoldierPlan, b: SoldierPlan): boolean {
  return (
    a.soldierId === b.soldierId &&
    a.finalFacing === b.finalFacing &&
    a.waypoints.length === b.waypoints.length &&
    a.waypoints.every((w, i) => {
      const v = b.waypoints[i];
      return w.id === v?.id && w.x === v.x && w.y === v.y;
    })
  );
}

/** Problems that prevent committing a plan; empty when the plan is valid. */
export function validatePlan(plan: SoldierPlan, terrain: TerrainDataset): string[] {
  const problems: string[] = [];
  if (!(plan.finalFacing >= 0 && plan.finalFacing < 2 * Math.PI)) {
    problems.push(`final facing ${String(plan.finalFacing)} is not an azimuth in [0, 2π)`);
  }
  const ids = new Set<string>();
  plan.waypoints.forEach((w, i) => {
    const label = `waypoint ${String(i + 1)}`;
    if (ids.has(w.id)) problems.push(`${label} repeats id "${w.id}"`);
    ids.add(w.id);
    if (!isOnTerrain(terrain, w.x, w.y)) problems.push(`${label} is off the map`);
  });
  return problems;
}
