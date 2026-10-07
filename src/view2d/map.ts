import type { Exercise } from '#exercise';
import type { Session } from '#session';
import { heightAt, isOnTerrain, type Vec2 } from '#sim';
import { fitBounds, screenToWorld, type Camera, type Viewport } from './camera';
import { createMapActions } from './actions';
import { createMapController } from './interaction';
import { createTerrainLayer, drawMap } from './render';
import { buildScene, type MapScene, type VisibilityView } from './scene';
import { createViewshedService } from './viewshed-service';

/** Viewshed resolution in metres: full detail, and a quicker preview while dragging. */
export const VIEWSHED_CELL_M = 4;
export const VIEWSHED_PREVIEW_CELL_M = 8;

// The tactical map widget: owns the canvas, the camera and pointer handling,
// and edits the exercise's draft plans and the session's selection.

export interface TacticalMapOptions {
  readonly canvas: HTMLCanvasElement;
  readonly exercise: Exercise;
  readonly getSession: () => Session;
  readonly setSession: (session: Session) => void;
  /** Shows the trainee why a map edit was refused. */
  readonly notify?: (message: string) => void;
}

/** Map point under the pointer, for a coordinate readout. */
export interface PointerReadout {
  readonly east: number;
  readonly north: number;
  readonly elevation: number;
}

export interface TacticalMap {
  /** Draws the current state. Call once per animation frame. */
  render(): void;
  /** Fits the whole terrain into view. */
  fitView(): void;
  /** Map point under the pointer, or `null` when the pointer is off the terrain. */
  readonly pointer: PointerReadout | null;
  /** The visibility overlay as last drawn, or `null` when it is off or nothing is selected. */
  readonly visibility: VisibilityView | null;
  dispose(): void;
}

export function createTacticalMap({
  canvas,
  exercise,
  getSession,
  setSession,
  notify,
}: TacticalMapOptions): TacticalMap {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  const world = exercise.simulation.world;
  const layer = createTerrainLayer(world.terrain);

  let viewport: Viewport = { width: 1, height: 1 };
  let camera: Camera = fitBounds(layer.bounds, viewport);
  let fitted = false;
  let pointer: PointerReadout | null = null;

  const viewsheds = createViewshedService(world.terrain);
  let visibility: VisibilityView | null = null;
  const scene = (): MapScene => buildScene(exercise, getSession(), camera, viewport, visibility);

  /**
   * The selected soldier's viewshed from its planned final position (or where it
   * stands): a coarser preview while that final waypoint is being dragged, full
   * detail otherwise. Computed in the background; the previous result is shown
   * until the new one is ready.
   */
  const updateVisibility = () => {
    const session = getSession();
    const id = session.selectedSoldierId;
    const observer = session.showVisibility && id !== null ? exercise.observer(id) : undefined;
    if (!observer || id === null) {
      visibility = null;
      return;
    }
    const finalWaypoint = exercise.draft(id)?.waypoints.at(-1)?.id;
    const dragging = finalWaypoint !== undefined && controller.draggedWaypoint === finalWaypoint;
    const cellSize = dragging ? VIEWSHED_PREVIEW_CELL_M : VIEWSHED_CELL_M;
    const { viewshed, pending } = viewsheds.request(observer.point, cellSize);
    visibility = { observer: observer.point, planned: observer.planned, viewshed, pending };
  };

  const actions = createMapActions(
    exercise,
    { get: getSession, set: setSession },
    (next) => {
      camera = next;
    },
    notify,
  );
  const controller = createMapController(scene, actions);

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
    pointer = isOnTerrain(world.terrain, x, y)
      ? { east: x, north: y, elevation: heightAt(world.terrain, x, y) }
      : null;
  };

  const onPointerDown = (event: PointerEvent) => {
    canvas.setPointerCapture(event.pointerId);
    controller.pointerDown({ ...local(event), button: event.button });
    canvas.style.cursor = controller.cursor;
    if (event.button === 1) event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent) => {
    const p = local(event);
    controller.pointerMove({ ...p, button: event.button });
    updatePointer(p);
    canvas.style.cursor = controller.cursor;
  };
  const onPointerUp = (event: PointerEvent) => {
    controller.pointerUp({ ...local(event), button: event.button });
    canvas.style.cursor = controller.cursor;
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMap(ctx, scene(), layer);
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    viewport = { width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) };
    if (!fitted && rect.width > 0 && rect.height > 0) {
      camera = fitBounds(layer.bounds, viewport);
      fitted = true;
    }
    const width = Math.round(viewport.width * dpr);
    const height = Math.round(viewport.height * dpr);
    if (canvas.width === width && canvas.height === height) return;
    // Setting the size clears the canvas, and resize observers run after this
    // frame's animation callbacks: redraw now so a blank canvas is never shown.
    canvas.width = width;
    canvas.height = height;
    draw();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  return {
    render: draw,
    fitView() {
      camera = fitBounds(layer.bounds, viewport);
    },
    get pointer() {
      return pointer;
    },
    get visibility() {
      return visibility;
    },
    dispose() {
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
