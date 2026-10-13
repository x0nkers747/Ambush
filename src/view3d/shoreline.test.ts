import { describe, expect, it } from 'vitest';
import {
  computeViewshed,
  createSyntheticTerrain,
  fingerprintPlainData,
  gradeTerrain,
  heightAt,
  lineOfSight,
  planPath,
  viewshedGrid,
  waterLevelAt,
  type Building,
  type EnvironmentFeatures,
  type Vec2,
} from '#sim';
import { buildFeatures } from './geo-features';
import {
  carveShoreField,
  groundCut,
  maskLevel,
  QUAY_CAP_M,
  SHORE_INSET_M,
  SHORE_RANGE_M,
  shoreDistanceAt,
  shoreField,
  shoreline,
  shoreMask,
  shoreWalls,
  WALL_FOOT_M,
  waterLevelNear,
  type ShoreField,
  type WallMesh,
} from './shoreline';
import { triangles, type Tri } from './test-helpers';
import { urbanGrid } from './water-profiles';

// The 3D shoreline (docs/adr/0046): the shore field and mask, the cut of the
// ground standing above the water, and the walls that close it, on a small
// town by the water: an L-shaped canal lined with buildings that stand in it,
// a basin joined to the canal's end, a steep bank, and a natural lake with an
// island.

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const ring = (cx: number, cy: number, r: number, n = 24): Vec2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });

/** The canal: along y −10…10 from x −150 to 60, and an arm north at x 40…60 (sharp corners). */
const CANAL: Vec2[] = [
  { x: -150, y: -10 },
  { x: 60, y: -10 },
  { x: 60, y: 120 },
  { x: 40, y: 120 },
  { x: 40, y: 10 },
  { x: -150, y: 10 },
];
/** Canal houses along its north side, each standing 3 m into the water. */
const HOUSES: Building[] = Array.from({ length: 6 }, (_, k) => ({
  id: `house-${String(k)}`,
  footprint: rect(-140 + 20 * k, 7, -126 + 20 * k, 20),
  heightMeters: 12,
}));

const features: EnvironmentFeatures = {
  // A road on an embankment along the lake's east shore, reaching into it.
  roads: [
    {
      id: 'lake-road',
      roadClass: 'paved',
      centerline: [
        { x: -12, y: -175 },
        { x: -12, y: -65 },
      ],
      widthMeters: 8,
    },
  ],
  buildings: HOUSES,
  vegetation: [],
  water: [
    // Mapped as plain water, as Amsterdam's canals are: standing, levelled.
    { id: 'canal', kind: 'water', waterClass: 'other', boundary: CANAL },
    // Joined to the canal's west end: one water with it.
    { id: 'basin', kind: 'water', waterClass: 'basin', boundary: rect(-190, -10, -150, 10) },
    {
      id: 'lake',
      kind: 'water',
      waterClass: 'lake',
      boundary: ring(-60, -120, 45),
      holes: [ring(-60, -120, 10, 12)],
    },
  ],
  waterways: [],
  landUse: [],
};
const source = createSyntheticTerrain(
  { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
  // Level, with the houses on a quay raised 1.2 m along the canal (reaching
  // into it, as the elevation data does), and a steep bank east of its arm.
  (x, y) =>
    3 +
    (x > -146 && x < -22 && y > 4 && y < 26 ? 1.2 : 0) +
    (x > 60 && y > 20 && y < 110 ? Math.min(5, (x - 60) * 0.9) : 0) +
    // The lake road's embankment.
    (x > -22 && x < -2 && y > -175 && y < -65 ? 1.5 : 0),
  features,
);
const terrain = gradeTerrain(source);
/** The terrain's shore field (it has levelled water). */
function fieldOf(): ShoreField {
  const f = shoreField(terrain);
  if (!f) throw new Error('no levelled water');
  return f;
}
const field = fieldOf();
const urban = urbanGrid(terrain);
const result = shoreline(terrain, shoreField(terrain));
const walls = shoreWalls(terrain, field, urban);
const wallTris = (m: WallMesh) => triangles(m);

/** Distance from (x, y) to the nearest edge of any water ring (outlines and holes). */
function toShore(x: number, y: number): number {
  let best = Infinity;
  const rings = features.water?.flatMap((w) => [w.boundary, ...(w.holes ?? [])]) ?? [];
  for (const r of rings) {
    r.forEach((a, i) => {
      const b = r[(i + 1) % r.length] ?? a;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = dx * dx + dy * dy;
      const t = l > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / l)) : 0;
      best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
    });
  }
  return best;
}

const area = (t: Tri) => {
  const ux = t.b.x - t.a.x;
  const uy = t.b.y - t.a.y;
  const uz = t.b.z - t.a.z;
  const vx = t.c.x - t.a.x;
  const vy = t.c.y - t.a.y;
  const vz = t.c.z - t.a.z;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
};

describe('the shore field (docs/adr/0046)', () => {
  it('is negative in levelled water, positive ashore, and holds the level in the water', () => {
    expect(shoreDistanceAt(field, -50, 0)).toBeCloseTo(-SHORE_RANGE_M, 5);
    expect(shoreDistanceAt(field, -50, 40)).toBeCloseTo(SHORE_RANGE_M, 5);
    // A metre inside the straight south edge, and a metre outside it.
    expect(shoreDistanceAt(field, -50, -9)).toBeCloseTo(-1, 1);
    expect(shoreDistanceAt(field, -50, -11)).toBeCloseTo(1, 1);
    const level = waterLevelAt(terrain, -50, 0) ?? NaN;
    expect(waterLevelNear(field, -50, 0)).toBeCloseTo(level, 4);
    expect(waterLevelNear(field, -50, 40)).toBeNull();
  });

  it('takes joined water areas as one water: no shore between them', () => {
    // On the edge the canal and the basin share, the water goes on.
    expect(shoreDistanceAt(field, -150, 0)).toBeLessThan(-SHORE_RANGE_M + 0.5);
  });

  it('leaves islands ashore', () => {
    expect(shoreDistanceAt(field, -60, -120)).toBeGreaterThan(0);
    expect(shoreDistanceAt(field, -60, -95)).toBeLessThan(0);
  });

  it('is cut where the water sheet is cut away (low decks, roads on a bank)', () => {
    const f = fieldOf();
    expect(groundCut(terrain, f, -127, 8.5)).toBe(true);
    carveShoreField(f, [[-133, 6, -121, 6, -121, 10, -133, 10]]);
    expect(groundCut(terrain, f, -127, 8.5)).toBe(false);
    // Elsewhere unchanged.
    expect(shoreDistanceAt(f, -50, 0)).toBe(shoreDistanceAt(field, -50, 0));
  });
});

describe('the cut', () => {
  it('takes ground standing above the water inside it, never ashore or under the water', () => {
    const level = waterLevelAt(terrain, -50, 0) ?? NaN;
    // A house's pad stands in the canal, above the water.
    expect(heightAt(terrain, -127, 8.5)).toBeGreaterThan(level);
    expect(groundCut(terrain, field, -127, 8.5)).toBe(true);
    // Ashore, and the canal's bed.
    expect(groundCut(terrain, field, -127, 25)).toBe(false);
    expect(heightAt(terrain, -50, 0)).toBeLessThan(level);
    expect(groundCut(terrain, field, -50, 0)).toBe(false);
    expect(result?.stats.cutSamples ?? 0).toBeGreaterThan(0);
  });
});

describe('the shore mask', () => {
  const mask = shoreMask(field, urban);
  const { columns, rows, step, originX, originY } = mask.grid;

  it('encodes the signed distance and the level the shaders read', () => {
    for (const [x, y] of [
      [-50, 0],
      [-50, -9],
      [45, 60],
      [-60, -100],
    ] as const) {
      const c = Math.round((x - originX) / step);
      const r = Math.round((y - originY) / step);
      const i = r * columns + c;
      const d = ((mask.pixels[i * 4] ?? 0) / 255 - 0.5) * 2 * SHORE_RANGE_M;
      expect(Math.abs(d - (field.distance[i] ?? 0))).toBeLessThan(0.02);
      expect(maskLevel(mask, c, r)).toBeCloseTo(field.level[i] ?? NaN, 2);
    }
    expect(mask.pixels.length).toBe(columns * rows * 4);
  });

  it('marks natural shores for shallows, not built-up ones', () => {
    const at = (x: number, y: number) => {
      const c = Math.round((x - originX) / step);
      const r = Math.round((y - originY) / step);
      return mask.pixels[(r * columns + c) * 4 + 3];
    };
    expect(at(-100, 8)).toBe(0); // the canal by the houses
    expect(at(-60, -78)).toBe(255); // the lake
  });
});

describe('the shore walls', () => {
  const quayAll = wallTris(walls.quay);
  /** A triangle's normal (map axes, unit), from its winding. */
  const normalOf = (t: Tri) => {
    const ux = t.b.x - t.a.x;
    const uy = t.b.y - t.a.y;
    const uz = t.b.z - t.a.z;
    const vx = t.c.x - t.a.x;
    const vy = t.c.y - t.a.y;
    const vz = t.c.z - t.a.z;
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0);
    return n.map((v) => v / l) as [number, number, number];
  };
  // A quay is its wall (vertical) and its coping (level, facing up).
  const quay = quayAll.filter((t) => Math.abs(normalOf(t)[2]) < 0.5);
  const coping = quayAll.filter((t) => normalOf(t)[2] > 0.5);
  const bank = wallTris(walls.bank);
  const all = [...quayAll, ...bank];
  const nearHouse = (x: number, y: number, r: number) =>
    HOUSES.some((h) => h.footprint.some((p) => Math.hypot(p.x - x, p.y - y) < r));

  it('are quays on the built-up canal and banks elsewhere', () => {
    expect(quay.length).toBeGreaterThan(0);
    expect(coping.length).toBeGreaterThan(0);
    expect(quay.length + coping.length).toBe(quayAll.length);
    expect(walls.quayMeters).toBeGreaterThan(50);
    // Every quay is by the houses (within the built-up reach of them).
    for (const t of quayAll) expect(nearHouse(t.a.x, t.a.y, 50)).toBe(true);
  });

  it('reach from the street or the ground at the shore down to below the water', () => {
    for (const t of all) {
      const cx = (t.a.x + t.b.x + t.c.x) / 3;
      const cy = (t.a.y + t.b.y + t.c.y) / 3;
      const level = waterLevelNear(field, cx, cy, 3) ?? NaN;
      for (const v of [t.a, t.b, t.c]) {
        expect(v.z).toBeGreaterThanOrEqual(level - WALL_FOOT_M - 1e-3);
      }
    }
    // A bank never stands above the ground; a quay's top is the street behind it.
    for (const t of bank) {
      for (const v of [t.a, t.b, t.c]) {
        expect(v.z).toBeLessThanOrEqual(heightAt(terrain, v.x, v.y) + 0.05);
      }
    }
    for (const t of quay) {
      for (const v of [t.a, t.b, t.c]) {
        // The highest ground within the coping's reach (and a metre either side).
        let street = heightAt(terrain, v.x, v.y);
        const reach = QUAY_CAP_M + 0.5 + 1;
        for (let dx = -reach; dx <= reach; dx += 0.25) {
          for (let dy = -reach; dy <= reach; dy += 0.25) {
            if (Math.hypot(dx, dy) <= reach) {
              street = Math.max(street, heightAt(terrain, v.x + dx, v.y + dy));
            }
          }
        }
        expect(v.z).toBeLessThanOrEqual(street + 0.05);
      }
    }
  });

  it('give a quay a level top over the steep bank, and coping back to the street', () => {
    // Along the raised quay the wall's top is the street's height, 1.2 m up.
    const level = waterLevelAt(terrain, -80, 0) ?? NaN;
    const tops = quay
      .flatMap((t) => [t.a, t.b, t.c])
      .filter((v) => v.x > -130 && v.x < -40 && Math.abs(v.y - 10) < 1 && v.z > level + 0.4);
    expect(tops.length).toBeGreaterThan(4);
    const street = heightAt(terrain, -80, 15);
    for (const v of tops) expect(v.z).toBeCloseTo(street + 0.03, 1);
    // The coping's outer edge meets the ground.
    for (const t of coping) {
      for (const v of [t.a, t.b, t.c]) {
        expect(v.z).toBeGreaterThanOrEqual(heightAt(terrain, v.x, v.y) - 0.05);
      }
    }
  });

  it('follow a straight canal edge in one straight wall', () => {
    // The houses' side of the canal: its north edge, y = 10.
    const tops = quay
      .flatMap((t) => [t.a, t.b, t.c])
      .filter((v) => v.x > -138 && v.x < -30 && Math.abs(v.y - 10) < 1);
    expect(tops.length).toBeGreaterThan(4);
    for (const v of tops) expect(Math.abs(v.y - (10 - SHORE_INSET_M))).toBeLessThan(0.06);
    // Simplified: a few long pieces, not one per mask sample.
    const pieces = quay.filter((t) =>
      [t.a, t.b, t.c].every((v) => v.x > -138 && v.x < -30 && Math.abs(v.y - 10) < 1),
    );
    expect(pieces.length).toBeLessThan(((108 / 4 + 2) * 4) | 0);
  });

  it('give banks a top that follows the ground exactly, across refined cells', () => {
    expect(terrain.refinement).toBeDefined();
    let tops = 0;
    for (const t of bank) {
      for (const v of [t.a, t.b, t.c]) {
        const g = heightAt(terrain, v.x, v.y);
        const level = waterLevelNear(field, v.x, v.y, 3) ?? NaN;
        if (v.z > level + 0.1 && Math.abs(v.z - g) < 0.05) {
          tops += 1;
          expect(v.z - g).toBeGreaterThanOrEqual(-1e-3);
        }
      }
    }
    expect(tops).toBeGreaterThan(0);
  });

  it('stay at the shore: nothing far from a water outline, at sharp corners too', () => {
    for (const t of all) {
      for (const v of [t.a, t.b, t.c]) expect(toShore(v.x, v.y)).toBeLessThan(QUAY_CAP_M + 0.6);
    }
  });

  it('have no NaN, no slivers, no coincident duplicates', () => {
    const seen = new Set<string>();
    for (const t of all) {
      for (const v of [t.a, t.b, t.c]) {
        expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
      }
      expect(area(t)).toBeGreaterThan(1e-5);
      const key = [t.a, t.b, t.c]
        .map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`)
        .sort()
        .join('|');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    for (const m of [walls.quay, walls.bank]) {
      expect(m.uvs.length / 2).toBe(m.positions.length / 3);
      expect(m.colors?.length).toBe(m.positions.length);
      for (const n of m.normals) expect(Number.isFinite(n)).toBe(true);
    }
  });

  it('face the water: front faces wound towards it', () => {
    for (const t of quay) {
      if (Math.abs(normalOf(t)[2]) > 0.5) continue;
      const ux = t.b.x - t.a.x;
      const uy = t.b.y - t.a.y;
      const uz = t.b.z - t.a.z;
      const vx = t.c.x - t.a.x;
      const vy = t.c.y - t.a.y;
      const vz = t.c.z - t.a.z;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const l = Math.hypot(nx, ny);
      if (l < 1e-9) continue;
      const cx = (t.a.x + t.b.x + t.c.x) / 3;
      const cy = (t.a.y + t.b.y + t.c.y) / 3;
      // A step along the face's normal goes into the water.
      expect(shoreDistanceAt(field, cx + (nx / l) * 0.5, cy + (ny / l) * 0.5)).toBeLessThan(
        shoreDistanceAt(field, cx - (nx / l) * 0.5, cy - (ny / l) * 0.5),
      );
    }
  });

  it('are deterministic', () => {
    const again = shoreWalls(terrain, fieldOf(), urban);
    expect(again.quay.positions).toEqual(walls.quay.positions);
    expect(again.bank.positions).toEqual(walls.bank.positions);
    expect(again.quay.normals).toEqual(walls.quay.normals);
  });

  it('leave a natural shore graded down to the water alone', () => {
    // The lake: no quays, and its island's middle has no wall.
    for (const t of all) {
      expect(Math.hypot(t.a.x + 60, t.a.y + 120)).toBeGreaterThan(8);
      if (Math.hypot(t.a.x + 60, t.a.y + 120) < 47) expect(urban.at(t.a.x, t.a.y)).toBe(false);
    }
  });
});

describe('simulation isolation (docs/adr/0046)', () => {
  it('building the 3D shoreline and features changes nothing the simulation reads', () => {
    const fresh = gradeTerrain(source);
    const before = fingerprintPlainData(fresh);
    const heights = [-127, -50, 0, 45].flatMap((x) =>
      [-120, -9, 0, 8.5, 60].map((y) => heightAt(fresh, x, y)),
    );
    const sight = lineOfSight(fresh, { x: -127, y: 30 }, { x: -50, y: -30 });
    const path = planPath(fresh, { x: -100, y: 40 }, { x: 100, y: -60 });
    const grid = viewshedGrid(fresh, 10);
    const view = computeViewshed(fresh, { x: -100, y: 40 }, grid);
    const built = buildFeatures(fresh);
    expect(built.geometry.shore).not.toBeNull();
    expect(fingerprintPlainData(fresh)).toBe(before);
    expect(
      [-127, -50, 0, 45].flatMap((x) => [-120, -9, 0, 8.5, 60].map((y) => heightAt(fresh, x, y))),
    ).toEqual(heights);
    expect(lineOfSight(fresh, { x: -127, y: 30 }, { x: -50, y: -30 })).toEqual(sight);
    expect(planPath(fresh, { x: -100, y: 40 }, { x: 100, y: -60 })).toEqual(path);
    expect(computeViewshed(fresh, { x: -100, y: 40 }, grid)).toEqual(view);
  });
});
