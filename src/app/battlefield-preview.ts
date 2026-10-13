import { createExercise, type AmbushScenario, type Exercise } from '#exercise';
import { createSession, setTool, type Session } from '#session';
import { DEFAULT_TICK_RATE_HZ } from '#sim';
import { createTacticalMap, type MapSurface, type TacticalMap } from '#view2d';
import type { BattlefieldView3d } from '#view3d';

// The terrain-selection preview (docs/adr/0025): the selected battlefield on
// the tactical map, with its scenario as saved (ORP, OPFOR and route). It is
// for looking only: the map pans and zooms, and clicks select but never edit
// (the `view` tool). Opening the battlefield hands this map to the
// workspace, and leaving the workspace hands it back, so the map is never
// rebuilt between the two.
//
// The 3D button shows the same battlefield in the 3D view (docs/adr/0029),
// loaded on first use. It is the preview's own: it follows the selected
// battlefield, and is disposed when the preview is hidden or its map is
// handed to the workspace, which has its own 3D view.

export interface PreviewData {
  /** The battlefield's scenario as it would be played (its terrain is the battlefield's). */
  readonly scenario: AmbushScenario;
  /** Whether its ORP is placed; until then the squad and the ORP are not shown. */
  readonly squadPlaced: boolean;
  /** Source credits shown on the map. */
  readonly attribution: readonly string[];
  /** A short line about the scenario, e.g. "No OPFOR yet". */
  readonly caption: string;
}

export interface BattlefieldPreview {
  /**
   * Shows battlefield `id`, loading it unless it is already shown or
   * loading; a newer `show`, `adopt` or `hide` wins over a slower load.
   */
  show(id: string, load: () => Promise<PreviewData>): void;
  /** Shows battlefield `id` on a map handed back by its workspace, keeping the map's view. */
  adopt(id: string, map: TacticalMap, data: PreviewData): void;
  hide(): void;
  /**
   * Gives the map away (to the workspace) without disposing it, or `null`
   * when no map is shown yet. The preview is empty afterwards.
   */
  release(): TacticalMap | null;
}

export function createBattlefieldPreview(container: HTMLElement): BattlefieldPreview {
  container.innerHTML = `
    <div class="preview-map" data-ui="preview-map"></div>
    <div class="attribution" data-ui="preview-attribution" hidden></div>
    <div class="preview-status" data-ui="preview-status" role="status"></div>
    <div class="mapbar"><span class="pointer" data-ui="preview-pointer"></span><span class="spacer"></span>
      <span data-ui="preview-caption"></span>
      <span class="view-toggle" role="group" aria-label="View">
        <button class="small" data-preview-view="2d" aria-pressed="true" title="The 2D tactical map">2D</button>
        <button class="small" data-preview-view="3d" aria-pressed="false" title="The terrain in 3D">3D</button>
      </span>
      <button class="small" data-ui="preview-fit" title="Fit the whole map">Fit map</button></div>`;
  const el = (name: string) => {
    const e = container.querySelector<HTMLElement>(`[data-ui="${name}"]`);
    if (!e) throw new Error(`Missing UI element ${name}`);
    return e;
  };
  let map: TacticalMap | null = null;
  let session: Session = setTool(createSession(), 'view');
  /** The battlefield shown or loading, or `null`. */
  let shownId: string | null = null;
  /** Each show, adopt or hide; a load that finishes after a newer one is dropped. */
  let generation = 0;
  let frame: number | null = null;
  /** The shown exercise (view only), for the 3D view. */
  let exercise: Exercise | null = null;
  let hideTrainee = true;
  let viewMode: '2d' | '3d' = '2d';
  let view3d: BattlefieldView3d | null = null;
  let loading3d = false;
  /** The map's gameplay on the 3D view, forgotten with the view. */
  let surface3d: MapSurface | null = null;

  const stopLoop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  /** Disposes the 3D view (the preview's own, never handed on), keeping the chosen mode. */
  const stop3d = () => {
    surface3d?.detach();
    surface3d = null;
    if (!view3d) return;
    view3d.canvas.remove();
    view3d.overlay.remove();
    view3d.dispose();
    view3d = null;
  };
  /** Disposes the preview's own map; a released map is no longer the preview's to remove. */
  const stopMap = () => {
    stopLoop();
    stop3d();
    exercise = null;
    if (!map) return;
    map.dispose();
    map = null;
    el('preview-map').replaceChildren();
  };
  const showing3d = () => viewMode === '3d' && view3d !== null;
  const loop = () => {
    if (showing3d()) view3d?.render();
    else map?.render();
    // The same pointer readout as the other stages' map bar.
    const ground = showing3d() ? (view3d?.pointer ?? null) : null;
    const p = showing3d()
      ? ground && { east: ground.x, north: ground.y, elevation: ground.z }
      : map?.pointer;
    const readout = p
      ? `E ${p.east.toFixed(1)} m   N ${p.north.toFixed(1)} m   Elev ${p.elevation.toFixed(1)} m`
      : '';
    const text = showing3d()
      ? (view3d?.status() ??
        (readout || 'Drag: pan · Right-drag: orbit · Wheel: zoom · Double-click: focus'))
      : readout;
    const readoutEl = el('preview-pointer');
    if (readoutEl.textContent !== text) readoutEl.textContent = text;
    frame = requestAnimationFrame(loop);
  };
  /** The 3D camera's distance that shows about as much ground as the 2D map's scale (as in the workspace). */
  const FOV_HALF_TAN = Math.tan((22.5 * Math.PI) / 180);
  /** Keeps the place in view when switching: the other view looks where this one did. */
  const carryFocus = (to: '2d' | '3d') => {
    if (!view3d || !map) return;
    const height = Math.max(map.canvas.getBoundingClientRect().height, 1);
    if (to === '3d') {
      const { centre, metersPerPixel } = map.view;
      view3d.focusOn(centre, (metersPerPixel * height) / (2 * FOV_HALF_TAN));
    } else {
      const focus = view3d.focus();
      if (focus) map.setView(focus.point, (2 * FOV_HALF_TAN * focus.distance) / height);
    }
  };
  const showViewMode = () => {
    for (const b of container.querySelectorAll<HTMLButtonElement>('[data-preview-view]'))
      b.setAttribute('aria-pressed', String(b.dataset['previewView'] === viewMode));
    if (view3d) {
      view3d.canvas.hidden = viewMode !== '3d';
      view3d.overlay.hidden = viewMode !== '3d';
    }
    const fit = el('preview-fit');
    fit.title = viewMode === '3d' ? 'Back to the overhead view' : 'Fit the whole map';
    fit.textContent = viewMode === '3d' ? 'Reset view' : 'Fit map';
  };
  /** Places a 3D view over the 2D map, with the map's overlays (ORP, OPFOR, route) drawn on it. */
  const place3d = (v: BattlefieldView3d) => {
    el('preview-map').append(v.canvas, v.overlay);
    if (!map) return;
    const surface = map.surface(
      () => v.projection(),
      () => {
        const rect = v.canvas.getBoundingClientRect();
        return { width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) };
      },
    );
    surface3d = surface;
    // The `view` tool: clicks select, nothing is edited.
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
  /** Opens the 3D view for the shown battlefield, loading the 3D code on first use. */
  const open3d = () => {
    if (view3d || loading3d || !exercise) return;
    loading3d = true;
    const loading = 'Loading the 3D view…';
    status(loading);
    import('#view3d')
      .then(({ createBattlefieldView3d }) => {
        loading3d = false;
        if (el('preview-status').textContent === loading) status(null);
        // Whatever is shown now (the battlefield may have changed while loading), if still wanted.
        if (!exercise || viewMode !== '3d' || view3d) return;
        view3d = createBattlefieldView3d({
          exercise: () => {
            if (!exercise) throw new Error('No battlefield shown');
            return exercise;
          },
          session: () => session,
          hideTrainee: () => hideTrainee,
        });
        place3d(view3d);
        showViewMode();
        // The first frame lays out the camera; then look where the 2D map did.
        const opened = view3d;
        requestAnimationFrame(() => {
          if (view3d === opened && viewMode === '3d') carryFocus('3d');
        });
      })
      .catch((error: unknown) => {
        loading3d = false;
        if (el('preview-status').textContent === loading) status(null);
        viewMode = '2d';
        showViewMode();
        if (exercise)
          status(
            `The 3D view could not be opened: ${error instanceof Error ? error.message : String(error)}`,
          );
      });
  };
  const setViewMode = (mode: '2d' | '3d') => {
    if (mode === viewMode) return;
    if (view3d) carryFocus(mode);
    viewMode = mode;
    showViewMode();
    if (mode === '3d') open3d();
  };
  for (const b of container.querySelectorAll<HTMLButtonElement>('[data-preview-view]')) {
    b.addEventListener('click', () => {
      setViewMode(b.dataset['previewView'] === '3d' ? '3d' : '2d');
    });
  }
  const status = (text: string | null) => {
    el('preview-status').hidden = text === null;
    el('preview-status').textContent = text ?? '';
  };
  el('preview-fit').addEventListener('click', () => {
    if (showing3d()) view3d?.resetView();
    else map?.fitView();
  });

  /** Shows `data` on `existing` (a handed-back map) or on a new map. */
  const present = (data: PreviewData, existing: TacticalMap | null) => {
    if (map !== existing) stopMap();
    stopLoop();
    // The 3D view follows the map, so a new one is made for the new map and battlefield.
    stop3d();
    session = setTool(createSession(), 'view');
    exercise = createExercise({
      config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
      scenario: data.scenario,
    });
    hideTrainee = !data.squadPlaced;
    const binding = {
      exercise,
      getSession: () => session,
      setSession: (next: Session) => {
        session = next;
      },
      hideTrainee: () => !data.squadPlaced,
    };
    const canvas = existing?.canvas ?? document.createElement('canvas');
    canvas.id = '';
    canvas.className = 'preview-canvas';
    canvas.setAttribute('aria-label', 'Battlefield preview');
    el('preview-map').replaceChildren(canvas);
    if (existing) existing.attach(binding);
    map = existing ?? createTacticalMap({ canvas, ...binding });
    const credits = el('preview-attribution');
    credits.hidden = data.attribution.length === 0;
    credits.textContent = data.attribution
      .map((line) => line.replace(/^Map data /, ''))
      .slice(0, 2)
      .join(' · ');
    credits.title = data.attribution.join('\n');
    el('preview-caption').textContent = data.caption;
    status(null);
    showViewMode();
    if (viewMode === '3d') open3d();
    loop();
  };

  return {
    show(id, load) {
      if (id === shownId) return;
      shownId = id;
      const mine = (generation += 1);
      container.hidden = false;
      status('Loading the preview…');
      load()
        .then((data) => {
          if (mine !== generation) return;
          present(data, null);
        })
        .catch((error: unknown) => {
          if (mine !== generation) return;
          stopMap();
          el('preview-caption').textContent = '';
          status(
            `No preview: ${error instanceof Error ? error.message : String(error)}. The battlefield may still open.`,
          );
        });
    },
    adopt(id, handed, data) {
      generation += 1;
      shownId = id;
      container.hidden = false;
      present(data, handed);
    },
    hide() {
      generation += 1;
      shownId = null;
      stopMap();
      container.hidden = true;
    },
    release() {
      generation += 1;
      shownId = null;
      stopLoop();
      stop3d();
      exercise = null;
      const given = map;
      map = null;
      return given;
    },
  };
}
