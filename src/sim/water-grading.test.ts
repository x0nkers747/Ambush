import { describe, expect, it } from 'vitest';
import type { EnvironmentFeatures, Road, WaterArea, Waterway } from './environment';
import type { Vec2 } from './geometry';
import { gradeTerrain, terrainModelId } from './ground';
import { lineOfSight } from './los';
import { pointInPolygon } from './polygon';
import { createSyntheticTerrain } from './synthetic-terrain';
import { heightAt, validateTerrain, type TerrainDataset } from './terrain';
import { surfaceMesh } from './terrain-surface';
import {
  BANK_MAX_RISE,
  BANK_REACH_M,
  classifyWater,
  nonIncreasingFit,
  riverLevels,
  SHORE_FREEBOARD_M,
  terrainWaterQuery,
  UNTAGGED_CHANNEL_WIDTH_M,
  WATER_RULES,
  waterLevelAt,
} from './water-grading';

// Water levelled into the authoritative ground (docs/adr/0040): standing
// water one exact level, rivers level across and never rising downstream,
// beds below the water, shores meeting it, banks blended locally, and the
// whole of it deterministic and part of the one graded terrain.

const GRID = { originX: -300, originY: -300, cellSize: 10, columns: 61, rows: 61 };

const ring = (cx: number, cy: number, r: number, n = 24, phase = 0): Vec2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    // A slightly irregular outline.
    const rr = r * (1 + 0.06 * Math.sin(3 * a));
    return { x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) };
  });

/** Distance from p to a polygon's outline. */
function edgeDistance(p: Vec2, poly: readonly Vec2[]): number {
  let best = Infinity;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length] ?? a;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  });
  return best;
}

/** DEM-like noise: deterministic, ±amp. */
const noise = (x: number, y: number, amp: number) =>
  amp * Math.sin(x * 0.37 + 1.3) * Math.cos(y * 0.23 - 0.4);

const features = (f: Partial<EnvironmentFeatures>): EnvironmentFeatures => ({
  roads: [],
  buildings: [],
  vegetation: [],
  water: [],
  waterways: [],
  landUse: [],
  ...f,
});

const LAKE = ring(0, 0, 120);
const lakeArea = (extra: Partial<WaterArea> = {}): WaterArea => ({
  id: 'lake',
  kind: 'water',
  waterClass: 'lake',
  boundary: LAKE,
  ...extra,
});

/** A lake in a hollow whose elevation data is noisy and leaks the banks in. */
function lakeWorld(
  f: Partial<EnvironmentFeatures> = {},
  ground?: (x: number, y: number) => number,
) {
  return createSyntheticTerrain(
    GRID,
    ground ??
      ((x, y) => {
        const r = Math.hypot(x, y);
        return 50 + noise(x, y, 0.5) + (r > 110 ? 0.12 * (r - 110) : 0);
      }),
    features({ water: [lakeArea()], ...f }),
  );
}

/** Points of the battlefield every `step` metres. */
function* points(step: number, margin = 0): Generator<Vec2> {
  for (let y = -300 + margin; y <= 300 - margin; y += step) {
    for (let x = -300 + margin; x <= 300 - margin; x += step) yield { x, y };
  }
}

describe('standing water', () => {
  const source = lakeWorld();
  const terrain = gradeTerrain(source);
  const body = terrain.grading?.water?.bodies.find((b) => b.id === 'lake');
  const level = body?.level ?? NaN;

  it('is levelled once, at the median of its shoreline', () => {
    expect(body?.graded).toBe(true);
    expect(body?.flow).toBe('standing');
    const shore: number[] = [];
    LAKE.forEach((a, i) => {
      const b = LAKE[(i + 1) % LAKE.length] ?? a;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2.5));
      for (let m = 0; m < n; m += 1) {
        shore.push(heightAt(source, a.x + ((b.x - a.x) * m) / n, a.y + ((b.y - a.y) * m) / n));
      }
    });
    shore.sort((p, q) => p - q);
    const median =
      shore.length % 2 === 1
        ? (shore[(shore.length - 1) / 2] ?? NaN)
        : ((shore[shore.length / 2 - 1] ?? 0) + (shore[shore.length / 2] ?? 0)) / 2;
    expect(level).toBeCloseTo(median, 9);
  });

  it('has one exactly horizontal surface', () => {
    const levels = new Set<number>();
    for (const p of points(7)) {
      if (pointInPolygon(p, LAKE)) levels.add(waterLevelAt(terrain, p.x, p.y) ?? NaN);
    }
    expect([...levels]).toEqual([level]);
    expect(waterLevelAt(terrain, 250, 250)).toBeNull();
  });

  it('has its bed below the water away from the shore', () => {
    let checked = 0;
    for (const p of points(3)) {
      if (!pointInPolygon(p, LAKE) || edgeDistance(p, LAKE) < 6) continue;
      expect(heightAt(terrain, p.x, p.y)).toBeLessThan(level - 0.05);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1000);
    // The middle is the full depth below the water.
    expect(heightAt(terrain, 0, 0)).toBeLessThanOrEqual(level - WATER_RULES.lake.depthM + 1e-9);
  });

  it('meets the water at the shore: no land beside it is lower than the water', () => {
    let checked = 0;
    for (const p of points(1.7)) {
      if (pointInPolygon(p, LAKE)) continue;
      const d = edgeDistance(p, LAKE);
      if (d > BANK_REACH_M - 3) continue;
      // (Within the field's rounding of its clamps: under 10 cm.)
      expect(heightAt(terrain, p.x, p.y)).toBeGreaterThanOrEqual(level - 0.1);
      // …and no wall: at most the steepest bank above the water.
      expect(heightAt(terrain, p.x, p.y)).toBeLessThanOrEqual(
        Math.max(
          heightAt(source, p.x, p.y),
          level + SHORE_FREEBOARD_M + BANK_MAX_RISE * (d + 3.6) + 1e-6,
        ) + 0.2,
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('keeps the source elevations, and makes a valid, continuous refined surface', () => {
    expect(source.grading).toBeUndefined();
    expect(source.heightfield.elevations).toEqual(lakeWorld().heightfield.elevations);
    expect(() => {
      validateTerrain(terrain);
    }).not.toThrow();
    // The mesh the 3D view draws is the surface `heightAt` gives.
    const mesh = surfaceMesh(terrain);
    for (let v = 0; v < mesh.vertexCount; v += 7) {
      const x = mesh.positions[3 * v] ?? 0;
      const y = mesh.positions[3 * v + 1] ?? 0;
      // (Refined samples are Float32.)
      expect(Math.abs((mesh.positions[3 * v + 2] ?? 0) - heightAt(terrain, x, y))).toBeLessThan(
        1e-4,
      );
    }
  });

  it('lowers deep water on the elevation grid alone, without refining it', () => {
    const refined = new Set(terrain.refinement?.cells ?? []);
    // The cell at the lake's middle is not refined.
    expect(refined.has(30 * 60 + 30)).toBe(false);
  });

  it('is deterministic and does not depend on the order of the features', () => {
    const other = lakeWorld({
      water: [
        lakeArea(),
        { id: 'a-pond', kind: 'water', waterClass: 'pond', boundary: ring(200, 200, 30) },
      ],
    });
    const reordered: TerrainDataset = {
      ...other,
      features: { ...other.features, water: [...(other.features.water ?? [])].reverse() },
    };
    const a = gradeTerrain(other);
    const b = gradeTerrain(reordered);
    expect(b.heightfield.elevations).toEqual(a.heightfield.elevations);
    expect(b.refinement).toEqual(a.refinement);
    expect(b.grading?.water).toEqual(a.grading?.water);
    expect(gradeTerrain(other).heightfield.elevations).toEqual(a.heightfield.elevations);
  });

  it('levels disconnected lakes apart, each at its own level', () => {
    const t = gradeTerrain(
      createSyntheticTerrain(
        GRID,
        (x) => 40 + 0.05 * x,
        features({
          water: [
            { id: 'west', kind: 'water', waterClass: 'lake', boundary: ring(-180, 0, 50) },
            { id: 'east', kind: 'water', waterClass: 'lake', boundary: ring(180, 0, 50) },
          ],
        }),
      ),
    );
    const west = waterLevelAt(t, -180, 0) ?? NaN;
    const east = waterLevelAt(t, 180, 0) ?? NaN;
    expect(Math.abs(west - (40 - 0.05 * 180))).toBeLessThan(1);
    expect(Math.abs(east - (40 + 0.05 * 180))).toBeLessThan(1);
    expect(waterLevelAt(t, -170, 10)).toBe(west);
    expect(waterLevelAt(t, 190, -10)).toBe(east);
  });

  it('flattens a spike in the elevation data inside the water', () => {
    const spiky = gradeTerrain(
      lakeWorld({}, (x, y) => {
        const r = Math.hypot(x, y);
        return (
          50 + (r > 110 ? 0.12 * (r - 110) : 0) + (Math.abs(x - 40) < 6 && Math.abs(y) < 6 ? 15 : 0)
        );
      }),
    );
    const l = waterLevelAt(spiky, 0, 0) ?? NaN;
    expect(heightAt(spiky, 40, 0)).toBeLessThan(l);
  });

  it('keeps a steep shore steep, without a vertical wall', () => {
    const steep = gradeTerrain(
      lakeWorld({}, (x, y) => {
        const r = Math.hypot(x, y);
        return 50 + (r > 125 ? 1.2 * (r - 125) : 0);
      }),
    );
    const l = waterLevelAt(steep, 0, 0) ?? NaN;
    // Thirty metres up the slope, the hillside is as it was.
    expect(Math.abs(heightAt(steep, 0, 165) - (50 + 1.2 * 40))).toBeLessThan(0.15);
    // Up from the shore the bank rises no faster than the steepest bank (plus the lattice).
    let prev = heightAt(steep, 0, 126);
    for (let y = 127; y < 160; y += 1) {
      const h = heightAt(steep, 0, y);
      expect(h - prev).toBeLessThanOrEqual(BANK_MAX_RISE * 2.5 + 1e-6);
      prev = h;
    }
    expect(l).toBeLessThan(51);
  });

  it('does not level water the elevation data plainly does not hold', () => {
    const hill = lakeWorld(
      {},
      (x, y) => 50 + Math.max(0, 8 - Math.hypot(x, y) / 10), // a hill 8 m high inside the "lake"
    );
    const t = gradeTerrain(hill);
    const b = t.grading?.water?.bodies.find((w) => w.id === 'lake');
    expect(b?.graded).toBe(false);
    expect(b?.note).toMatch(/above the shoreline level/);
    expect(waterLevelAt(t, 0, 0)).toBeNull();
    expect(heightAt(t, 0, 0)).toBe(heightAt(hill, 0, 0));
  });

  it('leaves small ponds as they are, levels large ones', () => {
    const t = gradeTerrain(
      createSyntheticTerrain(
        GRID,
        (x, y) => 20 + noise(x, y, 0.3),
        features({
          water: [
            { id: 'small', kind: 'water', waterClass: 'pond', boundary: ring(-150, -150, 6, 8) },
            { id: 'large', kind: 'water', waterClass: 'pond', boundary: ring(150, 150, 25) },
            { id: 'res', kind: 'water', waterClass: 'reservoir', boundary: ring(150, -150, 40) },
          ],
        }),
      ),
    );
    const bodies = new Map((t.grading?.water?.bodies ?? []).map((b) => [b.id, b]));
    expect(bodies.get('small')?.graded).toBe(false);
    expect(bodies.get('small')?.note).toMatch(/smaller than/);
    expect(bodies.get('large')?.graded).toBe(true);
    expect(bodies.get('res')?.graded).toBe(true);
    expect(waterLevelAt(t, -150, -150)).toBeNull();
  });
});

describe('the sea', () => {
  // The shore is a beach rising from the sea; offshore, the data holds the sea floor.
  const shoreX = 100;
  const sea: WaterArea = {
    id: 'osm-sea',
    kind: 'water',
    // Imported before water classes were kept: known from its coastline source.
    boundary: [
      { x: shoreX, y: -300 },
      { x: 300, y: -300 },
      { x: 300, y: 300 },
      { x: shoreX + 20, y: 300 },
    ],
    holes: [ring(220, 0, 30, 16)],
    source: { ref: 'osm:natural=coastline' },
  };
  const source = createSyntheticTerrain(
    GRID,
    (x, y) =>
      (x < shoreX ? 3 + 0.04 * (shoreX - x) : 3 - 0.08 * (x - shoreX)) +
      noise(x, y, 0.2) +
      // The island: a hill rising out of the sea.
      Math.max(0, 12 - 0.3 * Math.hypot(x - 220, y)),
    features({ water: [sea] }),
  );
  const t = gradeTerrain(source);

  it('is classified from its coastline and levelled at 0 m', () => {
    expect(classifyWater(sea, [])).toBe('sea');
    const b = t.grading?.water?.bodies[0];
    expect(b?.waterClass).toBe('sea');
    expect(b?.level).toBe(0);
    expect(waterLevelAt(t, 250, -200)).toBe(0);
  });

  it('has its floor below the water offshore', () => {
    // (The shore crosses y = −100 at x ≈ 107.)
    for (let x = shoreX + 14; x < 300; x += 3) expect(heightAt(t, x, -100)).toBeLessThan(0);
  });

  it('works across the battlefield edge: the edge is no shore', () => {
    // Near the north and south edges the sea is as deep as anywhere (no shore there).
    expect(heightAt(t, 200, -299)).toBeLessThan(-WATER_RULES.sea.depthM + 1e-9);
    expect(heightAt(t, 200, 299)).toBeLessThan(-WATER_RULES.sea.depthM + 1e-9);
  });

  it('keeps islands above the water at their shores, as land', () => {
    expect(waterLevelAt(t, 220, 0)).toBeNull();
    const island = sea.holes?.[0] ?? [];
    let checked = 0;
    for (let y = -40; y <= 40; y += 1.3) {
      for (let x = 180; x <= 260; x += 1.3) {
        if (!pointInPolygon({ x, y }, island) || edgeDistance({ x, y }, island) > 4) continue;
        expect(heightAt(t, x, y)).toBeGreaterThanOrEqual(-0.1);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('uses the data’s own sea level when the data plainly is on another datum', () => {
    const offset = createSyntheticTerrain(
      GRID,
      (x) => 30 + (x < shoreX ? 0.04 * (shoreX - x) : 0),
      features({ water: [sea] }),
    );
    const b = gradeTerrain(offset).grading?.water?.bodies[0];
    expect(b?.level).toBeCloseTo(30, 1);
    expect(b?.note).toMatch(/not 0 m/);
  });
});

/** A valley falling east to west, a river along it. */
const valley = (x: number, y: number) => 80 + 0.01 * x + 0.002 * y * y + noise(x, y, 0.4);
const river = (extra: Partial<Waterway> = {}): Waterway => ({
  id: 'river',
  kind: 'river',
  centerline: [
    { x: 290, y: 0 },
    { x: 100, y: 10 },
    { x: 0, y: -20 },
    { x: -100, y: 10 },
    { x: -290, y: 0 },
  ],
  widthMeters: 20,
  ...extra,
});

describe('rivers', () => {
  const source = createSyntheticTerrain(GRID, valley, features({ waterways: [river()] }));
  const t = gradeTerrain(source);
  const profile = t.grading?.water?.rivers[0];

  it('falls downstream and never rises, with no steps', () => {
    expect(profile?.directed).toBe(true);
    const levels = profile?.levels ?? [];
    expect(levels.length).toBeGreaterThan(100);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i] ?? 0).toBeLessThanOrEqual((levels[i - 1] ?? 0) + 1e-9);
      // No stairs: the fall between neighbouring points stays small.
      expect((levels[i - 1] ?? 0) - (levels[i] ?? 0)).toBeLessThan(0.2);
    }
    // It keeps the valley's real fall (about 5.8 m over 580 m).
    expect((levels[0] ?? 0) - (levels[levels.length - 1] ?? 0)).toBeGreaterThan(4.5);
  });

  it('is level across each section, its bed below the water', () => {
    for (const x of [-200, -50, 150]) {
      // Across the channel at x, square to it.
      const dy = profileY(x + 1) - profileY(x - 1);
      const len = Math.hypot(2, dy);
      const nx = -dy / len;
      const ny = 2 / len;
      const a = waterLevelAt(t, x + 6 * nx, profileY(x) + 6 * ny) ?? NaN;
      const b = waterLevelAt(t, x - 6 * nx, profileY(x) - 6 * ny) ?? NaN;
      expect(Math.abs(a - b)).toBeLessThan(0.02);
      expect(heightAt(t, x, profileY(x))).toBeLessThan(a - 0.5);
    }
  });

  it('is not levelled as a channel where it is narrow; a stream is a channel in the ground', () => {
    const stream: Waterway = { ...river({ id: 's', kind: 'stream', widthMeters: 2 }) };
    const ts = gradeTerrain(
      createSyntheticTerrain(GRID, valley, features({ waterways: [stream] })),
    );
    expect(ts.grading?.water?.rivers ?? []).toEqual([]);
    expect(waterLevelAt(ts, 0, -20)).toBeNull();
    expect(heightAt(ts, 0, -20)).toBeLessThan(
      heightAt(gradeTerrain(createSyntheticTerrain(GRID, valley)), 0, -20) - 0.2,
    );
  });

  it('levels an unmeasured river at the narrowest width that qualifies', () => {
    const untagged = river({
      widthMeters: 12,
      source: { ref: 'osm:way/1', estimated: ['widthMeters'] },
    });
    const tu = gradeTerrain(
      createSyntheticTerrain(GRID, valley, features({ waterways: [untagged] })),
    );
    const half = (tu.grading?.water?.rivers[0]?.halfWidths ?? []).find((h) => h > 0);
    expect(half).toBe(UNTAGGED_CHANNEL_WIDTH_M / 2);
  });

  it('does not invent a direction: a river drawn uphill is smoothed, not forced', () => {
    const reversed = river({ centerline: [...river().centerline].reverse() });
    const tr = gradeTerrain(
      createSyntheticTerrain(GRID, valley, features({ waterways: [reversed] })),
    );
    expect(tr.grading?.water?.rivers[0]?.directed).toBe(false);
  });

  it('meets the river it joins at the same level', () => {
    const tributary: Waterway = {
      id: 'trib',
      kind: 'river',
      centerline: [
        { x: 50, y: 280 },
        { x: 0, y: -20 },
      ],
      widthMeters: 10,
    };
    const tc = gradeTerrain(
      createSyntheticTerrain(GRID, valley, features({ waterways: [river(), tributary] })),
    );
    const rivers = tc.grading?.water?.rivers ?? [];
    const trib = rivers.find((r) => r.id === 'trib');
    const main = rivers.find((r) => r.id === 'river');
    const end = trib?.levels[trib.levels.length - 1] ?? NaN;
    const query = terrainWaterQuery(tc);
    expect(main).toBeDefined();
    expect(Math.abs(end - (query?.levelAt(0, -20) ?? NaN))).toBeLessThan(0.05);
  });

  it('enters a lake at the lake’s level', () => {
    const lake: WaterArea = {
      id: 'l',
      kind: 'water',
      waterClass: 'lake',
      boundary: ring(-200, 0, 30),
    };
    const tl = gradeTerrain(
      createSyntheticTerrain(GRID, valley, features({ waterways: [river()], water: [lake] })),
    );
    const lakeLevel = tl.grading?.water?.bodies.find((b) => b.id === 'l')?.level ?? NaN;
    expect(Number.isFinite(lakeLevel)).toBe(true);
    const r = tl.grading?.water?.rivers[0];
    // Where the river is in the lake, its profile is the lake's level.
    const xy = r?.xy ?? [];
    for (let i = 0; i < xy.length; i += 2) {
      if (pointInPolygon({ x: xy[i] ?? 0, y: xy[i + 1] ?? 0 }, lake.boundary)) {
        expect(Math.abs((r?.levels[i / 2] ?? NaN) - lakeLevel)).toBeLessThan(0.01);
      }
    }
  });

  it('gives a river area its levels from the river in it', () => {
    const area: WaterArea = {
      id: 'riverbank',
      kind: 'water',
      waterClass: 'river',
      boundary: [
        { x: -290, y: -40 },
        { x: 290, y: -40 },
        { x: 290, y: 40 },
        { x: -290, y: 40 },
      ],
    };
    const ta = gradeTerrain(
      createSyntheticTerrain(GRID, valley, features({ waterways: [river()], water: [area] })),
    );
    const b = ta.grading?.water?.bodies.find((w) => w.id === 'riverbank');
    expect(b?.flow).toBe('flowing');
    const west = waterLevelAt(ta, -250, 20) ?? NaN;
    const east = waterLevelAt(ta, 250, 20) ?? NaN;
    expect(east).toBeGreaterThan(west + 3);
  });
});

/** The river's centreline y at x (it is piecewise straight). */
function profileY(x: number): number {
  const pts = river().centerline;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a && b && x <= a.x && x >= b.x) return a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
  }
  return 0;
}

describe('roads, buildings and sight', () => {
  const bridge: Road = {
    id: 'bridge',
    roadClass: 'paved',
    widthMeters: 6,
    centerline: [
      { x: 0, y: -290 },
      { x: 0, y: 290 },
    ],
  };
  const boathouse = {
    id: 'boathouse',
    footprint: [
      { x: 60, y: 60 },
      { x: 70, y: 60 },
      { x: 70, y: 70 },
      { x: 60, y: 70 },
    ],
    heightMeters: 4,
  };
  const source = lakeWorld({ roads: [bridge], buildings: [boathouse] });
  const t = gradeTerrain(source);
  const level = waterLevelAt(t, -50, -50) ?? NaN;

  it('gives a bridge over the water no ground of its own: the bed is the bed', () => {
    // The same lake with no road, and with the road mapped as a bridge: the ground under it is the bed.
    const without = gradeTerrain(lakeWorld({ buildings: [boathouse] }));
    const mapped = gradeTerrain(
      lakeWorld({ roads: [{ ...bridge, bridge: true }], buildings: [boathouse] }),
    );
    for (let y = -100; y <= 100; y += 5) {
      expect(Math.abs(heightAt(mapped, 0, y) - heightAt(without, 0, y))).toBeLessThan(0.01);
    }
    expect(heightAt(mapped, 0, 0)).toBeLessThan(level);
  });

  it('stands a building in the water on a level pad', () => {
    const heights = [61, 65, 69].flatMap((x) => [61, 65, 69].map((y) => heightAt(t, x, y)));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.05);
  });

  it('keeps sight across the water clear (it is flat, below the eyes)', () => {
    const across = lineOfSight(
      t,
      { x: -128, y: 0 },
      { x: 128, y: 10 },
      { observerHeightMeters: 1.7, targetHeightMeters: 1.7 },
    );
    expect(across.clear).toBe(true);
  });

  it('names a new model of the ground', () => {
    expect(terrainModelId(t)).toBe('field-v6');
    // A terrain graded by the earlier rules is left as it was (its scenarios notice the model).
    const old: TerrainDataset = { ...source, grading: { version: 1, fineSpacingM: 2.5 } };
    expect(gradeTerrain(old)).toBe(old);
    expect(waterLevelAt(old, 0, 0)).toBeNull();
  });
});

describe('profiles', () => {
  it('fits a sequence that never rises (pool adjacent violators)', () => {
    expect(nonIncreasingFit([5, 4, 6, 3], [1, 1, 1, 1])).toEqual([5, 5, 5, 3]);
    expect(nonIncreasingFit([3, 2, 1], [1, 1, 1])).toEqual([3, 2, 1]);
  });

  it('filters spikes and meets pinned levels', () => {
    const raw = Array.from({ length: 60 }, (_, i) => 10 - 0.05 * i + (i === 30 ? 6 : 0));
    const out = riverLevels(raw, new Map([[59, 6.9]]), true);
    expect(Math.max(...out.slice(25, 35))).toBeLessThan(9);
    expect(out[59]).toBeCloseTo(6.9, 6);
    for (let i = 1; i < out.length; i += 1)
      expect(out[i] ?? 0).toBeLessThanOrEqual((out[i - 1] ?? 0) + 1e-12);
  });
});
