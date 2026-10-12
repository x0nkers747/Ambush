import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  gradeTerrain,
  heightAt,
  waterLevelAt,
  type EnvironmentFeatures,
  type Vec2,
} from '#sim';
import { terrainGround } from './camera-math';
import { createDraper } from './drape';
import { coverage, triangles } from './test-helpers';
import { WATER_COLORS, waterGeometry } from './water-geometry';

// The 3D water (docs/adr/0040): levelled standing water one exactly level
// sheet, rivers on their profile, both on the ground the grading made for
// them; water not levelled draped as before.

const ring = (cx: number, cy: number, r: number, n = 20): Vec2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });

const features: EnvironmentFeatures = {
  roads: [],
  buildings: [],
  vegetation: [],
  water: [
    {
      id: 'lake',
      kind: 'water',
      waterClass: 'lake',
      boundary: ring(-80, 0, 50),
      holes: [ring(-80, 0, 10, 8)],
    },
    { id: 'tiny', kind: 'water', waterClass: 'pond', boundary: ring(120, 120, 5, 8) },
  ],
  waterways: [
    {
      id: 'river',
      kind: 'river',
      centerline: [
        { x: 190, y: -150 },
        { x: 60, y: -120 },
        { x: -190, y: -160 },
      ],
      widthMeters: 14,
    },
  ],
  landUse: [],
};
const source = createSyntheticTerrain(
  { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
  (x, y) =>
    30 +
    0.01 * x +
    0.6 * Math.sin(x * 0.31) * Math.cos(y * 0.27) +
    (Math.hypot(x + 80, y) > 45 ? 0.05 * (Math.hypot(x + 80, y) - 45) : 0),
  features,
);
const terrain = gradeTerrain(source);
const water = waterGeometry(terrain, createDraper(terrain));
const tris = triangles(water.mesh);

describe('waterGeometry on levelled water', () => {
  it('draws standing water as one exactly horizontal sheet at its level, islands open', () => {
    const level = waterLevelAt(terrain, -80, 30) ?? NaN;
    expect(Number.isFinite(level)).toBe(true);
    const lake = tris.filter(
      (t) => Math.hypot((t.a.x + t.b.x + t.c.x) / 3 + 80, (t.a.y + t.b.y + t.c.y) / 3) < 48,
    );
    expect(lake.length).toBeGreaterThan(10);
    for (const t of lake) for (const v of [t.a, t.b, t.c]) expect(v.z).toBe(Math.fround(level));
    const cover = coverage(water.mesh);
    expect(cover.covered(-80, 30)).toBe(true);
    expect(cover.covered(-80, 0)).toBe(false);
    expect(water.levelled).toBeGreaterThanOrEqual(1);
  });

  it('never floats above the ground beside it, nor sinks below its bed', () => {
    const level = waterLevelAt(terrain, -80, 30) ?? NaN;
    // Inside the lake, beyond the shore, the bed is below the sheet.
    for (const r of [15, 25, 35]) expect(heightAt(terrain, -80 + r, 0)).toBeLessThan(level);
    // Just outside its outline, the ground stands at or above it.
    for (let a = 0; a < 2 * Math.PI; a += 0.4) {
      const p = { x: -80 + 52 * Math.cos(a), y: 52 * Math.sin(a) };
      expect(heightAt(terrain, p.x, p.y)).toBeGreaterThanOrEqual(level - 1e-6);
    }
  });

  it('draws a wide river on its profile: falling downstream, level across', () => {
    const river = tris.filter((t) => t.a.y < -100);
    expect(river.length).toBeGreaterThan(20);
    for (const t of river) {
      for (const v of [t.a, t.b, t.c]) {
        const l = waterLevelAt(terrain, v.x, v.y);
        if (l !== null) expect(Math.abs(v.z - l)).toBeLessThan(1e-3);
      }
    }
    const up = waterLevelAt(terrain, 150, -141) ?? NaN;
    const down = waterLevelAt(terrain, -150, -152) ?? NaN;
    expect(up).toBeGreaterThan(down);
  });

  it('drapes water too small to level, as before', () => {
    const pond = tris.filter((t) => Math.hypot(t.a.x - 120, t.a.y - 120) < 6);
    expect(pond.length).toBeGreaterThan(0);
    for (const t of pond) {
      for (const v of [t.a, t.b, t.c]) expect(v.z).toBeGreaterThan(heightAt(terrain, v.x, v.y));
    }
  });

  it('colours each kind of water its own way', () => {
    expect(water.mesh.colors?.length).toBe(water.mesh.positions.length);
    expect(WATER_COLORS.sea).not.toBe(WATER_COLORS.river);
    expect(WATER_COLORS.lake).not.toBe(WATER_COLORS.river);
  });

  it('picks the water where it is seen, not the bed under it', () => {
    const ground = terrainGround(terrain);
    const level = waterLevelAt(terrain, -80, 30) ?? NaN;
    expect(ground(-80, -30)).toBe(level);
    expect(ground(150, -150)).toBe(heightAt(terrain, 150, 150));
  });
});
