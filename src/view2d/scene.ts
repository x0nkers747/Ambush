import type { Exercise, SoldierPlan } from '#exercise';
import type { Session } from '#session';
import {
  isOnTerrain,
  type DeepReadonly,
  type Soldier,
  type SoldierId,
  type Vec2,
  type WaypointId,
} from '#sim';
import { worldToScreen, type Camera, type Viewport } from './camera';

// What the map shows and where, in screen pixels, plus hit-testing on it.
// Pure: shared by the renderer and the interaction controller.

export interface MapScene {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly soldiers: readonly DeepReadonly<Soldier>[];
  readonly selectedId: SoldierId | null;
  /** Plans shown for every trainee soldier (drafts while editable, else remaining orders). */
  readonly plans: readonly SoldierPlan[];
  /** The selected soldier's entry in `plans`. */
  readonly selectedPlan: SoldierPlan | undefined;
  /** Whether the selected soldier's plan can be edited now. */
  readonly editable: boolean;
  /** Whether a map point lies on the terrain. */
  isOnMap(point: Vec2): boolean;
}

/** The scene for the current exercise and session state. */
export function buildScene(
  exercise: Exercise,
  session: Session,
  camera: Camera,
  viewport: Viewport,
): MapScene {
  const { state, world } = exercise.simulation;
  const plans = state.soldiers.flatMap((s) => exercise.displayedPlan(s.id) ?? []);
  const selectedPlan = plans.find((p) => p.soldierId === session.selectedSoldierId);
  return {
    camera,
    viewport,
    soldiers: state.soldiers,
    selectedId: session.selectedSoldierId,
    plans,
    selectedPlan,
    editable: exercise.canEditPlans && selectedPlan !== undefined,
    isOnMap: ({ x, y }) => isOnTerrain(world.terrain, x, y),
  };
}

/** Hit radii and sizes in CSS pixels. */
export const SOLDIER_HIT_RADIUS_PX = 10;
export const WAYPOINT_RADIUS_PX = 8;
export const WAYPOINT_HIT_RADIUS_PX = 10;
export const SEGMENT_HIT_DISTANCE_PX = 6;
export const FACING_ARROW_PX = 42;
export const FACING_HANDLE_HIT_RADIUS_PX = 10;

export interface RouteGeometry {
  /** Route start (the soldier) followed by each waypoint, in screen pixels. */
  readonly points: readonly Vec2[];
  /** Where the final facing arrow starts: the last waypoint, or the soldier. */
  readonly facingAnchor: Vec2;
  /** Tip of the final facing arrow (the drag handle). */
  readonly facingTip: Vec2;
}

export function selectedSoldier(scene: MapScene): DeepReadonly<Soldier> | undefined {
  return scene.soldiers.find((s) => s.id === scene.selectedId);
}

/** Screen geometry of the selected soldier's route, if there is a selection with a plan. */
export function routeGeometry(scene: MapScene): RouteGeometry | undefined {
  const soldier = selectedSoldier(scene);
  const plan = scene.selectedPlan;
  if (!soldier || !plan) return undefined;
  const toScreen = (p: Vec2) => worldToScreen(scene.camera, scene.viewport, p);
  const points = [toScreen(soldier.position), ...plan.waypoints.map(toScreen)];
  const facingAnchor = points[points.length - 1] ?? toScreen(soldier.position);
  return {
    points,
    facingAnchor,
    facingTip: {
      x: facingAnchor.x + Math.sin(plan.finalFacing) * FACING_ARROW_PX,
      y: facingAnchor.y - Math.cos(plan.finalFacing) * FACING_ARROW_PX,
    },
  };
}

/** The soldier drawn nearest to `screen`, within the hit radius. */
export function soldierAt(scene: MapScene, screen: Vec2): DeepReadonly<Soldier> | undefined {
  let best: DeepReadonly<Soldier> | undefined;
  let bestDistance = SOLDIER_HIT_RADIUS_PX;
  for (const soldier of scene.soldiers) {
    const d = distance(worldToScreen(scene.camera, scene.viewport, soldier.position), screen);
    if (d <= bestDistance) {
      best = soldier;
      bestDistance = d;
    }
  }
  return best;
}

/** The selected route's waypoint drawn nearest to `screen`, within the hit radius. */
export function waypointAt(scene: MapScene, screen: Vec2): WaypointId | undefined {
  const plan = scene.selectedPlan;
  const route = routeGeometry(scene);
  if (!plan || !route) return undefined;
  let best: WaypointId | undefined;
  let bestDistance = WAYPOINT_HIT_RADIUS_PX;
  plan.waypoints.forEach((w, i) => {
    const point = route.points[i + 1];
    if (!point) return;
    const d = distance(point, screen);
    if (d <= bestDistance) {
      best = w.id;
      bestDistance = d;
    }
  });
  return best;
}

/**
 * The index at which a waypoint placed at `screen` would be inserted if it lies
 * on a leg of the selected route (leg i ends at waypoint i), or `undefined`.
 */
export function insertionIndexAt(scene: MapScene, screen: Vec2): number | undefined {
  const route = routeGeometry(scene);
  if (!route) return undefined;
  let best: number | undefined;
  let bestDistance = SEGMENT_HIT_DISTANCE_PX;
  for (let i = 1; i < route.points.length; i += 1) {
    const a = route.points[i - 1];
    const b = route.points[i];
    if (!a || !b) continue;
    const d = distanceToSegment(screen, a, b);
    if (d <= bestDistance) {
      best = i - 1;
      bestDistance = d;
    }
  }
  return best;
}

export function isOnFacingHandle(scene: MapScene, screen: Vec2): boolean {
  const route = routeGeometry(scene);
  return route !== undefined && distance(route.facingTip, screen) <= FACING_HANDLE_HIT_RADIUS_PX;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0), 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
