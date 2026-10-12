import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  gradeTerrain,
  heightAt,
  lineOfSight,
  shareTerrain,
  waterLevelAt,
  type EnvironmentFeatures,
  type Road,
  type RoadCrossing,
  type TerrainDataset,
  type WaterArea,
  type Waterway,
} from '#sim';
import {
  APPROACH_M,
  BRIDGE_MIN_WATERWAY_M,
  bridgeGeometry,
  bridgeIndex,
  CLEARANCE_M,
  liftOntoBridges,
  planBridges,
  type Bridge,
} from './bridges';
import { terrainGround } from './camera-math';
import { createDraper } from './drape';
import { buildFeatureGeometry } from './geo-features';
import { roadGeometry } from './road-geometry';
import { triangles } from './test-helpers';

// Decorative bridges (docs/adr/0041): where roads cross water, and only
// there; decks that continue the road; and nothing in the simulation changed.

const GRID = { originX: -300, originY: -300, cellSize: 10, columns: 61, rows: 61 };
/** A river valley along y: banks at 20 m, the river 40 m wide at x ∈ [−20, 20]. */
const valley = (x: number) => (Math.abs(x) < 20 ? 18 : 18 + Math.min(2, 0.2 * (Math.abs(x) - 20)));

const river: WaterArea = {
  id: 'river-area',
  kind: 'water',
  waterClass: 'river',
  boundary: [
    { x: -20, y: -300 },
    { x: 20, y: -300 },
    { x: 20, y: 300 },
    { x: -20, y: 300 },
  ],
};
const riverLine: Waterway = {
  id: 'river',
  kind: 'river',
  centerline: [
    { x: 0, y: 300 },
    { x: 0, y: -300 },
  ],
  widthMeters: 40,
};
const road = (id: string, pts: [number, number][], extra: Partial<Road> = {}): Road => ({
  id,
  roadClass: 'paved',
  widthMeters: 6,
  centerline: pts.map(([x, y]) => ({ x, y })),
  highway: 'tertiary',
  ...extra,
});
const world = (
  f: Partial<EnvironmentFeatures>,
  ground: (x: number, y: number) => number = valley,
) =>
  gradeTerrain(
    createSyntheticTerrain(GRID, ground, {
      roads: [],
      buildings: [],
      vegetation: [],
      water: [river],
      waterways: [riverLine],
      landUse: [],
      ...f,
    }),
  );
const across = road('across', [
  [-150, 0],
  [150, 0],
]);
const bridged = (t: TerrainDataset) => planBridges(t).bridges;
const length = (b: Bridge) => {
  let l = 0;
  for (let i = 2; i < b.xy.length; i += 2) {
    l += Math.hypot((b.xy[i] ?? 0) - (b.xy[i - 2] ?? 0), (b.xy[i + 1] ?? 0) - (b.xy[i - 1] ?? 0));
  }
  return l;
};
const crossing = (kind: RoadCrossing['kind']): Partial<Road> => ({
  crossing: { kind, value: 'yes' },
  ...(kind === 'bridge' ? { bridge: true as const } : {}),
});

describe('crossings', () => {
  it('bridges a road over a river, from bank to bank and a little beyond', () => {
    const [b, ...rest] = bridged(world({ roads: [across] }));
    expect(rest).toHaveLength(0);
    expect(b?.mapped).toBe(false);
    expect(b?.roadIds).toEqual(['across']);
    // 40 m of water, the approaches, perhaps longer ramps.
    const l = b ? length(b) : 0;
    expect(l).toBeGreaterThanOrEqual(40 + 2 * APPROACH_M - 2);
    expect(l).toBeLessThan(40 + 2 * APPROACH_M + 2 * 14 + 2);
  });

  it('bridges a lake crossing and a canal mapped only as a line', () => {
    const lake: WaterArea = {
      id: 'lake',
      kind: 'water',
      waterClass: 'lake',
      boundary: [
        { x: 60, y: 40 },
        { x: 200, y: 40 },
        { x: 200, y: 160 },
        { x: 60, y: 160 },
      ],
    };
    const canal: Waterway = {
      id: 'canal',
      kind: 'canal',
      centerline: [
        { x: -300, y: -150 },
        { x: 300, y: -150 },
      ],
      widthMeters: 8,
    };
    const t = world({
      water: [river, lake],
      waterways: [riverLine, canal],
      roads: [
        road('over-lake', [
          [130, -20],
          [130, 220],
        ]),
        road('over-canal', [
          [-200, -250],
          [-200, -50],
        ]),
      ],
    });
    const ids = bridged(t).map((b) => b.roadIds[0]);
    expect(ids).toContain('over-lake');
    expect(ids).toContain('over-canal');
  });

  it('leaves small creeks alone, unless mapped as a bridge', () => {
    const creek: Waterway = {
      id: 'creek',
      kind: 'stream',
      centerline: [
        { x: -300, y: 150 },
        { x: 300, y: 150 },
      ],
      widthMeters: BRIDGE_MIN_WATERWAY_M - 3,
    };
    const over = (extra: Partial<Road>) =>
      road(
        'lane',
        [
          [-200, 100],
          [-200, 200],
        ],
        extra,
      );
    const plain = world({ water: [], waterways: [creek], roads: [over({})] });
    expect(bridged(plain)).toHaveLength(0);
    const mapped = world({
      water: [],
      waterways: [creek],
      roads: [
        road('lane-a', [
          [-200, 100],
          [-200, 147],
        ]),
        road(
          'lane-bridge',
          [
            [-200, 147],
            [-200, 153],
          ],
          crossing('bridge'),
        ),
        road('lane-b', [
          [-200, 153],
          [-200, 200],
        ]),
      ],
    });
    const [b] = bridged(mapped);
    expect(b?.mapped).toBe(true);
    expect(b?.roadIds).toContain('lane-bridge');
  });

  it('never bridges a road mapped through a ford or a tunnel', () => {
    for (const kind of ['ford', 'tunnel'] as const) {
      const t = world({
        roads: [
          road('w', [
            [-150, 0],
            [-25, 0],
          ]),
          road(
            'x',
            [
              [-25, 0],
              [25, 0],
            ],
            crossing(kind),
          ),
          road('e', [
            [25, 0],
            [150, 0],
          ]),
        ],
      });
      expect(bridged(t)).toHaveLength(0);
      expect(planBridges(t).skipped.map((s) => s.reason)).toContain('mapped as a tunnel or ford');
    }
  });

  it('does not bridge a road along the river or one only touching the water', () => {
    const t = world({
      roads: [
        road('along', [
          [40, -250],
          [40, 250],
        ]),
        road('to-the-shore', [
          [-150, 60],
          [-20.5, 60],
        ]),
      ],
    });
    expect(bridged(t)).toHaveLength(0);
  });

  it('follows a diagonal crossing, longer than the river is wide', () => {
    const [b] = bridged(
      world({
        roads: [
          road('diag', [
            [-150, -150],
            [150, 150],
          ]),
        ],
      }),
    );
    expect(b).toBeDefined();
    const wet = (b?.wet.filter(Boolean).length ?? 0) - 1;
    expect(wet).toBeGreaterThan(40 * Math.SQRT2 - 3);
    expect(wet).toBeLessThan(40 * Math.SQRT2 + 3);
  });

  it('makes one bridge over a river split in two and an island', () => {
    const west: WaterArea = {
      ...river,
      id: 'w',
      boundary: river.boundary.map((p) => ({ x: p.x < 0 ? -20 : -4, y: p.y })),
    };
    const east: WaterArea = {
      ...river,
      id: 'e',
      boundary: river.boundary.map((p) => ({ x: p.x < 0 ? 4 : 20, y: p.y })),
    };
    const t = world({ water: [west, east], waterways: [], roads: [across] });
    expect(bridged(t)).toHaveLength(1);
  });

  it('follows a curved road: the deck is on its centreline', () => {
    const pts: [number, number][] = [];
    for (let a = -0.9; a <= 0.9; a += 0.05) pts.push([150 * Math.sin(a), -150 + 150 * Math.cos(a)]);
    const curve = road('curve', pts);
    const [b] = bridged(world({ roads: [curve] }));
    expect(b).toBeDefined();
    for (let i = 0; i < (b?.xy.length ?? 0); i += 2) {
      const x = b?.xy[i] ?? 0;
      const y = b?.xy[i + 1] ?? 0;
      let d = Infinity;
      for (let k = 1; k < curve.centerline.length; k += 1) {
        const p = curve.centerline[k - 1];
        const q = curve.centerline[k];
        if (!p || !q) continue;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const tt = Math.max(
          0,
          Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / (dx * dx + dy * dy)),
        );
        d = Math.min(d, Math.hypot(x - p.x - tt * dx, y - p.y - tt * dy));
      }
      expect(d).toBeLessThan(0.01);
    }
  });
});

describe('the deck', () => {
  const t = world({ roads: [across] });
  const [b] = bridged(t);

  it('meets the road at both ends and stands clear of the water over it', () => {
    expect(b).toBeDefined();
    if (!b) return;
    const n = b.deck.length - 1;
    expect(b.deck[0]).toBeCloseTo(heightAt(t, b.xy[0] ?? 0, b.xy[1] ?? 0), 6);
    expect(b.deck[n]).toBeCloseTo(heightAt(t, b.xy[2 * n] ?? 0, b.xy[2 * n + 1] ?? 0), 6);
    const level = waterLevelAt(t, 0, 0) ?? NaN;
    expect(b.deck[Math.round(n / 2)]).toBeGreaterThanOrEqual(level + CLEARANCE_M - 1e-6);
    expect(b.lowClearance).toBe(false);
    // No steps: the deck rises and falls gently.
    for (let k = 1; k <= n; k += 1) {
      expect(Math.abs((b.deck[k] ?? 0) - (b.deck[k - 1] ?? 0))).toBeLessThan(0.12);
    }
  });

  it('is as wide as the road and its verges, with barriers and supports in reach', () => {
    if (!b) return;
    expect(b.halfWidth).toBeGreaterThan(3);
    expect(b.halfWidth).toBeLessThan(3 + 1.6);
    const g = bridgeGeometry([b], (x, y) => heightAt(t, x, y));
    expect(g.mesh.triangleCount).toBeGreaterThan(100);
    // A 48 m bridge over a 40 m river: one pier for a rural road.
    expect(g.piers).toBe(1);
    for (const tri of triangles(g.mesh)) {
      for (const v of [tri.a, tri.b, tri.c]) {
        expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
        expect(Math.abs(v.y)).toBeLessThanOrEqual(b.halfWidth + 0.7);
      }
      // No degenerate triangles (in 3D: walls stand vertical).
      const ux = tri.b.x - tri.a.x;
      const uy = tri.b.y - tri.a.y;
      const uz = tri.b.z - tri.a.z;
      const wx = tri.c.x - tri.a.x;
      const wy = tri.c.y - tri.a.y;
      const wz = tri.c.z - tri.a.z;
      expect(Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx)).toBeGreaterThan(
        1e-6,
      );
    }
  });

  it('lifts the road surface onto the deck: no second road surface under it', () => {
    if (!b) return;
    const draper = createDraper(t);
    const surfaces = roadGeometry(t.features.roads, draper);
    const paved = surfaces.get('paved');
    expect(paved).toBeDefined();
    if (!paved) return;
    const index = bridgeIndex([b]);
    const lifted = liftOntoBridges(paved, index, (x, y) => heightAt(t, x, y));
    const level = waterLevelAt(t, 0, 0) ?? NaN;
    let over = 0;
    for (const tri of triangles(lifted)) {
      const cx = (tri.a.x + tri.b.x + tri.c.x) / 3;
      if (Math.abs(cx) > 10) continue;
      over += 1;
      // Every piece of road over the river is on the deck, none on the bed.
      for (const v of [tri.a, tri.b, tri.c]) expect(v.z).toBeGreaterThan(level + CLEARANCE_M - 0.2);
    }
    expect(over).toBeGreaterThan(4);
    // Away from the bridge the road is as draped.
    const far = triangles(lifted).filter(
      (tri) => tri.a.x < -100 && tri.b.x < -100 && tri.c.x < -100,
    );
    for (const tri of far) expect(tri.a.z).toBeCloseTo(heightAt(t, tri.a.x, tri.a.y) + 0.08, 4);
  });

  it('is deterministic, whatever order the features come in', () => {
    const other = world({
      roads: [
        road('z-other', [
          [-150, 80],
          [150, 80],
        ]),
        across,
      ],
    });
    const reversed: TerrainDataset = {
      ...other,
      features: { ...other.features, roads: [...other.features.roads].reverse() },
    };
    expect(planBridges(reversed)).toEqual(planBridges(other));
    const a = bridgeGeometry(planBridges(other).bridges, (x, y) => heightAt(other, x, y));
    const c = bridgeGeometry(planBridges(reversed).bridges, (x, y) => heightAt(other, x, y));
    expect(Array.from(c.mesh.positions)).toEqual(Array.from(a.mesh.positions));
  });
});

describe('decoration only', () => {
  it('changes nothing the simulation uses, and is part of the feature geometry', () => {
    const t = shareTerrain(world({ roads: [across] }));
    const before = JSON.stringify(t);
    const los = lineOfSight(t, { x: -100, y: -40 }, { x: 100, y: 40 });
    const f = buildFeatureGeometry(t);
    expect(f.stats.bridges.count).toBe(1);
    expect(f.bridges.triangleCount).toBe(f.stats.bridges.triangles);
    expect(JSON.stringify(t)).toBe(before);
    expect(lineOfSight(t, { x: -100, y: -40 }, { x: 100, y: 40 })).toEqual(los);
    // Picking goes by the ground (and water), never the bridge: beside the road, the river's surface;
    // on it, the ground as graded (ADR 0040), not the deck above.
    expect(terrainGround(t)(0, -30)).toBe(waterLevelAt(t, 0, 30));
    expect(terrainGround(t)(0, 0)).toBe(
      Math.max(heightAt(t, 0, 0), waterLevelAt(t, 0, 0) ?? -Infinity),
    );
    expect(terrainGround(t)(0, 0)).toBeLessThan(
      (f.stats.bridges.count > 0 ? (planBridges(t).bridges[0]?.deck[24] ?? 0) : 0) - 0.3,
    );
  });

  it('lifts road markings onto the deck, their dashes unchanged in plan', () => {
    const t = world({
      roads: [
        road(
          'marked',
          [
            [-150, 0],
            [150, 0],
          ],
          { highway: 'secondary', roadClass: 'major', widthMeters: 8 },
        ),
      ],
    });
    const f = buildFeatureGeometry(t);
    const level = waterLevelAt(t, 0, 0) ?? NaN;
    const over = triangles(f.markings).filter((tri) => Math.abs(tri.a.x) < 10);
    expect(over.length).toBeGreaterThan(0);
    for (const tri of over) expect(tri.a.z).toBeGreaterThan(level + CLEARANCE_M - 0.2);
    expect(f.stats.bridges.count).toBe(1);
  });
});
