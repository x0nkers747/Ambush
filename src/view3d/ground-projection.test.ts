import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { gradeTerrain, heightAt, createSyntheticTerrain, type TerrainDataset } from '#sim';
import { terrainGround } from './camera-math';
import { groundProjection, LINE_STEP_M, OVERLAY_LIFT_M } from './ground-projection';
import { roughGround } from './test-helpers';

// The 3D view's ground as a map projection (docs/adr/0039): what the 2D map's
// controller and overlays use in 3D. A map point goes to the canvas on the
// authoritative ground and comes back to the same point; lines follow the
// ground; bearings keep the map's convention.

const SIZE = { width: 1200, height: 800 };

function cameraOver(
  terrain: TerrainDataset,
  x: number,
  y: number,
  distance: number,
  pitchDeg: number,
) {
  const camera = new PerspectiveCamera(45, SIZE.width / SIZE.height, 1, 20_000);
  const z = heightAt(terrain, x, y);
  const pitch = (pitchDeg * Math.PI) / 180;
  // Looking north-east-ish, down at `pitch`.
  const az = (30 * Math.PI) / 180;
  const back = distance * Math.cos(pitch);
  camera.position.set(
    x - back * Math.sin(az),
    z + distance * Math.sin(pitch),
    -(y - back * Math.cos(az)),
  );
  camera.lookAt(new Vector3(x, z, -y));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

describe('groundProjection', () => {
  const terrain = roughGround();
  const ground = terrainGround(terrain);

  it('a map point goes to the canvas and back to itself, on the authoritative ground', () => {
    const camera = cameraOver(terrain, 0, 0, 400, 45);
    const p = groundProjection(camera, ground, SIZE, 0);
    for (const point of [
      { x: 0, y: 0 },
      { x: 40, y: -30 },
      { x: -60, y: 55 },
      { x: 20, y: 80 },
    ]) {
      const s = p.toScreen(point);
      const back = p.toWorld(s);
      expect(back).not.toBeNull();
      // Whatever ground is under the pixel (a hill may hide the point), it is drawn at that pixel.
      const again = p.toScreen(back ?? point);
      expect(Math.hypot(again.x - s.x, again.y - s.y)).toBeLessThan(0.5);
    }
    // Points in plain view come back to themselves (to the overlay's few centimetres).
    for (const point of [
      { x: 0, y: 0 },
      { x: 40, y: -30 },
    ]) {
      const back = p.toWorld(p.toScreen(point));
      expect(Math.hypot((back?.x ?? 0) - point.x, (back?.y ?? 0) - point.y)).toBeLessThan(0.15);
    }
  });

  it('picks the graded ground the simulation uses', () => {
    const source = createSyntheticTerrain(
      { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
      (x, y) => 100 + 6 * Math.exp(-(((y - 60) / 8) ** 2)) + 0.05 * x,
      {
        roads: [
          {
            id: 'cut',
            roadClass: 'paved',
            widthMeters: 6,
            centerline: [
              { x: -100, y: -180 },
              { x: -100, y: 180 },
            ],
          },
        ],
        buildings: [],
        vegetation: [],
      },
    );
    const graded = gradeTerrain(source);
    const camera = cameraOver(graded, -100, 60, 150, 60);
    const p = groundProjection(camera, terrainGround(graded), SIZE, 0);
    // A click on the road in the cutting lands on the cut road, not the ridge.
    const hit = p.toWorld(p.toScreen({ x: -100, y: 60 }));
    expect(hit).not.toBeNull();
    const hx = hit?.x ?? NaN;
    const hy = hit?.y ?? NaN;
    expect(Math.hypot(hx + 100, hy - 60)).toBeLessThan(0.15);
    expect(heightAt(graded, hx, hy)).toBeLessThan(heightAt(source, -100, 60) - 1);
  });

  it('raising a point (a soldier’s middle, a weapon) moves it up the screen', () => {
    const camera = cameraOver(terrain, 0, 0, 300, 40);
    const p = groundProjection(camera, ground, SIZE, 0);
    const foot = p.toScreen({ x: 10, y: 10 });
    const middle = p.toScreen({ x: 10, y: 10 }, 0.9);
    expect(middle.y).toBeLessThan(foot.y);
    expect(Math.abs(middle.x - foot.x)).toBeLessThan(2);
  });

  it('a point behind the camera cannot be drawn', () => {
    const camera = cameraOver(terrain, 0, 0, 100, 10);
    const p = groundProjection(camera, ground, SIZE, 0);
    // Far behind the camera, opposite to where it looks.
    const s = p.toScreen({ x: -280, y: -280 });
    expect(Number.isNaN(s.x) && Number.isNaN(s.y)).toBe(true);
  });

  it('the sky has no ground', () => {
    const camera = cameraOver(terrain, 0, 0, 300, 15);
    const p = groundProjection(camera, ground, SIZE, 0);
    expect(p.toWorld({ x: SIZE.width / 2, y: 2 })).toBeNull();
  });

  it('lines get a point every few metres, each on the ground', () => {
    const camera = cameraOver(terrain, 0, 0, 500, 50);
    const p = groundProjection(camera, ground, SIZE, 0);
    const a = { x: -80, y: -20 };
    const b = { x: 80, y: 40 };
    const line = p.line([a, b]);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    expect(line).toHaveLength(1 + Math.ceil(length / LINE_STEP_M));
    // Each point is the ground point that far along, projected: the line lies on the terrain.
    line.forEach((s, k) => {
      const t = k / (line.length - 1);
      const ground = p.toScreen({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      expect(Math.hypot(s.x - ground.x, s.y - ground.y)).toBeLessThan(1e-6);
    });
    // Over hills it bends on screen, unlike a straight line between its ends.
    const ends = [line[0], line[line.length - 1]];
    const straightness = Math.max(
      ...line.map((s) => {
        const [e0, e1] = ends;
        if (!e0 || !e1) return 0;
        const dx = e1.x - e0.x;
        const dy = e1.y - e0.y;
        return Math.abs((s.x - e0.x) * dy - (s.y - e0.y) * dx) / Math.hypot(dx, dy);
      }),
    );
    expect(straightness).toBeGreaterThan(2);
  });

  it('`along` points the map bearing’s way on screen: east is toward a point east', () => {
    const camera = cameraOver(terrain, 0, 0, 300, 50);
    const p = groundProjection(camera, ground, SIZE, 0);
    const from = p.toScreen({ x: 0, y: 0 });
    const tip = p.along({ x: 0, y: 0 }, Math.PI / 2, 42);
    expect(Math.hypot(tip.x - from.x, tip.y - from.y)).toBeCloseTo(42, 6);
    const east = p.toScreen({ x: 1, y: 0 });
    const dir = { x: east.x - from.x, y: east.y - from.y };
    const l = Math.hypot(dir.x, dir.y);
    expect((tip.x - from.x) / 42).toBeCloseTo(dir.x / l, 3);
    expect((tip.y - from.y) / 42).toBeCloseTo(dir.y / l, 3);
  });

  it('the overlay lift is small: nothing floats visibly', () => {
    expect(OVERLAY_LIFT_M).toBeLessThanOrEqual(0.1);
  });
});
