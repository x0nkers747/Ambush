import { describe, expect, it } from 'vitest';
import {
  buildingRoofElevations,
  createSyntheticTerrain,
  flatElevation,
  heightAt,
  NO_FEATURES,
  pointInPolygon,
  rectangle,
  type Building,
  type BuildingAppearance,
  type Road,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import {
  buildingGeometry,
  designBuildings,
  ROOF_LAYER_BASE,
  TRIM_LAYER,
  WATER_FOOTING_M,
  type BuildingGeometry,
} from './building-geometry';
import { WALL_LAYERS, WALL_TILE_M } from './building-style';
import { CORNER_CLEARANCE_M, storeysOf, windowCentres } from './facade';
import { footprintShape } from './footprint-shape';
import { MIN_WALL_M, planRoof, roofHeightAt } from './roof-geometry';
import type { SurfaceMeshData } from './surface-mesh';
import { roughGround } from './test-helpers';

// Procedural buildings (docs/adr/0035): roofs, walls, windows and doors.

const GROUND = 100;
const flat = (buildings: Building[], roads: Road[] = []): TerrainDataset =>
  createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
    flatElevation(GROUND),
    { ...NO_FEATURES, buildings, roads },
  );
const house = (
  id: string,
  footprint: Vec2[],
  heightMeters = 6,
  appearance?: BuildingAppearance,
): Building => ({ id, footprint, heightMeters, ...(appearance ? { appearance } : {}) });

interface V {
  x: number;
  y: number;
  z: number;
  u: number;
  v: number;
  nx: number;
  ny: number;
  nz: number;
  layer: number;
}
/** The vertices of a surface mesh, three per triangle, back in map axes. */
function vertices(m: SurfaceMeshData): V[] {
  const out: V[] = [];
  for (let i = 0; i < m.triangleCount * 3; i += 1) {
    out.push({
      x: m.positions[i * 3] ?? NaN,
      y: -(m.positions[i * 3 + 2] ?? NaN),
      z: m.positions[i * 3 + 1] ?? NaN,
      u: m.uvs[i * 2] ?? NaN,
      v: m.uvs[i * 2 + 1] ?? NaN,
      nx: m.normals[i * 3] ?? NaN,
      ny: -(m.normals[i * 3 + 2] ?? NaN),
      nz: m.normals[i * 3 + 1] ?? NaN,
      layer: m.layers[i] ?? NaN,
    });
  }
  return out;
}
const tris = (vs: V[]) =>
  Array.from(
    { length: vs.length / 3 },
    (_, i) => [vs[i * 3], vs[i * 3 + 1], vs[i * 3 + 2]] as [V, V, V],
  );
const isRoof = (v: V) => v.layer >= ROOF_LAYER_BASE;
const isWall = (v: V) => v.layer >= 0 && v.layer < ROOF_LAYER_BASE;

function designOf(terrain: TerrainDataset, id: string) {
  const d = designBuildings(terrain).get(id);
  if (!d) throw new Error(`no design for ${id}`);
  return d;
}
function planOf(terrain: TerrainDataset, b: Building) {
  const { shape, style } = designOf(terrain, b.id);
  if (!shape) throw new Error('no shape');
  return planRoof({
    shape,
    kind: style.roof,
    pitchDegrees: style.pitchDegrees,
    overhangM: style.overhangM,
    reference: buildingRoofElevations(terrain).get(b.id) ?? NaN,
    base: GROUND,
    appearance: b.appearance,
    chance: 0.25,
  });
}

function expectSound(g: BuildingGeometry) {
  for (const m of [g.surfaces, g.openings]) {
    for (const a of [m.positions, m.normals, m.uvs, m.colors, m.layers]) {
      for (const x of a) expect(Number.isFinite(x)).toBe(true);
    }
    for (const v of vertices(m)) expect(Math.hypot(v.nx, v.ny, v.nz)).toBeCloseTo(1, 4);
  }
}

describe('roofs', () => {
  it('ridges a rectangle along its long side, keeping the mean height of line of sight', () => {
    const b = house('r', rectangle(0, 0, 14, 8, 30), 6, { roofShape: 'gabled' });
    const terrain = flat([b]);
    const plan = planOf(terrain, b);
    const ref = GROUND + 6;
    expect(plan.kind).toBe('gabled');
    // Eaves half the rise below the reference, ridge half above (6 m: ≈ 4.5 and 7.5 m at 37°).
    expect(plan.top - ref).toBeCloseTo(ref - plan.eaves, 9);
    expect(plan.eaves).toBeLessThan(ref);
    expect(plan.eaves - GROUND).toBeGreaterThanOrEqual(MIN_WALL_M - 1e-9);
    const r = plan.rects[0];
    expect(r).toBeDefined();
    const long = r?.along === 's' ? r.rect.s1 - r.rect.s0 : (r?.rect.t1 ?? 0) - (r?.rect.t0 ?? 0);
    expect(long).toBeCloseTo(14, 6);
    // The ridge's highest points lie along the long axis through the centre.
    const vs = vertices(buildingGeometry(terrain).surfaces).filter(isRoof);
    const top = vs.filter((v) => Math.abs(v.z - plan.top) < 1e-3);
    expect(top.length).toBeGreaterThan(0);
    const a = (30 * Math.PI) / 180;
    for (const v of top) {
      // Across the ridge (the depth axis), the ridge is at the centre.
      expect(Math.abs(v.x * Math.sin(a) + v.y * Math.cos(a))).toBeLessThan(1e-3);
    }
  });

  it('puts the ridge at the tagged height when the source gives the roof height', () => {
    const b = house('t', rectangle(0, 0, 12, 9), 9, { heightMeters: 9, roofHeightMeters: 3 });
    const plan = planOf(flat([b]), b);
    expect(plan.top).toBeCloseTo(GROUND + 9, 6);
    expect(plan.eaves).toBeCloseTo(GROUND + 6, 6);
  });

  it('caps the rise to keep the walls 2.4 m tall, and draws a low building flat', () => {
    const low = house('low', rectangle(0, 0, 20, 14), 3, { roofShape: 'gabled' });
    const lowPlan = planOf(flat([low]), low);
    expect(lowPlan.eaves - GROUND).toBeCloseTo(MIN_WALL_M, 6);
    const tiny = house('tiny', rectangle(0, 0, 20, 14), 2.6, { roofShape: 'gabled' });
    expect(planOf(flat([tiny]), tiny).kind).toBe('flat');
  });

  it('follows the tagged orientation and direction', () => {
    const across = house('x', rectangle(0, 0, 16, 8), 6, {
      roofShape: 'gabled',
      roofOrientation: 'across',
    });
    const plan = planOf(flat([across]), across);
    const r = plan.rects[0];
    const ridgeLength =
      r?.along === 's' ? r.rect.s1 - r.rect.s0 : (r?.rect.t1 ?? 0) - (r?.rect.t0 ?? 0);
    expect(ridgeLength).toBeCloseTo(8, 6);
    // A skillion facing south is lowest along its southern edge.
    const shed = house('s', rectangle(0, 0, 10, 6), 4, {
      roofShape: 'skillion',
      roofDirectionDegrees: 180,
    });
    const terrain = flat([shed]);
    const sp = planOf(terrain, shed);
    expect(sp.kind).toBe('skillion');
    const south = roofHeightAt(sp, 0, -2.9) ?? NaN;
    const north = roofHeightAt(sp, 0, 2.9) ?? NaN;
    expect(south).toBeLessThan(north);
  });

  it('builds every roof shape closed and upward-facing, with overhangs and no gaps', () => {
    for (const roofShape of ['flat', 'gabled', 'hipped', 'skillion'] as const) {
      const fp = rectangle(0, 0, 13, 9, 17);
      const b = house(roofShape, fp, 6, { roofShape });
      const terrain = flat([b]);
      const g = buildingGeometry(terrain);
      expectSound(g);
      expect(g.stats.roofs[roofShape]).toBe(1);
      const vs = vertices(g.surfaces);
      // Roof faces face up.
      for (const v of vs.filter(isRoof)) expect(v.nz).toBeGreaterThan(0.2);
      // The roof covers every point of the footprint, at or above the wall tops.
      const plan = planOf(terrain, b);
      const wallTop = Math.max(...vs.filter(isWall).map((v) => v.z));
      for (let i = 0; i < 200; i += 1) {
        const p = { x: -6.4 + (i % 20) * 0.67, y: -4.4 + Math.floor(i / 20) * 0.98 };
        const q = {
          x: p.x * Math.cos(-0.297) - p.y * Math.sin(-0.297),
          y: p.x * Math.sin(-0.297) + p.y * Math.cos(-0.297),
        };
        if (!pointInPolygon(q, fp)) continue;
        if (roofShape === 'flat') continue;
        const z = roofHeightAt(plan, q.x, q.y);
        expect(z).not.toBeNull();
        expect(z ?? 0).toBeGreaterThanOrEqual(plan.eaves - 1e-6);
      }
      if (roofShape !== 'flat') {
        // The walls stop where the roof begins: at the eaves (a skillion's follow its slope).
        expect(wallTop).toBeLessThanOrEqual(plan.top + 1e-3);
        for (const p of fp) {
          const z = roofHeightAt(plan, p.x, p.y) ?? NaN;
          const near = vs.filter(
            (v) => isWall(v) && Math.hypot(v.x - p.x, v.y - p.y) < 1e-3 && v.z > GROUND + 1,
          );
          expect(Math.max(...near.map((v) => v.z))).toBeCloseTo(z, 3);
        }
        // The overhang reaches out past the walls.
        const reach = Math.max(...vs.filter(isRoof).map((v) => Math.hypot(v.x, v.y)));
        expect(reach).toBeGreaterThan(Math.hypot(6.5, 4.5) + 0.2);
      } else {
        // A flat roof lies exactly where line of sight finds the top.
        const roof = vs.filter(isRoof);
        for (const v of roof) expect(v.z).toBeCloseTo(GROUND + 6, 6);
      }
    }
  });

  it('roofs L and T plans as joined rectangles, an irregular plan flat', () => {
    const L: Vec2[] = [
      { x: 0, y: 0 },
      { x: 16, y: 0 },
      { x: 16, y: 7 },
      { x: 7, y: 7 },
      { x: 7, y: 15 },
      { x: 0, y: 15 },
    ];
    const T: Vec2[] = [
      { x: 0, y: 0 },
      { x: 18, y: 0 },
      { x: 18, y: 7 },
      { x: 12, y: 7 },
      { x: 12, y: 16 },
      { x: 6, y: 16 },
      { x: 6, y: 7 },
      { x: 0, y: 7 },
    ];
    const star: Vec2[] = Array.from({ length: 10 }, (_, i) => {
      const a = (i * Math.PI) / 5;
      const r = i % 2 ? 4 : 10;
      return { x: 60 + r * Math.cos(a), y: r * Math.sin(a) };
    });
    expect(footprintShape(L).kind).toBe('rectilinear');
    expect(footprintShape(T).kind).toBe('rectilinear');
    expect(footprintShape(star).kind).toBe('irregular');
    for (const [id, fp] of [
      ['L', L],
      ['T', T],
    ] as const) {
      const b = house(id, fp, 6, { roofShape: 'hipped' });
      const terrain = flat([b]);
      const plan = planOf(terrain, b);
      expect(plan.kind).toBe('hipped');
      expect(plan.rects.length).toBeGreaterThan(1);
      for (let x = 0.25; x < 18; x += 0.5) {
        for (let y = 0.25; y < 16; y += 0.5) {
          if (!pointInPolygon({ x, y }, fp)) continue;
          expect(roofHeightAt(plan, x, y) ?? -1).toBeGreaterThanOrEqual(plan.eaves - 1e-6);
        }
      }
      expectSound(buildingGeometry(terrain));
    }
    const s = house('star', star, 6, { roofShape: 'gabled' });
    const g = buildingGeometry(flat([s]));
    expect(g.stats.roofs.flat).toBe(1);
    // The flat roof covers the concave footprint exactly.
    const roofArea = tris(vertices(g.surfaces).filter(isRoof)).reduce(
      (sum, [a, b, c]) => sum + Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2,
      0,
    );
    let area = 0;
    star.forEach((p, i) => {
      const q = star[(i + 1) % star.length] ?? p;
      area += (p.x * q.y - q.x * p.y) / 2;
    });
    expect(roofArea).toBeCloseTo(area, 3);
  });

  it('handles tiny, huge and degenerate footprints', () => {
    const shed = house('shed', rectangle(0, 0, 2, 1.5), 2.5);
    const hall = house('hall', rectangle(80, 0, 90, 50), 10);
    const sliver = house('sliver', [
      { x: -80, y: 0 },
      { x: -70, y: 0 },
      { x: -75, y: 0.0001 },
    ]);
    const g = buildingGeometry(flat([shed, hall, sliver]));
    expectSound(g);
    expect(g.count).toBe(3);
    // A hall that big is flat-roofed.
    const hallPlan = planOf(flat([hall]), hall);
    expect(hallPlan.kind).toBe('flat');
  });

  it('textures walls at their real scale, never stretched', () => {
    const b = house('w', rectangle(0, 0, 12, 8), 6, { wallMaterial: 'brick' });
    const g = buildingGeometry(flat([b]));
    const brick = WALL_LAYERS.indexOf('brick');
    const walls = tris(vertices(g.surfaces)).filter(([a]) => a.layer === brick);
    expect(walls.length).toBeGreaterThan(0);
    for (const [a, b2, c] of walls) {
      // Texture coordinates change by one tile per tile size of wall, in both directions.
      for (const [p, q] of [
        [a, b2],
        [b2, c],
        [a, c],
      ] as const) {
        const horizontal = Math.hypot(q.x - p.x, q.y - p.y);
        const du = Math.abs(q.u - p.u) * WALL_TILE_M.brick;
        const dv = Math.abs(q.v - p.v) * WALL_TILE_M.brick;
        if (Math.abs(q.z - p.z) < 1e-6) expect(du).toBeCloseTo(horizontal, 3);
        if (horizontal < 1e-6) expect(dv).toBeCloseTo(Math.abs(q.z - p.z), 3);
      }
    }
  });
});

describe('walls on slopes', () => {
  it('reach below the ground, and never put a window or door underground', () => {
    const terrain = roughGround({
      ...NO_FEATURES,
      buildings: [
        house('cliff', rectangle(120, 50, 16, 10), 9),
        house('slope', rectangle(-40, 30, 20, 12, 25), 6, { kind: 'house' }),
      ],
    });
    const g = buildingGeometry(terrain);
    expectSound(g);
    const op = tris(vertices(g.openings));
    expect(op.length).toBeGreaterThan(0);
    for (const t of op) {
      for (const v of t) {
        // Each opening is in front of its wall, above the ground there.
        expect(v.z).toBeGreaterThan(heightAt(terrain, v.x, v.y) - 0.35);
      }
    }
    for (const e of g.entrances)
      expect(e.z).toBeGreaterThanOrEqual(heightAt(terrain, e.x, e.y) - 0.35);
  });
});

describe('windows and doors', () => {
  it('spread windows between clearances at the corners', () => {
    for (const length of [2, 3, 5.5, 9, 14.2, 31]) {
      const c = windowCentres(length, 3, 1);
      for (const x of c) {
        expect(x - 0.5).toBeGreaterThanOrEqual(CORNER_CLEARANCE_M - 1e-9);
        expect(x + 0.5).toBeLessThanOrEqual(length - CORNER_CLEARANCE_M + 1e-9);
      }
      for (let i = 1; i < c.length; i += 1) {
        expect((c[i] ?? 0) - (c[i - 1] ?? 0)).toBeGreaterThanOrEqual(3 - 1e-9);
      }
    }
    expect(windowCentres(2, 3, 1)).toEqual([]);
    expect(windowCentres(3, 3, 1)).toHaveLength(1);
    expect(storeysOf(5.8, 2.9, undefined)).toBe(2);
    expect(storeysOf(4.4, 3, undefined)).toBe(1);
    expect(storeysOf(4.4, 3, 3)).toBe(3);
  });

  it('puts the door on the wall facing the road, and a garage beside it', () => {
    // A road to the north of a house set east–west.
    const road: Road = {
      id: 'street',
      roadClass: 'paved',
      widthMeters: 6,
      centerline: [
        { x: -100, y: 20 },
        { x: 100, y: 20 },
      ],
    };
    const houses = Array.from({ length: 12 }, (_, i) =>
      house(`h${String(i)}`, rectangle(-90 + i * 16, 0, 14, 9), 6, { kind: 'house' }),
    );
    const terrain = {
      ...flat(houses, [road]),
      metadata: { architecture: 'north-american' },
    } as TerrainDataset;
    const g = buildingGeometry(terrain);
    expectSound(g);
    const doors = g.entrances.filter((e) => e.kind === 'door');
    expect(doors).toHaveLength(12);
    for (const d of doors) {
      expect(d.ny).toBeCloseTo(1, 6);
      expect(d.y).toBeCloseTo(4.5, 3);
      expect(d.z).toBeGreaterThanOrEqual(GROUND);
    }
    // Some houses have garages, on the same wall.
    const garages = g.entrances.filter((e) => e.kind === 'garage');
    expect(garages.length).toBeGreaterThan(0);
    for (const e of garages) expect(e.ny).toBeCloseTo(1, 6);
    // No window overlaps a door on the same wall.
    const front = tris(vertices(g.openings)).filter(
      ([a]) => a.ny > 0.99 && Math.abs(a.y - 4.54) < 0.01,
    );
    for (const d of g.entrances) {
      const half = d.kind === 'garage' ? 1.25 : 0.5;
      for (const t of front) {
        if (Math.min(...t.map((v) => v.z)) < d.z + 0.1) continue; // the door itself
        const lo = Math.min(...t.map((v) => v.x));
        const hi = Math.max(...t.map((v) => v.x));
        const low = Math.min(...t.map((v) => v.z));
        if (low > d.z + 2.3) continue; // upstairs
        expect(hi <= d.x - half + 1e-6 || lo >= d.x + half - 1e-6).toBe(true);
      }
    }
  });

  it('gives every storey windows below the eaves, and storeys from the tagged levels', () => {
    const b = house('tall', rectangle(0, 0, 14, 10), 12, { kind: 'apartments', levels: 4 });
    const terrain = flat([b]);
    const g = buildingGeometry(terrain);
    const plan = planOf(terrain, b);
    const op = vertices(g.openings);
    const sills = new Set(op.filter((v) => v.nz === 0).map((v) => Math.round(v.z * 10)));
    expect(sills.size).toBeGreaterThanOrEqual(4);
    for (const v of op) expect(v.z).toBeLessThanOrEqual(plan.top);
    const eaves = plan.kind === 'flat' ? GROUND + 12 : plan.eaves;
    // Wall windows stop short of the eaves (an attic window may sit in a gable above).
    const wallWindows = tris(op).filter(([a]) => a.z < eaves);
    for (const t of wallWindows)
      for (const v of t) expect(v.z).toBeLessThanOrEqual(eaves - 0.3 + 1e-6);
  });
});

describe('determinism and variety', () => {
  const buildings = Array.from({ length: 40 }, (_, i) =>
    house(
      `b${String(i)}`,
      rectangle((i % 8) * 20 - 80, Math.floor(i / 8) * 20 - 50, 11, 8, i * 7),
      6,
    ),
  );
  const terrain = flat(buildings);

  it('looks the same whatever order buildings come in, and on every rebuild', () => {
    const a = buildingGeometry(terrain);
    const b = buildingGeometry({
      ...terrain,
      features: { ...terrain.features, buildings: [...buildings].reverse() },
    });
    const c = buildingGeometry(terrain);
    for (const g of [b, c]) {
      expect(Array.from(g.surfaces.positions)).toEqual(Array.from(a.surfaces.positions));
      expect(Array.from(g.surfaces.colors)).toEqual(Array.from(a.surfaces.colors));
      expect(Array.from(g.surfaces.layers)).toEqual(Array.from(a.surfaces.layers));
      expect(Array.from(g.openings.uvs)).toEqual(Array.from(a.openings.uvs));
      expect(g.entrances).toEqual(a.entrances);
    }
  });

  it('varies roofs, materials and colours between buildings', () => {
    const designs = [...designBuildings(terrain).values()];
    expect(new Set(designs.map((d) => d.style.roof)).size).toBeGreaterThan(1);
    expect(new Set(designs.map((d) => d.style.wallTint)).size).toBeGreaterThan(3);
    expect(new Set(designs.map((d) => d.style.roofTint)).size).toBeGreaterThan(2);
    // Trim is untextured.
    expect(Array.from(buildingGeometry(terrain).surfaces.layers)).toContain(TRIM_LAYER);
  });

  it("follows the battlefield's region", () => {
    const us = designBuildings({
      ...terrain,
      metadata: { architecture: 'north-american' },
    } as TerrainDataset);
    const de = designBuildings({
      ...terrain,
      metadata: { architecture: 'central-european' },
    } as TerrainDataset);
    const layers = (m: typeof us) => new Set([...m.values()].map((d) => d.style.roofLayer));
    expect(layers(us).has('shingles')).toBe(true);
    expect(layers(de).has('shingles')).toBe(false);
    expect([...layers(de)].some((l) => l === 'clay' || l === 'tiles')).toBe(true);
  });
});

describe('buildings standing in water (docs/adr/0046)', () => {
  const b = house('canal-house', [
    { x: 0, y: 0 },
    { x: 12, y: 0 },
    { x: 12, y: 10 },
    { x: 0, y: 10 },
  ]);
  const lowest = (g: BuildingGeometry) => Math.min(...vertices(g.surfaces).map((v) => v.z));

  it('reach below the water where they stand in it, and nowhere else', () => {
    const terrain = flat([b]);
    const dry = buildingGeometry(terrain);
    // The front wall (y = 0) stands at the edge of water 2 m below the ground.
    const level = GROUND - 2;
    const wet = buildingGeometry(terrain, {
      waterLevelNear: (_x, y) => (y < 1 ? level : null),
    });
    expect(lowest(wet)).toBeCloseTo(level - WATER_FOOTING_M, 5);
    expect(lowest(dry)).toBeGreaterThan(level);
    // Nothing else about the building moves.
    const top = (g: BuildingGeometry) => Math.max(...vertices(g.surfaces).map((v) => v.z));
    expect(top(wet)).toBe(top(dry));
    expect(wet.surfaces.triangleCount).toBe(dry.surfaces.triangleCount);
  });
});
