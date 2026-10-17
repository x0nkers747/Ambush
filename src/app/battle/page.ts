import { busy, painted, type BusyTask } from '../busy';
import { followViewLoading } from '../view-loading';
import { emptyMotionSample } from '#exercise';
import {
  clearPlan,
  setOrderFollowRoads,
  setVehicleWaypointRoads,
  deleteOrder,
  reorderOrder,
  setDefendSector,
  setKillZone,
  clearVehicleRoute,
  renameVehicle,
  setVehicleFacing,
  vehicleLabel,
  vehicleShortName,
  vehiclesOf,
  type PlannedVehicle,
  formationsForOrganization,
  ORDER_LABELS,
  ORGANIZATION_LABELS,
  renameSquad,
  scenarioSummary,
  setOrderKind,
  setDefendPrepared,
  setOrderActionsOn,
  ACTIONS_ON_HINTS,
  ACTIONS_ON_LABELS,
  actionsOnOf,
  setSeed,
  setSquadFacing,
  setSquadFormation,
  setSquadAntiTank,
  withoutOrders,
  squadRangeRings,
  vehicleRangeRings,
  type RangeRings,
  ANTI_TANK_LOADOUTS,
  DEFAULT_ANTI_TANK,
  SIDE_VEHICLE_KINDS,
  type AntiTankLoadout,
  setSquadOrganization,
  SQUAD_ORGANIZATIONS,
  squadPlacementProblem,
  type BattleEdit,
  type BattleScenarioDefinition,
  type PlannedOrder,
  type ScenarioIssue,
  type ScenarioSquad,
  type SquadOrganization,
} from '#exercise/battle';
import {
  ACTIONS_ON,
  ORDER_KINDS,
  soldierId,
  surfaceHeightAt,
  type ActionsOn,
  type OrderKind,
  type Side,
  type TerrainDataset,
  type Vec2,
  type VehicleDestination,
  type Viewshed,
  viewshedGrid,
} from '#sim';
import {
  createTacticalMap,
  composeViewsheds,
  createViewshedService,
  drawViewshedOverlay,
  type MapBinding,
  type MapEditor,
  type TacticalMap,
  type ViewshedOverlay,
  type ViewshedService,
  type ViewshedSide,
} from '#view2d';
import type { BattlefieldView3d, CameraPose, UnitMarker } from '#view3d';
import type { HandedView } from '../battlefield-preview';
import {
  createConfirm,
  createToast,
  escapeHtml,
  headerHtml,
  htmlSetter,
  wireHeader,
} from '../shell';
import { STAGE_NAMES, type WorkflowRules } from '../workflow';
import { createCombat, type Combat, type CombatSpeed } from './combat';
import type { SquadStatus, VehicleStatus } from './status';
import {
  createCombatMapEditor,
  pendingAmbush,
  type BattleDisplay,
  type CombatUi,
} from './combat-editor';
import { createLocalDriver, type DriverFactory } from './driver';
import { createWorkerChannel, createWorkerDriver, type BattleChannel } from './worker-combat';
import { createReview, type Review, type ReviewSpeed } from './review';
import {
  momentsHtml,
  phasesHtml,
  reviewToolsHtml,
  timelineMarkersHtml,
  verificationText,
} from './review-panel';
import {
  aarSummaryHtml,
  clockText,
  combatEventsHtml,
  combatHint,
  combatRosterHtml,
  combatSquadHtml,
  combatVehicleHtml,
  vehicleDiagnosticsHtml,
  combatStatusRowsHtml,
  combatToolsHtml,
  playbackRate,
  slowerSpeed,
} from './combat-panel';
import { createBattleMapEditor, createMapShow } from './map-editor';
import {
  createPlanner,
  SECOND_CLICK,
  type BattleStage,
  type PinKind,
  type PlannerTool,
  type ViewshedPin,
} from './planner';

/** A viewshed shown: its pin, its side's colour, what it looks from, and its latest result shown. */
interface ViewshedLayer {
  readonly pin: ViewshedPin;
  readonly side: ViewshedSide;
  readonly look: ViewshedLook | null;
  shown: Viewshed | null;
}

/**
 * A viewshed or waypoint's range rings turned on in a battle (Sim, the
 * review): a unit's own (`orderIndex` null), where it is now; or a
 * waypoint's, with the waypoint's place (`at`), so it follows its order.
 */
interface LivePin extends ViewshedPin {
  readonly kind: PinKind;
  readonly at: Vec2 | null;
}
import {
  liveSquadWaypointObservers,
  plannedVehicleLook,
  SQUAD_VIEWSHED_CELLS_M,
  squadLook,
  vehicleLook,
  vehicleRouteLook,
  viewshedObservers,
  type ViewshedLook,
} from './squad-viewshed';

// Stages 2–5 of a battle on one battlefield (docs/constructive-simulation/03,
// 04): Scenario Setup (place and turn both sides' squads and vehicles),
// Planning (give them all their orders), Combat (the battle
// fought live: play, pause, speed, orders to either side, End Combat) and
// the After-Action Review (its summary; the full replay is milestone D). The workflow header, the map (2D, or 3D through
// the same editor), and a side panel: the stage's tools, the selected squad
// and its plan, the roster by force, and the scenario. Every edit goes
// through the planner (planner.ts) and is saved as it is made.

/** A squad's anti-tank weapons in words, by side (docs/combined-arms.md §9). */
const ANTI_TANK_TEXT: Readonly<Record<Side, Readonly<Record<AntiTankLoadout, string>>>> = {
  BLUEFOR: { none: 'None', rockets: 'AT4', rocketsAndMissile: 'AT4 + Javelin' },
  OPFOR: { none: 'None', rockets: 'RPG-7', rocketsAndMissile: 'RPG-7 + 9K111' },
};
const antiTankOptions = (side: Side, current: AntiTankLoadout | undefined): string =>
  ANTI_TANK_LOADOUTS.map(
    (k) =>
      `<option value="${k}"${(current ?? DEFAULT_ANTI_TANK) === k ? ' selected' : ''}>${escapeHtml(ANTI_TANK_TEXT[side][k])}</option>`,
  ).join('');

/** What a click on the map does with each order tool. */
const ORDER_HINTS: Readonly<Record<OrderKind, string>> = {
  move: 'Click the terrain to add a MOVE order.',
  attack: 'Click the terrain to add an ATTACK order.',
  withdraw: 'Click the terrain to add a WITHDRAW order.',
  ambush: 'Click the terrain at the position of the ambush, then click again to add a kill zone.',
  defend: 'Click the terrain at the position to defend, and click again to set firing arcs.',
};

export interface BattlePageOptions {
  /** Shown in the header: the battlefield's name. */
  readonly title: string;
  readonly terrain: TerrainDataset;
  readonly definition: BattleScenarioDefinition;
  readonly save: (definition: BattleScenarioDefinition) => Promise<void>;
  readonly attribution: readonly string[];
  readonly describePoint?: (point: Vec2) => string;
  readonly infoHtml: string;
  readonly initialStage: 'scenario' | 'bluefor';
  readonly notice?: string | null;
  /** The terrain-selection preview's map of this battlefield, kept as it is; otherwise a new one. */
  readonly map?: TacticalMap | null;
  /** How terrain selection's preview was looked at: in 3D, the page opens in 3D from that camera. */
  readonly view?: HandedView | null;
  /** Back to terrain selection, handing the map over (the page has stopped by then). */
  /** Back to terrain selection with the map; `unload`: the scenario is unloaded (the working scenario emptied). */
  readonly leave: (map: TacticalMap, unload: boolean) => void;
  readonly setAddress: (stage: 'scenario' | 'bluefor') => void;
  /** Scenario management (docs/scenarios.md): only in the planning stages. */
  readonly scenarios: ScenarioMenu;
}

/** What the Scenario menu does; the page's scenario is passed to each action. */
export interface ScenarioMenu {
  /** Its saved state: the saved scenario it is, and whether it has unsaved changes. */
  status(definition: BattleScenarioDefinition): {
    readonly savedName: string | null;
    readonly dirty: boolean;
  };
  run(action: ScenarioAction, scenario: PageScenario): Promise<void>;
  /** New scenario: the working scenario is no longer the saved one it was. */
  detach(): void;
}

export type ScenarioAction = 'save' | 'saveAs' | 'load' | 'import' | 'export';

/** The page's scenario, as the Scenario menu's actions see it. */
export interface PageScenario {
  definition(): BattleScenarioDefinition;
  stage(): 'scenario' | 'bluefor';
  /** Renames the scenario (an edit, saved as edits are). */
  rename(name: string): void;
  /** Leaves for terrain selection, handing the map over. */
  leave(): void;
}

const PLACE_ORGANIZATIONS: readonly SquadOrganization[] = ['squad', 'fireTeam', 'element3'];

/** A road, in `currentColor`, for the Prefer roads toggles. */
const ROAD_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3 4 21M16 3l4 18"/><path d="M12 4v3M12 10.5v3M12 17v3"/></svg>`;

/** A move order's (or a vehicle waypoint's) Prefer roads toggle. */
const roadsButton = (act: string, k: number, on: boolean, editable: boolean): string =>
  `<button class="small roads-toggle" data-act="${act}" data-index="${String(k)}" aria-pressed="${String(on)}"${editable ? '' : ' disabled'} title="Prefer roads: ${on ? 'on' : 'off'}. On, it goes to the nearest road, along the roads (a squad in column), and off them to the waypoint, when the roads help" aria-label="Prefer roads">${ROAD_ICON}</button>`;

/** Three rings round a dot, in `currentColor`, for the range rings toggles. */
const RINGS_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10" stroke-dasharray="2 2.5"/><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/></svg>`;

/**
 * A squad's or vehicle's range rings toggle (lit in its side's colour when
 * on): round it, or (`index`) round its waypoint `index`.
 */
const ringsButton = (id: string, side: Side, on: boolean, index: number | null = null): string => {
  const where = index === null ? '' : ` at waypoint ${String(index + 1)}`;
  return `<button class="small vs-toggle rings-toggle ${side === 'BLUEFOR' ? 'blue' : 'red'}" data-act="range-rings" data-unit="${escapeHtml(id)}"${index === null ? '' : ` data-index="${String(index)}"`} aria-pressed="${String(on)}" title="Range rings${where}: ${on ? 'on' : 'off'}. How far it sees (dotted), the furthest it fires (dashed), and its main weapon's maximum effective range (solid). The Range rings box on the map bar shows or hides them all" aria-label="Range rings${where}">${RINGS_ICON}</button>`;
};

/** An eye, in `currentColor`, for the viewshed toggles. */
const EYE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;

const HELP_HTML = `<dl class="kv help">
  <dt>Setup</dt><dd>Place both sides' squads and vehicles: pick the side and organization, then click the map. Drag one to move it, drag the white knob to turn it</dd>
  <dt>Orders</dt><dd>In Planning, select a squad (either side) or vehicle, pick an order and click the map: each click adds one, after the selected order. An ambush's second click sets its kill zone (drag its corners to resize it); a defence's sets its direction (drag the square on its edge to widen it, the circle at its middle to turn it)</dd>
  <dt>Drag</dt><dd>A waypoint to move its destination</dd>
  <dt>Right-click</dt><dd>A waypoint to delete its order</dd>
  <dt>Esc</dt><dd>Back to the Select tool; again, clears the selection</dd>
  <dt>Rings</dt><dd>Turns a squad's or vehicle's range rings on or off, round it or round a waypoint (the rings button by its name, or by the waypoint): how far it sees (dotted), the furthest it fires (dashed), its main weapon's maximum effective range (solid). The Range rings box on the map bar shows or hides them all</dd>
  <dt>Eye</dt><dd>Turns the viewshed of a squad or vehicle (from its start; in Sim, where it is) or of a waypoint on or off: what its soldiers can see, all round to 1,200 m, or its crew from its turret, as far as its sights see. BLUEFOR's are light blue, OPFOR's light red, ground both see purple; any number can be on. The Viewsheds box on the map bar shows or hides them all</dd>
</dl>
<p class="hint">Orders: <b>Move</b> goes to the destination, halting to fight on contact and carrying on;
<b>Attack</b> takes and clears the objective, assaulting with fire and movement; <b>Withdraw</b> falls back
without halting to fight; <b>Ambush</b> goes to the ambush position and lies in wait, concealed, facing its
kill zone: it opens fire when the enemy is in the kill zone, then holds there until ordered on; <b>Defend</b> goes to the
defensive position, deploys across its sector and digs in (full after 30 minutes), fighting from there until ordered on. Contact interrupts an order: the squad reacts on its own, then resumes it.
A squad with no orders left holds where it is.</p>`;

const sideClass = (side: Side) => (side === 'BLUEFOR' ? 'blue' : 'red');

export function startBattlePage(app: HTMLElement, o: BattlePageOptions): () => void {
  app.className = 'workspace battle';
  app.innerHTML = `
  ${headerHtml(o.title)}
  <main class="ws-map">
    <div class="ws-canvas">
      <canvas id="map" aria-label="Tactical map"></canvas>
      <div class="attribution" data-ui="attribution" hidden></div>
      <div class="confirm" data-ui="confirm" hidden></div>
      <div class="toast" data-ui="toast" role="status" hidden></div>
    </div>
    <div class="mapbar">
      <span class="pointer" data-ui="pointer"></span>
      <span class="spacer"></span>
      <span class="mapbar-tool" data-ui="viewshed-status"></span>
      <label class="mapbar-check" data-ui="rings-toggle" title="Show or hide every range ring turned on (each squad's or vehicle's rings button, in its panel)">
        <input type="checkbox" data-ui="show-rings" checked> Range rings
      </label>
      <label class="mapbar-check" data-ui="viewshed-toggle" title="Show or hide every viewshed turned on (each squad's start or waypoint: its eye in the squad panel)">
        <input type="checkbox" data-ui="show-viewshed" checked> Viewsheds
      </label>
      <label class="mapbar-check" data-ui="opfor-toggle" title="Show the OPFOR squads and vehicles, and their plans">
        <input type="checkbox" data-ui="show-opfor" checked> Show OPFOR
      </label>
      <label class="mapbar-check" data-ui="waypoints-toggle" title="Hide every waypoint and route (with defences' sectors and ambushes' kill zones), in 2D and 3D: only the units are shown">
        <input type="checkbox" data-ui="hide-waypoints"> Hide waypoints
      </label>
      <span class="mapbar-tool" data-ui="tool-label"></span>
      <div class="view-toggle" role="group" aria-label="Map view">
        <button class="small" data-view="2d" aria-pressed="true" title="The 2D tactical map">2D</button>
        <button class="small" data-view="3d" aria-pressed="false" title="The 3D battlefield view">3D</button>
      </div>
      <button class="small" data-ui="fit" title="Fit the whole map">Fit map</button>
    </div>
  </main>
  <aside class="side" aria-label="Stage tools and status">
    <div class="primary-action">
      <button class="primary-btn" data-ui="primary"></button>
      <div class="readiness" data-ui="readiness"></div>
    </div>
    <section class="sec" data-sec="tools">
      <h2 data-ui="tools-title"></h2>
      <div data-ui="tools"></div>
      <p class="hint" data-ui="tool-hint"></p>
    </section>
    <section class="sec" data-sec="squad">
      <h2 data-ui="squad-title">Selected squad</h2>
      <div data-ui="squad"></div>
    </section>
    <section class="sec" data-sec="roster">
      <h2>Roster by force</h2>
      <div data-ui="roster"></div>
    </section>
    <section class="sec" data-sec="scenario">
      <h2>Scenario</h2>
      <div data-ui="scenario"></div>
      <p class="scn-status" data-ui="scn-status"></p>
      <div class="tool-row">
        <details class="scn-menu" data-ui="scn-menu">
          <summary title="Save, load, import or export scenarios">Scenario ▾</summary>
          <div class="scn-menu-items" role="menu">
            <button role="menuitem" data-act="scn-save" title="Save this scenario in the browser">Save scenario</button>
            <button role="menuitem" data-act="scn-saveAs" title="Save a copy under a new name">Save as…</button>
            <button role="menuitem" data-act="scn-load" title="Open a saved scenario (from terrain selection)">Load scenario…</button>
            <button role="menuitem" data-act="scn-import" title="Load a scenario file (.ambush.json)">Import scenario…</button>
            <button role="menuitem" data-act="scn-export" title="Download this scenario as a file">Export scenario…</button>
          </div>
        </details>
        <button class="small" data-act="scn-save" title="Save this scenario in the browser">Save</button>
        <button class="small" data-act="new-scenario" data-ui="new-scenario" title="Start again: no squads">New scenario</button>
      </div>
    </section>
    <details class="sec collapsible" data-sec="events" open>
      <summary>Event log</summary>
      <ul class="events" data-ui="events"></ul>
    </details>
    <details class="sec collapsible" data-sec="help">
      <summary>Help</summary>
      ${HELP_HTML}
    </details>
    <details class="sec collapsible" data-sec="info">
      <summary>Battlefield Information</summary>
      <div class="bf-info">${o.infoHtml}</div>
    </details>
  </aside>`;

  const ui = (name: string): HTMLElement => {
    const element = app.querySelector<HTMLElement>(`[data-ui="${name}"]`);
    if (!element) throw new Error(`Missing UI element ${name}`);
    return element;
  };
  const setHtml = htmlSetter();
  const setText = (element: HTMLElement, text: string) => {
    if (element.textContent !== text) element.textContent = text;
  };
  const notify = createToast(ui('toast'));
  const confirm = createConfirm(ui('confirm'));

  const planner = createPlanner({
    terrain: o.terrain,
    definition: o.definition,
    stage: o.initialStage,
    save: o.save,
    notify,
  });
  /** What the map shows (the map bar's boxes, each unit's range rings), in every stage. */
  const show = createMapShow();
  const editor = createBattleMapEditor(planner, show);

  /** The viewsheds turned on ("Viewsheds", below); declared first, as the map draws them. */
  const viewshed = {
    service: null as ViewshedService | null,
    /** Each viewshed shown, by pin (`squad|order`): its observers, and the latest result shown. */
    layers: new Map<string, ViewshedLayer>(),
    /** The scenario version and pins the layers' observers were worked out for. */
    key: '',
    /** The results composed into `overlay`, in order. */
    composed: [] as (Viewshed | null)[],
    overlay: null as ViewshedOverlay | null,
    pending: false,
    /** Whether something on the map is being dragged (a squad, a waypoint, a kill zone's corner). */
    dragging: false,
    /** The 3D view the overlay was given to. */
    on3d: null as BattlefieldView3d | null,
  };
  /** In a battle (Sim, the review): the viewsheds and waypoint rings turned on there (`LivePin`). */
  let livePins: LivePin[] = [];
  /** In a battle: each waypoint's look, by the waypoint, the one before it and its unit (`lookOf`). */
  const liveWaypointLooks = new Map<string, ViewshedLook | null>();

  // --- Combat (docs/constructive-simulation/04) ------------------------------

  /**
   * The battle worker (docs/constructive-simulation/04), started with the
   * first battle and kept until the page is left: Combat and the review
   * simulate there, so the page keeps drawing whatever a battle costs.
   * Where workers are not available, battles are simulated on the page.
   */
  let channel: BattleChannel | null = null;
  let driverFactory: DriverFactory | null = null;
  const battleDriver = (): DriverFactory => {
    if (!driverFactory) {
      if (typeof Worker === 'undefined') driverFactory = createLocalDriver(o.terrain);
      else {
        channel = createWorkerChannel();
        driverFactory = createWorkerDriver(channel, o.terrain);
      }
    }
    return driverFactory;
  };
  /** The battle being fought (Combat), or fought (until the review replaces it). */
  let combat: Combat | null = null;
  /** The After-Action Review of the battle fought: its replay from tick 0. */
  let review: Review | null = null;
  const combatUi: CombatUi = {
    selected: null,
    selectedOrder: null,
    tool: null,
    ambush: null,
    second: null,
  };
  /** The live battle, in Combat. */
  const inCombat = (): Combat | null => (planner.stage === 'combat' ? combat : null);
  /** The replayed battle, in the review. */
  const inReview = (): Review | null => (planner.stage === 'aar' ? review : null);
  const combatDisplay = (c: Combat): BattleDisplay => ({
    motion: c.session.motion,
    events: c.session.events,
    terrain: o.terrain,
    renderSeconds: c.renderSeconds,
    battle: c.session.battle,
    squads: () => c.squads(),
    squad: (id) => c.squad(id),
    vehicles: () => c.vehicles(),
    // Live, the plans are edited as in planning; once the battle has ended, not.
    ...(c.ended
      ? {}
      : {
          edit: {
            terrain: o.terrain,
            plan: (id: string) => c.plan(id),
            editPlan: (id: string, change: (d: BattleScenarioDefinition) => BattleEdit) =>
              c.editPlan(id, change),
            previewPlan: (id: string, change: (d: BattleScenarioDefinition) => BattleEdit) =>
              c.previewPlan(id, change),
            vehicleRoute: (id: string) => c.vehicleRoute(id),
            setVehicleRoute: (id: string, route: readonly VehicleDestination[]) =>
              c.setVehicleRoute(id, route),
          },
        }),
  });
  const reviewDisplay = (r: Review): BattleDisplay => ({
    motion: r.replay.motion,
    events: r.replay.events,
    terrain: o.terrain,
    renderSeconds: r.seconds,
    battle: r.replay.battle,
    squads: () => r.squads(),
    squad: (id) => r.squad(id),
    vehicles: () => r.vehicles(),
  });
  /** What the map draws of a battle now: the live one, the replayed one, or none (planning). */
  const display = (): BattleDisplay | null => {
    const c = inCombat();
    if (c) return combatDisplay(c);
    const r = inReview();
    return r ? reviewDisplay(r) : null;
  };
  const combatEditor = createCombatMapEditor(
    display,
    combatUi,
    notify,
    (id) => planner.squad(id)?.organization ?? 'squad',
    show,
  );
  const current = (): MapEditor => (display() ? combatEditor : editor);
  /** The map's editor: the planner's, or in Combat and the review, the battle's. */
  const mapEditor: MapEditor = {
    press: (point, screen, button) => {
      // A press the editor claims starts a drag (others pan the map).
      viewshed.dragging = current().press?.(point, screen, button) ?? false;
      return viewshed.dragging;
    },
    drag: (point) => current().drag?.(point),
    drop: (point) => {
      viewshed.dragging = false;
      current().drop?.(point);
    },
    click: (point, screen) => {
      current().click(point, screen);
    },
    cursor: (point, screen) => current().cursor?.(point, screen) ?? null,
    draw: (ctx, toScreen, perspective) => {
      // The viewsheds under everything (in 3D they are on the ground itself).
      if (!perspective && viewshed.overlay) drawViewshedOverlay(ctx, viewshed.overlay, toScreen);
      current().draw?.(ctx, toScreen, perspective);
      drawViewshedMarks(ctx, toScreen);
    },
  };
  /** The page's gates: the planner's, and the battle's own (it ends only when the user ends it). */
  const rules: WorkflowRules = {
    next: (stage) =>
      stage === 'combat'
        ? combat?.ended === true
          ? null
          : 'End the combat first: the battle runs until you end it.'
        : planner.rules.next(stage),
    back: (to) => {
      if (planner.stage === 'aar' && to === 'combat')
        return 'The battle has ended: go back to Planning to fight it again.';
      return null;
    },
  };

  // --- Map --------------------------------------------------------------

  const placeholder = app.querySelector<HTMLCanvasElement>('#map');
  if (!placeholder) throw new Error('Missing map canvas');
  // The map draws the terrain; the battle (its planner, or its combat and review) draws over it.
  const binding: MapBinding = { editor: mapEditor };
  const adopt = (handed: TacticalMap): TacticalMap => {
    const canvas = handed.canvas;
    canvas.id = 'map';
    canvas.className = '';
    canvas.setAttribute('aria-label', 'Tactical map');
    placeholder.replaceWith(canvas);
    handed.attach(binding);
    return handed;
  };
  const map = o.map
    ? adopt(o.map)
    : createTacticalMap({ canvas: placeholder, terrain: o.terrain, ...binding });

  // --- 2D / 3D -----------------------------------------------------------

  let viewMode: '2d' | '3d' = '2d';
  let view3d: BattlefieldView3d | null = null;
  let loading3d = false;
  let stopped = false;
  /** The loading overlay while a battle starts, or `null`. */
  let startingTask: BusyTask | null = null;
  /** Terrain selection's 3D camera, for the 3D view when it opens. */
  let handedPose: CameraPose | null = null;
  const FOV_HALF_TAN = Math.tan((22.5 * Math.PI) / 180);
  const carryFocus = (to: '2d' | '3d') => {
    if (!view3d) return;
    const height = map.canvas.getBoundingClientRect().height;
    if (to === '3d') {
      const { centre, metersPerPixel } = map.view;
      view3d.focusOn(centre, (metersPerPixel * height) / (2 * FOV_HALF_TAN));
    } else {
      const focus = view3d.focus();
      if (focus)
        map.setView(focus.point, (2 * FOV_HALF_TAN * focus.distance) / Math.max(height, 1));
    }
  };
  const centreOn = (point: Vec2) => {
    if (viewMode === '3d' && view3d) view3d.focusOn(point);
    else map.centreOn(point);
  };
  /** The battle's soldiers where they start, for the 3D view (selected squad highlighted). */
  let combatWeapons: { battle: object; weapons: Record<string, string | null> } | null = null;
  const figureSample = emptyMotionSample();
  /** The battle the 3D view shows: live (Combat) or at the playhead (the review). */
  const shownBattle = () => {
    const c = inCombat();
    if (c)
      return {
        battle: c.session.battle,
        log: c.session.motion,
        combatLog: c.session.combatLog,
        seconds: c.renderSeconds,
        ended: c.ended,
        timeScale: playbackRate(c),
      };
    const r = inReview();
    if (r)
      return {
        battle: r.replay.battle,
        log: r.replay.motion,
        combatLog: r.replay.combatLog,
        seconds: r.seconds,
        ended: false,
        timeScale: r.speed as number,
      };
    return null;
  };
  const figures = () => {
    const c = shownBattle();
    if (c) {
      if (combatWeapons?.battle !== c.battle) {
        const weapons: Record<string, string | null> = {};
        for (const squad of c.battle.squads) Object.assign(weapons, squad.displayWeapons);
        combatWeapons = { battle: c.battle, weapons };
      }
      const selected = combatUi.selected;
      // Where each soldier is at the time drawn (the motion log: the battle may run on elsewhere).
      const tick = Math.floor(c.seconds * c.log.tickRateHz);
      const units: UnitMarker[] = c.battle.squads.flatMap((squad) =>
        (show.showOpfor || squad.side === 'BLUEFOR' ? squad.soldierIds : []).map((id) => {
          c.log.read(c.log.indexOf(id), tick, figureSample);
          return {
            id: soldierId(id),
            affiliation: squad.side === 'BLUEFOR' ? ('friendly' as const) : ('enemy' as const),
            position: { x: figureSample.x, y: figureSample.y, z: figureSample.z },
            azimuth: figureSample.azimuth,
            posture: figureSample.posture,
            status: figureSample.status,
            selected: squad.spec.id === selected,
          };
        }),
      );
      // Fighting positions dug by defences, as the battle reports them.
      const squads = inCombat()?.squads() ?? inReview()?.squads() ?? [];
      return {
        units,
        clock: {
          log: c.log,
          combatLog: c.combatLog,
          seconds: c.seconds,
          ended: c.ended,
          timeScale: c.timeScale,
        },
        weapons: combatWeapons.weapons,
        earthworks: squads.flatMap((s) => s.earthworks),
        vehicles: (inCombat()?.vehicles() ?? inReview()?.vehicles() ?? [])
          .filter((v) => show.showOpfor || v.side === 'BLUEFOR')
          .map((v) => ({
            id: v.id,
            side: v.side,
            kind: v.kind,
          })),
      };
    }
    const f = planner.figures();
    const selected = planner.selection.squadId;
    const hidden = (side: Side) => side === 'OPFOR' && !show.showOpfor;
    const units: UnitMarker[] = f.soldiers
      .filter((s) => !hidden(s.side))
      .map((s) => ({
        id: s.id,
        affiliation: s.side === 'BLUEFOR' ? 'friendly' : 'enemy',
        position: s.position,
        azimuth: s.azimuth,
        posture: s.posture,
        status: 'active',
        selected: selected !== null && s.id.startsWith(`${selected}-`),
      }));
    return {
      units,
      clock: { log: f.log, combatLog: [], seconds: 0 },
      weapons: f.weapons,
      vehicles: f.vehicles
        .filter((v) => !hidden(v.side))
        .map((v) => ({ id: v.id, side: v.side, kind: v.kind })),
    };
  };
  const showViewMode = () => {
    for (const b of app.querySelectorAll<HTMLButtonElement>('[data-view]'))
      b.setAttribute('aria-pressed', String(b.dataset['view'] === viewMode));
    if (view3d) {
      view3d.canvas.hidden = viewMode !== '3d';
      view3d.overlay.hidden = viewMode !== '3d';
    }
    map.canvas.style.visibility = viewMode === '3d' && view3d ? 'hidden' : '';
    app.dataset['view'] = viewMode;
    setText(ui('fit'), viewMode === '3d' ? 'Reset view' : 'Fit map');
    showAttribution();
  };
  const connect3d = (v: BattlefieldView3d) => {
    const surface = map.surface(
      () => v.projection(),
      () => {
        const rect = v.canvas.getBoundingClientRect();
        return { width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) };
      },
    );
    v.setPointerHandler({
      press: (p, button) => surface.press(p, button),
      drag: (p) => {
        surface.drag(p);
      },
      release: (p) => {
        surface.release(p);
      },
      click: (p, button) => {
        surface.click(p, button);
      },
      hover: (p) => surface.hover(p),
    });
    v.setOverlayPainter((ctx) => {
      surface.draw(ctx);
    });
  };
  const setViewMode = (mode: '2d' | '3d') => {
    if (mode === '2d' || view3d) {
      if (mode !== viewMode) carryFocus(mode);
      viewMode = mode;
      showViewMode();
      return;
    }
    if (loading3d) return;
    loading3d = true;
    notify('Loading the 3D view…');
    // Building the view holds the page: the progress overlay is up until its first frame.
    const task = busy('Loading the 3D view…', null, { immediate: true });
    import('#view3d')
      .then(async ({ createBattlefieldView3d }) => {
        await painted();
        loading3d = false;
        if (stopped) {
          task.done();
          return;
        }
        view3d = createBattlefieldView3d({ terrain: o.terrain, figures });
        ui('attribution').before(view3d.canvas, view3d.overlay);
        connect3d(view3d);
        viewMode = '3d';
        showViewMode();
        const opened = view3d;
        const pose = handedPose;
        handedPose = null;
        // The bar stays until the view is all in: ground, buildings, trees, soldiers.
        followViewLoading(
          () => opened.loading(),
          task,
          () => {
            task.done();
          },
          () => view3d === opened && !stopped,
        );
        requestAnimationFrame(() => {
          if (view3d !== opened || viewMode !== '3d') return;
          // From terrain selection's 3D camera, exactly; else where the 2D map looked.
          if (pose) opened.setCameraPose(pose);
          else carryFocus('3d');
        });
        notify('');
      })
      .catch((error: unknown) => {
        task.done();
        loading3d = false;
        notify(
          `The 3D view could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  for (const b of app.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    b.addEventListener('click', () => {
      setViewMode(b.dataset['view'] === '3d' ? '3d' : '2d');
    });
  }
  const fitView = () => {
    if (viewMode === '3d' && view3d) view3d.resetView();
    else map.fitView();
  };
  ui('fit').addEventListener('click', fitView);
  const MODEL_CREDITS = [
    '3D soldier: Microsoft Rocketbox (MIT)',
    'AK-47: "Assault Rifle" by Zsky (CC BY 3.0)',
  ];
  const showAttribution = () => {
    const three = viewMode === '3d' && view3d !== null;
    const lines = [...o.attribution, ...(three ? MODEL_CREDITS : [])];
    ui('attribution').hidden = lines.length === 0;
    if (lines.length === 0) return;
    setText(
      ui('attribution'),
      [
        ...o.attribution.map((line) => line.replace(/^Map data /, '')).slice(0, 2),
        ...(three ? MODEL_CREDITS : []),
      ].join(' · '),
    );
    ui('attribution').title = lines.join('\n');
  };
  showAttribution();
  // --- Viewsheds -------------------------------------------------------------

  /**
   * The viewsheds turned on (squad-viewshed.ts): each a squad's (the union of
   * its soldiers' viewsheds) or a vehicle's (from its turret, at its sights'
   * height), from where it starts or one of its waypoints; in a battle (Sim,
   * the review), from where it is now, or a waypoint of its orders as they
   * stand. BLUEFOR's light blue, OPFOR's light red, ground both see purple.
   * Computed by the viewshed workers one at a time: the selected unit's first,
   * then the latest turned on. Each shows a coarse look first, then full
   * detail; until its first look is in, the last it showed (so a dragged
   * waypoint's, or a moving unit's, follows it).
   */
  const showViewshed = ui('show-viewshed') as HTMLInputElement;
  showViewshed.addEventListener('change', () => {
    showViewshed.blur();
  });
  const fineGrid = viewshedGrid(o.terrain, SQUAD_VIEWSHED_CELLS_M.at(-1) ?? 4);
  const mapPoint = (p: { readonly east: number; readonly north: number }): Vec2 => ({
    x: p.east,
    y: p.north,
  });
  /** In a battle (Sim, the review): the battle drawn; in planning, `null`. */
  const battleShown = (): { readonly c: Combat | null; readonly d: BattleDisplay } | null => {
    const d = display();
    return d ? { c: inCombat(), d } : null;
  };
  /** A unit's side (planned, or in the battle), or `null` when it is gone. */
  const unitSide = (id: string): Side | null => {
    const shown = battleShown();
    if (shown)
      return shown.d.squad(id)?.side ?? shown.d.vehicles().find((v) => v.id === id)?.side ?? null;
    return planner.squad(id)?.side ?? planner.vehicle(id)?.side ?? null;
  };
  /**
   * A battle's waypoints of unit `id` as its orders stand (live: its plan or
   * route as edited; the review: none), or `null` for none.
   */
  const liveWaypoints = (id: string): Vec2[] | null => {
    const c = inCombat();
    if (!c) return null;
    if (c.squad(id)) return c.plan(id).map((order) => mapPoint(order.destination));
    if (c.vehicle(id)) return c.vehicleRoute(id).map((p) => ({ x: p.x, y: p.y }));
    return null;
  };
  /**
   * Keeps the battle's pins on their waypoints: a waypoint's pin holds its
   * place, so as orders are done (the plan moves up) or moved it follows its
   * own; dragged (no waypoint there any more), it keeps its place in the
   * order. Pins of waypoints gone, or of units gone, go.
   */
  const syncLivePins = () => {
    const kept: LivePin[] = [];
    for (const pin of livePins) {
      if (unitSide(pin.unitId) === null) continue;
      if (pin.orderIndex === null) {
        kept.push(pin);
        continue;
      }
      const points = liveWaypoints(pin.unitId);
      // The review shows only where units are.
      if (!points) continue;
      const at = pin.at;
      let k = at ? points.findIndex((p) => Math.hypot(p.x - at.x, p.y - at.y) < 0.5) : -1;
      if (k < 0) k = pin.orderIndex < points.length ? pin.orderIndex : -1;
      const point = points[k];
      if (!point) continue;
      kept.push(
        k === pin.orderIndex && at?.x === point.x && at.y === point.y
          ? pin
          : { ...pin, orderIndex: k, at: point },
      );
    }
    if (kept.length !== livePins.length || kept.some((p, i) => p !== livePins[i])) livePins = kept;
  };
  /** The pins of a kind shown now: the planner's in planning, the battle's in a battle. */
  const pinsOf = (kind: PinKind): readonly ViewshedPin[] => {
    if (!battleShown()) return kind === 'viewshed' ? planner.viewsheds() : planner.waypointRings();
    return livePins.filter((p) => p.kind === kind);
  };
  const hasPin = (kind: PinKind, id: string, index: number | null): boolean =>
    pinsOf(kind).some((p) => p.unitId === id && p.orderIndex === index);
  /** Turns a unit's (or a waypoint's) viewshed or waypoint rings on or off, in planning or in the battle. */
  const togglePin = (kind: PinKind, id: string, index: number | null) => {
    if (!battleShown()) {
      if (kind === 'viewshed') planner.toggleViewshed(id, index);
      else if (index !== null) planner.toggleWaypointRings(id, index);
    } else if (hasPin(kind, id, index)) {
      livePins = livePins.filter(
        (p) => p.kind !== kind || p.unitId !== id || p.orderIndex !== index,
      );
    } else {
      const at = index === null ? null : (liveWaypoints(id)?.[index] ?? null);
      if (index !== null && !at) return;
      livePins = [...livePins, { kind, unitId: id, orderIndex: index, at }];
    }
    // Turning one on shows them all again.
    if (kind === 'rings' && hasPin(kind, id, index) && !showRings.checked) {
      showRings.checked = true;
      show.rangeRings = true;
    }
    lastVersion = -1;
    combatPanelsAt = -Infinity;
    reviewPanelsAt = -Infinity;
  };
  /** A battle starts: its pins are those turned on in planning (a unit's own, where it is). */
  const startLivePins = () => {
    const at = (id: string, k: number | null) => {
      if (k === null) return null;
      const s = planner.squad(id);
      const p = s ? s.plan[k]?.destination : planner.vehicle(id)?.route[k];
      return p ? mapPoint(p) : null;
    };
    liveWaypointLooks.clear();
    livePins = [
      ...planner
        .viewsheds()
        .map((p) => ({ kind: 'viewshed' as const, ...p, at: at(p.unitId, p.orderIndex) })),
      ...planner
        .waypointRings()
        .map((p) => ({ kind: 'rings' as const, ...p, at: at(p.unitId, p.orderIndex) })),
    ];
  };
  /** Where a unit is now in the battle drawn: its active soldiers, or its hull (heading). */
  const unitNow = (
    d: BattleDisplay,
    id: string,
  ):
    | { readonly soldiers: Vec2[]; readonly centre: Vec2 }
    | { readonly vehicle: VehicleStatus }
    | null => {
    const v = d.vehicles().find((x) => x.id === id);
    if (v) return v.condition === 'destroyed' ? null : { vehicle: v };
    const squad = d.battle.squads.find((s) => s.spec.id === id);
    if (!squad) return null;
    const tick = Math.floor(d.renderSeconds * d.motion.tickRateHz);
    const soldiers: Vec2[] = [];
    for (const sid of squad.soldierIds) {
      d.motion.read(d.motion.indexOf(sid), tick, figureSample);
      if (figureSample.status === 'active') soldiers.push({ x: figureSample.x, y: figureSample.y });
    }
    if (soldiers.length === 0) return null;
    const centre = {
      x: soldiers.reduce((n, p) => n + p.x, 0) / soldiers.length,
      y: soldiers.reduce((n, p) => n + p.y, 0) / soldiers.length,
    };
    return { soldiers, centre };
  };
  /** What a pin's viewshed is worked out from now, or `null` when there is nothing to look from. */
  const lookOf = (pin: ViewshedPin): ViewshedLook | null => {
    const shown = battleShown();
    if (!shown) {
      if (planner.vehicle(pin.unitId))
        return plannedVehicleLook(planner.definition, pin.unitId, pin.orderIndex);
      const observers = viewshedObservers(
        o.terrain,
        planner.definition,
        pin.unitId,
        pin.orderIndex,
      );
      return observers ? squadLook(observers) : null;
    }
    const now = unitNow(shown.d, pin.unitId);
    if (!now) return null;
    if (pin.orderIndex === null)
      return 'vehicle' in now
        ? vehicleLook(now.vehicle.kind, now.vehicle.position, now.vehicle.heading)
        : squadLook(now.soldiers);
    // A waypoint: the unit there, facing the way it will have come. Kept
    // while the waypoint and the one before it stay where they are: coming
    // from where the unit is (its first), the way it faces would change as it
    // moves, and the viewshed be worked out again and again.
    const points = liveWaypoints(pin.unitId);
    const at = points?.[pin.orderIndex];
    const c = shown.c;
    if (!points || !at || !c) return null;
    const before = pin.orderIndex > 0 ? points[pin.orderIndex - 1] : undefined;
    const key = `${pin.unitId}|${String(pin.orderIndex)}|${String(at.x)},${String(at.y)}|${before ? `${String(before.x)},${String(before.y)}` : 'here'}`;
    const kept = liveWaypointLooks.get(key);
    if (kept !== undefined) return kept;
    let look: ViewshedLook | null;
    if ('vehicle' in now) {
      const v = now.vehicle;
      look = vehicleRouteLook(v.kind, v.position, v.heading, points, pin.orderIndex);
    } else {
      const observers = liveSquadWaypointObservers(
        o.terrain,
        planner.definition,
        pin.unitId,
        now.centre,
        c.plan(pin.unitId),
        pin.orderIndex,
      );
      look = observers ? squadLook(observers) : null;
    }
    liveWaypointLooks.set(key, look);
    return look;
  };
  /** Where a pin is marked on the map (and its waypoint rings drawn): its unit now, its start or its waypoint. */
  const pinPoint = (pin: ViewshedPin): Vec2 | null => {
    const shown = battleShown();
    if (!shown) {
      const s = planner.squad(pin.unitId);
      const v = planner.vehicle(pin.unitId);
      const at =
        pin.orderIndex === null
          ? (s ?? v)?.position
          : (s?.plan[pin.orderIndex]?.destination ?? v?.route[pin.orderIndex]);
      return at ? mapPoint(at) : null;
    }
    if (pin.orderIndex !== null) return liveWaypoints(pin.unitId)?.[pin.orderIndex] ?? null;
    const now = unitNow(shown.d, pin.unitId);
    if (!now) return null;
    return 'vehicle' in now ? now.vehicle.position : now.centre;
  };
  /** The viewsheds to show now, if shown, and OPFOR's unless OPFOR is hidden. */
  const shownPins = (): readonly ViewshedPin[] => {
    if (!showViewshed.checked) return [];
    return pinsOf('viewshed').filter((p) => showOpfor.checked || unitSide(p.unitId) !== 'OPFOR');
  };
  const pinKey = (p: ViewshedPin) => `${p.unitId}|${String(p.orderIndex)}`;
  /** As far as a layer's viewshed is ready (the first look, then each refinement), working on it if `work`. */
  const layerResult = (look: ViewshedLook, service: ViewshedService, work: boolean) => {
    const { observers, sectors } = look;
    const [firstCell, ...finer] = SQUAD_VIEWSHED_CELLS_M;
    if (!work) {
      let best = service.cachedUnion(observers, firstCell, sectors);
      for (const cell of finer) {
        if (!best) break;
        const fine = service.cachedRefined(observers, cell, sectors);
        if (!fine) break;
        best = fine;
      }
      return best;
    }
    const coarse = service.requestUnion(observers, firstCell, sectors);
    // Until the first look is in: its half-way rows, if any.
    if (coarse.pending) return coarse.preview ? coarse.viewshed : null;
    let best = coarse.viewshed;
    for (const cell of finer) {
      if (!best) break;
      const fine = service.requestRefined(observers, cell, sectors, best);
      if (fine.pending) return fine.preview ? fine.viewshed : best;
      best = fine.viewshed;
    }
    return best;
  };
  /** In a battle, where units look from is worked out again this often (ms): they move. */
  const LIVE_LOOK_MS = 1500;
  let liveLookAt = -Infinity;
  /** The unit selected (being dragged, its viewsheds first). */
  const selectedUnit = (): { readonly id: string | null; readonly orderIndex: number | null } =>
    battleShown()
      ? { id: combatUi.selected, orderIndex: combatUi.selectedOrder }
      : {
          id: planner.selection.squadId ?? planner.selection.vehicleId ?? null,
          orderIndex: planner.selection.orderIndex,
        };
  const updateViewshed = () => {
    if (battleShown()) syncLivePins();
    // Viewsheds shown: the workers start now, before any is turned on.
    if (showViewshed.checked && !viewshed.service) {
      viewshed.service = createViewshedService(o.terrain);
      viewshed.service.warmUp();
    }
    const sel = selectedUnit();
    // While a unit, a waypoint or a kill zone's corner is dragged nothing is
    // worked out (it slowed the drag): the dragged unit's viewsheds are hidden,
    // the rest stay as they are; on release they are worked out again.
    if (viewshed.dragging) {
      if ([...viewshed.layers.values()].some((l) => l.pin.unitId === sel.id)) {
        viewshed.layers = new Map([...viewshed.layers].filter(([, l]) => l.pin.unitId !== sel.id));
        showComposed();
      }
      viewshed.pending = false;
      setText(ui('viewshed-status'), '');
      return;
    }
    const pins = shownPins();
    const live = battleShown() !== null;
    const now = performance.now();
    const due = live && now - liveLookAt >= LIVE_LOOK_MS;
    const key = `${live ? 'live' : String(planner.version)}|${pins.map(pinKey).join(',')}`;
    if (key !== viewshed.key || due) {
      viewshed.key = key;
      if (live) liveLookAt = now;
      const layers = new Map<string, ViewshedLayer>();
      for (const pin of pins) {
        const k = pinKey(pin);
        const old = viewshed.layers.get(k);
        layers.set(k, {
          pin,
          side: unitSide(pin.unitId) === 'OPFOR' ? 'red' : 'blue',
          look: lookOf(pin),
          shown: old?.shown ?? null,
        });
      }
      viewshed.layers = layers;
    }
    // One worked on at a time: one showing nothing yet first (in a battle a
    // moving unit's is worked out again and again, and would keep the workers
    // from the rest), then the selected one, then the latest turned on.
    const isSelected = (l: ViewshedLayer) =>
      l.pin.unitId === sel.id && l.pin.orderIndex === sel.orderIndex;
    const rank = (l: ViewshedLayer) => (l.shown ? 0 : 2) + (isSelected(l) ? 1 : 0);
    const order = [...viewshed.layers.values()].reverse();
    order.sort((a, b) => rank(b) - rank(a));
    let working = false;
    viewshed.pending = false;
    const service = viewshed.service;
    for (const layer of order) {
      const look = layer.look;
      if (!look || look.observers.length === 0) {
        // Nothing to look from (a squad with nobody left, a destroyed vehicle): nothing shown.
        layer.shown = null;
        continue;
      }
      if (!service) continue;
      let best = layerResult(look, service, false);
      if (best?.grid.cellSize !== fineGrid.cellSize) {
        viewshed.pending = true;
        if (!working) {
          working = true;
          best = layerResult(look, service, true) ?? best;
        }
      }
      // Until its first look is in, what it showed last.
      if (best) layer.shown = best;
    }
    if (viewshed.layers.size === 0) service?.cancel();
    showComposed();
    setText(ui('viewshed-status'), viewshed.pending ? 'Working out viewsheds…' : '');
  };
  /** Composes the layers' results again when any has changed, and gives them to a new 3D view. */
  const showComposed = () => {
    const results = [...viewshed.layers.values()].map((l) => l.shown);
    const changed =
      results.length !== viewshed.composed.length ||
      results.some((r, i) => r !== viewshed.composed[i]);
    if (changed) {
      viewshed.composed = results;
      const layers: { viewshed: Viewshed; side: ViewshedSide }[] = [];
      // Only the ground within each one's reach of its observers.
      const reach: { p: Vec2; r: number }[] = [];
      for (const l of viewshed.layers.values()) {
        if (!l.shown || !l.look) continue;
        layers.push({ viewshed: l.shown, side: l.side });
        for (const p of l.look.observers) reach.push({ p, r: l.look.rangeM });
      }
      viewshed.overlay =
        layers.length === 0 || reach.length === 0
          ? null
          : composeViewsheds(fineGrid, layers, {
              minX: Math.min(...reach.map(({ p, r }) => p.x - r)),
              minY: Math.min(...reach.map(({ p, r }) => p.y - r)),
              maxX: Math.max(...reach.map(({ p, r }) => p.x + r)),
              maxY: Math.max(...reach.map(({ p, r }) => p.y + r)),
            });
    }
    if (changed || view3d !== viewshed.on3d) {
      viewshed.on3d = view3d;
      view3d?.setGroundOverlay(viewshed.overlay);
    }
  };
  /** A dashed ring round each unit, start or waypoint whose viewshed is shown, in its side's colour. */
  // (A declaration: the map draws before this point of the page is reached.)
  function drawViewshedMarks(ctx: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2) {
    for (const layer of viewshed.layers.values()) {
      const at = pinPoint(layer.pin);
      if (!at) continue;
      const p = toScreen(at);
      ctx.save();
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = layer.side === 'red' ? '#ff6b5e' : '#5aaeff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 15, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.restore();
    }
  }
  /** A unit's range rings (as `MapShow.ringed` draws them round it). */
  const unitRangeRings = (id: string): RangeRings | null => {
    const shown = battleShown();
    const kind = shown
      ? shown.d.vehicles().find((v) => v.id === id)?.kind
      : planner.vehicle(id)?.kind;
    if (kind) return vehicleRangeRings(kind);
    const s = planner.squad(id);
    return s ? squadRangeRings(s.side, s.organization, s.antiTank) : null;
  };
  /**
   * The waypoints whose range rings are on (`MapShow.waypointRings`, drawn
   * under everything): in planning the planner's, in a battle its own;
   * OPFOR's unless OPFOR is hidden.
   */
  const updateWaypointRings = () => {
    const rings: { at: Vec2; rings: RangeRings; side: Side }[] = [];
    for (const pin of pinsOf('rings')) {
      const side = unitSide(pin.unitId);
      const at = pinPoint(pin);
      if (!side || !at || (side === 'OPFOR' && !showOpfor.checked)) continue;
      const rr = unitRangeRings(pin.unitId);
      if (rr) rings.push({ at, rings: rr, side });
    }
    show.waypointRings = rings;
  };

  /** The map bar's boxes: they change what the map shows, and the panels with it. */
  const shownChanged = (box: HTMLInputElement) => {
    box.blur();
    lastVersion = -1;
    combatPanelsAt = -Infinity;
    reviewPanelsAt = -Infinity;
  };
  const showOpfor = ui('show-opfor') as HTMLInputElement;
  showOpfor.addEventListener('change', () => {
    show.showOpfor = showOpfor.checked;
    shownChanged(showOpfor);
  });
  const showRings = ui('show-rings') as HTMLInputElement;
  showRings.addEventListener('change', () => {
    show.rangeRings = showRings.checked;
    shownChanged(showRings);
  });
  const hideWaypoints = ui('hide-waypoints') as HTMLInputElement;
  hideWaypoints.addEventListener('change', () => {
    show.hideWaypoints = hideWaypoints.checked;
    shownChanged(hideWaypoints);
  });
  /** A squad's or vehicle's range rings, on or off. */
  const toggleRings = (id: string) => {
    if (show.ringed.has(id)) show.ringed.delete(id);
    else show.ringed.add(id);
    // Turning one on shows them all again.
    if (show.ringed.has(id) && !showRings.checked) {
      showRings.checked = true;
      show.rangeRings = true;
    }
    shownChanged(showRings);
  };

  // --- Stages -------------------------------------------------------------

  const header = wireHeader(app, {
    go: (target) => {
      const go = () => {
        if (target === 'terrain') toTerrain();
        else enter(target);
      };
      // Leaving a battle under way discards it: asked first.
      const c = combat;
      if (planner.stage !== 'combat' || !c || c.ended) {
        go();
        return;
      }
      const wasPlaying = c.playing;
      c.pause();
      confirm({
        message: `Leave the battle at ${clockText(c.session.seconds)}? It will be discarded.`,
        action: 'Discard battle',
        onConfirm: go,
      });
      if (wasPlaying) notify('Paused. Discard the battle, or Cancel to go on.');
    },
    blocked: notify,
    // The Info window pauses a battle running, or its replay, until it closes.
    pause: () => {
      const c = inCombat();
      if (c?.playing) {
        c.pause();
        return () => {
          if (inCombat() === c && !c.ended && !c.playing) c.play();
        };
      }
      const r = inReview();
      if (r?.playing) {
        r.pause();
        return () => {
          if (inReview() === r && !r.playing) r.play();
        };
      }
      return null;
    },
  });
  const enter = (target: BattleStage) => {
    if (target === 'combat' && (!combat || combat.ended)) {
      // A new battle from the scenario as planned.
      combat?.dispose();
      combat = createCombat({
        terrain: o.terrain,
        definition: planner.definition,
        notify,
        driver: battleDriver(),
      });
      // Its viewsheds and waypoint rings: those turned on in planning.
      startLivePins();
      combatUi.selected = null;
      combatUi.tool = null;
      lastFrameMs = null;
    }
    if (target === 'scenario' || target === 'bluefor') {
      combat?.dispose();
      review?.dispose();
      combat = null;
      review = null;
    }
    if (target === 'aar') reviewToolsShown = false;
    // Back to Scenario Setup: the orders and routes go, and every unit stands at its start.
    if (target === 'scenario' && planner.stage !== 'scenario') {
      planner.edit((d) => ({ ok: true, definition: withoutOrders(d) }));
      planner.select(null);
    }
    planner.setStage(target);
    if (target === 'scenario' || target === 'bluefor') o.setAddress(target);
    lastVersion = -1;
  };
  /**
   * Restarts the battle (after asking): fought again from the start, from the
   * scenario as planned; orders and route changes given during it are lost.
   */
  const restartCombat = (c: Combat) => {
    if (c.ended) return;
    const wasPlaying = c.playing;
    c.pause();
    confirm({
      message: `Restart the battle from the start? It goes back to T+ 00:00.0, as planned: orders and route changes given during it are lost.`,
      action: 'Restart',
      onConfirm: () => {
        if (combat !== c) return;
        const speed = c.speed;
        c.dispose();
        combat = createCombat({
          terrain: o.terrain,
          definition: planner.definition,
          notify,
          driver: battleDriver(),
        });
        combat.setSpeed(speed);
        startLivePins();
        if (wasPlaying) combat.play();
        combatUi.selectedOrder = null;
        combatUi.tool = null;
        combatUi.ambush = null;
        combatUi.second = null;
        lastFrameMs = null;
        combatPanelsAt = -Infinity;
        notify('The battle restarts from the start.');
      },
    });
    if (wasPlaying) notify('Paused. Restart the battle, or Cancel to go on.');
  };
  /** Ends the battle (after asking) and opens the review. */
  const endCombat = () => {
    const c = combat;
    if (!c || c.ended) return;
    const wasPlaying = c.playing;
    c.pause();
    confirm({
      message: `End the battle at ${clockText(c.session.seconds)}? It cannot be resumed.`,
      action: 'End combat',
      onConfirm: () => {
        c.end();
        combatUi.tool = null;
        notify('Ending the battle…');
        const task = busy('Ending the battle and preparing the review…');
        void c
          .recording()
          .finally(() => {
            task.done();
          })
          .then((recording) => {
            if (combat !== c || stopped) return;
            c.dispose();
            // The review replays the battle from its recording, from tick 0.
            review = createReview({ terrain: o.terrain, recording, driver: battleDriver() });
            notify('');
            enter('aar');
          });
      },
    });
    if (wasPlaying) notify('Paused. End the battle, or Cancel to go on.');
  };
  const leave = (unload = false) => {
    stop();
    o.leave(map, unload);
  };
  /** Back to Terrain: the scenario is unloaded, after a warning. */
  const toTerrain = () => {
    const { savedName, dirty } = o.scenarios.status(planner.definition);
    const unsaved = dirty
      ? ' Its unsaved changes will be lost: Cancel, and save it first to keep them.'
      : '';
    confirm({
      message: `Go back to Terrain? ${savedName === null ? 'This scenario' : `The scenario ${savedName}`} will be unloaded.${unsaved}`,
      action: 'Unload scenario',
      onConfirm: () => {
        leave(true);
      },
    });
  };
  const PRIMARY: Readonly<Record<BattleStage, string>> = {
    scenario: 'Continue to Planning →',
    bluefor: 'Simulate →',
    combat: 'End combat and review →',
    aar: '← Back to Planning',
  };
  const NEXT: Readonly<Record<BattleStage, BattleStage>> = {
    scenario: 'bluefor',
    bluefor: 'combat',
    combat: 'aar',
    aar: 'bluefor',
  };
  ui('primary').addEventListener('click', () => {
    const stage = planner.stage;
    if (stage === 'combat' && combat && !combat.ended) {
      endCombat();
      return;
    }
    const reason = stage === 'aar' ? null : rules.next(stage);
    if (reason) {
      notify(reason);
      return;
    }
    enter(NEXT[stage]);
    // Simulate starts the battle running: no Play to press as well.
    if (NEXT[stage] === 'combat') combat?.play();
  });

  // --- Side panel -----------------------------------------------------------

  const toolPressed = (t: PlannerTool) => {
    const now = planner.tool;
    if (now.kind !== t.kind) return false;
    if (now.kind === 'order' && t.kind === 'order') return now.order === t.order;
    if (now.kind === 'place' && t.kind === 'place')
      return now.side === t.side && now.organization === t.organization;
    if (now.kind === 'placeVehicle' && t.kind === 'placeVehicle')
      return now.side === t.side && (now.vehicle ?? 'm113') === (t.vehicle ?? 'm113');
    return true;
  };
  const toolButton = (t: PlannerTool, label: string, title: string, extra = '') =>
    `<button class="tool ${extra}" data-tool='${escapeHtml(JSON.stringify(t))}' aria-pressed="${String(toolPressed(t))}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;

  const orderTools = () =>
    `<div class="tool-grid order-tools" role="group" aria-label="Orders">
      ${(planner.selectedVehicle ? (['move'] as const) : planner.selectedSquad ? ORDER_KINDS : [])
        .map((k) =>
          toolButton(
            { kind: 'order', order: k },
            ORDER_LABELS[k],
            `Give the selected squad ${ORDER_LABELS[k]} orders: each click on the map adds one`,
            `order-${k}`,
          ),
        )
        .join('')}
      ${toolButton({ kind: 'select' }, 'Select', 'Select and drag squads and waypoints')}
    </div>`;

  /**
   * An ambush order's "Set kill zone", or a defend order's "Set direction",
   * under its row's drop-downs: the next click on the map sets it.
   */
  const secondClickButton = (kind: OrderKind, k: number, armed: boolean): string => {
    if (kind !== 'ambush' && kind !== 'defend') return '';
    const title =
      kind === 'ambush'
        ? "Click the map to centre this ambush's kill zone: a 50 m square facing the ambush position"
        : 'Click the map in the direction this defence defends toward; then drag the square on its arc to widen or narrow it, the circle to turn it';
    return `<button class="small kill-zone" data-act="set-kill-zone" data-index="${String(k)}" aria-pressed="${String(armed)}" title="${escapeHtml(title)}">${kind === 'ambush' ? 'Set kill zone' : 'Set direction'}</button>`;
  };

  const toolsHtml = (): string => {
    switch (planner.stage) {
      case 'scenario':
        return `<h3>Place squads</h3>
          ${(['BLUEFOR', 'OPFOR'] as const)
            .map(
              (
                side,
              ) => `<div class="tool-grid place-tools" role="group" aria-label="Place ${side} squads">
              <span class="place-side ${sideClass(side)}">${side}</span>
              ${PLACE_ORGANIZATIONS.map((organization) =>
                toolButton(
                  { kind: 'place', side, organization },
                  ORGANIZATION_LABELS[organization],
                  `Click the map to place a ${side} ${ORGANIZATION_LABELS[organization].toLowerCase()} (${String(SQUAD_ORGANIZATIONS[organization].slots.length)} soldiers)`,
                  sideClass(side),
                ),
              ).join('')}
            </div>`,
            )
            .join('')}
          <h3>Place vehicles</h3>
          ${(['BLUEFOR', 'OPFOR'] as const)
            .map(
              (
                side,
              ) => `<div class="tool-grid place-tools" role="group" aria-label="Place ${side} vehicles">
              <span class="place-side ${sideClass(side)}">${side}</span>
              ${SIDE_VEHICLE_KINDS[side]
                .map((vehicle) =>
                  toolButton(
                    { kind: 'placeVehicle', side, vehicle },
                    vehicleShortName(vehicle),
                    `Click the map to place a ${side} ${vehicleLabel(vehicle)}`,
                    sideClass(side),
                  ),
                )
                .join('')}
            </div>`,
            )
            .join('')}`;
      case 'bluefor':
        // Nothing selected: no order to give, so no order tool.
        if (!planner.selectedSquad && !planner.selectedVehicle && planner.tool.kind === 'order')
          planner.setTool({ kind: 'select' });
        return orderTools();
      case 'combat':
        if (
          combat &&
          combatUi.tool !== null &&
          !combat.squad(combatUi.selected) &&
          !combat.vehicle(combatUi.selected)
        )
          combatUi.tool = null;
        return combat ? combatToolsHtml(combat, combatUi) : '';
      case 'aar':
        return review
          ? reviewToolsHtml()
          : `<p class="muted">No battle fought yet: ${escapeHtml(scenarioSummary(planner.definition))}.</p>`;
    }
  };

  const toolHint = (): string => {
    const t = planner.tool;
    const selected = planner.selectedSquad;
    if (t.kind === 'place')
      return `Click the map to place a ${t.side} ${ORGANIZATION_LABELS[t.organization].toLowerCase()}; Esc to stop.`;
    if (t.kind === 'placeVehicle')
      return `Click the map to place a ${t.side} ${vehicleLabel(t.vehicle ?? 'm113')}.`;
    const car = planner.selectedVehicle;
    if (t.kind === 'order' && car) {
      if (!planner.canRoute(car)) return 'Orders are given in Planning.';
      return t.order === 'move' ? ORDER_HINTS.move : 'Vehicles only take MOVE orders.';
    }
    if (t.kind === 'sector')
      return selected && planner.selection.orderIndex !== null
        ? 'Click the terrain to set firing arcs.'
        : 'Select a defend order first.';
    if (t.kind === 'killZone')
      return selected && planner.selection.orderIndex !== null
        ? 'Click the terrain to add a kill zone.'
        : 'Select an ambush order first.';
    if (t.kind === 'order') {
      if (!selected) return 'Select a squad first (click it, or pick it in the roster).';
      if (!planner.canPlan(selected)) return 'Orders are given in Planning.';
      return ORDER_HINTS[t.order];
    }
    if (planner.stage === 'scenario')
      return 'Place both sides’ squads and vehicles; drag them to move them, their knobs to turn them.';
    if (planner.stage === 'bluefor')
      return 'Select a squad or vehicle (either side), pick an order and click the map for each one.';
    return '';
  };

  /** A defence's preparation before the battle: chosen while planning it, else shown. */
  const preparedHtml = (minutes: number, k: number, planning: boolean): string => {
    const label = (m: number) =>
      m === 0 ? 'Not dug in' : m >= 30 ? 'Dug in' : `Prepared ${String(m)} min`;
    if (!planning) return `<span class="muted prepared">${label(minutes)}</span>`;
    const options = [0, 5, 10, 15, 20, 25, 30]
      .map(
        (m) =>
          `<option value="${String(m)}"${m === minutes ? ' selected' : ''}>${label(m)}</option>`,
      )
      .join('');
    return `<select class="prepared" data-act="order-prepared" data-index="${String(k)}" aria-label="Order ${String(k + 1)}: how long its position was prepared before the battle" title="How long the position was prepared before the battle: it starts that far dug in (30 minutes: fully)">${options}</select>`;
  };
  /**
   * The eye that turns a squad's or vehicle's viewshed on or off: from where
   * it starts (`index` null; in a battle, where it is now), or from a waypoint.
   */
  const viewshedButton = (id: string, side: Side, index: number | null): string => {
    const on = hasPin('viewshed', id, index);
    const what =
      index === null
        ? battleShown()
          ? 'from where it is'
          : 'from where it starts'
        : `from waypoint ${String(index + 1)}`;
    return `<button class="small vs-toggle ${sideClass(side)}" data-act="viewshed" data-unit="${escapeHtml(id)}" data-index="${index === null ? 'start' : String(index)}" aria-pressed="${String(on)}" title="${on ? 'Hide' : 'Show'} the viewshed ${what}" aria-label="Viewshed ${what}">${EYE_ICON}</button>`;
  };
  /** A unit's (or one of its waypoints') range rings and viewshed buttons, side by side. */
  const unitButtons = (id: string, side: Side, index: number | null = null): string =>
    `${ringsButton(id, side, index === null ? show.ringed.has(id) : hasPin('rings', id, index), index)}${viewshedButton(id, side, index)}`;
  const squadHtml = (s: ScenarioSquad | undefined): string => {
    if (!s) return '<p class="muted">No squad selected. Click one on the map or in the roster.</p>';
    const placing = planner.canPlace();
    const planning = planner.canPlan(s);
    const issues = planner.issues().filter((i) => i.squadId === s.id);
    const formations = formationsForOrganization(s.organization);
    const formation = s.formation ?? formations[0]?.id ?? '';
    const orgOptions = (Object.keys(SQUAD_ORGANIZATIONS) as SquadOrganization[])
      .map(
        (org) =>
          `<option value="${org}"${org === s.organization ? ' selected' : ''}>${ORGANIZATION_LABELS[org]} (${String(SQUAD_ORGANIZATIONS[org].slots.length)})</option>`,
      )
      .join('');
    const formationOptions = formations
      .map(
        (f) =>
          `<option value="${escapeHtml(f.id)}"${f.id === formation ? ' selected' : ''}>${escapeHtml(f.name)}</option>`,
      )
      .join('');
    const squadIssues = issues.filter((i) => i.orderIndex === null);
    return `<div class="squad-head ${sideClass(s.side)}">
        <span class="side-badge">${s.side}</span>
        ${
          placing
            ? `<input class="squad-name" data-act="rename" value="${escapeHtml(s.name)}" aria-label="Squad name" maxlength="40">`
            : `<span class="squad-name">${escapeHtml(s.name)}</span>`
        }
        ${unitButtons(s.id, s.side)}
      </div>
      <dl class="kv">
        <dt>Organization</dt><dd>${
          placing
            ? `<select data-act="organization" aria-label="Organization">${orgOptions}</select>`
            : `${ORGANIZATION_LABELS[s.organization]} (${String(SQUAD_ORGANIZATIONS[s.organization].slots.length)})`
        }</dd>
        <dt>Formation</dt><dd>${
          placing || planning
            ? `<select data-act="formation" aria-label="Formation">${formationOptions}</select>`
            : escapeHtml(formations.find((f) => f.id === formation)?.name ?? formation)
        }</dd>
        <dt>Anti-tank</dt><dd>${
          placing
            ? `<select data-act="anti-tank" aria-label="Anti-tank weapons">${antiTankOptions(s.side, s.antiTank)}</select>`
            : escapeHtml(ANTI_TANK_TEXT[s.side][s.antiTank ?? DEFAULT_ANTI_TANK])
        }</dd>
        <dt>Facing</dt><dd>${
          placing || planning
            ? `<input type="number" class="facing-input" data-act="facing" min="0" max="359" step="1" value="${String(s.facingDeg)}" aria-label="Facing, degrees from north">°`
            : `${String(s.facingDeg)}°`
        }</dd>
        <dt>Start</dt><dd class="start-row">${String(Math.round(s.position.east))} E, ${String(Math.round(s.position.north))} N</dd>
      </dl>
      ${squadIssues.map((i) => `<p class="warn">${escapeHtml(i.message)}</p>`).join('')}
      ${planSectionHtml({
        plan: s.plan,
        editable: planning,
        selectedIndex: planner.selection.orderIndex,
        activeIndex: null,
        armedIndex:
          planner.tool.kind === 'killZone' || planner.tool.kind === 'sector'
            ? planner.selection.orderIndex
            : null,
        issues,
        eye: (k) => unitButtons(s.id, s.side, k),
        empty: 'No orders: it holds where it starts.',
        // Orders are given in Planning: Setup shows none.
        planHidden: planner.stage === 'scenario',
        extraButtons: placing
          ? '<button class="small danger" data-act="delete-squad">Delete squad</button>'
          : '',
      })}`;
  };

  /**
   * A squad's plan, as Planning and Sim both show it: each order's kind and
   * actions on contact, its buttons (its viewshed in planning, Set kill zone /
   * Set direction, earlier, later, delete), a defence's preparation and any
   * issue; then Clear plan and Centre on map.
   */
  const planSectionHtml = (p: {
    readonly plan: readonly PlannedOrder[];
    readonly editable: boolean;
    readonly selectedIndex: number | null;
    /** The order being carried out (Sim), marked. */
    readonly activeIndex: number | null;
    /** The order whose kill zone or direction the next click sets. */
    readonly armedIndex: number | null;
    readonly issues: readonly ScenarioIssue[];
    readonly eye: (k: number) => string;
    readonly empty: string;
    readonly extraButtons: string;
    /** Only its buttons (Scenario Setup: no plan is made there). */
    readonly planHidden?: boolean;
  }): string => {
    const { plan, editable } = p;
    const rows = plan
      .map((order, k) => {
        const kindSelect = editable
          ? `<select data-act="order-kind" data-index="${String(k)}" aria-label="Order ${String(k + 1)} kind">${ORDER_KINDS.map(
              (kind) =>
                `<option value="${kind}"${kind === order.kind ? ' selected' : ''}>${ORDER_LABELS[kind]}</option>`,
            ).join('')}</select>`
          : `<span>${ORDER_LABELS[order.kind]}</span>`;
        const onContact = actionsOnOf(order);
        const actionsSelect = editable
          ? `<select data-act="order-actions" data-index="${String(k)}" aria-label="Order ${String(k + 1)}: on contact" title="${escapeHtml(ACTIONS_ON_HINTS[onContact])}">${ACTIONS_ON.map(
              (a) =>
                `<option value="${a}"${a === onContact ? ' selected' : ''} title="${escapeHtml(ACTIONS_ON_HINTS[a])}">On contact: ${ACTIONS_ON_LABELS[a]}</option>`,
            ).join('')}</select>`
          : `<span class="muted" title="${escapeHtml(ACTIONS_ON_HINTS[onContact])}">on contact: ${ACTIONS_ON_LABELS[onContact]}</span>`;
        const issue = p.issues.find((i) => i.orderIndex === k);
        const classes = [
          'order-row',
          p.selectedIndex === k ? 'selected' : '',
          p.activeIndex === k ? 'active' : '',
          issue ? 'has-issue' : '',
        ].filter((c) => c !== '');
        return `<li class="${classes.join(' ')}" data-index="${String(k)}">
          <button class="order-pick small" data-act="pick-order" data-index="${String(k)}" title="${p.activeIndex === k ? 'The order being carried out: select it' : 'Select this order'}">${String(k + 1)}</button>
          ${kindSelect}
          ${actionsSelect}
          ${
            editable
              ? `<span class="order-buttons">${secondClickButton(order.kind, k, p.armedIndex === k)}${order.kind === 'move' ? roadsButton('order-roads', k, order.followRoads === true, true) : ''}${p.eye(k)}
              <button class="small" data-act="order-up" data-index="${String(k)}" title="Earlier" aria-label="Move order ${String(k + 1)} earlier"${k === 0 ? ' disabled' : ''}>▲</button>
              <button class="small" data-act="order-down" data-index="${String(k)}" title="Later" aria-label="Move order ${String(k + 1)} later"${k === plan.length - 1 ? ' disabled' : ''}>▼</button>
              <button class="small" data-act="order-delete" data-index="${String(k)}" title="Delete" aria-label="Delete order ${String(k + 1)}">✕</button></span>`
              : `<span class="order-buttons">${order.kind === 'move' && order.followRoads ? roadsButton('order-roads', k, true, false) : ''}${p.eye(k)}</span>`
          }
          ${order.kind === 'defend' ? preparedHtml(order.preparedMinutes ?? 0, k, editable) : ''}
          ${issue ? `<span class="warn order-issue">${escapeHtml(issue.message)}</span>` : ''}
        </li>`;
      })
      .join('');
    const listed =
      p.planHidden === true
        ? ''
        : `<h3>Plan${plan.length > 0 ? ` (${String(plan.length)} order${plan.length === 1 ? '' : 's'})` : ''}</h3>
      ${
        plan.length === 0
          ? `<p class="muted">${escapeHtml(p.empty)}${editable ? ' Pick an order and click the map.' : ''}</p>`
          : `<ol class="plan-list">${rows}</ol>`
      }`;
    return `${listed}
      <p class="buttons">
        ${editable && plan.length > 0 ? '<button class="small" data-act="clear-plan">Clear plan</button>' : ''}
        ${p.extraButtons}
        <button class="small" data-act="centre">Centre on map</button>
      </p>`;
  };

  /** The selected vehicle's panel in Sim: its state, then its route as it stands, edited as in planning. */
  const combatVehiclePanelHtml = (c: Combat, v: VehicleStatus): string => {
    const route = c.vehicleRoute(v.id);
    const editable = !c.ended;
    const rows = route
      .map(
        (
          _,
          k,
        ) => `<li class="order-row${combatUi.selectedOrder === k ? ' selected' : ''}" data-index="${String(k)}">
          <button class="order-pick small" data-act="pick-waypoint" data-index="${String(k)}" title="Select this waypoint">${String(k + 1)}</button>
          <span>Move</span>
          <span class="order-buttons">${roadsButton('waypoint-roads', k, route[k]?.followRoads === true, editable)}${unitButtons(v.id, v.side, k)}${editable ? `<button class="small" data-act="waypoint-delete" data-index="${String(k)}" title="Delete" aria-label="Delete waypoint ${String(k + 1)}">✕</button>` : ''}</span>
        </li>`,
      )
      .join('');
    return `<div class="squad-head ${sideClass(v.side)}">
        <span class="side-badge">${v.side}</span>
        <span class="squad-name">${escapeHtml(v.name)}</span>
        ${unitButtons(v.id, v.side)}
      </div>
      ${vehicleDiagnosticsHtml(v, new Map(c.vehicles().map((x) => [x.id, x.name])))}
      <h3>Route${route.length > 0 ? ` (${String(route.length)} waypoint${route.length === 1 ? '' : 's'})` : ''}</h3>
      ${
        route.length === 0
          ? `<p class="muted">No route: it stays where it is.${editable ? ' Pick Move and click the map.' : ''}</p>`
          : `<ol class="plan-list">${rows}</ol>`
      }
      <p class="buttons">
        ${editable && route.length > 0 ? '<button class="small" data-act="vehicle-clear-route">Clear route</button>' : ''}
        <button class="small" data-act="centre">Centre on map</button>
      </p>`;
  };

  /** The selected squad's panel in Sim: its state, then its plan as it stands, edited as in planning. */
  const combatSquadPanelHtml = (c: Combat, s: SquadStatus): string => {
    const replaced = s.queued.some((q) => q.mode === 'replace');
    const second = combatUi.second;
    return `<div class="squad-head ${sideClass(s.side)}">
        <span class="side-badge">${s.side}</span>
        <span class="squad-name">${escapeHtml(s.name)}</span>
        ${unitButtons(s.id, s.side)}
      </div>
      <dl class="kv">${combatStatusRowsHtml(s)}</dl>
      ${planSectionHtml({
        plan: c.plan(s.id),
        editable: !c.ended,
        selectedIndex: combatUi.selectedOrder,
        activeIndex: s.active !== null && !replaced ? 0 : null,
        armedIndex: second?.squadId === s.id ? second.index : null,
        issues: [],
        eye: (k) => unitButtons(s.id, s.side, k),
        empty: 'No orders: it holds where it is.',
        extraButtons: '',
      })}`;
  };

  /** The selected vehicle's panel: its name, facing, start and route. */
  const vehicleHtml = (v: PlannedVehicle): string => {
    const placing = planner.canPlace();
    const routing = planner.canRoute(v);
    const issues = planner.issues().filter((i) => i.vehicleId === v.id);
    const rows = v.route
      .map((_, k) => {
        const selected = planner.selection.orderIndex === k;
        const issue = issues.find((i) => i.orderIndex === k);
        return `<li class="order-row${selected ? ' selected' : ''}${issue ? ' has-issue' : ''}" data-index="${String(k)}">
          <button class="order-pick small" data-act="pick-waypoint" data-index="${String(k)}" title="Select this waypoint">${String(k + 1)}</button>
          <span>Move</span>
          <span class="order-buttons">${roadsButton('waypoint-roads', k, v.route[k]?.followRoads === true, routing)}${unitButtons(v.id, v.side, k)}${routing ? `<button class="small" data-act="waypoint-delete" data-index="${String(k)}" title="Delete" aria-label="Delete waypoint ${String(k + 1)}">✕</button>` : ''}</span>
          ${issue ? `<span class="warn order-issue">${escapeHtml(issue.message)}</span>` : ''}
        </li>`;
      })
      .join('');
    return `<div class="squad-head ${sideClass(v.side)}">
        <span class="side-badge">${v.side}</span>
        ${
          placing
            ? `<input class="squad-name" data-act="vehicle-rename" value="${escapeHtml(v.name)}" aria-label="Vehicle name" maxlength="40">`
            : `<span class="squad-name">${escapeHtml(v.name)}</span>`
        }
        ${unitButtons(v.id, v.side)}
      </div>
      <dl class="kv">
        <dt>Type</dt><dd>${escapeHtml(vehicleLabel(v.kind))}</dd>
        <dt>Facing</dt><dd>${
          placing || routing
            ? `<input type="number" class="facing-input" data-act="vehicle-facing" min="0" max="359" step="1" value="${String(v.facingDeg)}" aria-label="Facing, degrees from north">°`
            : `${String(v.facingDeg)}°`
        }</dd>
        <dt>Start</dt><dd>${String(Math.round(v.position.east))} E, ${String(Math.round(v.position.north))} N</dd>
      </dl>
      ${issues
        .filter((i) => i.orderIndex === null)
        .map((i) => `<p class="warn">${escapeHtml(i.message)}</p>`)
        .join('')}
      ${
        // Routes are given in Planning: Setup shows none.
        planner.stage === 'scenario'
          ? ''
          : `<h3>Route${v.route.length > 0 ? ` (${String(v.route.length)} waypoint${v.route.length === 1 ? '' : 's'})` : ''}</h3>
      ${
        v.route.length === 0
          ? `<p class="muted">No route: it stays where it starts.${routing ? ' Pick Move and click the map.' : ''}</p>`
          : `<ol class="plan-list">${rows}</ol>`
      }`
      }
      <p class="buttons">
        ${routing && v.route.length > 0 ? '<button class="small" data-act="vehicle-clear-route">Clear route</button>' : ''}
        ${placing ? '<button class="small danger" data-act="delete-vehicle">Delete vehicle</button>' : ''}
        <button class="small" data-act="centre">Centre on map</button>
      </p>`;
  };

  const vehicleRosterHtml = (): string => {
    const list = vehiclesOf(planner.definition);
    if (list.length === 0) return '';
    const issues = planner.issues();
    const rows = list
      .map((v) => {
        const issue = issues.some((i) => i.vehicleId === v.id);
        return `<button class="squad-row ${sideClass(v.side)}" data-act="pick-vehicle" data-vehicle="${v.id}" aria-pressed="${String(planner.selection.vehicleId === v.id)}">
          <span class="sq-id">${v.id}</span>
          <span class="sq-name">${escapeHtml(v.name)}</span>
          <span class="sq-org muted">${v.side === 'BLUEFOR' ? 'BLUEFOR' : 'OPFOR'} vehicle</span>
          <span class="sq-plan${issue ? ' warn' : ''}">${issue ? '⚠ ' : ''}${v.route.length === 0 ? 'stays' : `${String(v.route.length)} waypoint${v.route.length === 1 ? '' : 's'}`}</span>
        </button>`;
      })
      .join('');
    return `<div class="force vehicles">
      <h3>Vehicles <span class="muted">· ${String(list.length)}</span></h3>
      ${rows}
    </div>`;
  };

  const rosterHtml = (): string => {
    const issues = planner.issues();
    return (['BLUEFOR', 'OPFOR'] as const)
      .map((side) => {
        const list = planner.definition.squads.filter((s) => s.side === side);
        const soldiers = list.reduce(
          (n, s) => n + SQUAD_ORGANIZATIONS[s.organization].slots.length,
          0,
        );
        const rows = list
          .map((s) => {
            const issue = issues.some((i) => i.squadId === s.id);
            const pressed = planner.selection.squadId === s.id;
            return `<button class="squad-row ${sideClass(side)}" data-act="pick-squad" data-squad="${s.id}" aria-pressed="${String(pressed)}">
              <span class="sq-id">${s.id}</span>
              <span class="sq-name">${escapeHtml(s.name)}</span>
              <span class="sq-org muted">${ORGANIZATION_LABELS[s.organization]}</span>
              <span class="sq-plan${issue ? ' warn' : ''}">${issue ? '⚠ ' : ''}${s.plan.length === 0 ? 'holds' : `${String(s.plan.length)} order${s.plan.length === 1 ? '' : 's'}`}</span>
            </button>`;
          })
          .join('');
        return `<div class="force ${sideClass(side)}">
          <h3>${side} <span class="muted">· ${String(list.length)} squad${list.length === 1 ? '' : 's'}, ${String(soldiers)} soldiers</span></h3>
          ${rows || `<p class="muted">None yet.${planner.stage === 'scenario' ? ' Place one with the tools above.' : ''}</p>`}
        </div>`;
      })
      .join('')
      .concat(vehicleRosterHtml());
  };

  const scenarioHtml = (): string => {
    const d = planner.definition;
    const stage = planner.stage;
    return `<dl class="kv">
        <dt>Name</dt><dd>${escapeHtml(d.name)}</dd>
        <dt>Forces</dt><dd>${escapeHtml(scenarioSummary(d))}</dd>
        <dt>Seed</dt><dd>${
          stage === 'scenario'
            ? `<input type="number" class="seed-input" data-act="seed" min="0" max="4294967295" step="1" value="${String(d.seed)}" aria-label="Random seed">`
            : String(d.seed)
        }</dd>
      </dl>`;
  };
  /** Under the primary button: what still stops the scenario from being played (nothing when ready). */
  const readinessHtml = (): string => {
    const issues = planner.issues();
    // Order issues belong to Planning; Setup shows the others.
    const shown =
      planner.stage === 'scenario' ? issues.filter((i) => i.orderIndex === null) : issues;
    return shown.length === 0
      ? ''
      : `<ul class="blockers">${shown
          .slice(0, 8)
          .map((i) => `<li>${escapeHtml(i.message)}</li>`)
          .join(
            '',
          )}${shown.length > 8 ? `<li>…and ${String(shown.length - 8)} more</li>` : ''}</ul>`;
  };

  /** A click on the Combat stage's panel; `true` when it was one. */
  const combatClick = (target: HTMLElement, clicks: number): boolean => {
    const c = inCombat();
    if (!c) return false;
    const el = target.closest<HTMLElement>('[data-ctool], [data-speed], [data-cact], [data-squad]');
    if (!el) return false;
    const { ctool, speed, cact, squad } = el.dataset;
    if (ctool !== undefined) {
      const kind = ctool === 'select' ? null : (ctool as OrderKind);
      combatUi.tool = combatUi.tool === kind ? null : kind;
      combatUi.ambush = null;
      combatUi.second = null;
    } else if (speed !== undefined) c.setSpeed(Number(speed) as CombatSpeed);
    else if (cact === 'play') {
      if (c.playing) c.pause();
      else c.play();
    } else if (cact === 'restart') restartCombat(c);
    else if (cact === 'centre') {
      const s = c.squad(combatUi.selected);
      const v = c.vehicle(combatUi.selected);
      if (s) centreOn(s.centre);
      else if (v) centreOn(v.position);
    } else if (squad !== undefined && !el.hasAttribute('data-act')) {
      if (combatUi.selected !== squad) {
        combatUi.selectedOrder = null;
        combatUi.ambush = null;
        combatUi.second = null;
      }
      combatUi.selected = squad;
      const s = c.squad(squad);
      const v = c.vehicle(squad);
      if (s && clicks >= 2) centreOn(s.centre);
      else if (v && clicks >= 2) centreOn(v.position);
    } else return false;
    return true;
  };

  /** A click on the review's panel; `true` when it was one. */
  const reviewClick = (target: HTMLElement, clicks: number): boolean => {
    const r = inReview();
    if (!r) return false;
    const el = target.closest<HTMLElement>(
      '[data-ract], [data-rspeed], [data-seek], [data-squad], [data-cact]',
    );
    if (!el) return false;
    const { ract, rspeed, seek, squad, cact } = el.dataset;
    if (seek !== undefined) r.seek(Number(seek));
    else if (rspeed !== undefined) r.setSpeed(Number(rspeed) as ReviewSpeed);
    else if (ract !== undefined) reviewAction(r, ract);
    else if (cact === 'centre') {
      const s = r.squad(combatUi.selected);
      const v = r.vehicles().find((x) => x.id === combatUi.selected);
      if (s) centreOn(s.centre);
      else if (v) centreOn(v.position);
    } else if (squad !== undefined && !el.hasAttribute('data-act')) {
      combatUi.selected = squad;
      const s = r.squad(squad);
      const v = r.vehicles().find((x) => x.id === squad);
      if (s && clicks >= 2) centreOn(s.centre);
      else if (v && clicks >= 2) centreOn(v.position);
    } else return false;
    return true;
  };
  /** The review's buttons and keys. */
  const reviewAction = (r: Review, action: string) => {
    const markers = r.markers();
    switch (action) {
      case 'play':
        if (r.playing) r.pause();
        else r.play();
        break;
      case 'start':
        r.seek(0);
        break;
      case 'end':
        r.seek(r.endSeconds);
        break;
      case 'back':
        r.seek(r.seconds - 5);
        break;
      case 'forward':
        r.seek(r.seconds + 5);
        break;
      case 'prev': {
        const before = markers.filter((m) => m.seconds < r.seconds - 0.05).at(-1);
        r.seek(before?.seconds ?? 0);
        break;
      }
      case 'next': {
        const after = markers.find((m) => m.seconds > r.seconds + 0.05);
        if (after) r.seek(after.seconds);
        break;
      }
      case 'export': {
        const blob = new Blob([JSON.stringify(r.recording)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${planner.definition.name.replace(/[^\w.-]+/g, '-') || 'battle'}.battle-run.json`;
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
        }, 1000);
        break;
      }
    }
  };

  // Clicks and changes in the side panel.
  const aside = app.querySelector<HTMLElement>('aside.side');
  if (!aside) throw new Error('Missing side panel');
  /**
   * The selected squad's (or vehicle's) plan edited from the panel in Sim,
   * as in planning, its live plan given at once; `true` when it was such an act.
   */
  const combatPlanAct = (act: string, index: number, value: string): boolean => {
    const c = inCombat();
    const id = combatUi.selected;
    if (!c || id === null) return false;
    if (act === 'centre') {
      const s = c.squad(id);
      const v = c.vehicle(id);
      if (s) centreOn(s.centre);
      else if (v) centreOn(v.position);
      return true;
    }
    if (c.vehicle(id)) {
      const route = c.vehicleRoute(id);
      switch (act) {
        case 'pick-waypoint':
          combatUi.selectedOrder = index;
          return true;
        case 'waypoint-delete':
          if (
            c.setVehicleRoute(
              id,
              route.filter((_, k) => k !== index),
            )
          )
            combatUi.selectedOrder = index > 0 ? index - 1 : null;
          return true;
        case 'waypoint-roads':
          c.setVehicleRoute(
            id,
            route.map((p, k) =>
              k !== index ? p : p.followRoads ? { x: p.x, y: p.y } : { ...p, followRoads: true },
            ),
          );
          return true;
        case 'vehicle-clear-route':
          confirm({
            message: `Clear the route of ${c.vehicle(id)?.name ?? 'the vehicle'}? It stops where it is until it is given a new one.`,
            action: 'Clear route',
            onConfirm: () => {
              c.setVehicleRoute(id, []);
              combatUi.selectedOrder = null;
            },
          });
          return true;
      }
      return false;
    }
    const squad = c.squad(id);
    if (!squad) return false;
    switch (act) {
      case 'pick-order':
        combatUi.selectedOrder = index;
        return true;
      case 'order-up':
      case 'order-down': {
        const by = act === 'order-up' ? -1 : 1;
        if (c.editPlan(id, (d) => reorderOrder(d, id, index, by)))
          combatUi.selectedOrder = index + by;
        return true;
      }
      case 'order-delete':
        if (c.editPlan(id, (d) => deleteOrder(d, id, index)))
          combatUi.selectedOrder = index > 0 ? index - 1 : null;
        return true;
      case 'set-kill-zone': {
        const kind = c.plan(id)[index]?.kind;
        if (kind !== 'ambush' && kind !== 'defend') return true;
        const second = kind === 'ambush' ? 'killZone' : 'sector';
        const armed = combatUi.second?.squadId === id && combatUi.second.index === index;
        combatUi.second = armed ? null : { squadId: id, index, kind: second };
        combatUi.selectedOrder = index;
        if (!armed) notify(SECOND_CLICK[second]);
        return true;
      }
      case 'clear-plan':
        confirm({
          message: `Clear the plan of ${squad.name}? It stops where it is until it is given new orders.`,
          action: 'Clear plan',
          onConfirm: () => {
            c.editPlan(id, (d) => clearPlan(d, id));
            combatUi.selectedOrder = null;
            combatUi.second = null;
          },
        });
        return true;
      case 'order-kind': {
        const kind = value as OrderKind;
        const plan = c.plan(id);
        const order = plan[index];
        if (!order) return true;
        // A new ambush or defence faces on along its way: a kill zone (or direction) 75 m ahead, to drag.
        const to = { x: order.destination.east, y: order.destination.north };
        const before = plan[index - 1];
        const from = before
          ? { x: before.destination.east, y: before.destination.north }
          : squad.centre;
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        const ahead =
          length > 1
            ? {
                x: to.x + ((to.x - from.x) / length) * 75,
                y: to.y + ((to.y - from.y) / length) * 75,
              }
            : { x: to.x, y: to.y + 75 };
        c.editPlan(id, (d) => {
          const changed = setOrderKind(d, id, index, kind);
          if (!changed.ok) return changed;
          if (kind === 'ambush')
            return setKillZone(o.terrain, changed.definition, id, index, ahead);
          if (kind === 'defend') return setDefendSector(changed.definition, id, index, ahead);
          return changed;
        });
        return true;
      }
      case 'order-actions':
        c.editPlan(id, (d) => setOrderActionsOn(d, id, index, value as ActionsOn));
        return true;
      case 'order-roads': {
        const on = c.plan(id)[index]?.followRoads !== true;
        c.editPlan(id, (d) => setOrderFollowRoads(d, id, index, on));
        return true;
      }
      case 'order-prepared':
        c.editPlan(id, (d) => setDefendPrepared(d, id, index, Number(value)));
        return true;
    }
    return false;
  };

  aside.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const rings = target.closest<HTMLElement>('[data-act="range-rings"]');
    const ringsUnit = rings?.dataset['unit'];
    if (rings && ringsUnit) {
      const at = rings.dataset['index'];
      if (at === undefined) toggleRings(ringsUnit);
      else togglePin('rings', ringsUnit, Number(at));
      return;
    }
    // A unit's viewshed (data-index "start": from where it starts, or is) or a waypoint's.
    const eye = target.closest<HTMLElement>('[data-act="viewshed"]');
    const eyeUnit = eye?.dataset['unit'];
    if (eye && eyeUnit) {
      const at = eye.dataset['index'];
      togglePin('viewshed', eyeUnit, at === undefined || at === 'start' ? null : Number(at));
      return;
    }
    if (combatClick(target, event.detail)) return;
    if (reviewClick(target, event.detail)) return;
    if (inCombat()) {
      const el = target.closest<HTMLElement>('[data-act]');
      const act = el?.dataset['act'];
      if (el && act && !(el instanceof HTMLSelectElement))
        combatPlanAct(act, Number(el.dataset['index']), '');
      return;
    }
    const toolEl = target.closest<HTMLElement>('[data-tool]');
    if (toolEl?.dataset['tool']) {
      const t = JSON.parse(toolEl.dataset['tool']) as PlannerTool;
      planner.setTool(toolPressed(t) && t.kind !== 'select' ? { kind: 'select' } : t);
      return;
    }
    const el = target.closest<HTMLElement>('[data-act]');
    const act = el?.dataset['act'];
    if (!el || !act || el instanceof HTMLSelectElement || el instanceof HTMLInputElement) return;
    const s = planner.selectedSquad;
    const index = Number(el.dataset['index']);
    const car = planner.selectedVehicle;
    switch (act) {
      case 'pick-vehicle': {
        const picked = planner.vehicle(el.dataset['vehicle']);
        if (!picked) return;
        planner.selectVehicle(picked.id);
        if (event.detail >= 2) centreOn({ x: picked.position.east, y: picked.position.north });
        return;
      }
      case 'pick-waypoint':
        if (car) planner.selectVehicle(car.id, index);
        return;
      case 'waypoint-delete':
        if (car) planner.removeVehicleWaypoint(car.id, index);
        return;
      case 'vehicle-clear-route':
        if (car && planner.canRoute(car)) planner.edit((d) => clearVehicleRoute(d, car.id));
        return;
      case 'delete-vehicle':
        if (car) planner.removeVehicle(car.id);
        return;
      case 'pick-squad': {
        const picked = planner.squad(el.dataset['squad'] ?? null);
        if (!picked) return;
        planner.select(picked.id);
        if (event.detail >= 2) centreOn({ x: picked.position.east, y: picked.position.north });
        return;
      }
      case 'pick-order':
        if (s) planner.select(s.id, index);
        return;
      case 'order-roads':
        if (s && planner.canPlan(s)) {
          const on = s.plan[index]?.followRoads !== true;
          planner.edit((d) => setOrderFollowRoads(d, s.id, index, on));
        }
        return;
      case 'waypoint-roads':
        if (car && planner.canRoute(car)) {
          const on = car.route[index]?.followRoads !== true;
          planner.edit((d) => setVehicleWaypointRoads(d, car.id, index, on));
        }
        return;
      case 'set-kill-zone': {
        // This order's second click: armed (or, armed already, put down).
        const t = planner.tool.kind;
        if (s && planner.selection.orderIndex === index && (t === 'killZone' || t === 'sector')) {
          planner.setTool({ kind: 'select' });
          return;
        }
        if (s) planner.select(s.id, index);
        planner.armKillZone();
        return;
      }
      case 'order-up':
      case 'order-down':
        if (s && planner.canPlan(s)) {
          planner.moveOrder(s.id, index, act === 'order-up' ? -1 : 1);
        }
        return;
      case 'order-delete':
        if (s) planner.removeOrder(s.id, index);
        return;
      case 'clear-plan':
        if (s && planner.canPlan(s))
          confirm({
            message: `Delete all ${String(s.plan.length)} orders of ${s.name}? It will hold where it starts.`,
            action: 'Clear plan',
            onConfirm: () => {
              planner.edit((d) => clearPlan(d, s.id));
            },
          });
        return;
      case 'delete-squad':
        if (s) planner.removeSquad(s.id);
        return;
      case 'centre':
        if (s) centreOn({ x: s.position.east, y: s.position.north });
        else if (car) centreOn({ x: car.position.east, y: car.position.north });
        return;
      case 'scn-save':
      case 'scn-saveAs':
      case 'scn-load':
      case 'scn-import':
      case 'scn-export':
        runScenarioAction(act.slice(4) as ScenarioAction);
        return;
      case 'new-scenario':
        if (planner.stage !== 'scenario') return;
        confirm({
          message: `Delete every squad and plan of this scenario (${scenarioSummary(planner.definition)}) and start again?`,
          action: 'New scenario',
          onConfirm: () => {
            planner.edit((d) => {
              const rest = { ...d, squads: [] };
              delete rest.vehicles;
              return { ok: true, definition: rest };
            });
            planner.select(null);
            o.scenarios.detach();
            scenarioEpoch += 1;
          },
        });
        return;
    }
  });
  aside.addEventListener('change', (event) => {
    const el = event.target as HTMLElement;
    const act = el.dataset['act'];
    if (inCombat()) {
      if (act && el instanceof HTMLSelectElement)
        combatPlanAct(act, Number(el.dataset['index']), el.value);
      // Drawn again at once, from the plan as now given.
      combatPanelsAt = -Infinity;
      (el as HTMLSelectElement).blur();
      return;
    }
    const s = planner.selectedSquad;
    const car = planner.selectedVehicle;
    const value = el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : '';
    switch (act) {
      case 'vehicle-rename':
        if (car) planner.edit((d) => renameVehicle(d, car.id, value));
        break;
      case 'vehicle-facing':
        if (car) planner.edit((d) => setVehicleFacing(d, car.id, Number(value)));
        break;
      case 'rename':
        if (s) planner.edit((d) => renameSquad(d, s.id, value));
        break;
      case 'organization':
        if (s)
          planner.edit((d) => setSquadOrganization(o.terrain, d, s.id, value as SquadOrganization));
        break;
      case 'formation':
        if (s) planner.edit((d) => setSquadFormation(o.terrain, d, s.id, value));
        break;
      case 'anti-tank':
        if (s) planner.edit((d) => setSquadAntiTank(d, s.id, value as AntiTankLoadout));
        break;
      case 'facing':
        if (s) planner.edit((d) => setSquadFacing(o.terrain, d, s.id, Number(value)));
        break;
      case 'order-kind':
        if (s)
          planner.edit((d) =>
            setOrderKind(d, s.id, Number(el.dataset['index']), value as OrderKind),
          );
        break;
      case 'order-actions':
        if (s)
          planner.edit((d) =>
            setOrderActionsOn(d, s.id, Number(el.dataset['index']), value as ActionsOn),
          );
        break;
      case 'order-prepared':
        if (s)
          planner.edit((d) =>
            setDefendPrepared(d, s.id, Number(el.dataset['index']), Number(value)),
          );
        break;
      case 'seed':
        planner.edit((d) => setSeed(d, Number(value)));
        break;
    }
    lastVersion = -1;
  });

  // --- Scenario management (docs/scenarios.md) ------------------------------

  /** Bumped when the saved state may have changed without an edit (a save). */
  let scenarioEpoch = 0;
  let scenarioBusy = false;
  const pageScenario: PageScenario = {
    definition: () => planner.definition,
    stage: () => (planner.stage === 'bluefor' ? 'bluefor' : 'scenario'),
    rename: (name) => {
      planner.edit((d) => ({ ok: true, definition: { ...d, name } }));
    },
    leave: () => {
      leave();
    },
  };
  /** Scenario actions belong to planning: none in Combat or the review. */
  const runScenarioAction = (action: ScenarioAction) => {
    const menu = ui('scn-menu') as HTMLDetailsElement;
    menu.open = false;
    if (planner.stage !== 'scenario' && planner.stage !== 'bluefor') return;
    if (scenarioBusy) return;
    scenarioBusy = true;
    void o.scenarios
      .run(action, pageScenario)
      .catch((error: unknown) => {
        if (!stopped) notify(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        scenarioBusy = false;
        scenarioEpoch += 1;
      });
  };
  let shownStatus: { definition: BattleScenarioDefinition; epoch: number } | null = null;
  const updateScenarioStatus = () => {
    const d = planner.definition;
    if (shownStatus?.definition === d && shownStatus.epoch === scenarioEpoch) return;
    shownStatus = { definition: d, epoch: scenarioEpoch };
    const { savedName, dirty } = o.scenarios.status(d);
    setHtml(
      ui('scn-status'),
      `${savedName === null ? '<span class="muted">Not saved in the browser yet.</span>' : `Saved as <b>${escapeHtml(savedName)}</b>.`}${dirty ? ' <span class="warn" data-ui="unsaved">Unsaved changes.</span>' : ''}`,
    );
  };

  // --- Keys ---------------------------------------------------------------

  // Escape cancels (a dialog, a tool, a selection); in Scenario Setup, Delete
  // deletes the squad or vehicle selected.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' && event.key !== 'Delete') return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement
    )
      return;
    if (event.key === 'Delete') {
      if (planner.stage !== 'scenario' || !ui('confirm').hidden) return;
      const car = planner.selectedVehicle;
      const squad = planner.selectedSquad;
      if (car) planner.removeVehicle(car.id);
      else if (squad) planner.removeSquad(squad.id);
      else return;
      event.preventDefault();
      return;
    }
    if (!ui('confirm').hidden) {
      ui('confirm').hidden = true;
      return;
    }
    if (inCombat()) {
      if (combatUi.second) combatUi.second = null;
      else if (pendingAmbush(combatUi)) combatUi.ambush = null;
      else if (combatUi.tool !== null) combatUi.tool = null;
      else if (combatUi.selectedOrder !== null) combatUi.selectedOrder = null;
      else combatUi.selected = null;
      return;
    }
    if (inReview()) {
      combatUi.selected = null;
      return;
    }
    if (planner.tool.kind !== 'select') planner.setTool({ kind: 'select' });
    else planner.select(null);
  };
  window.addEventListener('keydown', onKeyDown);

  // --- Frame loop -------------------------------------------------------------

  let lastVersion = -1;
  const updatePanels = () => {
    const stage = planner.stage;
    header.update(stage, rules);
    const fighting = stage === 'combat' && combat !== null && !combat.ended;
    const reason = stage === 'aar' || fighting ? null : rules.next(stage);
    const primary = ui('primary') as HTMLButtonElement;
    setText(primary, PRIMARY[stage]);
    primary.classList.toggle('danger-solid', fighting);
    primary.setAttribute('aria-disabled', String(reason !== null));
    const c = inCombat();
    const r = inReview();
    const events = app.querySelector<HTMLElement>('[data-sec="events"]');
    if (events) events.hidden = !c && !r;
    const scenarioSection = app.querySelector<HTMLElement>('[data-sec="scenario"]');
    // Scenario management is a planning activity: none in Combat or the review.
    const planning = stage === 'scenario' || stage === 'bluefor';
    if (scenarioSection) scenarioSection.hidden = !planning || c !== null || r !== null;
    if (planning) updateScenarioStatus();
    if (c) {
      updateCombatPanels(c);
      return;
    }
    if (r) {
      updateReviewPanels(r);
      return;
    }
    const pointer = map.pointer;
    setText(
      ui('pointer'),
      pointer
        ? `${String(Math.round(pointer.east))} E, ${String(Math.round(pointer.north))} N · ${pointer.elevation.toFixed(1)} m${o.describePoint ? ` · ${o.describePoint({ x: pointer.east, y: pointer.north })}` : ''}`
        : '',
    );
    if (planner.version === lastVersion) return;
    lastVersion = planner.version;
    app.dataset['stage'] = stage;
    ui('new-scenario').hidden = stage !== 'scenario';
    setText(
      ui('tools-title'),
      stage === 'scenario' ? 'Scenario tools' : stage === 'bluefor' ? 'Orders' : STAGE_NAMES[stage],
    );
    setHtml(ui('tools'), toolsHtml());
    setText(ui('tool-hint'), toolHint());
    const t = planner.tool;
    setText(
      ui('tool-label'),
      t.kind === 'place'
        ? `Placing ${t.side} ${ORGANIZATION_LABELS[t.organization].toLowerCase()}s`
        : t.kind === 'placeVehicle'
          ? `Placing a ${t.side} ${vehicleShortName(t.vehicle ?? 'm113')}`
          : t.kind === 'order'
            ? `${ORDER_LABELS[t.order]} orders`
            : '',
    );
    const squadSection = app.querySelector<HTMLElement>('[data-sec="squad"]');
    if (squadSection) squadSection.hidden = false;
    // Not while the user is typing or choosing in it (a button pressed there,
    // such as an order's ✕, keeps the focus but must not stop it); drawn once
    // they are done.
    const squadEl = ui('squad');
    const scenarioEl = ui('scenario');
    if (editingIn(squadEl) || editingIn(scenarioEl)) lastVersion = -1;
    const car = planner.selectedVehicle;
    setText(ui('squad-title'), car ? 'Selected vehicle' : 'Selected squad');
    if (!editingIn(squadEl))
      setHtml(squadEl, car ? vehicleHtml(car) : squadHtml(planner.selectedSquad));
    setHtml(ui('roster'), rosterHtml());
    if (!editingIn(scenarioEl)) setHtml(scenarioEl, scenarioHtml());
    setHtml(ui('readiness'), readinessHtml());
  };
  /** Whether the user is typing or choosing in a field of `el`. */
  const editingIn = (el: HTMLElement) => {
    const a = document.activeElement;
    return (
      (a instanceof HTMLInputElement ||
        a instanceof HTMLSelectElement ||
        a instanceof HTMLTextAreaElement) &&
      el.contains(a)
    );
  };

  /** The Combat stage's and the review's panels: the clock every frame, the rest a few times a second. */
  let combatPanelsAt = -Infinity;
  const updateCombatPanels = (c: Combat) => {
    const clock = app.querySelector<HTMLElement>('[data-ui="combat-clock"]');
    if (clock) setText(clock, clockText(c.renderSeconds));
    // The speed actually kept, when well below the speed chosen.
    const actual = app.querySelector<HTMLElement>('[data-ui="combat-actual"]');
    const slower = slowerSpeed(c);
    if (actual) setText(actual, slower === null ? '' : `(${slower.toFixed(1)}×)`);
    const now = performance.now();
    if (now - combatPanelsAt < 150 && lastVersion === planner.version) return;
    combatPanelsAt = now;
    lastVersion = planner.version;
    app.dataset['stage'] = planner.stage;
    setText(ui('tools-title'), STAGE_NAMES[planner.stage]);
    setHtml(ui('tools'), toolsHtml());
    setText(ui('tool-hint'), planner.stage === 'combat' ? combatHint(c) : '');
    setText(
      ui('tool-label'),
      combatUi.tool === null ? '' : `${ORDER_LABELS[combatUi.tool]} orders`,
    );
    setHtml(ui('readiness'), '');
    const car = c.vehicle(combatUi.selected);
    setText(ui('squad-title'), car ? 'Selected vehicle' : 'Selected squad');
    // Not while the user is choosing in it (a drop-down open).
    const squadEl = ui('squad');
    if (!editingIn(squadEl)) {
      const s = c.squad(combatUi.selected);
      setHtml(
        squadEl,
        car
          ? combatVehiclePanelHtml(c, car)
          : s
            ? combatSquadPanelHtml(c, s)
            : '<p class="muted">No squad selected. Click one on the map or in the roster.</p>',
      );
    } else combatPanelsAt = -Infinity;
    setHtml(ui('roster'), combatRosterHtml(c, combatUi));
    setHtml(ui('events'), combatEventsHtml(combatDisplay(c)));
  };

  /** Whether the review's controls are drawn (they are drawn once, then kept current). */
  let reviewToolsShown = false;
  let reviewPanelsAt = -Infinity;
  /** Whether the user is dragging the timeline (its value is then left alone). */
  let scrubbing = false;
  const updateReviewPanels = (r: Review) => {
    if (!reviewToolsShown) {
      app.dataset['stage'] = planner.stage;
      setText(ui('tools-title'), STAGE_NAMES.aar);
      setText(ui('tool-hint'), '');
      setText(ui('tool-label'), '');
      setHtml(ui('tools'), toolsHtml());
      const scrub = app.querySelector<HTMLInputElement>('[data-ui="review-scrub"]');
      scrub?.addEventListener('pointerdown', () => {
        scrubbing = true;
      });
      scrub?.addEventListener('pointerup', () => {
        scrubbing = false;
      });
      scrub?.addEventListener('input', () => {
        r.seek(Number(scrub.value));
      });
      reviewToolsShown = true;
      reviewPanelsAt = -Infinity;
    }
    // Every frame: the clock, the timeline and the play button.
    const q = (name: string) => app.querySelector<HTMLElement>(`[data-ui="${name}"]`);
    const clock = q('review-clock');
    if (clock) setText(clock, clockText(r.seconds));
    const end = q('review-end');
    if (end) setText(end, `of ${clockText(r.endSeconds)}`);
    const scrub = q('review-scrub') as HTMLInputElement | null;
    if (scrub) {
      const max = String(r.endSeconds);
      if (scrub.max !== max) scrub.max = max;
      if (!scrubbing) scrub.value = String(r.seconds);
    }
    const replayed = q('timeline-replayed');
    if (replayed)
      replayed.style.width = `${((100 * r.replayedSeconds) / Math.max(r.endSeconds, 1e-9)).toFixed(2)}%`;
    const play = q('review-play');
    if (play) setText(play, r.playing ? 'Pause' : 'Play');
    // A few times a second: the rest.
    const now = performance.now();
    if (now - reviewPanelsAt < 200) return;
    reviewPanelsAt = now;
    const verify = verificationText(r);
    const line = q('review-verify');
    if (line) {
      setText(line, verify.text);
      line.className = `review-verify ${verify.kind}`;
    }
    for (const b of app.querySelectorAll<HTMLButtonElement>('[data-rspeed]'))
      b.setAttribute('aria-pressed', String(Number(b.dataset['rspeed']) === r.speed));
    const markers = q('timeline-markers');
    if (markers) setHtml(markers, timelineMarkersHtml(r));
    const summary = q('review-summary');
    if (summary) setHtml(summary, aarSummaryHtml(r.summary()));
    const moments = q('review-moments');
    if (moments) setHtml(moments, momentsHtml(r));
    const car = r.vehicles().find((v) => v.id === combatUi.selected);
    setText(ui('squad-title'), car ? 'Selected vehicle' : 'Selected squad');
    setHtml(
      ui('squad'),
      car
        ? combatVehicleHtml(
            car,
            new Map(r.vehicles().map((x) => [x.id, x.name])),
            unitButtons(car.id, car.side),
          )
        : combatSquadHtml(r.squad(combatUi.selected), (s) => unitButtons(s.id, s.side)) +
            phasesHtml(r, combatUi.selected),
    );
    setHtml(ui('roster'), combatRosterHtml(r, combatUi));
    setHtml(ui('events'), combatEventsHtml(reviewDisplay(r), 60, true));
  };

  let frameId = 0;
  let lastFrameMs: number | null = null;
  // rAF stops in hidden tabs; the gap is dropped on return rather than caught up.
  const onVisibility = () => {
    lastFrameMs = null;
  };
  document.addEventListener('visibilitychange', onVisibility);
  const frame = (nowMs: number) => {
    const dt = lastFrameMs === null ? 0 : (nowMs - lastFrameMs) / 1000;
    // The battle steps for at most part of a frame, so the view keeps drawing
    // smoothly (less in 3D, whose drawing takes longer).
    inCombat()?.frame(dt, viewMode === '3d' && view3d ? 10 : 16);
    // A battle starting: its worker prepares the battlefield before the first tick.
    const c = inCombat();
    const starting = c !== null && !c.ended && c.playing && c.session.tick === 0;
    if (starting && !startingTask)
      startingTask = busy('Starting the battle: preparing the battlefield…');
    else if (!starting && startingTask) {
      startingTask.done();
      startingTask = null;
    }
    inReview()?.frame(dt, viewMode === '3d' && view3d ? 10 : 16);
    lastFrameMs = nowMs;
    updateViewshed();
    updateWaypointRings();
    if (viewMode === '3d' && view3d) view3d.render();
    else map.render();
    updatePanels();
    frameId = requestAnimationFrame(frame);
  };
  const stop = () => {
    stopped = true;
    startingTask?.done();
    startingTask = null;
    viewshed.service?.dispose();
    viewshed.service = null;
    view3d?.dispose();
    view3d = null;
    map.canvas.style.visibility = '';
    cancelAnimationFrame(frameId);
    window.removeEventListener('keydown', onKeyDown);
    combat?.dispose();
    review?.dispose();
    channel?.close();
    channel = null;
    document.removeEventListener('visibilitychange', onVisibility);
  };

  // For automated browser checks: the planner's state, whichever view is shown. Read-only.
  Object.defineProperty(app, 'ambushBattle', {
    configurable: true,
    value: () => ({
      stage: planner.stage,
      view: viewMode,
      camera: viewMode === '3d' ? (view3d?.view() ?? null) : null,
      viewsheds: {
        pending: viewshed.pending,
        layers: [...viewshed.layers.values()].map((l) => ({
          unitId: l.pin.unitId,
          orderIndex: l.pin.orderIndex,
          side: l.side,
          observers: l.look?.observers.length ?? 0,
          rangeM: l.look?.rangeM ?? null,
          eyeHeightM: l.look?.sectors[0]?.eyeHeightM ?? null,
          cellSize: l.shown?.grid.cellSize ?? null,
          visible: l.shown ? l.shown.visible.reduce((n, v) => n + v, 0) : 0,
        })),
      },
      tool: planner.tool,
      selection: planner.selection,
      definition: JSON.parse(JSON.stringify(planner.definition)) as unknown,
      issues: planner.issues().map((i) => ({ ...i })),
      blocker: planner.stage === 'aar' ? null : rules.next(planner.stage),
      review: review
        ? {
            seconds: review.seconds,
            endSeconds: review.endSeconds,
            replayedSeconds: review.replayedSeconds,
            playing: review.playing,
            speed: review.speed,
            verification: review.verification,
            markers: review.markers().map((m) => ({ ...m })),
            squads: review.squads().map((q) => ({
              id: q.id,
              up: q.up,
              phase: q.phase,
              centre: q.centre,
              active: q.active?.kind ?? null,
            })),
            summary: review.summary(),
            selected: combatUi.selected,
          }
        : null,
      combat: combat
        ? {
            playing: combat.playing,
            speed: combat.speed,
            ended: combat.ended,
            tick: combat.session.tick,
            seconds: combat.session.seconds,
            renderSeconds: combat.renderSeconds,
            ui: { ...combatUi },
            commands: combat.session.battle.commands.length,
            cpu: combat.session.cpu(),
            squads: combat.squads().map((q) => ({
              id: q.id,
              side: q.side,
              up: q.up,
              total: q.total,
              phase: q.phase,
              centre: q.centre,
              active: q.active
                ? {
                    kind: q.active.kind,
                    destination: q.active.destination,
                    killZone: q.active.killZone,
                  }
                : null,
              pending: q.pending.length,
              pendingTo: q.pending.map((x) => x.destination),
              plan: (combat?.plan(q.id) ?? []).map((x) => [
                x.kind,
                Math.round(x.destination.east),
                Math.round(x.destination.north),
              ]),
              orders: q.orders.map((x) => `${x.kind}:${x.status}`),
              queued: q.queued.length,
            })),
            vehicles: combat.vehicles().map((v) => ({ ...v })),
            summary: combat.summary(),
            hash: combat.session.hashes.at(-1) ?? null,
          }
        : null,
    }),
  });

  // For automated browser checks: a map point's position in the page, in the view shown.
  // For automated browser checks: why a squad could not stand at a map point (null: it could).
  Object.defineProperty(app, 'ambushBattleCheck', {
    configurable: true,
    value: (x: number, y: number) => squadPlacementProblem(o.terrain, { x, y }),
  });
  // Puts the 3D camera looking at map point (x, y) on the ground from `distance` m away, `pitchDeg` down, from `bearingDeg`.
  Object.defineProperty(app, 'ambushBattleCamera', {
    configurable: true,
    value: (x: number, y: number, distance: number, pitchDeg: number, bearingDeg: number) => {
      const z = surfaceHeightAt(o.terrain, x, y);
      const p = (pitchDeg * Math.PI) / 180;
      const b = (bearingDeg * Math.PI) / 180;
      const ex = x + distance * Math.cos(p) * Math.sin(b);
      const ey = y + distance * Math.cos(p) * Math.cos(b);
      view3d?.setCameraPose({
        target: { x, y: z, z: -y },
        position: { x: ex, y: z + distance * Math.sin(p), z: -ey },
      });
    },
  });
  Object.defineProperty(app, 'ambushBattleProject', {
    configurable: true,
    value: (x: number, y: number) => {
      const three = viewMode === '3d' ? view3d : null;
      const canvas = three ? three.canvas : map.canvas;
      const p = three ? three.projection().toScreen({ x, y }) : map.toScreen({ x, y });
      const r = canvas.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    },
  });

  enter(o.initialStage);
  if (o.notice) notify(o.notice);
  // Terrain selection was in 3D: so is the page, in the same 3D view (never
  // showing the 2D map meanwhile), or a new one with its camera where it was.
  if (o.view?.view3d) {
    const given = o.view.view3d;
    view3d = given;
    given.setFigures(figures);
    ui('attribution').before(given.canvas, given.overlay);
    connect3d(given);
    viewMode = '3d';
    showViewMode();
  } else if (o.view?.mode === '3d') {
    handedPose = o.view.pose;
    setViewMode('3d');
  }
  frameId = requestAnimationFrame(frame);
  return stop;
}
