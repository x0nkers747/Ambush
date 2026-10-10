import {
  orpOutline,
  toVec2,
  TRAINEE_SIDE,
  type AmbushTrigger,
  type DisplayedFacing,
  type Exercise,
  type FireTeamFormation,
  type IndividualIcon,
  type KillZone,
  type OpforRoute,
  type PlannedRoute,
  type SoldierDeploymentPlan,
} from '#exercise';
import type { MapTool, Session } from '#session';
import {
  isOnTerrain,
  type CombatBehavior,
  type DeepReadonly,
  type Side,
  type Soldier,
  type SoldierId,
  type Vec2,
  type Viewshed,
} from '#sim';
import { worldToScreen, type Camera, type Viewport } from './camera';
import { engagementWedge, type EngagementWedge } from './engagement';
import { FACING_REACH, type Affiliation } from './soldier-icons';

// What the map shows and where, in screen pixels, plus hit-testing on it.
// Pure: shared by the renderer and the interaction controller.

/** How a trainee soldier is drawn: its role icon and short role label. */
export interface SoldierMarking {
  /** The slot's individual icon from the organization template (docs/adr/0013); `null`: none defined. */
  readonly icon: IndividualIcon | null;
  /** Short role label from the organization template (e.g. "1-AR"). */
  readonly label: string;
}

export interface MapScene {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly soldiers: readonly DeepReadonly<Soldier>[];
  readonly selectedId: SoldierId | null;
  /** The selected fire team (docs/adr/0022), or `null`; never set together with `selectedId`. */
  readonly selectedTeam: SelectedTeamView | null;
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
  /** Icon and label of each trainee soldier, from the organization template. */
  readonly markings: ReadonlyMap<SoldierId, SoldierMarking>;
  /** The trainee organization's objective rally point, or `null` while the squad is hidden. */
  readonly orp: {
    readonly name: string;
    readonly centre: Vec2;
    readonly outline: readonly Vec2[];
  } | null;
  /** Scenario OPFOR routes the trainee may see, with their walkable paths. */
  readonly opforRoutes: readonly { readonly route: OpforRoute; readonly path: PlannedRoute }[];
  /** The selected soldier's visible area, while the visibility overlay is on. */
  readonly visibility: VisibilityView | null;
  /** The selected Marine's weapon engagement wedge, or `null` (nothing selected, or no weapon range). */
  readonly engagement: EngagementWedge | null;
  /**
   * Every wedge to draw: the selected Marine's, or one for each Marine of the
   * selected fire team that has one, in slot order.
   */
  readonly engagements: readonly EngagementWedge[];
  /** The trainee's ambush trigger, once requested (with OPFOR positions at that moment). */
  readonly trigger: AmbushTrigger | null;
  /** What combat shows, from the start of the engagement (docs/adr/0019); `null` before. */
  readonly combat: CombatView | null;
  /** Whether a map point lies on the terrain. */
  isOnMap(point: Vec2): boolean;
}

/** How long a shot stays drawn, in simulation seconds. */
export const SHOT_DISPLAY_SECONDS = 0.6;

/** A recent shot, drawn as a line from shooter to target. */
export interface ShotView {
  readonly from: Vec2;
  readonly to: Vec2;
  readonly side: Side;
  readonly hit: boolean;
  /** Simulation seconds since the shot, in [0, SHOT_DISPLAY_SECONDS). */
  readonly ageSeconds: number;
}

/** Combat as the map shows it. */
export interface CombatView {
  /** Shots of the last `SHOT_DISPLAY_SECONDS`, oldest first. */
  readonly shots: readonly ShotView[];
  /** Each soldier's part in the engagement. */
  readonly behaviors: ReadonlyMap<SoldierId, CombatBehavior>;
  readonly ended: boolean;
}

/** The selected fire team as the map shows it. */
export interface SelectedTeamView {
  readonly unitId: string;
  readonly name: string;
  /** Its Marines, in formation slot order. */
  readonly memberIds: readonly SoldierId[];
  /** Its formation while plans are editable and a Marine still follows it. */
  readonly formation: FireTeamFormation | undefined;
  /** Whether a map click places the team, and the formation's handles can be dragged. */
  readonly editable: boolean;
}

/** The visibility overlay for the selected soldier, or the union for the selected fire team. */
export interface VisibilityView {
  /** Where the soldier observes from: its destination, or where it stands (a fire team: its first Marine). */
  readonly observer: Vec2;
  /** For a fire team: where each of its Marines observes from. */
  readonly observers?: readonly Vec2[];
  /** For a fire team: its unit id; the viewshed is then the union of its Marines' (docs/adr/0022). */
  readonly team?: string;
  readonly planned: boolean;
  /** The viewshed to draw: from `observer` once ready, otherwise the previous one. */
  readonly viewshed: Viewshed | null;
  /** Whether the viewshed from `observer` is still being computed. */
  readonly pending: boolean;
  /** Whether viewsheds cannot be computed (every worker failed). */
  readonly failed?: boolean;
  /** Whether `viewshed` is the requested one half-computed (every other row). */
  readonly preview?: boolean;
}

/** The scene for the current exercise and session state. */
export function buildScene(
  exercise: Exercise,
  session: Session,
  camera: Camera,
  viewport: Viewport,
  visibility: VisibilityView | null = null,
  /** The trainee's squad is not placed yet: neither it nor its ORP is drawn (or can be selected). */
  hideTrainee = false,
): MapScene {
  const { world } = exercise.simulation;
  const state = hideTrainee
    ? {
        ...exercise.simulation.state,
        soldiers: exercise.simulation.state.soldiers.filter((s) => s.side !== TRAINEE_SIDE),
      }
    : exercise.simulation.state;
  const plans = state.soldiers.flatMap((s) => exercise.displayedPlan(s.id) ?? []);
  const selectedPlan = plans.find((p) => p.soldierId === session.selectedSoldierId);
  const orp = exercise.orp;
  const team = exercise.fireTeams.find((t) => t.unitId === session.selectedFireTeamId);
  const selectedTeam: SelectedTeamView | null = team
    ? {
        unitId: team.unitId,
        name: team.name,
        memberIds: team.memberIds,
        formation: exercise.formation(team.unitId),
        editable: exercise.canEditPlans && session.tool === 'deploy',
      }
    : null;
  const engagement = engagementWedge(exercise, state.soldiers, session.selectedSoldierId);
  return {
    camera,
    viewport,
    soldiers: state.soldiers,
    selectedId: session.selectedSoldierId,
    selectedTeam,
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
          ? [[p.soldierId, { icon: member.icon, label: member.slot.label }] as const]
          : [];
      }),
    ),
    orp: hideTrainee
      ? null
      : {
          name: orp.name,
          centre: { x: orp.centre.east, y: orp.centre.north },
          outline: orpOutline(orp),
        },
    opforRoutes: exercise.opforRoutes.flatMap((route) => {
      const path = exercise.opforRoutePaths.get(route.id);
      return route.shownToTrainee && path ? [{ route, path }] : [];
    }),
    visibility: session.showVisibility ? visibility : null,
    engagement,
    engagements: selectedTeam
      ? selectedTeam.memberIds.flatMap((id) => engagementWedge(exercise, state.soldiers, id) ?? [])
      : engagement
        ? [engagement]
        : [],
    trigger: exercise.trigger,
    combat: combatView(exercise),
    isOnMap: ({ x, y }) => isOnTerrain(world.terrain, x, y),
  };
}

function combatView(exercise: Exercise): CombatView | null {
  const { state, timeSeconds } = exercise.simulation;
  const engagement = state.engagement;
  if (!engagement) return null;
  const position = new Map(state.soldiers.map((s) => [s.id, s.position]));
  const shots: ShotView[] = [];
  const log = exercise.combatLog;
  // The log is in time order: walk back from the newest shot.
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const event = log[i];
    if (event === undefined) continue;
    const age = timeSeconds - event.atSeconds;
    if (age >= SHOT_DISPLAY_SECONDS) break;
    if (event.type !== 'shotFired') continue;
    const from = position.get(event.shooterId);
    const to = position.get(event.targetId);
    if (!from || !to) continue;
    shots.unshift({
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      side: event.shooterSide,
      hit: event.hit,
      ageSeconds: Math.max(0, age),
    });
  }
  return {
    shots,
    behaviors: new Map(engagement.combatants.map((c) => [c.soldierId, c.behavior])),
    ended: engagement.end !== null,
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
/**
 * Diameter of a soldier icon's circle on the map, in CSS pixels. The icon
 * design stays legible from 16 px; the facing triangle extends beyond it.
 */
export const SOLDIER_ICON_PX = 22;
/** The square a full trainee symbol occupies on screen, for decluttering: the circle plus a margin. */
export const SYMBOL_BOX_PX = SOLDIER_ICON_PX + 2;
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
  /**
   * Where the facing arrow's shaft is drawn from: the anchor, or, when the
   * anchor is on the soldier (no destination, or standing on it), a point
   * beyond its icon and facing triangle, so no line is drawn across the icon.
   */
  readonly facingShaftStart: Vec2;
  /** Tip of the facing arrow (the drag handle). */
  readonly facingTip: Vec2;
  readonly facing: DisplayedFacing;
}

/** The icon colour of a soldier's side: the trainee's side is friendly, the other enemy. */
export function affiliationOf(side: Side): Affiliation {
  return side === TRAINEE_SIDE ? 'friendly' : 'enemy';
}

/** Whether a soldier is selected: the selected Marine, or a member of the selected fire team. */
export function isSelected(scene: MapScene, id: SoldierId): boolean {
  return id === scene.selectedId || (scene.selectedTeam?.memberIds.includes(id) ?? false);
}

/** The selected fire team's formation on screen: its centre, line and facing handle. */
export interface FormationGeometry {
  readonly centre: Vec2;
  /** Every slot's point, in slot order. */
  readonly slots: readonly Vec2[];
  /** Tip of the facing arrow from the centre (the drag handle). */
  readonly facingTip: Vec2;
  readonly azimuth: number;
}

export function formationGeometry(scene: MapScene): FormationGeometry | undefined {
  const formation = scene.selectedTeam?.formation;
  if (!formation) return undefined;
  const toScreen = (p: Vec2) => worldToScreen(scene.camera, scene.viewport, p);
  const centre = toScreen(formation.centre);
  return {
    centre,
    slots: formation.slots.map((s) => toScreen(s.point)),
    facingTip: {
      x: centre.x + Math.sin(formation.azimuth) * FACING_ARROW_PX,
      y: centre.y - Math.cos(formation.azimuth) * FACING_ARROW_PX,
    },
    azimuth: formation.azimuth,
  };
}

/** Whether `screen` is on the selected fire team's formation centre (its drag handle). */
export function isOnFormationCentre(scene: MapScene, screen: Vec2): boolean {
  const geometry = formationGeometry(scene);
  return geometry !== undefined && distance(geometry.centre, screen) <= DESTINATION_HIT_RADIUS_PX;
}

/** Whether `screen` is on the formation's facing handle. */
export function isOnFormationFacingHandle(scene: MapScene, screen: Vec2): boolean {
  const geometry = formationGeometry(scene);
  return (
    geometry !== undefined && distance(geometry.facingTip, screen) <= FACING_HANDLE_HIT_RADIUS_PX
  );
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
  const clear =
    distance(facingAnchor, start) <= SOLDIER_ICON_PX / 2 ? FACING_REACH * SOLDIER_ICON_PX + 1 : 0;
  return {
    soldier: start,
    destination,
    path,
    impossible: destination !== null && (leg?.turns ?? null) === null,
    facingAnchor,
    facingShaftStart: {
      x: facingAnchor.x + Math.sin(facing.azimuth) * clear,
      y: facingAnchor.y - Math.cos(facing.azimuth) * clear,
    },
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

/** How a soldier's symbol is drawn after decluttering. */
export interface SymbolPlacement {
  /** The soldier's true position on screen: symbols are never displaced. */
  readonly at: Vec2;
  /** `full`: the full icon; `compact`: a small dot, because it would overlap another symbol. */
  readonly mode: 'full' | 'compact';
  /** Icon colour family, from the soldier's side. */
  readonly affiliation: Affiliation;
  /** Text beside the symbol: the trainee soldier's slot label, or the soldier id. */
  readonly label: string;
  readonly showLabel: boolean;
  /**
   * Compact soldiers standing under this full symbol, where they cannot be seen
   * (shown as "+n" badges, one per affiliation); empty for compact symbols.
   */
  readonly hidden: readonly { readonly id: SoldierId; readonly affiliation: Affiliation }[];
  /** `hidden.length`. */
  readonly covered: number;
}

/**
 * Declutters every soldier's symbol, whatever its side, without moving it:
 * the selected soldiers (a Marine, or a fire team's Marines) first, then in
 * scene order, each gets a full symbol
 * unless it would overlap a full symbol already placed, in which case it is
 * drawn compact (a dot at its true position). A label is shown where it
 * overlaps no symbol or label placed before it; selected soldiers' labels
 * are always shown. Compact soldiers hidden under a full symbol are listed on
 * that symbol (`hidden`), so a cluster always shows how many it holds, and of
 * which affiliation.
 */
export function symbolLayout(scene: MapScene): ReadonlyMap<SoldierId, SymbolPlacement> {
  const ordered = [
    ...scene.soldiers.filter((s) => isSelected(scene, s.id)),
    ...scene.soldiers.filter((s) => !isSelected(scene, s.id)),
  ];
  const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const symbols: Box[] = [];
  const owners: SoldierId[] = [];
  const labels: Box[] = [];
  const layout = new Map<SoldierId, SymbolPlacement>();
  const hidden = new Map<SoldierId, { id: SoldierId; affiliation: Affiliation }[]>();
  const half = SYMBOL_BOX_PX / 2;
  for (const soldier of ordered) {
    const at = worldToScreen(scene.camera, scene.viewport, soldier.position);
    const affiliation = affiliationOf(soldier.side);
    const box = { x0: at.x - half, y0: at.y - half, x1: at.x + half, y1: at.y + half };
    const selected = isSelected(scene, soldier.id);
    const full = selected || !symbols.some((b) => overlaps(b, box));
    if (full) {
      symbols.push(box);
      owners.push(soldier.id);
    } else {
      const under = symbols.findIndex(
        (b) => at.x >= b.x0 && at.x <= b.x1 && at.y >= b.y0 && at.y <= b.y1,
      );
      const owner = owners[under];
      if (owner !== undefined) {
        const list = hidden.get(owner) ?? [];
        list.push({ id: soldier.id, affiliation });
        hidden.set(owner, list);
      }
    }
    const text = scene.markings.get(soldier.id)?.label ?? soldier.id;
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
    layout.set(soldier.id, {
      at,
      mode: full ? 'full' : 'compact',
      affiliation,
      label: text,
      showLabel,
      hidden: [],
      covered: 0,
    });
  }
  for (const [id, list] of hidden) {
    const placement = layout.get(id);
    if (placement) layout.set(id, { ...placement, hidden: list, covered: list.length });
  }
  return layout;
}

/**
 * The trainee soldiers a click at `screen` may select: every one whose symbol
 * box (`SYMBOL_BOX_PX`) contains the point, nearest first (scene order on a
 * tie). Depends only on positions, never on which soldier is selected or drawn
 * in full, so clicking a cluster repeatedly steps through all its soldiers,
 * including those drawn compact or hidden under another symbol.
 */
export function selectableSoldiersAt(scene: MapScene, screen: Vec2): SoldierId[] {
  const half = SYMBOL_BOX_PX / 2;
  return scene.soldiers
    .filter((s) => scene.markings.has(s.id))
    .map((s, order) => {
      const at = worldToScreen(scene.camera, scene.viewport, s.position);
      return { id: s.id, at, order, d: distance(at, screen) };
    })
    .filter(({ at }) => Math.abs(at.x - screen.x) <= half && Math.abs(at.y - screen.y) <= half)
    .sort((a, b) => a.d - b.d || a.order - b.order)
    .map(({ id }) => id);
}

/**
 * The soldier a click at `screen` selects: the nearest selectable one, or, if
 * the selected soldier is among them, the next after it (wrapping round), so
 * repeated clicks on a cluster select each of its soldiers in turn.
 */
export function nextSelectionAt(scene: MapScene, screen: Vec2): SoldierId | undefined {
  const candidates = selectableSoldiersAt(scene, screen);
  const current = scene.selectedId === null ? -1 : candidates.indexOf(scene.selectedId);
  return candidates[current < 0 ? 0 : (current + 1) % candidates.length];
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
