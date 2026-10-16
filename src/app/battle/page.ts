import { emptyMotionSample } from '#exercise';
import {
  clearPlan,
  formationsForOrganization,
  ORDER_LABELS,
  ORGANIZATION_LABELS,
  renameSquad,
  reorderOrder,
  scenarioSummary,
  setOrderKind,
  setOrderActionsOn,
  ACTIONS_ON_HINTS,
  ACTIONS_ON_LABELS,
  actionsOnOf,
  setSeed,
  setSquadFacing,
  setSquadFormation,
  setSquadOrganization,
  SQUAD_ORGANIZATIONS,
  squadPlacementProblem,
  type BattleScenarioDefinition,
  type ScenarioSquad,
  type SquadOrganization,
} from '#exercise/battle';
import {
  ACTIONS_ON,
  ORDER_KINDS,
  soldierId,
  type ActionsOn,
  type OrderKind,
  type Side,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import { createTacticalMap, type MapBinding, type MapEditor, type TacticalMap } from '#view2d';
import type { BattlefieldView3d, UnitMarker } from '#view3d';
import {
  createConfirm,
  createToast,
  escapeHtml,
  headerHtml,
  htmlSetter,
  wireHeader,
} from '../shell';
import { STAGE_NAMES, type WorkflowRules } from '../workflow';
import { COMBAT_SPEEDS, createCombat, type Combat, type CombatSpeed } from './combat';
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
  combatToolsHtml,
} from './combat-panel';
import { createBattleMapEditor, ORDER_INITIALS } from './map-editor';
import { createPlanner, type BattleStage, type PlannerTool } from './planner';

// Stages 2–5 of a battle on one battlefield (docs/constructive-simulation/03,
// 04): Scenario Setup (place both sides' squads, give OPFOR its plans),
// BLUEFOR Planning (give BLUEFOR's squads their plans), Combat (the battle
// fought live: play, pause, speed, orders to either side, End Combat) and
// the After-Action Review (its summary; the full replay is milestone D). The workflow header, the map (2D, or 3D through
// the same editor), and a side panel: the stage's tools, the selected squad
// and its plan, the roster by force, and the scenario. Every edit goes
// through the planner (planner.ts) and is saved as it is made.

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
  /** Back to terrain selection, handing the map over (the page has stopped by then). */
  readonly leave: (map: TacticalMap) => void;
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

const ORDER_KEYS: Readonly<Record<string, OrderKind>> = {
  m: 'move',
  a: 'attack',
  w: 'withdraw',
  b: 'ambush',
};

const HELP_HTML = `<dl class="kv help">
  <dt>S, Esc</dt><dd>Select tool; Esc again clears the selection</dd>
  <dt>P</dt><dd>Place squads (Scenario Setup): pick the side and organization, then click the map</dd>
  <dt>M, A, W, B</dt><dd>Give the selected squad Move, Attack, Withdraw or Ambush orders: each click adds one, after the selected order</dd>
  <dt>K</dt><dd>Set the kill zone of the selected ambush order: click its centre; drag its corners to resize it</dd>
  <dt>Drag</dt><dd>A squad to move it (Setup), a waypoint to move its destination, the white knob to turn the selected squad</dd>
  <dt>Right-click</dt><dd>A waypoint to delete its order</dd>
  <dt>Delete</dt><dd>The selected order, or else the selected squad (Setup)</dd>
  <dt>F</dt><dd>Fit the map (2D) or return to the overhead view (3D)</dd>
</dl>
<p class="hint">Orders: <b>Move</b> goes to the destination, halting to fight on contact and carrying on;
<b>Attack</b> takes and clears the objective, assaulting with fire and movement; <b>Withdraw</b> falls back
without halting to fight; <b>Ambush</b> goes to the ambush position and lies in wait, concealed, facing its
kill zone: it opens fire when the enemy is in the kill zone, then holds there until ordered on. Contact interrupts an order: the squad reacts on its own, then resumes it.
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
      <label class="mapbar-check" data-ui="opfor-toggle" title="Show the OPFOR squads and their plans while BLUEFOR plans">
        <input type="checkbox" data-ui="show-opfor" checked> Show OPFOR
      </label>
      <span class="mapbar-tool" data-ui="tool-label"></span>
      <div class="view-toggle" role="group" aria-label="Map view">
        <button class="small" data-view="2d" aria-pressed="true" title="The 2D tactical map">2D</button>
        <button class="small" data-view="3d" aria-pressed="false" title="The 3D battlefield view">3D</button>
      </div>
      <button class="small" data-ui="fit" title="Fit the whole map (F)">Fit map</button>
    </div>
  </main>
  <aside class="side" aria-label="Stage tools and status">
    <div class="primary-action">
      <button class="primary-btn" data-ui="primary" aria-describedby="primary-reason"></button>
      <p class="reason warn" id="primary-reason" data-ui="primary-reason"></p>
    </div>
    <section class="sec" data-sec="tools">
      <h2 data-ui="tools-title"></h2>
      <div data-ui="tools"></div>
      <p class="hint" data-ui="tool-hint"></p>
    </section>
    <section class="sec" data-sec="squad">
      <h2>Selected squad</h2>
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
  const editor = createBattleMapEditor(planner);

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
    tool: null,
    append: false,
    shift: false,
    actionsOn: null,
    ambush: null,
  };
  /** The live battle, in Combat. */
  const inCombat = (): Combat | null => (planner.stage === 'combat' ? combat : null);
  /** The replayed battle, in the review. */
  const inReview = (): Review | null => (planner.stage === 'aar' ? review : null);
  const combatDisplay = (c: Combat): BattleDisplay => ({
    motion: c.session.motion,
    events: c.session.events,
    renderSeconds: c.renderSeconds,
    battle: c.session.battle,
    squads: () => c.squads(),
    squad: (id) => c.squad(id),
    order: (id, kind, point, mode, actionsOn, killZoneAt) =>
      c.order(id, kind, point, mode, actionsOn, killZoneAt),
  });
  const reviewDisplay = (r: Review): BattleDisplay => ({
    motion: r.replay.motion,
    events: r.replay.events,
    renderSeconds: r.seconds,
    battle: r.replay.battle,
    squads: () => r.squads(),
    squad: (id) => r.squad(id),
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
  );
  const current = (): MapEditor => (display() ? combatEditor : editor);
  /** The map's editor: the planner's, or in Combat and the review, the battle's. */
  const mapEditor: MapEditor = {
    press: (point, screen, button) => current().press?.(point, screen, button) ?? false,
    drag: (point) => current().drag?.(point),
    drop: (point) => current().drop?.(point),
    click: (point, screen) => {
      current().click(point, screen);
    },
    cursor: (point, screen) => current().cursor?.(point, screen) ?? null,
    draw: (ctx, toScreen, perspective) => current().draw?.(ctx, toScreen, perspective),
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
      if (planner.stage === 'combat' && combat && !combat.ended)
        return 'End the combat first: leaving now would discard the battle.';
      if (planner.stage === 'aar' && to === 'combat')
        return 'The battle has ended: go back to BLUEFOR Planning to fight it again.';
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
      };
    const r = inReview();
    if (r)
      return {
        battle: r.replay.battle,
        log: r.replay.motion,
        combatLog: r.replay.combatLog,
        seconds: r.seconds,
        ended: false,
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
        squad.soldierIds.map((id) => {
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
      return {
        units,
        clock: { log: c.log, combatLog: c.combatLog, seconds: c.seconds, ended: c.ended },
        weapons: combatWeapons.weapons,
      };
    }
    const f = planner.figures();
    const selected = planner.selection.squadId;
    const hidden = (side: Side) =>
      side === 'OPFOR' && planner.stage === 'bluefor' && !editor.showOpfor;
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
    return { units, clock: { log: f.log, combatLog: [], seconds: 0 }, weapons: f.weapons };
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
    import('#view3d')
      .then(({ createBattlefieldView3d }) => {
        loading3d = false;
        if (stopped) return;
        view3d = createBattlefieldView3d({ terrain: o.terrain, figures });
        ui('attribution').before(view3d.canvas, view3d.overlay);
        connect3d(view3d);
        viewMode = '3d';
        showViewMode();
        const opened = view3d;
        requestAnimationFrame(() => {
          if (view3d === opened && viewMode === '3d') carryFocus('3d');
        });
        notify('');
      })
      .catch((error: unknown) => {
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
  const showOpfor = ui('show-opfor') as HTMLInputElement;
  showOpfor.addEventListener('change', () => {
    editor.showOpfor = showOpfor.checked;
    lastVersion = -1;
  });

  // --- Stages -------------------------------------------------------------

  const header = wireHeader(app, {
    go: (target) => {
      if (target === 'terrain') leave();
      else enter(target);
    },
    blocked: notify,
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
    planner.setStage(target);
    if (target === 'scenario' || target === 'bluefor') o.setAddress(target);
    lastVersion = -1;
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
        void c.recording().then((recording) => {
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
  const leave = () => {
    stop();
    o.leave(map);
  };
  const PRIMARY: Readonly<Record<BattleStage, string>> = {
    scenario: 'Continue to BLUEFOR Planning →',
    bluefor: 'Continue to Combat →',
    combat: 'End combat and review →',
    aar: '← Back to BLUEFOR Planning',
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
    if (reason) notify(reason);
    else enter(NEXT[stage]);
  });

  // --- Side panel -----------------------------------------------------------

  const toolPressed = (t: PlannerTool) => {
    const now = planner.tool;
    if (now.kind !== t.kind) return false;
    if (now.kind === 'order' && t.kind === 'order') return now.order === t.order;
    if (now.kind === 'place' && t.kind === 'place')
      return now.side === t.side && now.organization === t.organization;
    return true;
  };
  const toolButton = (t: PlannerTool, label: string, key: string, title: string, extra = '') =>
    `<button class="tool ${extra}" data-tool='${escapeHtml(JSON.stringify(t))}' aria-pressed="${String(toolPressed(t))}" title="${escapeHtml(title)}${key ? ` (${key})` : ''}">${escapeHtml(label)}</button>`;

  const orderTools = () =>
    `<div class="tool-grid order-tools" role="group" aria-label="Orders">
      ${ORDER_KINDS.map((k) =>
        toolButton(
          { kind: 'order', order: k },
          ORDER_LABELS[k],
          ORDER_INITIALS[k],
          `Give the selected squad ${ORDER_LABELS[k]} orders: each click on the map adds one`,
          `order-${k}`,
        ),
      ).join('')}
      ${toolButton({ kind: 'select' }, 'Select', 'S', 'Select and drag squads and waypoints')}
    </div>
    ${killZoneButton()}`;

  /** "Set kill zone": only with the Ambush tool, or an ambush order selected (of a squad being planned). */
  const killZoneButton = (): string => {
    const t = planner.tool;
    const s = planner.selectedSquad;
    const index = planner.selection.orderIndex;
    const ambushSelected = index !== null && s?.plan[index]?.kind === 'ambush';
    const shown =
      (t.kind === 'order' && t.order === 'ambush') || t.kind === 'killZone' || ambushSelected;
    if (!shown || !planner.canPlan(s)) return '';
    const hasAmbush = s?.plan.some((o) => o.kind === 'ambush') === true;
    return `<div class="tool-row kill-zone-row">
      <button class="tool kill-zone" data-act="set-kill-zone" aria-pressed="${String(t.kind === 'killZone')}"${hasAmbush ? '' : ' disabled'} title="Click the map to centre the selected ambush order's kill zone: a 50 m square facing the ambush position (K)">Set kill zone</button>
    </div>`;
  };

  const toolsHtml = (): string => {
    switch (planner.stage) {
      case 'scenario':
        return `<h3>Place squads <span class="muted">(P)</span></h3>
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
                  '',
                  `Click the map to place a ${side} ${ORGANIZATION_LABELS[organization].toLowerCase()} (${String(SQUAD_ORGANIZATIONS[organization].slots.length)} soldiers)`,
                  sideClass(side),
                ),
              ).join('')}
            </div>`,
            )
            .join('')}
          <h3>OPFOR plans</h3>
          ${orderTools()}`;
      case 'bluefor':
        return `<h3>BLUEFOR orders</h3>${orderTools()}`;
      case 'combat':
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
    if (t.kind === 'killZone') {
      const index = planner.selection.orderIndex;
      return selected && index !== null
        ? `Click the map at the centre of order ${String(index + 1)}'s kill zone: a 50 m square, facing the ambush position. Then drag its corners to resize it.`
        : 'Select an ambush order first.';
    }
    if (t.kind === 'order') {
      if (!selected) return 'Select a squad first (click it, or pick it in the roster).';
      if (!planner.canPlan(selected))
        return planner.stage === 'bluefor'
          ? `${selected.name} is OPFOR: its plan is set in Scenario Setup.`
          : `${selected.name} is BLUEFOR: its plan is made in BLUEFOR Planning.`;
      return `Click the map: ${selected.name} gets a${t.order === 'ambush' || t.order === 'attack' ? 'n' : ''} ${ORDER_LABELS[t.order]} order there${planner.selection.orderIndex === null ? ', after its last order' : `, after order ${String(planner.selection.orderIndex + 1)}`}.${t.order === 'ambush' ? ' That is the ambush position; the next click sets its kill zone.' : ''}`;
    }
    if (planner.stage === 'scenario')
      return 'Place both sides’ squads, then give OPFOR its plans (select an OPFOR squad, then M, A, W or B).';
    if (planner.stage === 'bluefor')
      return 'Select a BLUEFOR squad, then M, A, W or B and click the map for each order.';
    return '';
  };

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
    const orders = s.plan
      .map((order, k) => {
        const selected = planner.selection.orderIndex === k;
        const kindSelect = planning
          ? `<select data-act="order-kind" data-index="${String(k)}" aria-label="Order ${String(k + 1)} kind">${ORDER_KINDS.map(
              (kind) =>
                `<option value="${kind}"${kind === order.kind ? ' selected' : ''}>${ORDER_LABELS[kind]}</option>`,
            ).join('')}</select>`
          : `<span>${ORDER_LABELS[order.kind]}</span>`;
        const onContact = actionsOnOf(order);
        const actionsSelect = planning
          ? `<select data-act="order-actions" data-index="${String(k)}" aria-label="Order ${String(k + 1)}: on contact" title="${escapeHtml(ACTIONS_ON_HINTS[onContact])}">${ACTIONS_ON.map(
              (a) =>
                `<option value="${a}"${a === onContact ? ' selected' : ''} title="${escapeHtml(ACTIONS_ON_HINTS[a])}">On contact: ${ACTIONS_ON_LABELS[a]}</option>`,
            ).join('')}</select>`
          : `<span class="muted" title="${escapeHtml(ACTIONS_ON_HINTS[onContact])}">on contact: ${ACTIONS_ON_LABELS[onContact]}</span>`;
        const issue = issues.find((i) => i.orderIndex === k);
        return `<li class="order-row${selected ? ' selected' : ''}${issue ? ' has-issue' : ''}" data-index="${String(k)}">
          <button class="order-pick small" data-act="pick-order" data-index="${String(k)}" title="Select this order">${String(k + 1)}</button>
          ${kindSelect}
          ${actionsSelect}
          <span class="muted coords">${String(Math.round(order.destination.east))} E, ${String(Math.round(order.destination.north))} N${
            order.kind === 'ambush'
              ? order.killZone
                ? ` · kill zone ${String(Math.round(order.killZone.widthM))} × ${String(Math.round(order.killZone.depthM))} m`
                : ' · <span class="warn">no kill zone</span>'
              : ''
          }</span>
          ${
            planning
              ? `<span class="order-buttons">
              <button class="small" data-act="order-up" data-index="${String(k)}" title="Earlier" aria-label="Move order ${String(k + 1)} earlier"${k === 0 ? ' disabled' : ''}>▲</button>
              <button class="small" data-act="order-down" data-index="${String(k)}" title="Later" aria-label="Move order ${String(k + 1)} later"${k === s.plan.length - 1 ? ' disabled' : ''}>▼</button>
              <button class="small" data-act="order-delete" data-index="${String(k)}" title="Delete" aria-label="Delete order ${String(k + 1)}">✕</button></span>`
              : ''
          }
          ${issue ? `<span class="warn order-issue">${escapeHtml(issue.message)}</span>` : ''}
        </li>`;
      })
      .join('');
    const squadIssues = issues.filter((i) => i.orderIndex === null);
    return `<div class="squad-head ${sideClass(s.side)}">
        <span class="side-badge">${s.side}</span>
        ${
          placing
            ? `<input class="squad-name" data-act="rename" value="${escapeHtml(s.name)}" aria-label="Squad name" maxlength="40">`
            : `<span class="squad-name">${escapeHtml(s.name)}</span>`
        }
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
        <dt>Facing</dt><dd>${
          placing || planning
            ? `<input type="number" class="facing-input" data-act="facing" min="0" max="359" step="1" value="${String(s.facingDeg)}" aria-label="Facing, degrees from north">°`
            : `${String(s.facingDeg)}°`
        }</dd>
        <dt>Start</dt><dd>${String(Math.round(s.position.east))} E, ${String(Math.round(s.position.north))} N</dd>
      </dl>
      ${squadIssues.map((i) => `<p class="warn">${escapeHtml(i.message)}</p>`).join('')}
      <h3>Plan${s.plan.length > 0 ? ` (${String(s.plan.length)} order${s.plan.length === 1 ? '' : 's'})` : ''}</h3>
      ${
        s.plan.length === 0
          ? `<p class="muted">No orders: it holds where it starts.${planning ? ' Press M, A or W and click the map.' : ''}</p>`
          : `<ol class="plan-list">${orders}</ol>`
      }
      <p class="buttons">
        ${planning && s.plan.length > 0 ? '<button class="small" data-act="clear-plan">Clear plan</button>' : ''}
        ${placing ? '<button class="small danger" data-act="delete-squad">Delete squad</button>' : ''}
        <button class="small" data-act="centre">Centre on map</button>
      </p>`;
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
      .join('');
  };

  const scenarioHtml = (): string => {
    const d = planner.definition;
    const issues = planner.issues();
    const stage = planner.stage;
    // BLUEFOR plan issues belong to planning; setup shows the others.
    const shown =
      stage === 'scenario'
        ? issues.filter(
            (i) =>
              !(
                d.squads.find((s) => s.id === i.squadId)?.side === 'BLUEFOR' &&
                i.orderIndex !== null
              ),
          )
        : issues;
    return `<dl class="kv">
        <dt>Name</dt><dd>${escapeHtml(d.name)}</dd>
        <dt>Forces</dt><dd>${escapeHtml(scenarioSummary(d))}</dd>
        <dt>Seed</dt><dd>${
          stage === 'scenario'
            ? `<input type="number" class="seed-input" data-act="seed" min="0" max="4294967295" step="1" value="${String(d.seed)}" aria-label="Random seed">`
            : String(d.seed)
        }</dd>
      </dl>
      ${
        shown.length === 0
          ? '<p class="ok">Ready: nothing stops this scenario from being played.</p>'
          : `<ul class="blockers">${shown
              .slice(0, 8)
              .map((i) => `<li>${escapeHtml(i.message)}</li>`)
              .join(
                '',
              )}${shown.length > 8 ? `<li>…and ${String(shown.length - 8)} more</li>` : ''}</ul>`
      }`;
  };

  /** A click on the Combat stage's panel; `true` when it was one. */
  const combatClick = (target: HTMLElement, clicks: number): boolean => {
    const c = inCombat();
    if (!c) return false;
    const el = target.closest<HTMLElement>(
      '[data-ctool], [data-cmode], [data-speed], [data-cact], [data-squad]',
    );
    if (!el) return false;
    const { ctool, cmode, speed, cact, squad } = el.dataset;
    if (ctool !== undefined) {
      const kind = ctool === 'select' ? null : (ctool as OrderKind);
      combatUi.tool = combatUi.tool === kind ? null : kind;
      combatUi.ambush = null;
    } else if (cmode !== undefined) combatUi.append = cmode === 'append';
    else if (speed !== undefined) c.setSpeed(Number(speed) as CombatSpeed);
    else if (cact === 'play') {
      if (c.playing) c.pause();
      else c.play();
    } else if (cact === 'end') endCombat();
    else if (cact === 'kill-zone') {
      // Before the ambush position it cannot be set; after it, the button starts again.
      if (pendingAmbush(combatUi)) combatUi.ambush = null;
      else notify('Click the ambush position on the map first, then the kill zone.');
    } else if (cact === 'hold') {
      if (combatUi.selected !== null) c.hold(combatUi.selected);
    } else if (cact === 'centre') {
      const s = c.squad(combatUi.selected);
      if (s) centreOn(s.centre);
    } else if (squad !== undefined && !el.hasAttribute('data-act')) {
      combatUi.selected = squad;
      const s = c.squad(squad);
      if (s && clicks >= 2) centreOn(s.centre);
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
      if (s) centreOn(s.centre);
    } else if (squad !== undefined && !el.hasAttribute('data-act')) {
      combatUi.selected = squad;
      const s = r.squad(squad);
      if (s && clicks >= 2) centreOn(s.centre);
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
  aside.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (combatClick(target, event.detail)) return;
    if (reviewClick(target, event.detail)) return;
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
    switch (act) {
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
      case 'set-kill-zone':
        if (planner.tool.kind === 'killZone') planner.setTool({ kind: 'select' });
        else if (!planner.armKillZone()) notify('Give the squad an ambush order first.');
        return;
      case 'order-up':
      case 'order-down':
        if (s && planner.canPlan(s)) {
          const by = act === 'order-up' ? -1 : 1;
          if (planner.edit((d) => reorderOrder(d, s.id, index, by)))
            planner.select(s.id, index + by);
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
            planner.edit((d) => ({ ok: true, definition: { ...d, squads: [] } }));
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
    const s = planner.selectedSquad;
    const value = el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : '';
    switch (act) {
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
      case 'combat-actions':
        combatUi.actionsOn = value === 'order' ? null : (value as ActionsOn);
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

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (!ui('confirm').hidden && event.key === 'Escape') {
      ui('confirm').hidden = true;
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'shift') combatUi.shift = true;
    const c = inCombat();
    if (c) {
      combatKey(c, key, event);
      return;
    }
    const r = inReview();
    if (r) {
      const action = (
        {
          ' ': 'play',
          arrowleft: 'back',
          arrowright: 'forward',
          home: 'start',
          end: 'end',
          ',': 'prev',
          '.': 'next',
        } as Record<string, string | undefined>
      )[key];
      if (action) {
        event.preventDefault();
        reviewAction(r, action);
      } else if (key === 'escape') combatUi.selected = null;
      else if (key === 'f') fitView();
      return;
    }
    const order = ORDER_KEYS[key];
    if (order && (planner.stage === 'scenario' || planner.stage === 'bluefor')) {
      planner.setTool({ kind: 'order', order });
      return;
    }
    switch (key) {
      case 'f':
        fitView();
        break;
      case 's':
        planner.setTool({ kind: 'select' });
        break;
      case 'k':
        if (planner.stage === 'scenario' || planner.stage === 'bluefor') planner.armKillZone();
        break;
      case 'p':
        if (planner.stage === 'scenario') {
          const last = lastPlace;
          planner.setTool(planner.tool.kind === 'place' ? { kind: 'select' } : last);
        }
        break;
      case 'escape':
        if (planner.tool.kind !== 'select') planner.setTool({ kind: 'select' });
        else planner.select(null);
        break;
      case 'delete':
      case 'backspace': {
        const s = planner.selectedSquad;
        if (!s) break;
        event.preventDefault();
        const index = planner.selection.orderIndex;
        if (index !== null && planner.canPlan(s)) planner.removeOrder(s.id, index);
        else if (index === null && planner.canPlace()) planner.removeSquad(s.id);
        break;
      }
    }
  };
  /** The Combat stage's and the review's keys. */
  const combatKey = (c: Combat, key: string, event: KeyboardEvent) => {
    const order = ORDER_KEYS[key];
    if (order && !c.ended) {
      if (combatUi.tool !== order) combatUi.ambush = null;
      combatUi.tool = order;
      return;
    }
    const speedAt = COMBAT_SPEEDS.indexOf(c.speed);
    switch (key) {
      case ' ':
        if (c.ended) break;
        event.preventDefault();
        if (c.playing) c.pause();
        else c.play();
        break;
      case 'f':
        fitView();
        break;
      case 's':
        combatUi.tool = null;
        break;
      case 'h':
        if (combatUi.selected !== null) c.hold(combatUi.selected);
        break;
      case '+':
      case '=':
        c.setSpeed(COMBAT_SPEEDS[Math.min(COMBAT_SPEEDS.length - 1, speedAt + 1)] ?? c.speed);
        break;
      case '-':
      case '_':
        c.setSpeed(COMBAT_SPEEDS[Math.max(0, speedAt - 1)] ?? c.speed);
        break;
      case 'escape':
        if (pendingAmbush(combatUi)) combatUi.ambush = null;
        else if (combatUi.tool !== null) combatUi.tool = null;
        else combatUi.selected = null;
        break;
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'Shift') combatUi.shift = false;
  };
  const onBlur = () => {
    combatUi.shift = false;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  let lastPlace: PlannerTool = { kind: 'place', side: 'BLUEFOR', organization: 'squad' };

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
    setText(ui('primary-reason'), reason ?? '');
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
    if (planner.tool.kind === 'place') lastPlace = planner.tool;
    app.dataset['stage'] = stage;
    ui('opfor-toggle').hidden = stage !== 'bluefor';
    ui('new-scenario').hidden = stage !== 'scenario';
    setText(
      ui('tools-title'),
      stage === 'scenario'
        ? 'Scenario tools'
        : stage === 'bluefor'
          ? 'Planning tools'
          : STAGE_NAMES[stage],
    );
    setHtml(ui('tools'), toolsHtml());
    setText(ui('tool-hint'), toolHint());
    const t = planner.tool;
    setText(
      ui('tool-label'),
      t.kind === 'place'
        ? `Placing ${t.side} ${ORGANIZATION_LABELS[t.organization].toLowerCase()}s`
        : t.kind === 'order'
          ? `${ORDER_LABELS[t.order]} orders`
          : '',
    );
    const squadSection = app.querySelector<HTMLElement>('[data-sec="squad"]');
    if (squadSection) squadSection.hidden = false;
    // Not while the user is typing in it.
    const squadEl = ui('squad');
    if (!squadEl.contains(document.activeElement) || document.activeElement === document.body)
      setHtml(squadEl, squadHtml(planner.selectedSquad));
    setHtml(ui('roster'), rosterHtml());
    const scenarioEl = ui('scenario');
    if (!scenarioEl.contains(document.activeElement)) setHtml(scenarioEl, scenarioHtml());
  };

  /** The Combat stage's and the review's panels: the clock every frame, the rest a few times a second. */
  let combatPanelsAt = -Infinity;
  const updateCombatPanels = (c: Combat) => {
    const clock = app.querySelector<HTMLElement>('[data-ui="combat-clock"]');
    if (clock) setText(clock, clockText(c.renderSeconds));
    const now = performance.now();
    if (now - combatPanelsAt < 150 && lastVersion === planner.version) return;
    combatPanelsAt = now;
    lastVersion = planner.version;
    app.dataset['stage'] = planner.stage;
    ui('opfor-toggle').hidden = true;
    setText(ui('tools-title'), STAGE_NAMES[planner.stage]);
    setHtml(ui('tools'), toolsHtml());
    setText(ui('tool-hint'), planner.stage === 'combat' ? combatHint(c, combatUi) : '');
    setText(
      ui('tool-label'),
      combatUi.tool === null
        ? ''
        : `${ORDER_LABELS[combatUi.tool]} orders (${combatUi.append !== combatUi.shift ? 'append' : 'replace'})`,
    );
    setHtml(ui('squad'), combatSquadHtml(c.squad(combatUi.selected)));
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
      ui('opfor-toggle').hidden = true;
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
    setHtml(
      ui('squad'),
      combatSquadHtml(r.squad(combatUi.selected)) + phasesHtml(r, combatUi.selected),
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
    inReview()?.frame(dt, viewMode === '3d' && view3d ? 10 : 16);
    lastFrameMs = nowMs;
    if (viewMode === '3d' && view3d) view3d.render();
    else map.render();
    updatePanels();
    frameId = requestAnimationFrame(frame);
  };
  const stop = () => {
    stopped = true;
    view3d?.dispose();
    view3d = null;
    map.canvas.style.visibility = '';
    cancelAnimationFrame(frameId);
    window.removeEventListener('keydown', onKeyDown);
    combat?.dispose();
    review?.dispose();
    channel?.close();
    channel = null;
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
  };

  // For automated browser checks: the planner's state, whichever view is shown. Read-only.
  Object.defineProperty(app, 'ambushBattle', {
    configurable: true,
    value: () => ({
      stage: planner.stage,
      view: viewMode,
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
              orders: q.orders.map((x) => `${x.kind}:${x.status}`),
              queued: q.queued.length,
            })),
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
  frameId = requestAnimationFrame(frame);
  return stop;
}
