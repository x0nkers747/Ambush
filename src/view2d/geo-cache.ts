import type { Bounds, Camera, Viewport } from './camera';
import { screenToWorld } from './camera';

// Caching of the geographic map between frames (5 km rendering, phase 2).
// The ground (background and terrain shading) and the features (contours and
// environment) do not change while soldiers move, plans are edited or the
// simulation runs, but drawing them took most of every frame. They are drawn
// into two offscreen canvases the size of the map canvas, at the camera of
// the frame, and copied onto it each frame:
//
//   ground cache → visibility overlay → features cache → grid and tactical overlays
//
// which is the order `drawMap` draws them in. The caches are redrawn only when
// the view changes:
//
// - Panning by whole device pixels (a mouse drag; cameras are snapped to whole
//   device pixels, `snapCamera`): the cached pixels are moved and only the
//   newly exposed strips are drawn, with what lies outside them skipped.
// - Zooming: the old caches are drawn scaled into place for the moment (with a
//   cached view of the whole map underneath for what they do not cover).
// - Another canvas size or pixel ratio, or nothing cached yet: drawn at once.
//
// Chrome rasterizes some strokes and fills slightly differently where a
// drawing is cut by a clip, so the strips of a pan leave faint seams (a few
// antialiasing pixels along their edges), and scaled imagery is blurred. Once
// the view has stayed still for `SETTLE_MS`, the caches are therefore drawn
// again, exactly as `drawMap` draws them, into spare canvases, one phase per
// frame (the ground in bands, then the contours, areas, roads and buildings,
// each over the whole view) so that no frame stalls; the result replaces the caches
// when it is complete. A change of view meanwhile abandons it.

/** How long the view must stay still before scaled imagery is redrawn at full quality. */
export const SETTLE_MS = 150;

/** A view of the map on a canvas: the camera, the viewport (CSS pixels) and the canvas size (device pixels). */
export interface CacheView {
  readonly camera: Camera;
  readonly viewport: Viewport;
  /** Canvas size in device pixels. */
  readonly width: number;
  readonly height: number;
}

/**
 * The camera moved to the nearest centre that lies a whole number of device
 * pixels (`metersPerPixel / dpr` metres) from the map origin. Any two snapped
 * cameras at the same zoom are then a whole number of device pixels apart, so
 * every pan can move the cached pixels instead of redrawing them. The map
 * shifts by less than half a device pixel, which cannot be seen.
 */
export function snapCamera(camera: Camera, dpr: number): Camera {
  const step = camera.metersPerPixel / dpr;
  if (!(step > 0) || !Number.isFinite(step)) return camera;
  return {
    ...camera,
    centerX: Math.round(camera.centerX / step) * step,
    centerY: Math.round(camera.centerY / step) * step,
  };
}

/** A rectangle in device pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What to do with caches drawn for one view to show another. */
export type CacheStep =
  | { readonly kind: 'reuse' }
  /** Move the cached pixels by (dx, dy) device pixels and draw the exposed rectangles. */
  | { readonly kind: 'scroll'; readonly dx: number; readonly dy: number; readonly exposed: Rect[] }
  /** Draw the caches transformed for now; redraw once the view settles. */
  | { readonly kind: 'interim' }
  /** Draw the caches anew. */
  | { readonly kind: 'render' };

/** Shifts closer than this to a whole pixel count as whole (camera arithmetic is not exact). */
const WHOLE_PIXEL_EPSILON = 1e-3;

/** Device pixels per CSS pixel of a view. */
export function pixelRatio(view: CacheView): number {
  return view.width / view.viewport.width;
}

/** Whether two views are on canvases of the same size (CSS and device pixels). */
function sameSize(a: CacheView, b: CacheView): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height
  );
}

/** How caches drawn for `cached` (or none) can show `next`. */
export function planCacheStep(cached: CacheView | null, next: CacheView): CacheStep {
  if (!cached || !sameSize(cached, next)) return { kind: 'render' };
  const a = cached.camera;
  const b = next.camera;
  if (a.centerX === b.centerX && a.centerY === b.centerY && a.metersPerPixel === b.metersPerPixel)
    return { kind: 'reuse' };
  if (a.metersPerPixel !== b.metersPerPixel) return { kind: 'interim' };
  const dpr = pixelRatio(next);
  const dx = ((a.centerX - b.centerX) / b.metersPerPixel) * dpr;
  const dy = ((b.centerY - a.centerY) / b.metersPerPixel) * dpr;
  const rx = Math.round(dx);
  const ry = Math.round(dy);
  if (Math.abs(dx - rx) > WHOLE_PIXEL_EPSILON || Math.abs(dy - ry) > WHOLE_PIXEL_EPSILON)
    return { kind: 'interim' };
  if (Math.abs(rx) >= next.width || Math.abs(ry) >= next.height) return { kind: 'render' };
  return { kind: 'scroll', dx: rx, dy: ry, exposed: exposedRects(next.width, next.height, rx, ry) };
}

/**
 * The parts of a `width` × `height` canvas left uncovered when its content
 * moves by (dx, dy) whole pixels: a full-height band at the side it moved
 * away from, and a band along the top or bottom for the rest. They do not overlap.
 */
export function exposedRects(width: number, height: number, dx: number, dy: number): Rect[] {
  const rects: Rect[] = [];
  if (dx > 0) rects.push({ x: 0, y: 0, width: dx, height });
  if (dx < 0) rects.push({ x: width + dx, y: 0, width: -dx, height });
  const x = Math.max(dx, 0);
  const w = width - Math.abs(dx);
  if (dy > 0) rects.push({ x, y: 0, width: w, height: dy });
  if (dy < 0) rects.push({ x, y: height + dy, width: w, height: -dy });
  return rects;
}

/** The map area (metres) shown in a rectangle of the canvas. */
export function rectArea(view: CacheView, rect: Rect): Bounds {
  const dpr = pixelRatio(view);
  const a = screenToWorld(view.camera, view.viewport, { x: rect.x / dpr, y: rect.y / dpr });
  const b = screenToWorld(view.camera, view.viewport, {
    x: (rect.x + rect.width) / dpr,
    y: (rect.y + rect.height) / dpr,
  });
  return { minX: a.x, minY: b.y, maxX: b.x, maxY: a.y };
}

/**
 * Where an image drawn for `from` goes on a canvas showing `to`, in device
 * pixels: `drawImage(image, x, y, image.width * scale, image.height * scale)`.
 */
export function placement(from: CacheView, to: CacheView): { x: number; y: number; scale: number } {
  const dpr = pixelRatio(to);
  const scale = (from.camera.metersPerPixel / to.camera.metersPerPixel) * (dpr / pixelRatio(from));
  // The map point at `from`'s top-left corner, then its position in `to`.
  const corner = screenToWorld(from.camera, from.viewport, { x: 0, y: 0 });
  const x =
    (to.viewport.width / 2 + (corner.x - to.camera.centerX) / to.camera.metersPerPixel) * dpr;
  const y =
    (to.viewport.height / 2 - (corner.y - to.camera.centerY) / to.camera.metersPerPixel) * dpr;
  return { x, y, scale };
}

/** The parts of a canvas the cache needs (so that tests can use stand-ins). */
export interface CacheCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): CacheContext | null;
}

/** The 2D context calls the cache makes itself. */
export type CacheContext = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'setTransform'
  | 'beginPath'
  | 'rect'
  | 'clip'
  | 'clearRect'
  | 'fillRect'
  | 'drawImage'
  | 'fillStyle'
  | 'imageSmoothingEnabled'
  | 'imageSmoothingQuality'
>;

/**
 * A step of drawing a cached layer: called with the transform set for the
 * view's pixel ratio and with `area`, the map area being drawn (the context is
 * clipped to it when it is part of the view; anything outside may be skipped).
 */
export type GeoPhase<Scene> = (ctx: CacheContext, scene: Scene, area: Bounds) => void;

/** Draws the layers. */
export interface GeoPainter<Scene> {
  /** The ground (opaque: it covers the whole canvas), in steps. */
  readonly ground: readonly GeoPhase<Scene>[];
  /** The features over it, in steps. */
  readonly features: readonly GeoPhase<Scene>[];
  /** Between the ground and the features; not cached (it changes with the selection). */
  between(ctx: CacheContext, scene: Scene): void;
  /** Whether `between` draws anything for `scene`. */
  hasBetween(scene: Scene): boolean;
}

/** Counts of what the cache did, for tests and benchmarks. */
export interface GeoCacheStats {
  renders: number;
  scrolls: number;
  interims: number;
  reuses: number;
  overviews: number;
  /** Phases drawn towards a settled redraw, and settled redraws completed. */
  settlePhases: number;
  settles: number;
}

export interface GeoCache<Scene> {
  /**
   * Draws the cached layers for `scene` onto `target` (the map canvas), whose
   * view is `view`; `fit` is the camera that shows the whole map in it.
   * `now` is a timestamp in milliseconds (for settling after a zoom).
   */
  draw(target: CacheContext, scene: Scene, view: CacheView, fit: Camera, now: number): void;
  readonly stats: Readonly<GeoCacheStats>;
  /** Device pixels held by the caches (4 bytes each). */
  readonly pixels: number;
  /** Releases the canvases. The cache draws nothing afterwards. */
  dispose(): void;
}

/** A cached layer: a canvas and its context. */
interface Cached {
  canvas: CacheCanvas;
  ctx: CacheContext;
}

/** A cached layer and what it holds. */
interface CachedLayer {
  kind: LayerKind;
  cached: Cached;
}

/**
 * What a cached canvas holds: the ground and the features together (when
 * nothing goes between them, the usual case: one canvas to move and copy, and
 * exactly what drawing them directly gives), or one of them alone.
 */
type LayerKind = 'both' | 'ground' | 'features';

export function createGeoCache<Scene>(
  painter: GeoPainter<Scene>,
  createCanvas: (width: number, height: number) => CacheCanvas,
  /** The scene for another camera (to draw the whole-map view). */
  withCamera: (scene: Scene, camera: Camera) => Scene,
  /** Fill for canvas areas no cached imagery covers (the map's background). */
  background: string,
): GeoCache<Scene> {
  const stats: GeoCacheStats = {
    renders: 0,
    scrolls: 0,
    interims: 0,
    reuses: 0,
    overviews: 0,
    settlePhases: 0,
    settles: 0,
  };
  /** The cached layers, bottom to top: `both`, or `ground` then `features`. */
  let layers: CachedLayer[] = [];
  /** Canvases not in use, kept for the next pan or settled redraw. */
  let pool: Cached[] = [];
  /** The whole map (ground and features) at the fit camera, for interim frames. */
  let overview: Cached | null = null;
  let overviewView: CacheView | null = null;
  /** The view the layers show, and whether they are exactly as drawn for it (no seams, not scaled). */
  let cachedView: CacheView | null = null;
  let exact = false;
  /** A settled redraw in progress: the layers being drawn and the phases still to draw. */
  let settling: { view: CacheView; layers: CachedLayer[]; next: number } | null = null;
  /** The camera of the previous frame, and when it last changed. */
  let lastCamera: Camera | null = null;
  let changedAt = 0;
  let disposed = false;

  const release = (c: Cached | null | undefined): null => {
    if (c) {
      c.canvas.width = 0;
      c.canvas.height = 0;
    }
    return null;
  };
  /** A canvas of the view's size: from the pool when one fits, else new. */
  const take = (view: CacheView): Cached => {
    const i = pool.findIndex(
      (c) => c.canvas.width === view.width && c.canvas.height === view.height,
    );
    const found = i >= 0 ? pool.splice(i, 1)[0] : undefined;
    if (found) return found;
    const canvas = createCanvas(view.width, view.height);
    canvas.width = view.width;
    canvas.height = view.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    return { canvas, ctx };
  };
  /** Returns canvases to the pool, keeping at most one spare of the current size. */
  const giveBack = (cs: readonly Cached[], view: CacheView) => {
    pool.push(...cs);
    const fits = (c: Cached) => c.canvas.width === view.width && c.canvas.height === view.height;
    const keep = pool.filter(fits).slice(0, 2);
    for (const c of pool) if (!keep.includes(c)) release(c);
    pool = keep;
  };

  const phasesOf = (kind: LayerKind): readonly GeoPhase<Scene>[] =>
    kind === 'ground'
      ? painter.ground
      : kind === 'features'
        ? painter.features
        : [...painter.ground, ...painter.features];

  /** Draws phases of a layer for `view` into `c`: within `rect` (cleared and clipped first), or over the whole canvas. */
  const paint = (
    c: Cached,
    view: CacheView,
    scene: Scene,
    phases: readonly GeoPhase<Scene>[],
    rect: Rect | null,
    clear: boolean,
  ) => {
    const full = { x: 0, y: 0, width: view.width, height: view.height };
    const dpr = pixelRatio(view);
    const area = rectArea(view, rect ?? full);
    c.ctx.save();
    c.ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (rect) {
      c.ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
      c.ctx.beginPath();
      c.ctx.rect(rect.x, rect.y, rect.width, rect.height);
      c.ctx.clip();
    } else if (clear) c.ctx.clearRect(0, 0, view.width, view.height);
    c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const phase of phases) phase(c.ctx, scene, area);
    c.ctx.restore();
  };

  const kindsFor = (split: boolean): LayerKind[] => (split ? ['ground', 'features'] : ['both']);

  /** Replaces the layers with `next` (drawn for `view`), returning the old canvases to the pool. */
  const install = (next: CachedLayer[], view: CacheView, isExact: boolean) => {
    giveBack(
      layers.map((l) => l.cached),
      view,
    );
    layers = next;
    cachedView = view;
    exact = isExact;
  };

  const cancelSettling = (view: CacheView) => {
    if (!settling) return;
    giveBack(
      settling.layers.map((l) => l.cached),
      view,
    );
    settling = null;
  };

  const renderAll = (view: CacheView, scene: Scene, split: boolean) => {
    cancelSettling(view);
    const next = kindsFor(split).map((kind) => {
      const cached = take(view);
      paint(cached, view, scene, phasesOf(kind), null, true);
      return { kind, cached };
    });
    install(next, view, true);
    stats.renders += 1;
  };

  /** One more phase of the settled redraw; installs it when complete. */
  const settleStep = (view: CacheView, scene: Scene, split: boolean) => {
    settling ??= {
      view,
      layers: kindsFor(split).map((kind) => ({ kind, cached: take(view) })),
      next: 0,
    };
    // Phases are numbered across the layers, bottom layer first.
    let n = settling.next;
    for (const layer of settling.layers) {
      const phases = phasesOf(layer.kind);
      if (n < phases.length) {
        const phase = phases[n];
        if (phase) paint(layer.cached, view, scene, [phase], null, n === 0);
        break;
      }
      n -= phases.length;
    }
    settling.next += 1;
    stats.settlePhases += 1;
    const total = settling.layers.reduce((sum, l) => sum + phasesOf(l.kind).length, 0);
    if (settling.next >= total) {
      const done = settling;
      settling = null;
      install(done.layers, view, true);
      stats.settles += 1;
    }
  };

  /** Moves a layer's pixels by (dx, dy) whole device pixels, through a spare canvas. */
  const shift = (c: Cached, view: CacheView, dx: number, dy: number): Cached => {
    const s = take(view);
    s.ctx.save();
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.clearRect(0, 0, view.width, view.height);
    s.ctx.drawImage(c.canvas as CanvasImageSource, dx, dy);
    s.ctx.restore();
    giveBack([c], view);
    return s;
  };

  /** The overview's canvas, at the view's size. */
  const overviewCanvas = (view: CacheView): Cached => {
    if (overview?.canvas.width === view.width && overview.canvas.height === view.height)
      return overview;
    release(overview);
    return take(view);
  };

  const renderOverview = (view: CacheView, scene: Scene, fit: Camera) => {
    const fitView: CacheView = { ...view, camera: fit };
    overview = overviewCanvas(view);
    paint(overview, fitView, withCamera(scene, fit), phasesOf('both'), null, true);
    overviewView = fitView;
    stats.overviews += 1;
  };

  const sameCamera = (a: Camera, b: Camera) =>
    a.centerX === b.centerX && a.centerY === b.centerY && a.metersPerPixel === b.metersPerPixel;
  const hasOverview = (view: CacheView, fit: Camera) =>
    overviewView !== null && sameSize(overviewView, view) && sameCamera(overviewView.camera, fit);

  /** Draws an image made for `from` onto the target showing `to`. */
  const place = (target: CacheContext, image: Cached, from: CacheView, to: CacheView) => {
    const { x, y, scale } = placement(from, to);
    target.drawImage(
      image.canvas as CanvasImageSource,
      x,
      y,
      image.canvas.width * scale,
      image.canvas.height * scale,
    );
  };

  return {
    stats,
    get pixels() {
      return [
        ...layers.map((l) => l.cached),
        ...(settling?.layers.map((l) => l.cached) ?? []),
        ...pool,
        overview,
      ].reduce((sum, c) => sum + (c ? c.canvas.width * c.canvas.height : 0), 0);
    },
    draw(target, scene, view, fit, now) {
      if (disposed) return;
      if (!lastCamera || !sameCamera(lastCamera, view.camera)) changedAt = now;
      lastCamera = view.camera;
      const split = painter.hasBetween(scene);

      let step = planCacheStep(cachedView, view);
      // Something to draw between the ground and the features needs them apart (and together after).
      if (step.kind !== 'interim' && split !== (layers.length === 2)) step = { kind: 'render' };
      if (
        settling &&
        (!sameSize(settling.view, view) ||
          !sameCamera(settling.view.camera, view.camera) ||
          split !== (settling.layers.length === 2))
      )
        cancelSettling(view);

      if (step.kind === 'render') renderAll(view, scene, split);
      else if (step.kind === 'scroll') {
        const { dx, dy, exposed } = step;
        for (const layer of layers) {
          layer.cached = shift(layer.cached, view, dx, dy);
          for (const rect of exposed)
            paint(layer.cached, view, scene, phasesOf(layer.kind), rect, true);
        }
        cachedView = view;
        exact = false;
        stats.scrolls += 1;
      } else if (step.kind === 'reuse') stats.reuses += 1;
      else stats.interims += 1;

      // Still for long enough with seams or scaled imagery: redraw exactly, a phase per frame.
      if (
        step.kind !== 'render' &&
        (step.kind === 'interim' || !exact) &&
        now - changedAt >= SETTLE_MS
      )
        settleStep(view, scene, split);
      const interim = cachedView !== null && !sameCamera(cachedView.camera, view.camera);

      // The whole-map view comes free when the map is drawn exactly at the fit camera.
      if (!interim && exact && sameCamera(view.camera, fit) && !hasOverview(view, fit)) {
        overview = overviewCanvas(view);
        overview.ctx.save();
        overview.ctx.setTransform(1, 0, 0, 1, 0, 0);
        overview.ctx.clearRect(0, 0, view.width, view.height);
        for (const { cached } of layers)
          overview.ctx.drawImage(cached.canvas as CanvasImageSource, 0, 0);
        overview.ctx.restore();
        overviewView = view;
      }

      if (!cachedView || layers.length === 0) return;
      const from = cachedView;
      const dpr = pixelRatio(view);
      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      if (interim) {
        target.imageSmoothingEnabled = true;
        target.imageSmoothingQuality = 'low';
        // Zoomed in, the scaled cache covers the canvas; otherwise the whole map shows round it.
        const { x, y, scale } = placement(from, view);
        const covered =
          x <= 0 &&
          y <= 0 &&
          x + from.width * scale >= view.width &&
          y + from.height * scale >= view.height;
        if (!covered) {
          if (!hasOverview(view, fit)) renderOverview(view, scene, fit);
          target.fillStyle = background;
          target.fillRect(0, 0, view.width, view.height);
          if (overview && overviewView) place(target, overview, overviewView, view);
        }
      }
      for (const { kind, cached } of layers) {
        if (kind === 'features') {
          target.setTransform(dpr, 0, 0, dpr, 0, 0);
          painter.between(target, scene);
          target.setTransform(1, 0, 0, 1, 0, 0);
        }
        if (interim) place(target, cached, from, view);
        else target.drawImage(cached.canvas as CanvasImageSource, 0, 0);
      }
      if (split && layers.length === 1) {
        // Interim frames keep the combined layer: the overlay goes on top of it for now.
        target.setTransform(dpr, 0, 0, dpr, 0, 0);
        painter.between(target, scene);
      }
      target.restore();
    },
    dispose() {
      disposed = true;
      for (const { cached } of layers) release(cached);
      for (const { cached } of settling?.layers ?? []) release(cached);
      for (const c of pool) release(c);
      layers = [];
      settling = null;
      pool = [];
      overview = release(overview);
      cachedView = null;
      overviewView = null;
    },
  };
}
