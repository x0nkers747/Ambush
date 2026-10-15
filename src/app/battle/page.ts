import {
  buildPreviewScenario,
  createExercise,
  defaultScenarioDefinition,
  type Exercise,
} from '#exercise';
import {
  battleScenarioId,
  clearPlan,
  formationsForOrganization,
  ORDER_LABELS,
  ORGANIZATION_LABELS,
  parseBattleScenario,
  renameSquad,
  reorderOrder,
  scenarioSummary,
  setOrderKind,
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
import { createSession, type Session } from '#session';
import {
  DEFAULT_TICK_RATE_HZ,
  ORDER_KINDS,
  type OrderKind,
  type Side,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import { createTacticalMap, type MapBinding, type TacticalMap } from '#view2d';
import type { BattlefieldView3d, UnitMarker } from '#view3d';
import {
  createConfirm,
  createToast,
  escapeHtml,
  headerHtml,
  htmlSetter,
  wireHeader,
} from '../shell';
import { STAGE_NAMES } from '../workflow';
import { createBattleMapEditor, ORDER_INITIALS } from './map-editor';
import { createPlanner, type BattleStage, type PlannerTool } from './planner';

// Stages 2–5 of a battle on one battlefield (docs/constructive-simulation/03):
// Scenario Setup (place both sides' squads, give OPFOR its plans), BLUEFOR
// Planning (give BLUEFOR's squads their plans), Combat and the After-Action
// Review (next milestones). The workflow header, the map (2D, or 3D through
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
  /** Opens the battlefield's legacy ambush exercise instead (until Combat replaces it). */
  readonly openLegacy?: () => void;
}

/**
 * The map's own content on a battle's page: the terrain alone. The map
 * draws an exercise; a battle's squads and plans are the editor's drawing.
 */
export function terrainOnlyExercise(terrain: TerrainDataset): Exercise {
  const definition = defaultScenarioDefinition(terrain, 'terrain', undefined, { withOrp: false });
  return createExercise({
    config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
    scenario: buildPreviewScenario(terrain, definition).scenario,
  });
}

const PLACE_ORGANIZATIONS: readonly SquadOrganization[] = ['squad', 'fireTeam', 'element3'];

const ORDER_KEYS: Readonly<Record<string, OrderKind>> = { m: 'move', a: 'attack', w: 'withdraw' };

const HELP_HTML = `<dl class="kv help">
  <dt>S, Esc</dt><dd>Select tool; Esc again clears the selection</dd>
  <dt>P</dt><dd>Place squads (Scenario Setup): pick the side and organization, then click the map</dd>
  <dt>M, A, W</dt><dd>Give the selected squad Move, Attack or Withdraw orders: each click adds one, after the selected order</dd>
  <dt>Drag</dt><dd>A squad to move it (Setup), a waypoint to move its destination, the white knob to turn the selected squad</dd>
  <dt>Right-click</dt><dd>A waypoint to delete its order</dd>
  <dt>Delete</dt><dd>The selected order, or else the selected squad (Setup)</dd>
  <dt>F</dt><dd>Fit the map (2D) or return to the overhead view (3D)</dd>
</dl>
<p class="hint">Orders: <b>Move</b> goes to the destination, halting to fight on contact and carrying on;
<b>Attack</b> takes and clears the objective, assaulting with fire and movement; <b>Withdraw</b> falls back
without halting to fight. Contact interrupts an order: the squad reacts on its own, then resumes it.
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
      <div class="tool-row">
        <button class="small" data-act="export" title="Download the scenario as a file">Export…</button>
        <button class="small" data-act="import" title="Load a scenario file (version 1 or 2) for this battlefield">Import…</button>
        <button class="small" data-act="new-scenario" data-ui="new-scenario" title="Start again: no squads">New scenario</button>
        <input type="file" accept=".json,application/json" data-ui="import-file" hidden>
      </div>
    </section>
    <details class="sec collapsible" data-sec="help">
      <summary>Help</summary>
      ${HELP_HTML}
    </details>
    <details class="sec collapsible" data-sec="info">
      <summary>Battlefield Information</summary>
      <div class="bf-info">${o.infoHtml}</div>
      ${o.openLegacy ? '<p class="hint">The earlier ambush exercise (one squad, the ORP, the kill zone) is still available until Combat replaces it. <button class="link" data-act="legacy">Open the ambush exercise</button></p>' : ''}
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

  // --- Map --------------------------------------------------------------

  let session: Session = createSession();
  const placeholder = app.querySelector<HTMLCanvasElement>('#map');
  if (!placeholder) throw new Error('Missing map canvas');
  const base = terrainOnlyExercise(o.terrain);
  const binding: MapBinding = {
    exercise: base,
    getSession: () => session,
    setSession: (next) => {
      session = next;
    },
    notify,
    editor,
    hideTrainee: () => true,
  };
  const adopt = (handed: TacticalMap): TacticalMap => {
    const canvas = handed.canvas;
    canvas.id = 'map';
    canvas.className = '';
    canvas.setAttribute('aria-label', 'Tactical map');
    placeholder.replaceWith(canvas);
    handed.attach(binding);
    return handed;
  };
  const map = o.map ? adopt(o.map) : createTacticalMap({ canvas: placeholder, ...binding });

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
  const figures = () => {
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
        view3d = createBattlefieldView3d({
          exercise: () => base,
          session: () => session,
          hideTrainee: () => true,
          figures,
        });
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
    planner.setStage(target);
    if (target === 'scenario' || target === 'bluefor') o.setAddress(target);
    lastVersion = -1;
  };
  const leave = () => {
    stop();
    o.leave(map);
  };
  const PRIMARY: Readonly<Record<BattleStage, string>> = {
    scenario: 'Continue to BLUEFOR Planning →',
    bluefor: 'Continue to Combat →',
    combat: 'After-Action Review →',
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
    const reason = stage === 'aar' ? null : planner.rules.next(stage);
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
    </div>`;

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
        return `<p class="coming-soon">Combat comes next</p>
          <p>The plans are ready: ${escapeHtml(scenarioSummary(planner.definition))}. Running them
          live, with orders to either side, pause and speed, is the next milestone
          (docs/constructive-simulation/progress.md).</p>`;
      case 'aar':
        return '<p class="coming-soon">The After-Action Review comes after Combat.</p>';
    }
  };

  const toolHint = (): string => {
    const t = planner.tool;
    const selected = planner.selectedSquad;
    if (t.kind === 'place')
      return `Click the map to place a ${t.side} ${ORGANIZATION_LABELS[t.organization].toLowerCase()}; Esc to stop.`;
    if (t.kind === 'order') {
      if (!selected) return 'Select a squad first (click it, or pick it in the roster).';
      if (!planner.canPlan(selected))
        return planner.stage === 'bluefor'
          ? `${selected.name} is OPFOR: its plan is set in Scenario Setup.`
          : `${selected.name} is BLUEFOR: its plan is made in BLUEFOR Planning.`;
      return `Click the map: ${selected.name} gets a ${ORDER_LABELS[t.order]} order there${planner.selection.orderIndex === null ? ', after its last order' : `, after order ${String(planner.selection.orderIndex + 1)}`}.`;
    }
    if (planner.stage === 'scenario')
      return 'Place both sides’ squads, then give OPFOR its plans (select an OPFOR squad, then M, A or W).';
    if (planner.stage === 'bluefor')
      return 'Select a BLUEFOR squad, then M, A or W and click the map for each order.';
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
        const issue = issues.find((i) => i.orderIndex === k);
        return `<li class="order-row${selected ? ' selected' : ''}${issue ? ' has-issue' : ''}" data-index="${String(k)}">
          <button class="order-pick small" data-act="pick-order" data-index="${String(k)}" title="Select this order">${String(k + 1)}</button>
          ${kindSelect}
          <span class="muted coords">${String(Math.round(order.destination.east))} E, ${String(Math.round(order.destination.north))} N</span>
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

  // Clicks and changes in the side panel.
  const aside = app.querySelector<HTMLElement>('aside.side');
  if (!aside) throw new Error('Missing side panel');
  aside.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
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
      case 'export':
        exportScenario();
        return;
      case 'import':
        (ui('import-file') as HTMLInputElement).click();
        return;
      case 'new-scenario':
        if (planner.stage !== 'scenario') return;
        confirm({
          message: `Delete every squad and plan of this scenario (${scenarioSummary(planner.definition)}) and start again?`,
          action: 'New scenario',
          onConfirm: () => {
            planner.edit((d) => ({ ok: true, definition: { ...d, squads: [] } }));
            planner.select(null);
          },
        });
        return;
      case 'legacy':
        stop();
        o.openLegacy?.();
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
        if (s) planner.edit((d) => setSquadOrganization(d, s.id, value as SquadOrganization));
        break;
      case 'formation':
        if (s) planner.edit((d) => setSquadFormation(d, s.id, value));
        break;
      case 'facing':
        if (s) planner.edit((d) => setSquadFacing(d, s.id, Number(value)));
        break;
      case 'order-kind':
        if (s)
          planner.edit((d) =>
            setOrderKind(d, s.id, Number(el.dataset['index']), value as OrderKind),
          );
        break;
      case 'seed':
        planner.edit((d) => setSeed(d, Number(value)));
        break;
    }
    lastVersion = -1;
  });

  // --- Export and import ------------------------------------------------------

  const exportScenario = () => {
    const d = planner.definition;
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${d.name.replace(/[^\w.-]+/g, '-') || 'scenario'}.scenario.json`;
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
    }, 1000);
  };
  const importFile = ui('import-file') as HTMLInputElement;
  importFile.addEventListener('change', () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (!file) return;
    void file.text().then((text) => {
      let read: BattleScenarioDefinition;
      try {
        read = parseBattleScenario(JSON.parse(text) as unknown);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error));
        return;
      }
      const own = planner.definition;
      const other = read.battlefieldId !== own.battlefieldId;
      const adopted: BattleScenarioDefinition = {
        ...read,
        id: battleScenarioId(own.battlefieldId),
        battlefieldId: own.battlefieldId,
        ...(own.terrainModel !== undefined ? { terrainModel: own.terrainModel } : {}),
      };
      confirm({
        message: `Replace this scenario with “${read.name}” (${scenarioSummary(read)})?${other ? ' It was made for another battlefield: its positions are taken as this one’s map coordinates.' : ''}`,
        action: 'Replace scenario',
        onConfirm: () => {
          planner.edit(() => ({ ok: true, definition: adopted }));
          planner.select(null);
          const issues = planner.issues().length;
          notify(
            issues === 0
              ? `Loaded “${read.name}”.`
              : `Loaded “${read.name}”: ${String(issues)} thing${issues === 1 ? '' : 's'} to fix before it can be played.`,
          );
        },
      });
    });
  });

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
  window.addEventListener('keydown', onKeyDown);
  let lastPlace: PlannerTool = { kind: 'place', side: 'BLUEFOR', organization: 'squad' };

  // --- Frame loop -------------------------------------------------------------

  let lastVersion = -1;
  const updatePanels = () => {
    const stage = planner.stage;
    header.update(stage, planner.rules);
    const reason = stage === 'aar' ? null : planner.rules.next(stage);
    const primary = ui('primary') as HTMLButtonElement;
    setText(primary, PRIMARY[stage]);
    primary.setAttribute('aria-disabled', String(reason !== null));
    setText(ui('primary-reason'), reason ?? '');
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
    if (squadSection) squadSection.hidden = stage === 'combat' || stage === 'aar';
    // Not while the user is typing in it.
    const squadEl = ui('squad');
    if (!squadEl.contains(document.activeElement) || document.activeElement === document.body)
      setHtml(squadEl, squadHtml(planner.selectedSquad));
    setHtml(ui('roster'), rosterHtml());
    const scenarioEl = ui('scenario');
    if (!scenarioEl.contains(document.activeElement)) setHtml(scenarioEl, scenarioHtml());
  };

  let frameId = 0;
  const frame = () => {
    if (viewMode === '3d' && view3d) {
      map.update();
      view3d.render();
    } else map.render();
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
      blocker: planner.stage === 'aar' ? null : planner.rules.next(planner.stage),
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
