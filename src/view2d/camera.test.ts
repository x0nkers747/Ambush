import { describe, expect, it } from 'vitest';
import {
  fitBounds,
  MAX_METERS_PER_PIXEL,
  MIN_METERS_PER_PIXEL,
  panBy,
  screenToWorld,
  worldToScreen,
  worldToScreenTransform,
  zoomAt,
  type Camera,
} from './camera';

const viewport = { width: 800, height: 600 };
const camera: Camera = { centerX: 100, centerY: -50, metersPerPixel: 0.5 };

function expectPoint(actual: { x: number; y: number }, x: number, y: number) {
  expect(actual.x).toBeCloseTo(x, 9);
  expect(actual.y).toBeCloseTo(y, 9);
}

describe('screen ↔ map coordinates', () => {
  it('puts the camera centre at the viewport centre', () => {
    expectPoint(worldToScreen(camera, viewport, { x: 100, y: -50 }), 400, 300);
  });

  it('keeps East to the right and North up', () => {
    expectPoint(worldToScreen(camera, viewport, { x: 110, y: -50 }), 420, 300);
    expectPoint(worldToScreen(camera, viewport, { x: 100, y: -40 }), 400, 280);
  });

  it('uses the same scale on both axes', () => {
    const origin = worldToScreen(camera, viewport, { x: 0, y: 0 });
    const east = worldToScreen(camera, viewport, { x: 7, y: 0 });
    const north = worldToScreen(camera, viewport, { x: 0, y: 7 });
    expect(east.x - origin.x).toBeCloseTo(origin.y - north.y, 12);
  });

  it('round-trips', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: -312.5, y: 87.25 },
      { x: 1e4, y: -1e4 },
    ]) {
      expectPoint(screenToWorld(camera, viewport, worldToScreen(camera, viewport, p)), p.x, p.y);
    }
    expectPoint(
      worldToScreen(camera, viewport, screenToWorld(camera, viewport, { x: 13, y: 577 })),
      13,
      577,
    );
  });

  it('matches the canvas transform', () => {
    const [a, b, c, d, e, f] = worldToScreenTransform(camera, viewport);
    const p = { x: -37, y: 211 };
    const s = worldToScreen(camera, viewport, p);
    expectPoint({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }, s.x, s.y);
  });
});

describe('zoomAt', () => {
  it('keeps the map point under the cursor fixed', () => {
    const cursor = { x: 130, y: 470 };
    const before = screenToWorld(camera, viewport, cursor);
    for (const factor of [2, 0.5, 1.37]) {
      const zoomed = zoomAt(camera, viewport, cursor, factor);
      expect(zoomed.metersPerPixel).toBeCloseTo(camera.metersPerPixel / factor, 12);
      expectPoint(screenToWorld(zoomed, viewport, cursor), before.x, before.y);
    }
  });

  it('clamps the zoom range and still keeps the cursor point fixed', () => {
    const cursor = { x: 700, y: 50 };
    const before = screenToWorld(camera, viewport, cursor);
    const zoomedIn = zoomAt(camera, viewport, cursor, 1e6);
    const zoomedOut = zoomAt(camera, viewport, cursor, 1e-6);
    expect(zoomedIn.metersPerPixel).toBe(MIN_METERS_PER_PIXEL);
    expect(zoomedOut.metersPerPixel).toBe(MAX_METERS_PER_PIXEL);
    expectPoint(screenToWorld(zoomedIn, viewport, cursor), before.x, before.y);
    expectPoint(screenToWorld(zoomedOut, viewport, cursor), before.x, before.y);
  });
});

describe('panBy', () => {
  it('moves the map with the pointer', () => {
    const grab = { x: 200, y: 150 };
    const grabbed = screenToWorld(camera, viewport, grab);
    const panned = panBy(camera, 35, -20);
    expectPoint(worldToScreen(panned, viewport, grabbed), 235, 130);
    expect(panned.metersPerPixel).toBe(camera.metersPerPixel);
  });
});

describe('fitBounds', () => {
  const bounds = { minX: -400, minY: -300, maxX: 400, maxY: 300 };

  it('shows the whole area centred with the margin, keeping the aspect ratio', () => {
    for (const vp of [
      { width: 1100, height: 830 },
      { width: 500, height: 900 },
      { width: 1600, height: 400 },
    ]) {
      const fitted = fitBounds(bounds, vp, 24);
      expect(fitted.centerX).toBe(0);
      expect(fitted.centerY).toBe(0);
      const topLeft = worldToScreen(fitted, vp, { x: bounds.minX, y: bounds.maxY });
      const bottomRight = worldToScreen(fitted, vp, { x: bounds.maxX, y: bounds.minY });
      expect(topLeft.x).toBeGreaterThanOrEqual(24 - 1e-9);
      expect(topLeft.y).toBeGreaterThanOrEqual(24 - 1e-9);
      expect(bottomRight.x).toBeLessThanOrEqual(vp.width - 24 + 1e-9);
      expect(bottomRight.y).toBeLessThanOrEqual(vp.height - 24 + 1e-9);
      // The limiting dimension touches the margin exactly.
      expect(Math.min(topLeft.x, topLeft.y)).toBeCloseTo(24, 9);
    }
  });
});
