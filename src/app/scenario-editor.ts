import {
  addRouteWaypoint,
  AUTO_ORP_RADIUS_M,
  buildScenario,
  clearRoute,
  createExercise,
  defaultScenarioDefinition,
  deleteRouteWaypoint,
  moveRouteWaypoint,
  OPFOR_FORCES,
  scenarioProblems,
  setOpforStart,
  setOrp,
  type EditResult,
  type Exercise,
  type ScenarioDefinition,
} from '#exercise';
import { createSession, type Session } from '#session';
import { DEFAULT_TICK_RATE_HZ, type TerrainDataset, type Vec2 } from '#sim';
import { createTacticalMap } from '#view2d';

// Stage 2, scenario editing (docs/adr/0015): place the ORP and the OPFOR and
// draw the OPFOR's route on the tactical map. The map shows a preview of the
// scenario with the game's own symbols, rebuilt after every accepted edit;
// edits are validated by the scenario model and saved as they happen.

export interface ScenarioEditorOptions {
  readonly terrain: TerrainDataset;
  readonly battlefieldName: string;
  readonly definition: ScenarioDefinition;
  readonly attribution: readonly string[];
  readonly describePoint?: (point: Vec2) => string;
  /** Saves the definition (called after every accepted edit). */
  readonly save: (definition: ScenarioDefinition) => Promise<void>;
  readonly onBack: () => void;
  /** Called with a valid definition, already saved. */
  readonly onContinue: () => void;
}

type Tool = 'orp' | 'opfor' | 'route';
type Drag = { kind: 'orp' } | { kind: 'point'; index: number };

const TOOL_LABELS: Record<Tool, string> = {
  orp: 'Place ORP',
  opfor: 'Place OPFOR',
  route: 'Edit OPFOR route',
};
/** Handle hit radius, in pixels. */
const HIT_PX = 10;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
const toVec = (p: { east: number; north: number }): Vec2 => ({ x: p.east, y: p.north });

export function startScenarioEditor(app: HTMLElement, o: ScenarioEditorOptions): void {
  const { terrain } = o;
  let definition = o.definition;
  let tool: Tool = definition.orp ? 'opfor' : 'orp';
  if (definition.opfor.route.length > 0) tool = 'route';
  let drag: Drag | null = null;
  let dragPoint: Vec2 | null = null;
  let session: Session = createSession();
  let confirmReset = false;

  app.classList.remove('start');
  app.innerHTML = `
    <header>
      <h1>AMBUSH!</h1>
      <button data-ui="back" title="Back to terrain selection">◂ Terrain</button>
      <span class="phase" data-phase="editing">SCENARIO EDITING</span>
      <span class="battlefield-button" title="${escapeHtml(o.battlefieldName)}">${escapeHtml(o.battlefieldName)}</span>
      <div class="group" data-ui="tools"></div>
      <div class="group">
        <button data-ui="clear-route" title="Remove the route's waypoints (the OPFOR stays where it starts)">Clear route</button>
        <button data-ui="reset" title="Back to the default scenario: ORP near the centre, no OPFOR">Reset scenario</button>
      </div>
      <span class="spacer"></span>
      <button data-ui="fit" title="Fit the whole map (F)">Fit map</button>
      <button class="primary" data-ui="continue" title="Check the scenario and start BLUEFOR planning">Continue to BLUEFOR planning ▸</button>
    </header>
    <main>
      <canvas id="map" aria-label="Tactical map"></canvas>
      <div class="attribution" data-ui="attribution" hidden></div>
      <div class="toast" data-ui="toast" hidden></div>
    </main>
    <aside>
      <h2>Scenario</h2>
      <dl class="status" data-ui="summary"></dl>
      <div data-ui="problems" class="start-check"></div>
      <h2>OPFOR route</h2>
      <ol class="route-list" data-ui="route"></ol>
      <h2>Tools</h2>
      <dl class="help">
        <dt>Place ORP</dt><dd>Click the map to put the squad's ORP there, or drag the ORP</dd>
        <dt>Place OPFOR</dt><dd>Click where the OPFOR patrol starts (the route's first point), or drag it</dd>
        <dt>Edit OPFOR route</dt><dd>Click to add a waypoint at the end; drag a waypoint to move it; right-click a waypoint to delete it</dd>
        <dt>Drag map / wheel</dt><dd>Pan / zoom, as in planning</dd>
      </dl>
      <p class="muted">The ORP needs open ground for the 13 Marines; the OPFOR patrol (three soldiers in file) cannot start or walk into buildings or water. Between waypoints the patrol walks straight where it can and round buildings where it must; it does not follow roads by itself. Changes are saved as you make them.</p>
    </aside>
    <footer data-ui="pointer"></footer>`;

  const ui = (name: string): HTMLElement => {
    const el = app.querySelector<HTMLElement>(`[data-ui="${name}"]`);
    if (!el) throw new Error(`Missing UI element ${name}`);
    return el;
  };
  const canvas = app.querySelector<HTMLCanvasElement>('#map');
  if (!canvas) throw new Error('Missing map canvas');

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = (message: string) => {
    const el = ui('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 3500);
  };

  const preview = (d: ScenarioDefinition): Exercise =>
    createExercise({
      config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
      scenario: buildScenario(terrain, d),
    });

  const map = createTacticalMap({
    canvas,
    exercise: preview(definition),
    getSession: () => session,
    setSession: (next) => {
      session = next;
    },
    notify: toast,
    editor: {
      press(point, screen, button) {
        if (button === 2 && tool === 'route') {
          const index = pointAt(screen);
          if (index !== undefined) apply(deleteRouteWaypoint(terrain, definition, index));
          return true;
        }
        if (button !== 0) return false;
        if (
          tool === 'orp' &&
          definition.orp &&
          near(toVec(definition.orp), screen, orpRadiusPx())
        ) {
          drag = { kind: 'orp' };
          dragPoint = point;
          return true;
        }
        const index = pointAt(screen);
        if (index !== undefined && (tool === 'route' || (tool === 'opfor' && index === 0))) {
          drag = { kind: 'point', index };
          dragPoint = point;
          return true;
        }
        return false;
      },
      drag(point) {
        dragPoint = point;
      },
      drop(point) {
        const d = drag;
        drag = null;
        dragPoint = null;
        if (!d) return;
        if (d.kind === 'orp') apply(setOrp(terrain, definition, point));
        else if (d.index === 0) apply(setOpforStart(terrain, definition, point));
        else apply(moveRouteWaypoint(terrain, definition, d.index, point));
      },
      click(point) {
        if (tool === 'orp') apply(setOrp(terrain, definition, point));
        else if (tool === 'opfor') apply(setOpforStart(terrain, definition, point));
        else apply(addRouteWaypoint(terrain, definition, point));
      },
      draw(ctx, toScreen) {
        drawOverlay(ctx, toScreen);
      },
      cursor(_point, screen) {
        if (pointAt(screen) !== undefined && tool !== 'orp') return 'move';
        if (tool === 'orp' && definition.orp && near(toVec(definition.orp), screen, orpRadiusPx()))
          return 'move';
        return 'crosshair';
      },
    },
  });

  const near = (p: Vec2, screen: Vec2, radius: number) => {
    const s = map.toScreen(p);
    return Math.hypot(s.x - screen.x, s.y - screen.y) <= radius;
  };
  const orpRadiusPx = () => {
    if (!definition.orp) return 0;
    const c = map.toScreen(toVec(definition.orp));
    const e = map.toScreen({ x: definition.orp.east + AUTO_ORP_RADIUS_M, y: definition.orp.north });
    return Math.max(HIT_PX, Math.abs(e.x - c.x));
  };
  /** The route point under a screen position (the topmost, i.e. the latest). */
  const pointAt = (screen: Vec2): number | undefined => {
    for (let i = definition.opfor.route.length - 1; i >= 0; i -= 1) {
      const p = definition.opfor.route[i];
      if (p && near(toVec(p), screen, HIT_PX)) return i;
    }
    return undefined;
  };

  let dirty = true;
  const apply = (result: EditResult) => {
    if (!result.ok) {
      toast(result.problem);
      return;
    }
    commit(result.definition);
  };
  const commit = (next: ScenarioDefinition) => {
    let exercise: Exercise;
    try {
      exercise = preview(next);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      return;
    }
    definition = next;
    map.setExercise(exercise);
    dirty = true;
    void o.save(definition).catch((error: unknown) => {
      toast(
        `The scenario could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  /** Route point labels and, for the active tool, edit handles and the drag preview. */
  // A function declaration (hoisted): the map draws once while it is being created.
  function drawOverlay(ctx: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2): void {
    const route = definition.opfor.route.map((p, i) =>
      drag?.kind === 'point' && drag.index === i && dragPoint ? dragPoint : toVec(p),
    );
    ctx.save();
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // Drag preview: the legs to the dragged point.
    if (drag?.kind === 'point' && dragPoint) {
      ctx.strokeStyle = 'rgba(122, 22, 40, 0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      for (const k of [drag.index - 1, drag.index + 1]) {
        const q = route[k];
        if (!q) continue;
        const a = toScreen(q);
        const b = toScreen(dragPoint);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (drag?.kind === 'orp' && dragPoint) {
      const c = toScreen(dragPoint);
      const r = Math.abs(toScreen({ x: dragPoint.x + AUTO_ORP_RADIUS_M, y: dragPoint.y }).x - c.x);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, 2 * Math.PI);
      ctx.setLineDash([6, 3]);
      ctx.strokeStyle = 'rgba(29, 64, 120, 0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    route.forEach((p, i) => {
      const s = toScreen(p);
      const handles = tool === 'route' || (tool === 'opfor' && i === 0);
      if (handles) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 6, 0, 2 * Math.PI);
        ctx.fillStyle = i === 0 ? '#f25c5c' : '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#7a1628';
        ctx.stroke();
      }
      const label = i === 0 ? 'OPFOR start' : String(i);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.strokeText(label, s.x + 9, s.y - 9);
      ctx.fillStyle = '#7a1628';
      ctx.fillText(label, s.x + 9, s.y - 9);
    });
    ctx.restore();
  }

  // Header controls.
  for (const t of ['orp', 'opfor', 'route'] as const) {
    const b = document.createElement('button');
    b.textContent = TOOL_LABELS[t];
    b.dataset['tool'] = t;
    b.addEventListener('click', () => {
      tool = t;
      dirty = true;
    });
    ui('tools').append(b);
  }
  ui('clear-route').addEventListener('click', () => {
    commit(clearRoute(definition));
  });
  ui('reset').addEventListener('click', () => {
    // Two clicks: the first asks for confirmation.
    if (!confirmReset) {
      confirmReset = true;
      ui('reset').textContent = 'Confirm reset';
      ui('reset').classList.add('danger');
      return;
    }
    confirmReset = false;
    ui('reset').textContent = 'Reset scenario';
    ui('reset').classList.remove('danger');
    const fresh = defaultScenarioDefinition(terrain, definition.battlefieldId, definition.name);
    commit({ ...fresh, id: definition.id });
    tool = fresh.orp ? 'opfor' : 'orp';
  });
  ui('fit').addEventListener('click', () => {
    map.fitView();
  });
  ui('back').addEventListener('click', () => {
    o.onBack();
  });
  ui('continue').addEventListener('click', () => {
    const problems = scenarioProblems(terrain, definition);
    if (problems.length > 0) {
      toast(problems.join(' '));
      dirty = true;
      return;
    }
    o.save(definition)
      .then(() => {
        o.onContinue();
      })
      .catch((error: unknown) => {
        toast(
          `The scenario could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  });
  ui('route').addEventListener('click', (event) => {
    const index = (event.target as HTMLElement).closest<HTMLElement>('[data-delete]')?.dataset[
      'delete'
    ];
    if (index !== undefined) apply(deleteRouteWaypoint(terrain, definition, Number(index)));
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'f' || event.key === 'F') map.fitView();
  });
  if (o.attribution.length > 0) {
    ui('attribution').hidden = false;
    ui('attribution').textContent = o.attribution
      .map((line) => line.replace(/^Map data /, ''))
      .slice(0, 2)
      .join(' · ');
    ui('attribution').title = o.attribution.join('\n');
  }

  const fmt = (p: { east: number; north: number }) =>
    `E ${p.east.toFixed(0)} · N ${p.north.toFixed(0)}`;
  const updatePanels = () => {
    for (const b of ui('tools').querySelectorAll<HTMLButtonElement>('button')) {
      b.setAttribute('aria-pressed', String(b.dataset['tool'] === tool));
    }
    const route = definition.opfor.route;
    const length = route.reduce(
      (sum, p, i) =>
        i === 0
          ? 0
          : sum +
            Math.hypot(p.east - (route[i - 1]?.east ?? 0), p.north - (route[i - 1]?.north ?? 0)),
      0,
    );
    const force = OPFOR_FORCES[definition.opfor.force];
    ui('summary').innerHTML = `
      <dt>ORP</dt><dd>${definition.orp ? fmt(definition.orp) : 'not placed'}</dd>
      <dt>BLUEFOR</dt><dd>13-Marine rifle squad, starting in the ORP</dd>
      <dt>OPFOR</dt><dd>Patrol of ${String(force.soldiers.length)} (${force.soldiers.join(', ')}), ${route[0] ? `starting at ${fmt(route[0])}` : 'not placed'}</dd>
      <dt>Route</dt><dd>${String(Math.max(0, route.length - 1))} waypoint(s), ${length.toFixed(0)} m in straight lines</dd>`;
    const problems = scenarioProblems(terrain, definition);
    ui('problems').innerHTML =
      problems.length === 0
        ? '<p class="ok">Ready: continue to BLUEFOR planning.</p>'
        : `<p>To continue:</p><ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
    (ui('continue') as HTMLButtonElement).classList.toggle('armed', problems.length === 0);
    ui('route').innerHTML =
      route.length === 0
        ? '<li class="muted">No OPFOR yet: choose Place OPFOR and click the map.</li>'
        : route
            .map(
              (p, i) =>
                `<li>${i === 0 ? '<b>Start</b>' : `Waypoint ${String(i)}`} · ${fmt(p)} <button class="link" data-delete="${String(i)}" title="Delete">✕</button></li>`,
            )
            .join('');
  };

  const frame = () => {
    map.render();
    if (dirty) {
      updatePanels();
      dirty = false;
    }
    const p = map.pointer;
    ui('pointer').textContent = p
      ? `E ${p.east.toFixed(1)} m   N ${p.north.toFixed(1)} m   Elev ${p.elevation.toFixed(1)} m${
          o.describePoint ? `   ${o.describePoint({ x: p.east, y: p.north })}` : ''
        }   ·   Tool: ${TOOL_LABELS[tool]}`
      : `Tool: ${TOOL_LABELS[tool]}`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
