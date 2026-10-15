import { describe, expect, it } from 'vitest';
import { createSyntheticTerrain, flatElevation } from '#sim';
import { panBy, screenToWorld, worldToScreen, zoomAt, type Camera } from './camera';
import { createMapController, DRAG_THRESHOLD_PX, WHEEL_ZOOM_RATE } from './interaction';
import { buildScene, cameraProjection } from './scene';

// The map's projection and its own pointer handling (pan and zoom): the 2D
// projection is exactly the map camera; a press becomes a pan once it moves
// beyond the drag threshold, a middle drag pans at once, and the wheel zooms
// at the cursor.

const terrain = createSyntheticTerrain(
  { originX: -100, originY: -100, cellSize: 10, columns: 21, rows: 21 },
  flatElevation(0),
);
const viewport = { width: 800, height: 600 };
const start: Camera = { centerX: 10, centerY: -20, metersPerPixel: 0.5 };

describe('the 2D projection', () => {
  it('is exactly the map camera: points, arrows and lines', () => {
    const projection = cameraProjection(start, viewport);
    const p = { x: 37.5, y: -12.25 };
    expect(projection.toScreen(p)).toEqual(worldToScreen(start, viewport, p));
    expect(projection.toWorld({ x: 120, y: 80 })).toEqual(
      screenToWorld(start, viewport, { x: 120, y: 80 }),
    );
    const at = worldToScreen(start, viewport, p);
    const east = projection.along(p, Math.PI / 2, 30);
    expect(east.x).toBeCloseTo(at.x + 30, 9);
    expect(east.y).toBeCloseTo(at.y, 9);
    expect(projection.line([p, { x: 0, y: 0 }])).toEqual([
      worldToScreen(start, viewport, p),
      worldToScreen(start, viewport, { x: 0, y: 0 }),
    ]);
    expect(projection.perspective).toBe(false);
  });

  it('knows the terrain', () => {
    const scene = buildScene(terrain, start, viewport);
    expect(scene.isOnMap({ x: 0, y: 0 })).toBe(true);
    expect(scene.isOnMap({ x: 500, y: 0 })).toBe(false);
  });
});

describe('panning and zooming', () => {
  const controller = () => {
    let camera = start;
    const c = createMapController(
      () => buildScene(terrain, camera, viewport),
      (next) => {
        camera = next;
      },
    );
    return { c, camera: () => camera };
  };

  it('a left press pans once it moves beyond the drag threshold, by the whole movement', () => {
    const { c, camera } = controller();
    c.pointerDown({ x: 100, y: 100, button: 0 });
    c.pointerMove({ x: 100 + DRAG_THRESHOLD_PX - 1, y: 100, button: 0 });
    expect(camera()).toEqual(start);
    expect(c.cursor).toBe('grab');
    c.pointerMove({ x: 130, y: 90, button: 0 });
    expect(camera()).toEqual(panBy(start, 30, -10));
    expect(c.cursor).toBe('grabbing');
    c.pointerMove({ x: 140, y: 95, button: 0 });
    expect(camera()).toEqual(panBy(panBy(start, 30, -10), 10, 5));
    c.pointerUp({ x: 140, y: 95, button: 0 });
    expect(c.cursor).toBe('grab');
  });

  it('a middle drag pans at once; a right press does nothing', () => {
    const { c, camera } = controller();
    c.pointerDown({ x: 100, y: 100, button: 1 });
    c.pointerMove({ x: 101, y: 100, button: 1 });
    expect(camera()).toEqual(panBy(start, 1, 0));
    c.pointerUp({ x: 101, y: 100, button: 1 });
    const { c: right, camera: still } = controller();
    right.pointerDown({ x: 100, y: 100, button: 2 });
    right.pointerMove({ x: 200, y: 100, button: 2 });
    expect(still()).toEqual(start);
  });

  it('the wheel zooms at the cursor', () => {
    const { c, camera } = controller();
    c.wheel({ x: 200, y: 150 }, 100);
    expect(camera()).toEqual(
      zoomAt(start, viewport, { x: 200, y: 150 }, Math.exp(-100 * WHEEL_ZOOM_RATE)),
    );
  });

  it('a cancelled press neither pans nor clicks', () => {
    const { c, camera } = controller();
    c.pointerDown({ x: 100, y: 100, button: 0 });
    c.cancel();
    c.pointerMove({ x: 200, y: 100, button: 0 });
    expect(camera()).toEqual(start);
  });
});
