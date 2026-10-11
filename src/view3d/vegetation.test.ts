import { describe, expect, it } from 'vitest';
import {
  fingerprintWorld,
  heightAt,
  lineOfSight,
  pointInPolygon,
  rectangle,
  shareTerrain,
  type EnvironmentFeatures,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import {
  BUILDING_CLEARANCE_M,
  BUILDING_CROWN_SHARE,
  ROAD_CLEARANCE_M,
  WATER_CLEARANCE_M,
} from './exclusion';
import { LOD_LEVELS, PLANTS, PLANTS_BY_KIND, plantModels } from './plant-models';
import { detectQuality, isSoftwareRenderer, QUALITY_PRESETS } from './quality';
import { VERGE_M } from './road-geometry';
import { distanceToLine, roughGround } from './test-helpers';
import { createVegetationLayer } from './vegetation-layer';
import { keepFraction, lodBand, selectVegetation, type LodTarget } from './vegetation-lod';
import { placeVegetation, type VegetationInstances } from './vegetation-placement';

// Procedural vegetation (docs/adr/0031): where plants stand, how they look,
// and what is drawn.

const square = (cx: number, cy: number, half: number): Vec2[] => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half },
];

const wood = [
  { x: -260, y: -250 },
  { x: 60, y: -260 },
  { x: 90, y: 40 },
  { x: -40, y: 120 },
  { x: -270, y: 60 },
];
const clearing = square(-150, -100, 30);
const features: EnvironmentFeatures = {
  roads: [
    {
      id: 'r1',
      roadClass: 'paved',
      widthMeters: 6,
      centerline: [
        { x: -290, y: -40 },
        { x: 0, y: -60 },
        { x: 280, y: -20 },
      ],
    },
    {
      id: 'r2',
      roadClass: 'track',
      widthMeters: 3,
      centerline: [
        { x: -100, y: -280 },
        { x: -60, y: 200 },
      ],
    },
  ],
  buildings: [{ id: 'b1', footprint: rectangle(-200, 20, 16, 12), heightMeters: 8 }],
  vegetation: [
    {
      id: 'wood',
      kind: 'woodland',
      boundary: wood,
      holes: [clearing],
      canopyHeightMeters: 15,
      seeThroughMeters: 25,
    },
    {
      id: 'scrub',
      kind: 'scrub',
      boundary: square(200, 200, 60),
      canopyHeightMeters: 2.5,
      seeThroughMeters: 40,
    },
    {
      id: 'row',
      kind: 'treeLine',
      boundary: [
        { x: 150, y: 80 },
        { x: 290, y: 83 },
        { x: 290, y: 89 },
        { x: 150, y: 86 },
      ],
      canopyHeightMeters: 10,
      seeThroughMeters: 20,
    },
    {
      id: 'hedge',
      kind: 'treeLine',
      boundary: [
        { x: 100, y: -200 },
        { x: 260, y: -200 },
        { x: 260, y: -198 },
        { x: 100, y: -198 },
      ],
      canopyHeightMeters: 2,
      seeThroughMeters: 3,
    },
  ],
  water: [{ id: 'pond', kind: 'water', boundary: square(-60, -180, 25) }],
  waterways: [
    {
      id: 'brook',
      kind: 'stream',
      widthMeters: 2,
      centerline: [
        { x: -280, y: 100 },
        { x: -150, y: 60 },
      ],
    },
  ],
  landUse: [],
};
const terrain = roughGround(features);
const placed = placeVegetation(terrain);
const inst = placed.instances;

interface Plant {
  i: number;
  x: number;
  y: number;
  z: number;
  plant: number;
  kind: string;
  crown: number;
  height: number;
}
function plants(v: VegetationInstances): Plant[] {
  return Array.from({ length: v.count }, (_, i) => {
    const p = v.plant[i] ?? 0;
    const spec = PLANTS[p];
    return {
      i,
      x: v.position[i * 3] ?? 0,
      y: v.position[i * 3 + 1] ?? 0,
      z: v.position[i * 3 + 2] ?? 0,
      plant: p,
      kind: spec?.kind ?? '',
      crown: (v.scale[i * 2] ?? 1) * (spec?.crown ?? 1),
      height: (v.scale[i * 2 + 1] ?? 1) * (spec?.height ?? 1),
    };
  });
}
const all = plants(inst);
const isShrub = (p: Plant) => p.kind === 'shrub';

function arrays(v: VegetationInstances) {
  return [v.plant, v.position, v.yaw, v.scale, v.tint, v.rank, v.tiles.starts].map((a) =>
    Array.from(a),
  );
}

describe('placeVegetation', () => {
  it('plants trees and shrubs, deterministically', () => {
    expect(placed.stats.trees).toBeGreaterThan(500);
    expect(placed.stats.shrubs).toBeGreaterThan(300);
    expect(arrays(placeVegetation(terrain).instances)).toEqual(arrays(inst));
  });

  it('does not depend on the order the features were loaded in', () => {
    const reordered: TerrainDataset = roughGround({
      ...features,
      roads: [...features.roads].reverse(),
      vegetation: [...features.vegetation].reverse(),
    });
    expect(arrays(placeVegetation(reordered).instances)).toEqual(arrays(inst));
  });

  it('puts every plant inside a vegetation area of its kind, outside its holes', () => {
    const area = (id: string) => features.vegetation.find((v) => v.id === id);
    for (const p of all) {
      const at = { x: p.x, y: p.y };
      const inWood = pointInPolygon(at, wood) && !pointInPolygon(at, clearing);
      const inRow = pointInPolygon(at, area('row')?.boundary ?? []);
      const inScrub = pointInPolygon(at, area('scrub')?.boundary ?? []);
      const inHedge = pointInPolygon(at, area('hedge')?.boundary ?? []);
      if (isShrub(p))
        expect(inScrub || inHedge, `shrub at ${String(p.x)}, ${String(p.y)}`).toBe(true);
      else expect(inWood || inRow, `tree at ${String(p.x)}, ${String(p.y)}`).toBe(true);
    }
    // The clearing is open.
    expect(all.some((p) => pointInPolygon(p, clearing))).toBe(false);
  });

  it('keeps plants off roads and verges, away from buildings, and out of water', () => {
    for (const p of all) {
      for (const road of features.roads) {
        const half = road.widthMeters / 2 + (road.roadClass === 'paved' ? VERGE_M : 0);
        expect(distanceToLine(p.x, p.y, road.centerline)).toBeGreaterThanOrEqual(
          half + ROAD_CLEARANCE_M - 1e-6,
        );
      }
      const b = features.buildings[0]?.footprint ?? [];
      expect(pointInPolygon(p, b)).toBe(false);
      expect(distanceToLine(p.x, p.y, [...b, b[0] ?? { x: 0, y: 0 }])).toBeGreaterThanOrEqual(
        BUILDING_CLEARANCE_M + BUILDING_CROWN_SHARE * Math.min(p.crown, 8) - 1e-6,
      );
      const pond = features.water?.[0]?.boundary ?? [];
      expect(pointInPolygon(p, pond)).toBe(false);
      expect(distanceToLine(p.x, p.y, [...pond, pond[0] ?? { x: 0, y: 0 }])).toBeGreaterThanOrEqual(
        WATER_CLEARANCE_M - 1e-6,
      );
      expect(
        distanceToLine(p.x, p.y, features.waterways?.[0]?.centerline ?? []),
      ).toBeGreaterThanOrEqual(1 + WATER_CLEARANCE_M - 1e-6);
    }
    expect(placed.stats.excluded.road).toBeGreaterThan(0);
    expect(placed.stats.excluded.building).toBeGreaterThan(0);
    expect(placed.stats.excluded.water).toBeGreaterThan(0);
  });

  it('stands every plant on the ground', () => {
    for (const p of all) expect(Math.abs(p.z - heightAt(terrain, p.x, p.y))).toBeLessThan(1e-3);
  });

  it('sizes plants from the canopy height, with varied species, sizes and turns', () => {
    const trees = all.filter((p) => pointInPolygon(p, wood));
    const main = trees.filter((p) => ['broadleaf', 'conifer', 'pine'].includes(p.kind));
    // Crown tops of the main trees about the canopy height (±25 %).
    const within = main.filter((p) => p.height >= 0.75 * 15 && p.height <= 1.25 * 15);
    expect(within.length / main.length).toBeGreaterThan(0.95);
    expect(Math.max(...trees.map((p) => p.height))).toBeLessThanOrEqual(1.22 * 15 + 1e-6);
    // Several species and sizes, every orientation.
    expect(new Set(trees.map((p) => p.plant)).size).toBeGreaterThanOrEqual(4);
    const heights = main.map((p) => p.height);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(2);
    const yaws = Array.from(inst.yaw);
    expect(Math.min(...yaws)).toBeLessThan(0.5);
    expect(Math.max(...yaws)).toBeGreaterThan(5.5);
    // Shrubs are low: the scrub's canopy, not trees.
    for (const p of all.filter(isShrub)) expect(p.height).toBeLessThanOrEqual(2.5 + 1e-6);
    // Spaced: no two trees closer than the minimum spacing.
    const t = all.filter((p) => !isShrub(p));
    let closest = Infinity;
    for (let a = 0; a < t.length; a += 1) {
      for (let b = a + 1; b < t.length; b += 1) {
        const pa = t[a];
        const pb = t[b];
        if (pa && pb) closest = Math.min(closest, Math.hypot(pa.x - pb.x, pa.y - pb.y));
      }
    }
    expect(closest).toBeGreaterThan(3.5);
  });

  it('plants tree lines along their strip, and hedges with shrubs', () => {
    const row = all.filter((p) => p.x >= 150 && p.y > 78 && p.y < 91);
    expect(row.length).toBeGreaterThan(12);
    expect(row.every((p) => !isShrub(p))).toBe(true);
    const xs = row.map((p) => p.x).sort((a, b) => a - b);
    for (let k = 1; k < xs.length; k += 1) expect((xs[k] ?? 0) - (xs[k - 1] ?? 0)).toBeLessThan(16);
    expect((xs[0] ?? 0) - 150).toBeLessThan(10);
    expect(290 - (xs[xs.length - 1] ?? 0)).toBeLessThan(10);
    const hedge = all.filter((p) => p.y > -201 && p.y < -197 && p.x >= 100);
    expect(hedge.length).toBeGreaterThan(60);
    expect(hedge.every(isShrub)).toBe(true);
  });

  it('caps the number of plants, keeping a deterministic subset', () => {
    const capped = placeVegetation(terrain, { maxInstances: 200 });
    expect(capped.instances.count).toBe(200);
    expect(capped.stats.capped).toBe(true);
    expect(arrays(placeVegetation(terrain, { maxInstances: 200 }).instances)).toEqual(
      arrays(capped.instances),
    );
  });

  it('indexes plants by model, tile and rank, with tile height bounds', () => {
    const { tiles } = inst;
    const tileCount = tiles.columns * tiles.rows;
    expect(tiles.starts[PLANTS.length * tileCount]).toBe(inst.count);
    for (let p = 0; p < PLANTS.length; p += 1) {
      for (let t = 0; t < tileCount; t += 1) {
        const a = tiles.starts[p * tileCount + t] ?? 0;
        const b = tiles.starts[p * tileCount + t + 1] ?? 0;
        for (let i = a; i < b; i += 1) {
          expect(inst.plant[i]).toBe(p);
          const x = inst.position[i * 3] ?? 0;
          const y = inst.position[i * 3 + 1] ?? 0;
          expect(
            Math.floor((x - tiles.originX) / tiles.size) +
              Math.floor((y - tiles.originY) / tiles.size) * tiles.columns,
          ).toBe(t);
          if (i > a) expect(inst.rank[i]).toBeGreaterThanOrEqual(inst.rank[i - 1] ?? 0);
          expect(inst.position[i * 3 + 2]).toBeGreaterThanOrEqual(tiles.zMin[t] ?? Infinity);
          expect(
            (inst.position[i * 3 + 2] ?? 0) +
              (inst.scale[i * 2 + 1] ?? 0) * (PLANTS[p]?.height ?? 0),
          ).toBeLessThanOrEqual((tiles.zMax[t] ?? -Infinity) + 1e-3);
        }
      }
    }
  });

  it('leaves the simulation unchanged: same world, same line of sight', () => {
    const shared = shareTerrain(terrain);
    const world = { terrain: shared } as unknown as Parameters<typeof fingerprintWorld>[0];
    const before = fingerprintWorld(world);
    const sight = () => lineOfSight(shared, { x: -280, y: -100 }, { x: 60, y: -100 });
    const losBefore = sight();
    placeVegetation(shared); // works on a frozen terrain: it changes nothing
    expect(fingerprintWorld(world)).toBe(before);
    expect(sight()).toEqual(losBefore);
  });
});

describe('plantModels', () => {
  const models = plantModels();

  it('builds every plant at its exact height and crown radius, at every level', () => {
    expect(models.map((m) => m.spec)).toEqual(PLANTS);
    // (Props, docs/adr/0036, are checked below: their far levels drop details.)
    for (const m of models.filter((x) => x.spec.kind !== 'prop')) {
      expect(m.lods).toHaveLength(LOD_LEVELS);
      for (const lod of m.lods) {
        let top = -Infinity;
        let wide = 0;
        let bottom = Infinity;
        for (let i = 0; i < lod.positions.length; i += 3) {
          top = Math.max(top, lod.positions[i + 1] ?? 0);
          bottom = Math.min(bottom, lod.positions[i + 1] ?? 0);
          wide = Math.max(wide, Math.hypot(lod.positions[i] ?? 0, lod.positions[i + 2] ?? 0));
        }
        expect(top).toBeCloseTo(m.spec.height, 4);
        expect(wide).toBeCloseTo(m.spec.crown, 4);
        // Trunks and lower foliage reach below the ground, for slopes.
        expect(bottom).toBeLessThan(0.01);
        expect(lod.colors?.length).toBe(lod.positions.length);
      }
      const [near, medium, far] = m.lods;
      expect(near.triangleCount).toBeGreaterThan(medium.triangleCount);
      expect(medium.triangleCount).toBeGreaterThan(far.triangleCount);
      expect(near.triangleCount).toBeLessThan(500);
    }
  });

  it('builds every prop at its height and reach, simpler with distance', () => {
    const props = models.filter((x) => x.spec.kind === 'prop');
    expect(props.length).toBe(PLANTS_BY_KIND.prop.length);
    for (const m of props) {
      expect(m.lods).toHaveLength(LOD_LEVELS);
      const [near, medium, far] = m.lods;
      let top = -Infinity;
      let wide = 0;
      let bottom = Infinity;
      for (let i = 0; i < near.positions.length; i += 3) {
        top = Math.max(top, near.positions[i + 1] ?? 0);
        bottom = Math.min(bottom, near.positions[i + 1] ?? 0);
        wide = Math.max(wide, Math.hypot(near.positions[i] ?? 0, near.positions[i + 2] ?? 0));
      }
      expect(top).toBeCloseTo(m.spec.height, 4);
      expect(wide).toBeCloseTo(m.spec.crown, 4);
      // Posts and footings reach below the ground, for slopes.
      expect(bottom).toBeLessThan(-0.15);
      for (const lod of m.lods) expect(lod.colors?.length).toBe(lod.positions.length);
      expect(near.triangleCount).toBeGreaterThanOrEqual(medium.triangleCount);
      expect(medium.triangleCount).toBeGreaterThanOrEqual(far.triangleCount);
      expect(near.triangleCount).toBeGreaterThan(far.triangleCount);
      expect(near.triangleCount).toBeLessThan(600);
    }
  });

  it('winds every triangle to face the way its normals point', () => {
    for (const m of models) {
      for (const l of m.lods) {
        const p = l.positions;
        const n = l.normals;
        for (let t = 0; t < l.triangleCount; t += 1) {
          const i = t * 9;
          const ux = (p[i + 3] ?? 0) - (p[i] ?? 0);
          const uy = (p[i + 4] ?? 0) - (p[i + 1] ?? 0);
          const uz = (p[i + 5] ?? 0) - (p[i + 2] ?? 0);
          const vx = (p[i + 6] ?? 0) - (p[i] ?? 0);
          const vy = (p[i + 7] ?? 0) - (p[i + 1] ?? 0);
          const vz = (p[i + 8] ?? 0) - (p[i + 2] ?? 0);
          const g = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
          const s = [0, 1, 2].map(
            (k) => (n[i + k] ?? 0) + (n[i + 3 + k] ?? 0) + (n[i + 6 + k] ?? 0),
          );
          expect(
            (g[0] ?? 0) * (s[0] ?? 0) + (g[1] ?? 0) * (s[1] ?? 0) + (g[2] ?? 0) * (s[2] ?? 0),
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('is the same every time', () => {
    expect(Array.from(plantModels()[0]?.lods[0].positions ?? [])).toEqual(
      Array.from(models[0]?.lods[0].positions ?? []),
    );
  });
});

describe('vegetation levels of detail', () => {
  const s = QUALITY_PRESETS.medium.vegetation;

  it('chooses a band by distance, scaled for small plants', () => {
    expect(lodBand(0, s)).toBe(0);
    expect(lodBand(s.near - 1, s)).toBe(0);
    expect(lodBand(s.near + 1, s)).toBe(1);
    expect(lodBand(s.medium + 1, s)).toBe(2);
    expect(lodBand(s.far + 1, s)).toBe(-1);
    expect(lodBand(s.near * 0.6, s, 0.5)).toBe(1);
  });

  it('thins progressively in the far band', () => {
    expect(keepFraction(s.thinStart - 1, s)).toBe(1);
    expect(keepFraction(s.far, s)).toBeCloseTo(s.minFraction);
    let last = 1;
    for (let d = s.thinStart; d <= s.far; d += 100) {
      const f = keepFraction(d, s);
      expect(f).toBeLessThanOrEqual(last);
      last = f;
    }
  });

  const targets = (capacity = 1e9): LodTarget[][] =>
    PLANTS.map((_, p) =>
      Array.from({ length: LOD_LEVELS }, () => {
        const n = Math.min(capacity, placed.stats.byPlant[p] ?? 0);
        return {
          matrices: new Float32Array(n * 16),
          colors: new Float32Array(n * 3),
          capacity: n,
          count: 0,
        };
      }),
    );
  const total = (t: LodTarget[][]) => t.flat().reduce((sum, x) => sum + x.count, 0);

  it('draws every plant near the camera, at its own position, size and colour', () => {
    const t = targets();
    selectVegetation(
      inst,
      { x: 0, y: 0, z: 1300 },
      { ...s, near: 1e5, medium: 2e5, far: 3e5, thinStart: 3e5 },
      () => true,
      t,
    );
    expect(total(t)).toBe(inst.count);
    // Every written matrix is a plant's: translation (x, z, −y), scale (crown, height).
    const seen = new Set<string>();
    for (let p = 0; p < PLANTS.length; p += 1) {
      const target = t[p]?.[0];
      if (!target) continue;
      for (let k = 0; k < target.count; k += 1) {
        const m = target.matrices;
        seen.add(`${String(m[k * 16 + 12])},${String(-(m[k * 16 + 14] ?? 0))}`);
        expect(Math.hypot(m[k * 16] ?? 0, m[k * 16 + 2] ?? 0)).toBeGreaterThan(0);
        expect(m[k * 16 + 5]).toBeGreaterThan(0);
      }
    }
    for (const p of all.slice(0, 50)) {
      expect(seen.has(`${String(Math.fround(p.x))},${String(Math.fround(p.y))}`)).toBe(true);
    }
  });

  it('skips tiles out of view or out of range, thins the far band and respects capacity', () => {
    const none = targets();
    selectVegetation(inst, { x: 0, y: 0, z: 1300 }, s, () => false, none);
    expect(total(none)).toBe(0);
    const far = targets();
    // Far away above the battlefield: everything in the thinned band.
    const r = selectVegetation(inst, { x: 0, y: 0, z: 1200 + s.far * 0.9 }, s, () => true, far);
    expect(r.tilesDrawn).toBeGreaterThan(0);
    expect(total(far)).toBeGreaterThan(0);
    expect(total(far)).toBeLessThan(inst.count * 0.5);
    expect(
      far
        .flat()
        .filter((_, i) => i % LOD_LEVELS !== 2)
        .every((x) => x.count === 0),
    ).toBe(true);
    const gone = targets();
    selectVegetation(inst, { x: 0, y: 0, z: 1200 + s.far * 3 }, s, () => true, gone);
    expect(total(gone)).toBe(0);
    const small = targets(3);
    selectVegetation(
      inst,
      { x: 0, y: 0, z: 1300 },
      { ...s, near: 1e5, medium: 2e5, far: 3e5, thinStart: 3e5 },
      () => true,
      small,
    );
    for (const x of small.flat()) expect(x.count).toBeLessThanOrEqual(3);
  });
});

describe('quality presets', () => {
  it('detects a level from the GPU', () => {
    expect(detectQuality('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))')).toBe(
      'low',
    );
    expect(detectQuality('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)')).toBe('low');
    expect(detectQuality('Apple M2')).toBe('medium');
    expect(detectQuality('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)')).toBe('high');
    // Software renderers (the terrain then draws its flat ground path, docs/adr/0038).
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))')).toBe(
      true,
    );
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)')).toBe(
      false,
    );
    expect(isSoftwareRenderer(null)).toBe(false);
    expect(detectQuality('ANGLE (AMD, AMD Radeon RX 6700 XT)')).toBe('high');
    expect(detectQuality(null)).toBe('medium');
  });

  it('draws less on lower levels', () => {
    const { low, medium, high } = QUALITY_PRESETS;
    expect(low.vegetation.far).toBeLessThan(medium.vegetation.far);
    expect(medium.vegetation.far).toBeLessThan(high.vegetation.far);
    expect(low.shadows).toBeNull();
  });
});

describe('createVegetationLayer', () => {
  it('shares geometry per model and level, and frees everything on dispose', () => {
    const models = plantModels();
    const layer = createVegetationLayer(models, inst, QUALITY_PRESETS.medium.vegetation, {
      cast: true,
      receive: false,
    });
    const meshes = layer.group.children;
    expect(meshes).toHaveLength(PLANTS.length * LOD_LEVELS);
    let disposed = 0;
    for (const mesh of meshes) {
      const m = mesh as unknown as {
        geometry: { addEventListener: (e: string, f: () => void) => void };
      };
      m.geometry.addEventListener('dispose', () => {
        disposed += 1;
      });
    }
    layer.dispose();
    expect(disposed).toBe(PLANTS.length * LOD_LEVELS);
    expect(layer.group.children).toHaveLength(0);
    expect(PLANTS_BY_KIND.shrub.length).toBeGreaterThan(0);
  });
});
