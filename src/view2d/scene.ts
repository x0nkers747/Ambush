import type {
  AmbushTrigger,
  Exercise,
  KillZone,
  OpforRoute,
  PlannedRoute,
  SoldierPlan,
} from '#exercise';
import type { MapTool, Session } from '#session';
import {
  isOnTerrain,
  type DeepReadonly,
  type Soldier,
  type SoldierId,
  type Vec2,
  type Viewshed,
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
  /** Whether the selected soldier's plan can be edited now (route tool). */
  readonly editable: boolean;
  /** What map clicks edit. */
  readonly tool: MapTool;
  /** The trainee's kill zone as drawn so far. */
  readonly killZone: KillZone | null;
  /** Whether the kill zone can be edited now (kill-zone tool). */
  readonly killZoneEditable: boolean;
  /** Walkable routes of trainee soldiers (generated turn points between waypoints). */
  readonly routes: ReadonlyMap<SoldierId, PlannedRoute>;
  /** Scenario OPFOR routes the trainee may see, with their walkable paths. */
  readonly opforRoutes: readonly { readonly route: OpforRoute; readonly path: PlannedRoute }[];
  /** The selected soldier's visible area, while the visibility overlay is on. */
  readonly visibility: VisibilityView | null;
  /** The ambush trigger, once it has happened. */
  readonly trigger: AmbushTrigger | null;
  /** Whether a map point lies on the terrain. */
  isOnMap(point: Vec2): boolean;
}

/** The visibility overlay for the selected soldier. */
export interface VisibilityView {
  /** Where the soldier observes from: its planned final position, or where it stands. */
  readonly observer: Vec2;
  readonly planned: boolean;
  /** The viewshed to draw: from `observer` once ready, otherwise the previous one. */
  readonly viewshed: Viewshed | null;
  /** Whether the viewshed from `observer` is still being computed. */
  readonly pending: boolean;
}

/** The scene for the current exercise and session state. */
export function buildScene(
  exercise: Exercise,
  session: Session,
  camera: Camera,
  viewport: Viewport,
  visibility: VisibilityView | null = null,
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
    editable: exercise.canEditPlans && selectedPlan !== undefined && session.tool === 'routes',
    tool: session.tool,
    killZone: exercise.killZone,
    killZoneEditable: exercise.canEditPlans && session.tool === 'killZone',
    routes: new Map(
      plans.flatMap((p) => {
        const route = exercise.displayedRoute(p.soldierId);
        return route ? [[p.soldierId, route] as const] : [];
      }),
    ),
    opforRoutes: exercise.opforRoutes.flatMap((route) => {
      const path = exercise.opforRoutePaths.get(route.id);
      return route.shownToTrainee && path ? [{ route, path }] : [];
    }),
    visibility: session.showVisibility ? visibility : null,
    trigger: exercise.trigger,
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
export const KILL_ZONE_VERTEX_HIT_RADIUS_PX = 9;

export interface RouteGeometry {
  /** Route start (the soldier) followed by each trainee waypoint, in screen pixels. */
  readonly points: readonly Vec2[];
  /**
   * Each leg as walked, in screen pixels: from the previous point through the
   * generated turn points to its waypoint. A leg that cannot be walked is a
   * straight line flagged in `impossible`.
   */
  readonly legs: readonly (readonly Vec2[])[];
  readonly impossible: readonly boolean[];
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
  const route = scene.routes.get(soldier.id);
  const legs = plan.waypoints.map((_, i) => [
    points[i] ?? facingAnchor,
    ...(route?.legs[i]?.turns ?? []).map(toScreen),
    points[i + 1] ?? facingAnchor,
  ]);
  return {
    points,
    legs,
    impossible: plan.waypoints.map((_, i) => route?.legs[i]?.turns === null),
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
 * on a leg of the selected route as walked (leg i ends at waypoint i), or `undefined`.
 */
export function insertionIndexAt(scene: MapScene, screen: Vec2): number | undefined {
  const route = routeGeometry(scene);
  if (!route) return undefined;
  let best: number | undefined;
  let bestDistance = SEGMENT_HIT_DISTANCE_PX;
  // Any piece of a leg as walked counts, including around generated turns.
  route.legs.forEach((leg, i) => {
    for (let k = 1; k < leg.length; k += 1) {
      const a = leg[k - 1];
      const b = leg[k];
      if (!a || !b) continue;
      const d = distanceToSegment(screen, a, b);
      if (d <= bestDistance) {
        best = i;
        bestDistance = d;
      }
    }
  });
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

/** The kill-zone corner drawn nearest to `screen`, within the hit radius. */
export function killZoneVertexAt(scene: MapScene, screen: Vec2): number | undefined {
  let best: number | undefined;
  let bestDistance = KILL_ZONE_VERTEX_HIT_RADIUS_PX;
  scene.killZone?.vertices.forEach((v, i) => {
    const d = distance(worldToScreen(scene.camera, scene.viewport, v), screen);
    if (d <= bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

/**
 * The index at which a corner placed at `screen` would be inserted if it lies on
 * a side of the kill zone (side i runs from corner i to corner i + 1, the last
 * side back to corner 0), or `undefined`.
 */
export function killZoneInsertionIndexAt(scene: MapScene, screen: Vec2): number | undefined {
  const vertices = scene.killZone?.vertices ?? [];
  if (vertices.length < 2) return undefined;
  const points = vertices.map((v) => worldToScreen(scene.camera, scene.viewport, v));
  const sides = vertices.length >= 3 ? points.length : 1;
  let best: number | undefined;
  let bestDistance = SEGMENT_HIT_DISTANCE_PX;
  for (let i = 0; i < sides; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    const d = distanceToSegment(screen, a, b);
    if (d <= bestDistance) {
      best = i + 1;
      bestDistance = d;
    }
  }
  return best;
}
