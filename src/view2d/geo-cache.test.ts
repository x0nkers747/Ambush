import { describe, expect, it } from 'vitest';
import type { Bounds, Camera } from './camera';
import { screenToWorld, worldToScreen } from './camera';
import { viewArea } from './render';
import type { MapScene } from './scene';
import {
  createGeoCache,
  exposedRects,
  placement,
  planCacheStep,
  rectArea,
  SETTLE_MS,
  snapCamera,
  type CacheCanvas,
  type CacheContext,
  type CacheView,
  type GeoPainter,
} from './geo-cache';

// The geographic map cache (5 km rendering, phase 2): when it reuses, moves,
// scales and redraws its canvases, and what it draws where. Canvases are
// stand-ins that record the calls made on them.

const W = 400;
const H = 300;

function view(camera: Camera, dpr = 1, width = W, height = H): CacheView {
  return {
    camera,
    viewport: { width, height },
    width: Math.round(width * dpr),
    height: Math.round(height * dpr),
  };
}

const CAMERA: Camera = { centerX: 0, centerY: 0, metersPerPixel: 2 };
const FIT: Camera = { centerX: 0, centerY: 0, metersPerPixel: 10 };

interface FakeCanvas extends CacheCanvas {
  readonly id: number;
  readonly calls: string[];
}

/** Canvases whose contexts record calls; `drawImage` records the source canvas id. */
function fakeCanvases() {
  const all: FakeCanvas[] = [];
  const create = (width: number, height: number): FakeCanvas => {
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      setTransform: () => calls.push('setTransform'),
      beginPath: () => calls.push('beginPath'),
      rect: (x: number, y: number, w: number, h: number) =>
        calls.push(`rect ${String([x, y, w, h])}`),
      clip: () => calls.push('clip'),
      clearRect: (x: number, y: number, w: number, h: number) =>
        calls.push(`clearRect ${String([x, y, w, h])}`),
      fillRect: () => calls.push('fillRect'),
      drawImage: (source: FakeCanvas, ...args: number[]) =>
        calls.push(`drawImage #${String(source.id)} ${args.map((a) => a.toFixed(2)).join(',')}`),
      fillStyle: '',
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'low',
    } as unknown as CacheContext;
    const canvas: FakeCanvas = { id: all.length + 1, width, height, calls, getContext: () => ctx };
    all.push(canvas);
    return canvas;
  };
  return { all, create };
}

/** A painter recording which phase drew which map area, and a scene that is just a camera. */
function fakePainter(split = () => false) {
  const painted: { phase: string; area: Bounds; canvas: unknown }[] = [];
  const phase =
    (name: string) =>
    (ctx: CacheContext, _scene: Camera, area: Bounds): void => {
      painted.push({ phase: name, area, canvas: ctx });
    };
  const between: string[] = [];
  const painter: GeoPainter<Camera> = {
    ground: [phase('ground')],
    features: [phase('contours'), phase('areas'), phase('roads'), phase('buildings')],
    between: () => between.push('between'),
    hasBetween: () => split(),
  };
  return { painter, painted, between };
}

function setup(split = () => false) {
  const canvases = fakeCanvases();
  const { painter, painted, between } = fakePainter(split);
  const cache = createGeoCache<Camera>(painter, canvases.create, (_s, c) => c, '#000');
  const target = canvases.create(W, H);
  const targetCtx = target.getContext('2d');
  if (!targetCtx) throw new Error('no context');
  const draw = (camera: Camera, now: number, dpr = 1, width = W, height = H) => {
    target.calls.length = 0;
    cache.draw(targetCtx, camera, view(camera, dpr, width, height), FIT, now);
  };
  return { cache, canvases, painted, between, target, draw };
}

describe('planCacheStep', () => {
  const at = view(CAMERA);

  it('draws when nothing is cached or the canvas size changed', () => {
    expect(planCacheStep(null, at).kind).toBe('render');
    expect(planCacheStep(at, view(CAMERA, 2)).kind).toBe('render');
    expect(planCacheStep(at, view(CAMERA, 1, W + 1, H)).kind).toBe('render');
  });

  it('reuses the cache for the same view', () => {
    expect(planCacheStep(at, view({ ...CAMERA })).kind).toBe('reuse');
  });

  it('moves the pixels for a pan by whole device pixels, at any pixel ratio', () => {
    for (const dpr of [1, 1.25, 2]) {
      const from = view(snapCamera({ ...CAMERA, centerX: 123.4, centerY: -56.7 }, dpr), dpr);
      const step = (CAMERA.metersPerPixel / dpr) * 7;
      const to = view(
        snapCamera({ ...from.camera, centerX: from.camera.centerX - step }, dpr),
        dpr,
      );
      const plan = planCacheStep(from, to);
      expect(plan).toMatchObject({ kind: 'scroll', dx: 7, dy: 0 });
    }
  });

  it('scales the cache for the moment when zooming or moving by a fraction of a pixel', () => {
    expect(planCacheStep(at, view({ ...CAMERA, metersPerPixel: 2.2 })).kind).toBe('interim');
    expect(planCacheStep(at, view({ ...CAMERA, centerX: 0.5 })).kind).toBe('interim');
  });

  it('draws anew for a pan larger than the canvas', () => {
    expect(planCacheStep(at, view({ ...CAMERA, centerX: W * 2 })).kind).toBe('render');
  });
});

describe('exposedRects', () => {
  it('covers exactly the part a move uncovers, without overlap', () => {
    for (const [dx, dy] of [
      [5, 0],
      [-5, 0],
      [0, 7],
      [0, -7],
      [3, -4],
      [-6, 9],
    ] as const) {
      const rects = exposedRects(W, H, dx, dy);
      const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
      expect(area).toBe(W * H - (W - Math.abs(dx)) * (H - Math.abs(dy)));
      // Every uncovered pixel is in exactly one rectangle, every covered one in none.
      for (const [x, y] of [
        [0, 0],
        [W - 1, H - 1],
        [W - 1, 0],
        [0, H - 1],
        [W / 2, H / 2],
      ] as const) {
        const covered = x - dx >= 0 && x - dx < W && y - dy >= 0 && y - dy < H;
        const hits = rects.filter(
          (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
        ).length;
        expect(hits).toBe(covered ? 0 : 1);
      }
    }
  });
});

describe('snapCamera', () => {
  it('moves the centre by less than half a device pixel, onto a common grid', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const raw = { centerX: 1234.5678, centerY: -987.654, metersPerPixel: 0.37 };
      const snapped = snapCamera(raw, dpr);
      const half = raw.metersPerPixel / dpr / 2;
      expect(Math.abs(snapped.centerX - raw.centerX)).toBeLessThanOrEqual(half + 1e-9);
      expect(Math.abs(snapped.centerY - raw.centerY)).toBeLessThanOrEqual(half + 1e-9);
      expect(snapCamera(snapped, dpr)).toEqual(snapped);
      expect(snapped.metersPerPixel).toBe(raw.metersPerPixel);
    }
  });
});

describe('placement and areas', () => {
  it('puts an image drawn for the same view at the origin, unscaled', () => {
    expect(placement(view(CAMERA), view(CAMERA))).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('keeps cached imagery aligned with the map when zooming', () => {
    const from = view(CAMERA, 2);
    const to = view({ centerX: 30, centerY: -20, metersPerPixel: 1 }, 2);
    const { x, y, scale } = placement(from, to);
    // A map point is at the same place in the scaled image as on the new view.
    const point = { x: 50, y: 40 };
    const inImage = worldToScreen(from.camera, from.viewport, point);
    const onView = worldToScreen(to.camera, to.viewport, point);
    expect(x + inImage.x * 2 * scale).toBeCloseTo(onView.x * 2, 9);
    expect(y + inImage.y * 2 * scale).toBeCloseTo(onView.y * 2, 9);
  });

  it('covers the same map area as the renderer draws directly, at any pixel ratio', () => {
    for (const dpr of [1, 1.5, 2]) {
      const v = view({ centerX: 512.25, centerY: -77.5, metersPerPixel: 0.8 }, dpr);
      const direct = viewArea({ camera: v.camera, viewport: v.viewport } as MapScene);
      const cached = rectArea(v, { x: 0, y: 0, width: v.width, height: v.height });
      for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const)
        expect(cached[k]).toBeCloseTo(direct[k], 9);
    }
  });

  it('gives the map area of a canvas rectangle', () => {
    const v = view(CAMERA, 2);
    const area = rectArea(v, { x: 0, y: 0, width: v.width, height: v.height });
    const topLeft = screenToWorld(CAMERA, v.viewport, { x: 0, y: 0 });
    expect(area.minX).toBeCloseTo(topLeft.x, 9);
    expect(area.maxY).toBeCloseTo(topLeft.y, 9);
    expect(area.maxX - area.minX).toBeCloseTo(W * CAMERA.metersPerPixel, 9);
  });
});

describe('createGeoCache', () => {
  const phases = (painted: { phase: string }[]) => painted.map((p) => p.phase);
  const ALL = ['ground', 'contours', 'areas', 'roads', 'buildings'];

  it('draws the map once and reuses it while only the tactical layer changes', () => {
    const { cache, painted, draw, target } = setup();
    draw(CAMERA, 0);
    expect(phases(painted)).toEqual(ALL);
    for (let i = 1; i <= 60; i += 1) draw(CAMERA, i * 16);
    expect(phases(painted)).toEqual(ALL);
    expect(cache.stats).toMatchObject({ renders: 1, reuses: 60 });
    // Each frame copies the cached map onto the canvas, unscaled.
    expect(target.calls.filter((c) => c.startsWith('drawImage'))).toEqual([
      expect.stringMatching(/^drawImage #\d+ 0.00,0.00$/),
    ]);
  });

  it('pans by drawing only the exposed strip, then redraws exactly once still', () => {
    const { cache, painted, draw } = setup();
    draw(CAMERA, 0);
    painted.length = 0;
    // The camera ten pixels west: the map moves right and a strip opens on the left.
    const moved = { ...CAMERA, centerX: CAMERA.centerX - 10 * CAMERA.metersPerPixel };
    draw(moved, 16);
    expect(phases(painted)).toEqual(ALL);
    for (const { area } of painted) {
      expect(area.maxX - area.minX).toBeCloseTo(10 * CAMERA.metersPerPixel, 9);
      expect(area.maxY - area.minY).toBeCloseTo(H * CAMERA.metersPerPixel, 9);
    }
    expect(cache.stats.scrolls).toBe(1);
    // Still: after SETTLE_MS, a phase per frame over the whole view, then nothing more.
    painted.length = 0;
    draw(moved, 16 + SETTLE_MS - 1);
    expect(painted).toEqual([]);
    for (let i = 0; i < 8; i += 1) draw(moved, 16 + SETTLE_MS + i * 16);
    expect(phases(painted)).toEqual(ALL);
    for (const { area } of painted) expect(area.maxX - area.minX).toBeCloseTo(W * 2, 9);
    expect(cache.stats).toMatchObject({ settles: 1, settlePhases: 5 });
  });

  it('scales the cache while zooming, without drawing the map, and redraws once still', () => {
    const { cache, painted, draw, target } = setup();
    draw(CAMERA, 0);
    painted.length = 0;
    let t = 0;
    for (let i = 1; i <= 10; i += 1) {
      t += 16;
      draw({ ...CAMERA, metersPerPixel: CAMERA.metersPerPixel * (1 + i / 20) }, t);
    }
    // Only the whole-map view was drawn (once, for what the scaled cache does not cover).
    expect(phases(painted)).toEqual(ALL);
    expect(cache.stats).toMatchObject({ interims: 10, overviews: 1, renders: 1 });
    const scaled = target.calls.filter((c) => c.startsWith('drawImage'));
    expect(scaled).toHaveLength(2);
    painted.length = 0;
    const final = { ...CAMERA, metersPerPixel: CAMERA.metersPerPixel * 1.5 };
    for (let i = 0; i < 10; i += 1) draw(final, t + SETTLE_MS + i * 16);
    expect(phases(painted)).toEqual(ALL);
    expect(cache.stats.settles).toBe(1);
    // Exact again: copied unscaled.
    expect(target.calls.filter((c) => c.startsWith('drawImage'))).toEqual([
      expect.stringMatching(/ 0.00,0.00$/),
    ]);
  });

  it('abandons a settled redraw when the view changes meanwhile', () => {
    const { cache, painted, draw } = setup();
    draw(CAMERA, 0);
    const zoomed = { ...CAMERA, metersPerPixel: 3 };
    draw(zoomed, 16);
    draw(zoomed, 16 + SETTLE_MS);
    draw(zoomed, 32 + SETTLE_MS);
    expect(cache.stats.settlePhases).toBe(2);
    painted.length = 0;
    const again = { ...CAMERA, metersPerPixel: 4 };
    draw(again, 48 + SETTLE_MS);
    expect(cache.stats.settles).toBe(0);
    for (let i = 0; i < 10; i += 1) draw(again, 48 + 2 * SETTLE_MS + i * 16);
    expect(cache.stats.settles).toBe(1);
    expect(phases(painted).filter((p) => p === 'ground')).toHaveLength(1);
  });

  it('draws anew for another canvas size or pixel ratio, keeping memory bounded', () => {
    const { cache, painted, draw, canvases } = setup();
    draw(CAMERA, 0);
    draw(CAMERA, 16, 2);
    draw(CAMERA, 32, 2, W + 100, H);
    expect(cache.stats.renders).toBe(3);
    expect(phases(painted)).toEqual([...ALL, ...ALL, ...ALL]);
    // A long session of pans, zooms and settles at the last size.
    let t = 1000;
    for (let i = 0; i < 50; i += 1) {
      const camera = snapCamera(
        { centerX: i * 7.3, centerY: -i * 3.1, metersPerPixel: i % 10 < 5 ? 2 : 2.5 },
        2,
      );
      for (let k = 0; k < 15; k += 1) draw(camera, (t += 16), 2, W + 100, H);
    }
    // At most a handful of canvases of the current size are held (layers, spares, the
    // redraw in progress, the whole-map view); everything else has been released.
    const size = (W + 100) * 2 * H * 2;
    expect(cache.pixels).toBeLessThanOrEqual(6 * size);
    const held = canvases.all.filter((c) => c.width > 0 && c.id !== 1).length;
    expect(held).toBeLessThanOrEqual(7);
  });

  it('keeps the ground and the features apart while something goes between them', () => {
    let split = false;
    const { cache, painted, between, draw, target } = setup(() => split);
    draw(CAMERA, 0);
    split = true;
    painted.length = 0;
    draw(CAMERA, 16);
    expect(cache.stats.renders).toBe(2);
    expect(phases(painted)).toEqual(ALL);
    // Ground, then the overlay, then the features.
    const order = target.calls.filter((c) => c.startsWith('drawImage') || c === 'setTransform');
    expect(order.filter((c) => c.startsWith('drawImage'))).toHaveLength(2);
    expect(between).toEqual(['between']);
    draw(CAMERA, 32);
    expect(between).toEqual(['between', 'between']);
    expect(cache.stats.renders).toBe(2);
    split = false;
    draw(CAMERA, 48);
    expect(cache.stats.renders).toBe(3);
  });

  it('releases every canvas on dispose and draws nothing after', () => {
    const { cache, canvases, draw, target, painted } = setup();
    draw(CAMERA, 0);
    draw({ ...CAMERA, metersPerPixel: 3 }, 16);
    cache.dispose();
    for (const c of canvases.all) if (c !== target) expect([c.width, c.height]).toEqual([0, 0]);
    expect(cache.pixels).toBe(0);
    const before = painted.length;
    draw(CAMERA, 32);
    expect(painted).toHaveLength(before);
    expect(target.calls).toEqual([]);
  });
});
