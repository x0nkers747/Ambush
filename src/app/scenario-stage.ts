import {
  addRouteWaypoint,
  AUTO_ORP_RADIUS_M,
  buildPreviewScenario,
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
import { DEFAULT_TICK_RATE_HZ, type TerrainDataset, type Vec2 } from '#sim';
import type { MapEditor } from '#view2d';

// Stage 2, scenario editing (docs/adr/0015, docs/adr/0025): place the ORP and
// the OPFOR and draw the OPFOR's route on the tactical map. The map shows a
// preview of the scenario with the game's own symbols, rebuilt after every
// accepted edit; edits are validated by the scenario model and saved as they
// happen. This controller owns the scenario; the workspace owns the page.

export type ScenarioTool = 'orp' | 'opfor' | 'route';

export const SCENARIO_TOOL_LABELS: Readonly<Record<ScenarioTool, string>> = {
  orp: 'Place ORP',
  opfor: 'Place OPFOR',
  route: 'Edit OPFOR route',
};

const TOOL_HINTS: Readonly<Record<ScenarioTool, string>> = {
  orp: 'Click the map to put the ORP there, or drag it.',
  opfor: 'Click where the OPFOR patrol starts, or drag its start.',
  route: 'Click to add a waypoint; drag one to move it; right-click it to delete it.',
};

/** Handle hit radius, in pixels. */
const HIT_PX = 10;

const toVec = (p: { east: number; north: number }): Vec2 => ({ x: p.east, y: p.north });

export interface ScenarioStageOptions {
  readonly terrain: TerrainDataset;
  readonly definition: ScenarioDefinition;
  /** Saves the definition (called after every accepted edit). */
  readonly save: (definition: ScenarioDefinition) => Promise<void>;
  readonly notify: (message: string) => void;
  /** Canvas pixel position of a map point (for handle hit tests). */
  readonly toScreen: (point: Vec2) => Vec2;
  /** Whether edits are allowed now (edit handles are drawn only then). */
  readonly editable: () => boolean;
  /** Called after every accepted edit with the new preview. */
  readonly changed: (preview: Exercise) => void;
}

export interface ScenarioStage {
  readonly definition: ScenarioDefinition;
  /** The exercise the map shows while editing: the scenario as it would be played. */
  readonly preview: Exercise;
  /** Whether the ORP is placed; until then the squad is not shown (`buildPreviewScenario`). */
  readonly squadPlaced: boolean;
  tool: ScenarioTool;
  /** Map hooks; the workspace decides when they are active. */
  readonly editor: MapEditor;
  /** `scenarioProblems` for the current definition (computed once per edit). */
  problems(): readonly string[];
  clearRoute(): void;
  /** Back to a new scenario: no ORP, no OPFOR. */
  reset(): void;
  deleteWaypoint(index: number): void;
  /** Saves now (e.g. before playing); rejects with the reason it failed. */
  saveNow(): Promise<void>;
  statusHtml(): string;
  routeHtml(): string;
}

/** The exercise built from a definition, as played (seed 1: only for display). */
export function previewExercise(terrain: TerrainDataset, d: ScenarioDefinition): Exercise {
  return createExercise({
    config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
    scenario: buildPreviewScenario(terrain, d).scenario,
  });
}

export function createScenarioStage(o: ScenarioStageOptions): ScenarioStage {
  const { terrain } = o;
  let definition = o.definition;
  let preview = previewExercise(terrain, definition);
  let problems: readonly string[] | null = null;
  let tool: ScenarioTool = definition.orp ? 'opfor' : 'orp';
  if (definition.opfor.route.length > 0) tool = 'route';
  type Drag = { kind: 'orp' } | { kind: 'point'; index: number };
  let drag: Drag | null = null;
  let dragPoint: Vec2 | null = null;

  const near = (p: Vec2, screen: Vec2, radius: number) => {
    const s = o.toScreen(p);
    return Math.hypot(s.x - screen.x, s.y - screen.y) <= radius;
  };
  const orpRadiusPx = () => {
    if (!definition.orp) return 0;
    const c = o.toScreen(toVec(definition.orp));
    const e = o.toScreen({ x: definition.orp.east + AUTO_ORP_RADIUS_M, y: definition.orp.north });
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

  const save = (d: ScenarioDefinition) => {
    void o.save(d).catch((error: unknown) => {
      o.notify(
        `The scenario could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  const commit = (next: ScenarioDefinition) => {
    let exercise: Exercise;
    try {
      exercise = previewExercise(terrain, next);
    } catch (error) {
      o.notify(error instanceof Error ? error.message : String(error));
      return;
    }
    definition = next;
    preview = exercise;
    problems = null;
    o.changed(exercise);
    save(definition);
  };
  const apply = (result: EditResult) => {
    if (!result.ok) {
      o.notify(result.problem);
      return;
    }
    commit(result.definition);
  };

  /** Route point labels and, for the active tool, edit handles and the drag preview. */
  const drawOverlay = (ctx: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2) => {
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
      const handles = o.editable() && (tool === 'route' || (tool === 'opfor' && i === 0));
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
  };

  const editor: MapEditor = {
    press(point, screen, button) {
      if (button === 2 && tool === 'route') {
        const index = pointAt(screen);
        if (index !== undefined) apply(deleteRouteWaypoint(terrain, definition, index));
        return true;
      }
      if (button !== 0) return false;
      if (tool === 'orp' && definition.orp && near(toVec(definition.orp), screen, orpRadiusPx())) {
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
    draw: drawOverlay,
    cursor(_point, screen) {
      if (pointAt(screen) !== undefined && tool !== 'orp') return 'move';
      if (tool === 'orp' && definition.orp && near(toVec(definition.orp), screen, orpRadiusPx()))
        return 'move';
      return 'crosshair';
    },
  };

  const routeLength = () => {
    const route = definition.opfor.route;
    return route.reduce(
      (sum, p, i) =>
        i === 0
          ? 0
          : sum +
            Math.hypot(p.east - (route[i - 1]?.east ?? 0), p.north - (route[i - 1]?.north ?? 0)),
      0,
    );
  };
  const fmt = (p: { east: number; north: number }) =>
    `E ${p.east.toFixed(0)} · N ${p.north.toFixed(0)}`;

  return {
    get definition() {
      return definition;
    },
    get preview() {
      return preview;
    },
    get squadPlaced() {
      return definition.orp !== null;
    },
    get tool() {
      return tool;
    },
    set tool(next) {
      tool = next;
    },
    editor,
    problems() {
      problems ??= scenarioProblems(terrain, definition);
      return problems;
    },
    clearRoute() {
      commit(clearRoute(definition));
    },
    reset() {
      const fresh = defaultScenarioDefinition(terrain, definition.battlefieldId, definition.name, {
        withOrp: false,
      });
      commit({ ...fresh, id: definition.id });
      tool = 'orp';
    },
    deleteWaypoint(index) {
      apply(deleteRouteWaypoint(terrain, definition, index));
    },
    saveNow: () => o.save(definition),
    statusHtml() {
      const route = definition.opfor.route;
      const force = OPFOR_FORCES[definition.opfor.force];
      const placed = (yes: boolean, detail: string) =>
        yes
          ? `<span class="ok">✓ Placed</span> <span class="muted">${detail}</span>`
          : '<span class="warn">✗ Not placed</span>';
      const waypoints = Math.max(0, route.length - 1);
      return `<dl class="kv">
        <dt>ORP</dt><dd>${placed(definition.orp !== null, definition.orp ? fmt(definition.orp) : '')}</dd>
        <dt>OPFOR</dt><dd>${placed(route.length > 0, `patrol of ${String(force.soldiers.length)}`)}</dd>
        <dt>Route</dt><dd>${
          waypoints === 0
            ? '<span class="warn">No waypoints</span>'
            : `${String(waypoints)} waypoint${waypoints === 1 ? '' : 's'} · ${routeLength().toFixed(0)} m`
        }</dd>
      </dl>`;
    },
    routeHtml() {
      const route = definition.opfor.route;
      return route.length === 0
        ? '<li class="muted">No OPFOR yet.</li>'
        : route
            .map(
              (p, i) =>
                `<li>${i === 0 ? '<b>Start</b>' : `Waypoint ${String(i)}`} · ${fmt(p)} <button class="link" data-delete="${String(i)}" aria-label="Delete ${i === 0 ? 'the OPFOR start' : `waypoint ${String(i)}`}" title="Delete">✕</button></li>`,
            )
            .join('');
    },
  };
}

export const scenarioToolHint = (tool: ScenarioTool): string => TOOL_HINTS[tool];

export const SCENARIO_HELP = `<dl class="help">
  <dt>Place ORP</dt><dd>Click the map to put the squad's ORP there, or drag the ORP</dd>
  <dt>Place OPFOR</dt><dd>Click where the OPFOR patrol starts (the route's first point), or drag it</dd>
  <dt>Edit OPFOR route</dt><dd>Click to add a waypoint at the end; drag a waypoint to move it; right-click a waypoint to delete it</dd>
  <dt>Drag map / wheel</dt><dd>Pan / zoom</dd>
  <dt>F</dt><dd>Fit the map</dd>
</dl>
<p class="muted">The ORP needs open ground for the 13 Marines; the OPFOR patrol (three soldiers in file) cannot start or walk into buildings or water. Between waypoints the patrol walks straight where it can and round buildings where it must; it does not follow roads by itself. Changes are saved as you make them.</p>`;
