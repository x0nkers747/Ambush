import type { TerrainDataset, Vec2 } from '#sim';
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
import { createMapController, DRAG_THRESHOLD_PX } from './interaction';
import { createGeoCache, snapCamera, type CacheContext } from './geo-cache';
import { COLORS, createTerrainLayer, drawOverlays, FEATURE_PHASES, GROUND_PHASES } from './render';
import { elevationAt } from './terrain-layer';
import { buildScene, type MapProjection, type MapScene } from './scene';

// The tactical map widget: owns the canvas, the camera and the pointer, and
// draws a battlefield's terrain (the ground, its features, the grid, the
// north arrow and the scale bar). Everything on top of the terrain is an
// editor's (`MapEditor`): it draws over the map and takes the clicks and
// drags it wants, while the map keeps panning and zooming. The map's
// gameplay on another view (the 3D battlefield) goes through `surface`.

/** Who the map works for: the editor drawing over it and taking its clicks. */
export interface MapBinding {
  readonly editor?: MapEditor;
}

export interface TacticalMapOptions extends MapBinding {
  readonly canvas: HTMLCanvasElement;
  readonly terrain: TerrainDataset;
}

/**
 * Hooks that take over clicks and drags for an editor (e.g. a battle's
 * planner, docs/constructive-simulation/03) while the map keeps panning and
 * zooming. Points are map metres; `screen` is in canvas pixels.
 */
export interface MapEditor {
  /** A button pressed at a point: return `true` to take the gesture (then `drag` and `drop` follow). */
  press?(point: Vec2, screen: Vec2, button: number): boolean;
  drag?(point: Vec2): void;
  drop?(point: Vec2): void;
  /** A left click (no drag) at a point. */
  click(point: Vec2, screen: Vec2): void;
  /** Drawing on top of the map, in canvas pixels. */
  draw?(ctx: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2): void;
  /** Cursor over a point, or `null` for the map's own. */
  cursor?(point: Vec2, screen: Vec2): string | null;
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
 * The map's gameplay on another view's surface (docs/adr/0039): the 3D
 * battlefield hands over its ground projection and its pointer input, and
 * the map's editor takes its clicks and drags, and draws over it, as on the
 * 2D map. Points are CSS pixels of that view's canvas.
 */
export interface MapSurface {
  /** The scene as that view shows it. */
  scene(): MapScene;
  /** A press: `true` when the editor takes the drag. */
  press(screen: Vec2, button: number): boolean;
  /** The pointer moved during a drag the editor took. */
  drag(screen: Vec2): void;
  /** The drag the editor took ended. */
  release(screen: Vec2): void;
  /** A click (pressed and released without a drag), for any button. */
  click(screen: Vec2, button: number): void;
  /** The cursor suiting what is under a screen point. */
  hover(screen: Vec2): string;
  /** Draws the editor's overlay over that view. */
  draw(ctx: CanvasRenderingContext2D): void;
  /** Stops using the surface (its view is gone). */
  detach(): void;
}

export interface TacticalMap {
  /** Draws the current state. Call once per animation frame. */
  render(): void;
  /** The map's gameplay on another view (`MapSurface`), through that view's projection. */
  surface(projection: () => MapProjection, viewport: () => Viewport): MapSurface;
  /** Fits the whole terrain into view. */
  fitView(): void;
  /** Map point under the pointer, or `null` when the pointer is off the terrain. */
  readonly pointer: PointerReadout | null;
  /** Centres the view on a map point, keeping the zoom. */
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
  /** The terrain it shows. */
  readonly terrain: TerrainDataset;
  /**
   * Hands the map to a new owner (e.g. from the terrain-selection preview to
   * the battlefield's page, docs/adr/0025), keeping the view and the drawn
   * terrain. A gesture in progress is dropped.
   */
  attach(binding: MapBinding): void;
  dispose(): void;
}

export function createTacticalMap({
  canvas,
  terrain,
  ...initial
}: TacticalMapOptions): TacticalMap {
  let binding: MapBinding = initial;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  const layer = createTerrainLayer(terrain);

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
      between: () => undefined,
      hasBetween: () => false,
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

  const scene = (): MapScene => buildScene(terrain, camera, viewport);
  const controller = createMapController(scene, setCamera);

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
    const elevation = elevationAt(terrain, x, y);
    pointer = elevation === null ? null : { east: x, north: y, elevation };
  };

  const toWorld = (screen: Vec2) => screenToWorld(camera, viewport, screen);
  /** Editor gesture state: a drag the editor took, or where a press that may be a click began. */
  let editorDragging = false;
  let pressedAt: Vec2 | null = null;
  const editorCursor = (p: Vec2) => binding.editor?.cursor?.(toWorld(p), p) ?? null;
  /** The editor that took the current drag (it stays in charge until the drop). */
  let dragEditor: MapEditor | undefined;

  const onPointerDown = (event: PointerEvent) => {
    canvas.setPointerCapture(event.pointerId);
    const p = local(event);
    const editor = binding.editor;
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
    const editor = binding.editor;
    pressedAt = null;
    if (
      editor &&
      start &&
      event.button === 0 &&
      Math.hypot(p.x - start.x, p.y - start.y) < DRAG_THRESHOLD_PX
    ) {
      // A click: the editor's.
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
    const editor = binding.editor;
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
      buildScene(terrain, camera, surfaceViewport(), projection());
    const toWorld = (p: Vec2) => projection().toWorld(p);
    let editorDrag: MapEditor | undefined;
    return {
      scene: surfaceScene,
      press(p, button) {
        // Only the left button drags; the others belong to the view's camera.
        if (button !== 0) return false;
        const editor = binding.editor;
        const point = toWorld(p);
        if (editor && point && editor.press?.(point, p, button)) {
          editorDrag = editor;
          return true;
        }
        return false;
      },
      drag(p) {
        const point = toWorld(p);
        if (editorDrag && point) editorDrag.drag?.(point);
      },
      release(p) {
        const point = toWorld(p);
        if (editorDrag && point) editorDrag.drop?.(point);
        editorDrag = undefined;
      },
      click(p, button) {
        const editor = binding.editor;
        const point = toWorld(p);
        if (!editor || !point) return;
        // A right click is the editor's right press (e.g. deleting a waypoint).
        if (button === 0) editor.click(point, p);
        else if (button === 2) editor.press?.(point, p, button);
      },
      hover(p) {
        const point = toWorld(p);
        return (point ? binding.editor?.cursor?.(point, p) : null) ?? 'grab';
      },
      draw(ctx) {
        const s = surfaceScene();
        drawOverlays(ctx, s, layer);
        binding.editor?.draw?.(ctx, (p) => s.projection.toScreen(p));
      },
      detach() {
        editorDrag = undefined;
      },
    };
  };

  return {
    render: draw,
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
    terrain,
    attach(next) {
      controller.cancel();
      editorDragging = false;
      dragEditor = undefined;
      pressedAt = null;
      binding = next;
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
    dispose() {
      geo.dispose();
      layer.image.width = 0;
      layer.image.height = 0;
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
