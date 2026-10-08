import {
  orpOutline,
  toVec2,
  type AmbushTrigger,
  type DisplayedFacing,
  type Exercise,
  type KillZone,
  type OpforRoute,
  type PlannedRoute,
  type SoldierDeploymentPlan,
} from '#exercise';
import type { MapTool, Session } from '#session';
import {
  isOnTerrain,
  type DeepReadonly,
  type Soldier,
  type SoldierId,
  type Vec2,
  type Viewshed,
} from '#sim';
import { worldToScreen, type Camera, type Viewport } from './camera';

// What the map shows and where, in screen pixels, plus hit-testing on it.
// Pure: shared by the renderer and the interaction controller.

/** How a trainee soldier is drawn: its symbol code and short role label. */
export interface SoldierMarking {
  readonly sidc: string;
  /** Short role label from the organization template (e.g. "1-AR"). */
  readonly label: string;
}

export interface MapScene {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly soldiers: readonly DeepReadonly<Soldier>[];
  readonly selectedId: SoldierId | null;
  /** Plans shown for every trainee soldier (drafts while editable, else committed plans). */
  readonly plans: readonly SoldierDeploymentPlan[];
  /** The selected soldier's entry in `plans`. */
  readonly selectedPlan: SoldierDeploymentPlan | undefined;
  /** Whether the selected soldier's plan can be edited now (deployment tool). */
  readonly editable: boolean;
  /** What map clicks edit. */
  readonly tool: MapTool;
  /** The trainee's kill zone as drawn so far. */
  readonly killZone: KillZone | null;
  /** Whether the kill zone can be edited now (kill-zone tool). */
  readonly killZoneEditable: boolean;
  /** Walkable paths to trainee soldiers' destinations (generated turn points, not intent). */
  readonly routes: ReadonlyMap<SoldierId, PlannedRoute>;
  /** The facing each trainee soldier's plan gives it. */
  readonly facings: ReadonlyMap<SoldierId, DisplayedFacing>;
  /** Symbol and label of each trainee soldier, from the organization template. */
  readonly markings: ReadonlyMap<SoldierId, SoldierMarking>;
  /** The trainee organization's objective rally point. */
  readonly orp: { readonly name: string; readonly centre: Vec2; readonly outline: readonly Vec2[] };
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
  /** Where the soldier observes from: its destination, or where it stands. */
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
  const orp = exercise.orp;
  return {
    camera,
    viewport,
    soldiers: state.soldiers,
    selectedId: session.selectedSoldierId,
    plans,
    selectedPlan,
    editable: exercise.canEditPlans && selectedPlan !== undefined && session.tool === 'deploy',
    tool: session.tool,
    killZone: exercise.killZone,
    killZoneEditable: exercise.canEditPlans && session.tool === 'killZone',
    routes: new Map(
      plans.flatMap((p) => {
        const route = exercise.displayedRoute(p.soldierId);
        return route ? [[p.soldierId, route] as const] : [];
      }),
    ),
    facings: new Map(
      plans.flatMap((p) => {
        const facing = exercise.displayedFacing(p.soldierId);
        return facing ? [[p.soldierId, facing] as const] : [];
      }),
    ),
    markings: new Map(
      plans.flatMap((p) => {
        const member = exercise.rosterMember(p.soldierId);
        return member
          ? [[p.soldierId, { sidc: member.role.symbology.sidc, label: member.slot.label }] as const]
          : [];
      }),
    ),
    orp: {
      name: orp.name,
      centre: { x: orp.centre.east, y: orp.centre.north },
      outline: orpOutline(orp),
    },
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
export const DESTINATION_RADIUS_PX = 7;
export const DESTINATION_HIT_RADIUS_PX = 10;
export const FACING_ARROW_PX = 42;
export const FACING_HANDLE_HIT_RADIUS_PX = 10;
export const KILL_ZONE_VERTEX_HIT_RADIUS_PX = 9;
export const SEGMENT_HIT_DISTANCE_PX = 6;
/** The square a full trainee symbol occupies on screen, for decluttering. */
export const SYMBOL_BOX_PX = 24;
/** Approximate width per character of a soldier label, for decluttering. */
const LABEL_CHAR_PX = 6.5;
const LABEL_HEIGHT_PX = 12;

/** The selected soldier's plan in screen pixels. */
export interface DeploymentGeometry {
  readonly soldier: Vec2;
  /** The destination marker, or `null` without a destination. */
  readonly destination: Vec2 | null;
  /**
   * The path as it will be walked: from the soldier through the generated turn
   * points to the destination. Empty without a destination; a straight line
   * flagged `impossible` when it cannot be walked.
   */
  readonly path: readonly Vec2[];
  readonly impossible: boolean;
  /** Where the facing arrow starts: the destination, or the soldier. */
  readonly facingAnchor: Vec2;
  /** Tip of the facing arrow (the drag handle). */
  readonly facingTip: Vec2;
  readonly facing: DisplayedFacing;
}

export function selectedSoldier(scene: MapScene): DeepReadonly<Soldier> | undefined {
  return scene.soldiers.find((s) => s.id === scene.selectedId);
}

/** Screen geometry of a trainee soldier's plan (default: the selected soldier's). */
export function deploymentGeometry(
  scene: MapScene,
  id: SoldierId | null = scene.selectedId,
): DeploymentGeometry | undefined {
  const soldier = scene.soldiers.find((s) => s.id === id);
  const plan = scene.plans.find((p) => p.soldierId === id);
  const facing = id === null ? undefined : scene.facings.get(id);
  if (!soldier || !plan || !facing) return undefined;
  const toScreen = (p: Vec2) => worldToScreen(scene.camera, scene.viewport, p);
  const start = toScreen(soldier.position);
  const destination = plan.destination ? toScreen(toVec2(plan.destination)) : null;
  const leg = scene.routes.get(soldier.id)?.legs[0];
  const path = destination ? [start, ...(leg?.turns ?? []).map(toScreen), destination] : [];
  const facingAnchor = destination ?? start;
  return {
    soldier: start,
    destination,
    path,
    impossible: destination !== null && (leg?.turns ?? null) === null,
    facingAnchor,
    facingTip: {
      x: facingAnchor.x + Math.sin(facing.azimuth) * FACING_ARROW_PX,
      y: facingAnchor.y - Math.cos(facing.azimuth) * FACING_ARROW_PX,
    },
    facing,
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

/** Whether `screen` is on the selected soldier's destination marker. */
export function isOnDestination(scene: MapScene, screen: Vec2): boolean {
  const destination = deploymentGeometry(scene)?.destination;
  return destination != null && distance(destination, screen) <= DESTINATION_HIT_RADIUS_PX;
}

export function isOnFacingHandle(scene: MapScene, screen: Vec2): boolean {
  const geometry = deploymentGeometry(scene);
  return (
    geometry !== undefined && distance(geometry.facingTip, screen) <= FACING_HANDLE_HIT_RADIUS_PX
  );
}

/** A screen rectangle. */
interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** How a trainee soldier's symbol is drawn after decluttering. */
export interface SymbolPlacement {
  /** The soldier's true position on screen: symbols are never displaced. */
  readonly at: Vec2;
  /** `full`: the standard symbol; `compact`: a small dot, because it would overlap another symbol. */
  readonly mode: 'full' | 'compact';
  readonly showLabel: boolean;
  /**
   * How many compact soldiers stand under this full symbol, where they cannot
   * be seen (shown as a "+n" badge); 0 for compact symbols.
   */
  readonly covered: number;
}

/**
 * Declutters the trainee soldiers' symbols without moving them: the selected
 * soldier first, then in scene order, each gets a full symbol unless it would
 * overlap a full symbol already placed, in which case it is drawn compact.
 * A label is shown where it overlaps no symbol or label placed before it; the
 * selected soldier's label is always shown. Compact soldiers hidden under a
 * full symbol are counted on that symbol (`covered`), so a cluster always
 * shows how many it holds.
 */
export function symbolLayout(scene: MapScene): ReadonlyMap<SoldierId, SymbolPlacement> {
  const trainee = scene.soldiers.filter((s) => scene.markings.has(s.id));
  const ordered = [
    ...trainee.filter((s) => s.id === scene.selectedId),
    ...trainee.filter((s) => s.id !== scene.selectedId),
  ];
  const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const symbols: Box[] = [];
  const owners: SoldierId[] = [];
  const labels: Box[] = [];
  const layout = new Map<SoldierId, SymbolPlacement>();
  const covered = new Map<SoldierId, number>();
  const half = SYMBOL_BOX_PX / 2;
  for (const soldier of ordered) {
    const at = worldToScreen(scene.camera, scene.viewport, soldier.position);
    const box = { x0: at.x - half, y0: at.y - half, x1: at.x + half, y1: at.y + half };
    const selected = soldier.id === scene.selectedId;
    const full = selected || !symbols.some((b) => overlaps(b, box));
    if (full) {
      symbols.push(box);
      owners.push(soldier.id);
    } else {
      const under = symbols.findIndex(
        (b) => at.x >= b.x0 && at.x <= b.x1 && at.y >= b.y0 && at.y <= b.y1,
      );
      const owner = owners[under];
      if (owner !== undefined) covered.set(owner, (covered.get(owner) ?? 0) + 1);
    }
    const text = scene.markings.get(soldier.id)?.label ?? '';
    const offset = full ? half + 2 : 6;
    const label = {
      x0: at.x + offset,
      y0: at.y - LABEL_HEIGHT_PX / 2,
      x1: at.x + offset + text.length * LABEL_CHAR_PX,
      y1: at.y + LABEL_HEIGHT_PX / 2,
    };
    const showLabel =
      selected ||
      (full &&
        !labels.some((b) => overlaps(b, label)) &&
        !symbols.some((b) => b !== box && overlaps(b, label)));
    if (showLabel) labels.push(label);
    layout.set(soldier.id, { at, mode: full ? 'full' : 'compact', showLabel, covered: 0 });
  }
  for (const [id, count] of covered) {
    const placement = layout.get(id);
    if (placement) layout.set(id, { ...placement, covered: count });
  }
  return layout;
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
