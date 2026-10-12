import type { Exercise } from '#exercise';
import type { Session } from '#session';
import type { SoldierId, Vec2, ViewSector } from '#sim';
import {
  fitBounds,
  type Bounds,
  MAX_METERS_PER_PIXEL,
  MIN_METERS_PER_PIXEL,
  screenToWorld,
  worldToScreen,
  type Camera,
  type Viewport,
} from './camera';
import { createMapActions } from './actions';
import { createMapController, DRAG_THRESHOLD_PX } from './interaction';
import { createGeoCache, snapCamera, type CacheContext } from './geo-cache';
import {
  COLORS,
  createTerrainLayer,
  FEATURE_PHASES,
  GROUND_PHASES,
  drawOverlays,
  drawVisibility,
  hasVisibilityOverlay,
} from './render';
import { elevationAt } from './terrain-layer';
import { buildScene, type MapProjection, type MapScene, type VisibilityView } from './scene';
import { engagementWedge } from './engagement';
import { createTeamVisibility } from './group-viewshed';
import { createViewshedService } from './viewshed-service';

/** Viewshed resolution in metres: full detail, and a quicker preview while dragging. */
export const VIEWSHED_CELL_M = 4;
export const VIEWSHED_PREVIEW_CELL_M = 8;

// The tactical map widget: owns the canvas, the camera and pointer handling,
// and edits the exercise's draft plans and the session's selection.

/**
 * Who the map works for: the exercise it shows, the session it reads and
 * edits, and optional editor hooks. Set at creation and replaced by `attach`.
 */
export interface MapBinding {
  readonly exercise: Exercise;
  readonly getSession: () => Session;
  readonly setSession: (session: Session) => void;
  /** Shows the trainee why a map edit was refused. */
  readonly notify?: (message: string) => void;
  /** Editor hooks: clicks and drags go to the editor instead of the exercise. */
  readonly editor?: MapEditor;
  /** Whether the trainee's squad is not placed yet (no ORP): it and its ORP are then not drawn. */
  readonly hideTrainee?: () => boolean;
}

export interface TacticalMapOptions extends MapBinding {
  readonly canvas: HTMLCanvasElement;
}

/**
 * Hooks that take over clicks and drags for an editor (e.g. the scenario
 * editor, docs/adr/0015) while the map keeps panning and zooming. Points are
 * map metres; `screen` is in canvas pixels.
 */
export interface MapEditor {
  /** A button pressed at a point: return `true` to take the gesture (then `drag` and `drop` follow). */
  press?(point: Vec2, screen: Vec2, button: number): boolean;
  drag?(point: Vec2): void;
  drop?(point: Vec2): void;
  /** A left click (no drag) at a point. The map's own click handling (selection, destinations) is skipped. */
  click(point: Vec2, screen: Vec2): void;
  /** Drawing on top of the map, in canvas pixels. */
  draw?(ctx: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2): void;
  /** Cursor over a point, or `null` for the map's own. */
  cursor?(point: Vec2, screen: Vec2): string | null;
  /**
   * Whether the editor is in charge now (default: always). While it is not,
   * the map behaves as if there were no editor (e.g. stages 3–5 of the
   * workflow, docs/adr/0025).
   */
  active?(): boolean;
}

/** What the map shows: the map point at the centre and the scale. */
export interface MapView {
  readonly centre: Vec2;
  /** Map metres per CSS pixel. */
  readonly metersPerPixel: number;
}

/** Map point under the pointer, for a coordinate readout. */
export interface PointerReadout {
  readonly east: number;
  readonly north: number;
  readonly elevation: number;
}

/**
 * The tactical map's gameplay on another view's surface (docs/adr/0039): the
 * 3D battlefield hands over its ground projection and its pointer input, and
 * gets the same selection, plan and kill-zone edits, scenario editing and
 * tactical overlays as the 2D map, through the same controller and commands.
 * Points are CSS pixels of that view's canvas.
 */
export interface MapSurface {
  /** The scene as that view shows it. */
  scene(): MapScene;
  /** A press: `true` when the surface takes the drag (a plan handle or the scenario editor's). */
  press(screen: Vec2, button: number): boolean;
  /** The pointer moved during a drag the surface took. */
  drag(screen: Vec2): void;
  /** The drag the surface took ended. */
  release(screen: Vec2): void;
  /** A click (pressed and released without a drag), for any button. */
  click(screen: Vec2, button: number): void;
  /** The cursor suiting what is under a screen point. */
  hover(screen: Vec2): string;
  /** Draws the tactical overlays and the scenario editor's, over that view. */
  draw(ctx: CanvasRenderingContext2D): void;
  /** Stops using the surface (its view is gone): the map forgets its gesture state. */
  detach(): void;
}

export interface TacticalMap {
  /** Draws the current state. Call once per animation frame. */
  render(): void;
  /**
   * Keeps the visibility overlay's viewsheds current without drawing (while
   * another view is shown): call once per animation frame instead of `render`.
   */
  update(): void;
  /** The map's gameplay on another view (`MapSurface`), through that view's projection. */
  surface(projection: () => MapProjection, viewport: () => Viewport): MapSurface;
  /** Fits the whole terrain into view. */
  fitView(): void;
  /** Map point under the pointer, or `null` when the pointer is off the terrain. */
  readonly pointer: PointerReadout | null;
  /** The visibility overlay as last drawn, or `null` when it is off or nothing is selected. */
  readonly visibility: VisibilityView | null;
  /** Centres the view on a map point, keeping the zoom (e.g. a soldier chosen in the roster). */
  centreOn(point: Vec2): void;
  /** Centres the view on a map point at a scale in metres per pixel (within the zoom limits). */
  setView(point: Vec2, metersPerPixel: number): void;
  /** The current view (centre and scale). */
  readonly view: MapView;
  /** The canvas the map draws on; it can be moved to another place in the page. */
  readonly canvas: HTMLCanvasElement;
  /** Whether a map point is currently on screen. */
  isInView(point: Vec2): boolean;
  /** Canvas pixel position of a map point. */
  toScreen(point: Vec2): Vec2;
  /**
   * Shows another exercise on the same terrain (e.g. the scenario editor's
   * preview after an edit), keeping the view.
   */
  setExercise(next: Exercise): void;
  /**
   * Hands the map to a new owner (e.g. from the terrain-selection preview to
   * the battlefield's workspace, docs/adr/0025), keeping the view and the
   * drawn terrain. The exercise must be on the same terrain. A gesture in
   * progress is dropped.
   */
  attach(binding: MapBinding): void;
  dispose(): void;
}

export function createTacticalMap({ canvas, ...initial }: TacticalMapOptions): TacticalMap {
  let binding: MapBinding = initial;
  const getSession = () => binding.getSession();
  const activeEditor = () => {
    const editor = binding.editor;
    return editor && (editor.active?.() ?? true) ? editor : undefined;
  };
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  let current = initial.exercise;
  const world = current.simulation.world;
  const layer = createTerrainLayer(world.terrain);

  let viewport: Viewport = { width: 1, height: 1 };
  let camera: Camera = fitBounds(layer.bounds, viewport);
  /** Device pixels per CSS pixel of the canvas. */
  const pixelRatio = () => canvas.width / viewport.width;
  /** Every camera is snapped to whole device pixels, so pans can reuse the cached map (geo-cache.ts). */
  const setCamera = (next: Camera) => {
    camera = snapCamera(next, pixelRatio());
  };
  const fitCamera = () => snapCamera(fitBounds(layer.bounds, viewport), pixelRatio());
  let fitted = false;
  let pointer: PointerReadout | null = null;

  // The geographic map is cached between frames (geo-cache.ts); the painter
  // functions are the renderer's own, so what is cached is what was drawn.
  const asCanvas = (c: CacheContext) => c as CanvasRenderingContext2D;
  const geo = createGeoCache<MapScene>(
    {
      ground: GROUND_PHASES.map((phase) => (c: CacheContext, s: MapScene, area: Bounds) => {
        phase(asCanvas(c), s, layer, area);
      }),
      features: FEATURE_PHASES.map((phase) => (c: CacheContext, s: MapScene, area: Bounds) => {
        phase(asCanvas(c), s, layer, area);
      }),
      between: (c, s) => {
        drawVisibility(asCanvas(c), s, layer);
      },
      hasBetween: hasVisibilityOverlay,
    },
    (width, height) => {
      const offscreen = document.createElement('canvas');
      offscreen.width = width;
      offscreen.height = height;
      return offscreen;
    },
    (s, view) => ({ ...s, camera: view }),
    COLORS.background,
  );

  const viewsheds = createViewshedService(world.terrain);
  let visibility: VisibilityView | null = null;
  const scene = (): MapScene =>
    buildScene(
      current,
      getSession(),
      camera,
      viewport,
      visibility,
      binding.hideTrainee?.() ?? false,
    );

  /**
   * The selected soldier's viewshed from its destination (or where it stands): a
   * coarser grid while the destination is being dragged, full detail
   * otherwise. Computed in the background: half-way, every other row is shown
   * as a preview; until then the latest finished viewshed.
   */
  const teamVisibility = createTeamVisibility(viewsheds);
  /**
   * A Marine's firing arc (his engagement wedge): the viewshed shows only the
   * ground in it. `null` (the whole battlefield) when he has no wedge.
   */
  const arcOf = (id: SoldierId): ViewSector | null => {
    const wedge = engagementWedge(current, current.simulation.state.soldiers, id);
    return wedge
      ? { azimuth: wedge.azimuth, halfWidth: wedge.halfWidth, rangeM: wedge.rangeM }
      : null;
  };
  /** A selected fire team's visible area: the union of its Marines' viewsheds (`createTeamVisibility`). */
  const updateTeamVisibility = (unitId: string): VisibilityView | null => {
    const team = current.formationGroups.find((t) => t.unitId === unitId);
    const members = (team?.memberIds ?? []).flatMap((id) => {
      const observer = current.observer(id);
      return observer ? [{ observer, arc: arcOf(id) }] : [];
    });
    const observers = members.map((m) => m.observer);
    const first = observers[0];
    if (!first) return null;
    const cellSize = dragging() ? VIEWSHED_PREVIEW_CELL_M : VIEWSHED_CELL_M;
    // Never another team's (or a single Marine's) result while this team's is computed.
    const previous = visibility?.team === unitId ? visibility.viewshed : null;
    const { viewshed, pending, failed, preview } = teamVisibility(
      observers.map((o) => o.point),
      cellSize,
      previous,
      members.map((m) => m.arc),
    );
    return {
      observer: first.point,
      observers: observers.map((o) => o.point),
      planned: observers.some((o) => o.planned),
      viewshed,
      pending,
      failed,
      preview,
      team: unitId,
    };
  };

  const updateVisibility = () => {
    const session = getSession();
    if (session.showVisibility && session.selectedFireTeamId !== null) {
      const team = updateTeamVisibility(session.selectedFireTeamId);
      if (!team && visibility !== null) viewsheds.cancel();
      visibility = team;
      return;
    }
    const id = session.selectedSoldierId;
    const observer = session.showVisibility && id !== null ? current.observer(id) : undefined;
    if (!observer || id === null) {
      // Nothing to show: stop work in progress (finished viewsheds stay cached).
      if (visibility !== null) viewsheds.cancel();
      visibility = null;
      return;
    }
    const cellSize = dragging() ? VIEWSHED_PREVIEW_CELL_M : VIEWSHED_CELL_M;
    const { viewshed, pending, failed, preview } = viewsheds.request(
      observer.point,
      cellSize,
      arcOf(id),
    );
    visibility = {
      observer: observer.point,
      planned: observer.planned,
      viewshed,
      pending,
      failed,
      preview,
    };
  };

  /** Controllers of other views' surfaces: their drags also preview viewsheds coarsely. */
  const surfaceControllers = new Set<{ readonly draggingDestination: boolean }>();
  const dragging = () =>
    controller.draggingDestination || [...surfaceControllers].some((c) => c.draggingDestination);
  const makeActions = () =>
    createMapActions(
      current,
      {
        get: getSession,
        set: (session) => {
          binding.setSession(session);
        },
      },
      setCamera,
      (message) => binding.notify?.(message),
    );
  const makeController = () => createMapController(scene, makeActions());
  let controller = makeController();

  const local = (event: MouseEvent): Vec2 => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const updatePointer = (screen: Vec2 | null) => {
    if (screen === null) {
      pointer = null;
      return;
    }
    const { x, y } = screenToWorld(camera, viewport, screen);
    const elevation = elevationAt(world.terrain, x, y);
    pointer = elevation === null ? null : { east: x, north: y, elevation };
  };

  const toWorld = (screen: Vec2) => screenToWorld(camera, viewport, screen);
  /** Editor gesture state: a drag the editor took, or where a press that may be a click began. */
  let editorDragging = false;
  let pressedAt: Vec2 | null = null;
  const editorCursor = (p: Vec2) => activeEditor()?.cursor?.(toWorld(p), p) ?? null;
  /** The editor that took the current drag (it stays in charge until the drop). */
  let dragEditor: MapEditor | undefined;

  const onPointerDown = (event: PointerEvent) => {
    canvas.setPointerCapture(event.pointerId);
    const p = local(event);
    const editor = activeEditor();
    if (editor && event.button !== 1 && editor.press?.(toWorld(p), p, event.button)) {
      editorDragging = true;
      dragEditor = editor;
      return;
    }
    pressedAt = event.button === 0 ? p : null;
    controller.pointerDown({ ...p, button: event.button });
    canvas.style.cursor = controller.cursor;
    if (event.button === 1) event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent) => {
    const p = local(event);
    updatePointer(p);
    if (editorDragging) {
      dragEditor?.drag?.(toWorld(p));
      return;
    }
    controller.pointerMove({ ...p, button: event.button });
    canvas.style.cursor = editorCursor(p) ?? controller.cursor;
  };
  const onPointerUp = (event: PointerEvent) => {
    const p = local(event);
    if (editorDragging) {
      editorDragging = false;
      dragEditor?.drop?.(toWorld(p));
      dragEditor = undefined;
      return;
    }
    const start = pressedAt;
    const editor = activeEditor();
    pressedAt = null;
    if (
      editor &&
      start &&
      event.button === 0 &&
      Math.hypot(p.x - start.x, p.y - start.y) < DRAG_THRESHOLD_PX
    ) {
      // A click: the editor's, not the exercise's.
      controller.cancel();
      editor.click(toWorld(start), start);
    } else {
      controller.pointerUp({ ...p, button: event.button });
    }
    canvas.style.cursor = editorCursor(p) ?? controller.cursor;
  };
  const onPointerLeave = () => {
    updatePointer(null);
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const scale =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 33
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? 400
          : 1;
    controller.wheel(local(event), event.deltaY * scale);
  };
  const onContextMenu = (event: Event) => {
    event.preventDefault();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);

  const draw = () => {
    updateVisibility();
    const dpr = canvas.width / viewport.width;
    const s = scene();
    geo.draw(
      ctx,
      s,
      { camera, viewport, width: canvas.width, height: canvas.height },
      fitCamera(),
      performance.now(),
    );
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverlays(ctx, s, layer);
    const editor = activeEditor();
    if (editor?.draw) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      editor.draw(ctx, (p) => worldToScreen(camera, viewport, p));
    }
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    viewport = { width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) };
    const width = Math.round(viewport.width * dpr);
    const height = Math.round(viewport.height * dpr);
    const resized = canvas.width !== width || canvas.height !== height;
    // Setting the size clears the canvas, and resize observers run after this
    // frame's animation callbacks: redraw now so a blank canvas is never shown.
    if (resized) {
      canvas.width = width;
      canvas.height = height;
    }
    if (!fitted && rect.width > 0 && rect.height > 0) {
      setCamera(fitCamera());
      fitted = true;
    } else if (resized) {
      // Snapped again for the new pixel ratio.
      setCamera(camera);
    }
    if (!resized) return;
    draw();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const surface = (
    projection: () => MapProjection,
    surfaceViewport: () => Viewport,
  ): MapSurface => {
    const surfaceScene = (): MapScene =>
      buildScene(
        current,
        getSession(),
        camera,
        surfaceViewport(),
        visibility,
        binding.hideTrainee?.() ?? false,
        projection(),
      );
    // Its own gesture state, the same commands; rebuilt when the map's exercise changes.
    let made: { exercise: Exercise; controller: ReturnType<typeof createMapController> } | null =
      null;
    const own = () => {
      if (made?.exercise !== current) {
        if (made) surfaceControllers.delete(made.controller);
        made = { exercise: current, controller: createMapController(surfaceScene, makeActions()) };
        surfaceControllers.add(made.controller);
      }
      return made.controller;
    };
    const toWorld = (p: Vec2) => projection().toWorld(p);
    let editorDrag: MapEditor | undefined;
    return {
      scene: surfaceScene,
      press(p, button) {
        // Only the left button drags handles; the others belong to the view's camera.
        if (button !== 0) return false;
        const editor = activeEditor();
        const point = toWorld(p);
        if (editor && point && editor.press?.(point, p, button)) {
          editorDrag = editor;
          return true;
        }
        const c = own();
        c.pointerDown({ ...p, button });
        if (c.holdingHandle) return true;
        c.cancel();
        return false;
      },
      drag(p) {
        if (editorDrag) {
          const point = toWorld(p);
          if (point) editorDrag.drag?.(point);
          return;
        }
        own().pointerMove({ ...p, button: 0 });
      },
      release(p) {
        if (editorDrag) {
          const point = toWorld(p);
          if (point) editorDrag.drop?.(point);
          editorDrag = undefined;
          return;
        }
        own().pointerUp({ ...p, button: 0 });
      },
      click(p, button) {
        const editor = activeEditor();
        if (editor) {
          const point = toWorld(p);
          if (!point) return;
          // A right click is the editor's right press (e.g. deleting a route waypoint).
          if (button === 0) editor.click(point, p);
          else if (button === 2) editor.press?.(point, p, button);
          return;
        }
        // The map's own click: select, set a destination, place a formation,
        // add a kill-zone corner; a right click deletes the handle under it.
        const c = own();
        c.pointerDown({ ...p, button });
        c.pointerUp({ ...p, button });
      },
      hover(p) {
        const point = toWorld(p);
        const custom = point ? activeEditor()?.cursor?.(point, p) : null;
        if (custom) return custom;
        const c = own();
        c.pointerMove({ ...p, button: 0 });
        return c.cursor;
      },
      draw(ctx) {
        const s = surfaceScene();
        drawOverlays(ctx, s, layer);
        const editor = activeEditor();
        if (editor?.draw) editor.draw(ctx, (p) => s.projection.toScreen(p));
      },
      detach() {
        if (made) surfaceControllers.delete(made.controller);
        made = null;
      },
    };
  };

  return {
    render: draw,
    update: updateVisibility,
    surface,
    fitView() {
      setCamera(fitCamera());
    },
    centreOn(point) {
      setCamera({ ...camera, centerX: point.x, centerY: point.y });
    },
    setView(point, metersPerPixel) {
      fitted = true;
      setCamera({
        centerX: point.x,
        centerY: point.y,
        metersPerPixel: Math.min(
          Math.max(metersPerPixel, MIN_METERS_PER_PIXEL),
          MAX_METERS_PER_PIXEL,
        ),
      });
    },
    toScreen(point) {
      return worldToScreen(camera, viewport, point);
    },
    setExercise(next) {
      current = next;
      controller = makeController();
    },
    attach(next) {
      if (next.exercise.simulation.world.terrain !== world.terrain)
        throw new Error('The map shows one terrain: attach an exercise on the same terrain.');
      controller.cancel();
      editorDragging = false;
      dragEditor = undefined;
      pressedAt = null;
      binding = next;
      current = next.exercise;
      controller = makeController();
      // The new owner's selection decides what is visible.
      if (visibility !== null) viewsheds.cancel();
      visibility = null;
      canvas.style.cursor = '';
    },
    canvas,
    isInView(point) {
      const p = worldToScreen(camera, viewport, point);
      return p.x >= 0 && p.y >= 0 && p.x <= viewport.width && p.y <= viewport.height;
    },
    get view() {
      return {
        centre: { x: camera.centerX, y: camera.centerY },
        metersPerPixel: camera.metersPerPixel,
      };
    },
    get pointer() {
      return pointer;
    },
    get visibility() {
      return visibility;
    },
    dispose() {
      geo.dispose();
      layer.image.width = 0;
      layer.image.height = 0;
      viewsheds.dispose();
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
