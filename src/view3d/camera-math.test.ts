import { describe, expect, it } from 'vitest';
import { createSyntheticTerrain, heightAt, isOnTerrain, type TerrainDataset } from '#sim';
import {
  clampToExtent,
  DEFAULT_PITCH_DEG,
  defaultView,
  GROUND_CLEARANCE_M,
  groundHit,
  keepAboveGround,
  maxDistance,
  type GroundAt,
} from './camera-math';

// The tactical camera's geometry (docs/adr/0029).

const hills = createSyntheticTerrain(
  { originX: -2500, originY: -2500, cellSize: 10, columns: 501, rows: 501 },
  (x, y) => 200 + 150 * Math.sin(x / 600) * Math.cos(y / 800),
);
const groundOf =
  (terrain: TerrainDataset): GroundAt =>
  (x, z) =>
    isOnTerrain(terrain, x, -z) ? heightAt(terrain, x, -z) : null;
const ground = groundOf(hills);
const extent = { minX: -2500, maxX: 2500, minY: -2500, maxY: 2500 };

describe('the default tactical view', () => {
  const view = defaultView(extent, ground, 45, 16 / 9);

  it('focuses on the battlefield centre, on the ground', () => {
    expect(view.target.x).toBe(0);
    expect(view.target.z).toBe(0);
    expect(view.target.y).toBeCloseTo(heightAt(hills, 0, 0), 9);
  });

  it('looks north and down at an oblique angle, from above the battlefield', () => {
    const dx = view.target.x - view.position.x;
    const dy = view.target.y - view.position.y;
    const dz = view.target.z - view.position.z;
    expect(dx).toBeCloseTo(0, 9);
    expect(dz).toBeLessThan(0); // looking towards −z: north
    const pitch = (Math.atan2(-dy, Math.hypot(dx, dz)) * 180) / Math.PI;
    expect(pitch).toBeCloseTo(DEFAULT_PITCH_DEG, 6);
  });

  it('is far enough to show the whole width, and not absurdly far', () => {
    const distance = Math.hypot(
      view.position.x - view.target.x,
      view.position.y - view.target.y,
      view.position.z - view.target.z,
    );
    const halfH = Math.atan(Math.tan((22.5 * Math.PI) / 180) * (16 / 9));
    // The battlefield's half width fits within the horizontal half angle at the target.
    expect(Math.atan(2500 / distance)).toBeLessThanOrEqual(halfH);
    expect(distance).toBeLessThan(maxDistance(extent));
    expect(distance).toBeGreaterThan(2500);
  });

  it('fits a tall, narrow window too (portrait)', () => {
    const tall = defaultView(extent, ground, 45, 0.6);
    const far = Math.hypot(tall.position.y - tall.target.y, tall.position.z - tall.target.z);
    const near = Math.hypot(view.position.y - view.target.y, view.position.z - view.target.z);
    expect(far).toBeGreaterThan(near);
  });
});

describe('camera constraints', () => {
  it('keep the camera above the ground', () => {
    const g = ground(100, -200) ?? 0;
    expect(keepAboveGround({ x: 100, y: g - 50, z: -200 }, ground).y).toBe(g + GROUND_CLEARANCE_M);
    expect(keepAboveGround({ x: 100, y: g + 1, z: -200 }, ground).y).toBe(g + GROUND_CLEARANCE_M);
    expect(keepAboveGround({ x: 100, y: g + 300, z: -200 }, ground).y).toBe(g + 300);
    // Off the battlefield there is no ground to keep above.
    expect(keepAboveGround({ x: 9000, y: -5, z: 0 }, ground).y).toBe(-5);
    // ... unless there is a floor there (the plain round the battlefield).
    expect(keepAboveGround({ x: 9000, y: -5, z: 0 }, ground, 30).y).toBe(30 + GROUND_CLEARANCE_M);
    expect(
      keepAboveGround({ x: 100, y: (ground(100, -200) ?? 0) + 300, z: -200 }, ground, 9999).y,
    ).toBe((ground(100, -200) ?? 0) + 300);
  });

  it('keep the focus on the battlefield', () => {
    expect(clampToExtent({ x: 4000, y: 1, z: -9000 }, extent)).toEqual({ x: 2500, y: 1, z: -2500 });
    expect(clampToExtent({ x: -10, y: 1, z: 20 }, extent)).toEqual({ x: -10, y: 1, z: 20 });
  });

  it('allow zooming out to 2.5 battlefield widths', () => {
    expect(maxDistance(extent)).toBe(12_500);
  });
});

describe('picking the ground (double-click to focus)', () => {
  it('finds where a ray meets the simulated ground, to a centimetre', () => {
    for (const [x, y] of [
      [0, 0],
      [-1234, 987],
      [2000, -1500],
      [-2400, -2400],
    ] as const) {
      const g = heightAt(hills, x, y);
      // From a camera 3 km south and 2 km up, towards the ground point.
      const origin = { x, y: g + 2000, z: -y + 3000 };
      const hit = groundHit(origin, { x: 0, y: -2000, z: -3000 }, ground, 10_000);
      expect(hit).not.toBeNull();
      expect(hit?.x).toBeCloseTo(x, 1);
      expect(-(hit?.z ?? 0)).toBeCloseTo(y, 1);
      expect(Math.abs((hit?.y ?? 0) - g)).toBeLessThan(0.05);
    }
  });

  it('meets a hill before the point behind it', () => {
    // A ridge at y = 500 hides the ground beyond it from a low camera.
    const ridge = createSyntheticTerrain(
      { originX: -1000, originY: -1000, cellSize: 10, columns: 201, rows: 201 },
      (_x, y) => (Math.abs(y - 500) < 50 ? 100 : 0),
    );
    const g = groundOf(ridge);
    const hit = groundHit({ x: 0, y: 20, z: 0 }, { x: 0, y: -20, z: -900 }, g, 5000);
    expect(hit).not.toBeNull();
    expect(-(hit?.z ?? 0)).toBeGreaterThan(440);
    expect(-(hit?.z ?? 0)).toBeLessThan(460);
  });

  it('returns null for a ray that leaves the battlefield or points at the sky', () => {
    expect(groundHit({ x: 0, y: 1000, z: 0 }, { x: 0, y: 1, z: 0 }, ground, 10_000)).toBeNull();
    expect(groundHit({ x: 0, y: 1000, z: 0 }, { x: 1, y: 0, z: 0 }, ground, 10_000)).toBeNull();
  });

  it('reaches the battlefield from far outside it', () => {
    const hit = groundHit({ x: 0, y: 3000, z: 8000 }, { x: 0, y: -3000, z: -8000 }, ground, 20_000);
    expect(hit).not.toBeNull();
    expect(Math.abs(hit?.z ?? 99)).toBeLessThan(2600);
  });
});
