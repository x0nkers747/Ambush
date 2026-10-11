import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  flatElevation,
  heightAt,
  NO_FEATURES,
  pointInPolygon,
  rectangle,
  type Building,
  type DecorFeatures,
  type EnvironmentFeatures,
  type Road,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import { buildingGeometry } from './building-geometry';
import { roadEdge } from './decor-context';
import { DECOR_VERSION, planDecor, type DecorPlan } from './decor-plan';
import { roundCorners } from './decor-paths';
import { DecorSpace } from './decor-space';
import { buildFeatures, createGeoFeatures } from './geo-features';
import { PLANTS, plantModels } from './plant-models';
import { placeVegetation } from './vegetation-placement';

// Roadside and settlement details (docs/adr/0036).

const GROUND = 50;
type Arch = 'north-american' | 'central-european';

function world(
  features: Partial<EnvironmentFeatures>,
  options: { arch?: Arch; decor?: DecorFeatures; ground?: (x: number, y: number) => number } = {},
): TerrainDataset {
  const t = createSyntheticTerrain(
    { originX: -300, originY: -300, cellSize: 10, columns: 61, rows: 61 },
    options.ground ?? flatElevation(GROUND),
    { ...NO_FEATURES, ...features },
  );
  return {
    ...t,
    metadata: {
      elevationResolutionM: null,
      surfaceModel: 'unknown',
      architecture: options.arch ?? 'north-american',
    },
    ...(options.decor ? { decor: options.decor } : {}),
  };
}

function plan(terrain: TerrainDataset): DecorPlan {
  const b = buildingGeometry(terrain);
  return planDecor(terrain, b.designs, b.entrances);
}

const road = (id: string, pts: [number, number][], extra: Partial<Road> = {}): Road => ({
  id,
  roadClass: 'paved',
  widthMeters: 6,
  centerline: pts.map(([x, y]) => ({ x, y })),
  highway: 'residential',
  ...extra,
});
const house = (id: string, cx: number, cy: number, w = 12, d = 9): Building => ({
  id,
  footprint: rectangle(cx, cy, w, d),
  heightMeters: 6,
  appearance: { kind: 'house' },
});

/** A street along y = 0 with a row of houses 22 m north of it, facing it. */
function street(n = 10, extra: Partial<EnvironmentFeatures> = {}, arch: Arch = 'north-american') {
  const buildings = Array.from({ length: n }, (_, i) => house(`h${String(i)}`, -150 + i * 30, 22));
  return world(
    {
      roads: [
        road('main', [
          [-250, 0],
          [250, 0],
        ]),
      ],
      buildings,
      landUse: [{ id: 'town', kind: 'residential', boundary: rectangle(0, 0, 560, 560) }],
      ...extra,
    },
    { arch },
  );
}

const PROP = (name: string) => PLANTS.findIndex((p) => p.prop === name);
const isProp = (plant: number, names: string[]) => names.some((n) => PROP(n) === plant);
const distToSegment = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
const distToLine = (p: Vec2, pts: readonly Vec2[]) =>
  Math.min(...pts.slice(1).map((b, i) => distToSegment(p, pts[i] ?? b, b)));
const samplesOf = (pts: readonly Vec2[], step = 0.5) =>
  pts.slice(1).flatMap((b, i) => {
    const a = pts[i] ?? b;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    return Array.from({ length: n + 1 }, (_, k) => ({
      x: a.x + ((b.x - a.x) * k) / n,
      y: a.y + ((b.y - a.y) * k) / n,
    }));
  });

describe('paths and driveways', () => {
  it('joins each house door to the road it faces', () => {
    const terrain = street(6);
    const p = plan(terrain);
    const b = buildingGeometry(terrain);
    const walks = p.paths.filter((x) => x.kind === 'walk');
    expect(walks.length).toBe(6);
    for (const w of walks) {
      const door = b.entrances.find((e) => e.buildingId === w.buildingId && e.kind === 'door');
      expect(door).toBeDefined();
      const start = w.points[0];
      const end = w.points[w.points.length - 1];
      // From just outside the door, on the road-facing wall, to the road's centreline.
      expect(door?.ny).toBeCloseTo(-1, 6);
      expect(
        Math.hypot((start?.x ?? 0) - (door?.x ?? 0), (start?.y ?? 0) - (door?.y ?? 0)),
      ).toBeLessThan(0.5);
      expect(Math.abs(end?.y ?? 1)).toBeLessThan(1e-6);
      expect(w.style).toBe('walkConcrete');
    }
    // Garages get driveways, and walkways may end on them.
    const drives = p.paths.filter((x) => x.kind === 'drive');
    expect(drives.length).toBe(b.entrances.filter((e) => e.kind === 'garage').length);
  });

  it('leaves buildings with mapped access to the mapped way', () => {
    const terrain = street(6);
    const b = buildingGeometry(terrain);
    const door = b.entrances.find((e) => e.buildingId === 'h2' && e.kind === 'door');
    if (!door) throw new Error('no door');
    const mapped = road(
      'drive',
      [
        [door.x, door.y - 0.5],
        [door.x, 0],
      ],
      {
        roadClass: 'paved',
        widthMeters: 3,
        highway: 'service',
        service: 'driveway',
      },
    );
    const withMapped = world({ ...terrain.features, roads: [...terrain.features.roads, mapped] });
    const p = plan(withMapped);
    expect(p.paths.some((x) => x.buildingId === 'h2' && x.kind === 'walk')).toBe(false);
    expect(p.stats.paths.mappedAccess).toBeGreaterThan(0);
    expect(p.paths.some((x) => x.buildingId === 'h3' && x.kind === 'walk')).toBe(true);
  });

  it('never runs through buildings or water, and gives up rather than force a route', () => {
    // A shed right in front of h1's door, a pond in front of h3's, a cliff in front of h5's.
    const terrain = street(6, {
      buildings: [
        ...Array.from({ length: 6 }, (_, i) => house(`h${String(i)}`, -150 + i * 30, 22)),
        {
          id: 'shed',
          footprint: rectangle(-120, 11, 14, 4),
          heightMeters: 3,
          appearance: { kind: 'shed' },
        },
      ],
      water: [{ id: 'pond', kind: 'water', boundary: rectangle(-60, 10, 16, 8) }],
    });
    const p = plan(terrain);
    for (const path of p.paths) {
      for (const q of samplesOf(path.points)) {
        for (const b of terrain.features.buildings) {
          if (b.id !== path.buildingId) expect(pointInPolygon(q, b.footprint)).toBe(false);
        }
        expect(pointInPolygon(q, rectangle(-60, 10, 16, 8))).toBe(false);
      }
    }
    expect(p.stats.paths.refused).toBeGreaterThan(0);
  });

  it('refuses routes up steep banks', () => {
    // The ground rises 6 m in the 4 m between the road and the houses.
    const bank = (_x: number, y: number) => GROUND + (y > 4 ? Math.min(6, (y - 4) * 1.5) : 0);
    const flatStreet = street(4);
    const steep = world(flatStreet.features, { ground: bank });
    const p = plan(steep);
    expect(p.paths.filter((x) => x.kind === 'walk')).toHaveLength(0);
    expect(p.stats.paths.reasons['slope']).toBeGreaterThan(0);
  });

  it('copes with buildings without entrances, or too far from any road', () => {
    const terrain = world({
      roads: [
        road('main', [
          [-250, 0],
          [250, 0],
        ]),
      ],
      buildings: [
        house('far', 0, 200),
        { id: 'tiny', footprint: rectangle(50, 20, 1.5, 1.5), heightMeters: 2 },
      ],
    });
    const p = plan(terrain);
    expect(p.paths).toHaveLength(0);
  });

  it('rounds corners without sharp kinks', () => {
    const r = roundCorners(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ],
      2,
    );
    expect(r.length).toBeGreaterThan(3);
    for (let i = 1; i + 1 < r.length; i += 1) {
      const a = r[i - 1];
      const b = r[i];
      const c = r[i + 1];
      if (!a || !b || !c) continue;
      const turn = Math.abs(
        Math.atan2(
          (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x),
          (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y),
        ),
      );
      expect(turn).toBeLessThan(Math.PI / 4);
    }
  });
});

describe('roadside trees', () => {
  // Rural roads (few buildings) with patches of trees, and a wood beside one.
  const rural = world(
    {
      roads: [
        road('a', [
          [-280, -100],
          [280, -100],
        ]),
        road('b', [
          [-280, 100],
          [280, 100],
        ]),
        road(
          'drive',
          [
            [0, -100],
            [0, -140],
          ],
          { widthMeters: 3, highway: 'service', service: 'driveway' },
        ),
      ],
      buildings: [house('farm', 60, -120)],
      vegetation: [
        {
          id: 'wood',
          kind: 'woodland',
          boundary: rectangle(150, 140, 200, 60),
          canopyHeightMeters: 15,
          seeThroughMeters: 25,
        },
      ],
      water: [{ id: 'pond', kind: 'water', boundary: rectangle(-150, -80, 30, 20) }],
    },
    {
      arch: 'central-european',
      decor: {
        points: [
          { id: 'osm-n1', kind: 'tree', position: { x: 160, y: 140 } }, // in the wood: drawn by it
          { id: 'osm-n2', kind: 'tree', position: { x: -50, y: 60 }, leafType: 'needleleaved' },
        ],
        lines: [],
      },
    },
  );
  const p = plan(rural);
  const trees = p.instances.filter(
    (i) => (PLANTS[i.plant]?.kind ?? 'prop') !== 'prop' && PLANTS[i.plant]?.kind !== 'shrub',
  );

  it('grows some, never on the road, in water, in a wood or on a driveway', () => {
    expect(trees.length).toBeGreaterThan(5);
    for (const t of trees) {
      for (const r of rural.features.roads) {
        expect(distToLine(t, r.centerline)).toBeGreaterThan(r.widthMeters / 2 + 1);
      }
      expect(pointInPolygon(t, rectangle(-150, -80, 30, 20))).toBe(false);
      expect(pointInPolygon(t, rectangle(150, 140, 200, 60))).toBe(false);
    }
    // The mapped tree in the wood is not doubled; the other is planted, as a conifer.
    expect(p.stats.counts['tree:mapped']).toBe(1);
    expect(
      trees.some(
        (t) => Math.hypot(t.x + 50, t.y - 60) < 1e-6 && PLANTS[t.plant]?.kind === 'conifer',
      ),
    ).toBe(true);
  });

  it('keeps clear of buildings and of the wood edge', () => {
    for (const t of trees) {
      for (const b of rural.features.buildings) expect(pointInPolygon(t, b.footprint)).toBe(false);
    }
    // Nothing planted along the road beside the wood: the wood dominates there.
    const besideWood = trees.filter((t) => t.x > 60 && t.x < 240 && Math.abs(t.y - 100) < 15);
    expect(besideWood).toHaveLength(0);
  });

  it('varies in species, size and spacing', () => {
    expect(new Set(trees.map((t) => t.plant)).size).toBeGreaterThan(1);
    expect(new Set(trees.map((t) => t.scaleH.toFixed(2))).size).toBeGreaterThan(3);
    const ys = trees.filter((t) => Math.abs(t.y + 100) < 15).map((t) => Math.abs(t.y + 100));
    expect(new Set(ys.map((y) => y.toFixed(1))).size).toBeGreaterThan(1);
  });
});

describe('street lamps', () => {
  it('stand along built-up streets, spaced, off the road, away from junctions and buildings', () => {
    const terrain = street(14, {
      roads: [
        road('main', [
          [-250, 0],
          [250, 0],
        ]),
        road('side', [
          [0, 0],
          [0, -200],
        ]),
      ],
    });
    const p = plan(terrain);
    const lamps = p.instances.filter((i) =>
      isProp(i.plant, ['lampResidential', 'lampModern', 'lampVillage']),
    );
    expect(lamps.length).toBeGreaterThan(3);
    const main = terrain.features.roads[0];
    if (!main) throw new Error('no road');
    for (const l of lamps) {
      const d = Math.min(...terrain.features.roads.map((r) => distToLine(l, r.centerline)));
      expect(d).toBeGreaterThan(roadEdge(main));
      expect(Math.hypot(l.x, l.y)).toBeGreaterThan(9); // the junction at (0, 0)
      for (const b of terrain.features.buildings)
        expect(pointInPolygon(l, b.footprint)).toBe(false);
    }
    const along = lamps
      .filter((l) => Math.abs(l.y) < 10)
      .map((l) => l.x)
      .sort((a, b) => a - b);
    for (let i = 1; i < along.length; i += 1)
      expect((along[i] ?? 0) - (along[i - 1] ?? 0)).toBeGreaterThan(30);
  });

  it('are not put on rural roads, tracks or service roads', () => {
    const terrain = world({
      roads: [
        road('lane', [
          [-250, 0],
          [250, 0],
        ]),
        road(
          'track',
          [
            [-250, 50],
            [250, 50],
          ],
          { roadClass: 'track', highway: 'track' },
        ),
      ],
      buildings: [house('lonely', 0, 25)],
    });
    const p = plan(terrain);
    expect(
      p.instances.filter((i) =>
        isProp(i.plant, ['lampResidential', 'lampModern', 'lampVillage', 'lampIndustrial']),
      ),
    ).toHaveLength(0);
  });

  it('use the mapped lamps where there are some', () => {
    const terrain = world(street(14).features, {
      decor: {
        points: [{ id: 'osm-n9', kind: 'streetLamp', position: { x: 10, y: -5 } }],
        lines: [],
      },
    });
    const p = plan(terrain);
    expect(p.stats.counts['lampResidential:mapped']).toBe(1);
    const lamps = p.instances.filter((i) => isProp(i.plant, ['lampResidential']));
    for (const l of lamps) {
      if (l.x === 10 && l.y === -5) continue;
      expect(Math.hypot(l.x - 10, l.y + 5)).toBeGreaterThan(25);
    }
  });
});

describe('utility poles (standalone: no overhead wires, docs/adr/0037)', () => {
  it('stand along served roads, with no wire geometry anywhere', () => {
    // Several roads: some get poles (by their id), all along houses.
    const roads = Array.from({ length: 8 }, (_, i) =>
      road(`r${String(i)}`, [
        [-280, -250 + i * 60],
        [280, -250 + i * 60],
      ]),
    );
    const buildings = roads.flatMap((r, i) =>
      Array.from({ length: 6 }, (_, k) =>
        house(`h${String(i)}-${String(k)}`, -200 + k * 80, (r.centerline[0]?.y ?? 0) + 22),
      ),
    );
    const terrain = world({ roads, buildings });
    const p = plan(terrain);
    const poles = p.instances.filter((i) => isProp(i.plant, ['poleTimber']));
    expect(poles.length).toBeGreaterThan(5);
    for (const q of poles) {
      for (const b of buildings) expect(pointInPolygon(q, b.footprint)).toBe(false);
    }
    // The plan has no wires, and the scene no line meshes.
    expect('wires' in p).toBe(false);
    expect('wireSpans' in p.stats).toBe(false);
    const layer = createGeoFeatures(buildFeatures(terrain).geometry);
    expect(layer.group.children.some((c) => c.type === 'LineSegments' || c.type === 'Line')).toBe(
      false,
    );
    layer.dispose();
  });

  it("keep mapped power lines' supports, without their wires", () => {
    const line = (kind: 'powerLine' | 'minorLine'): DecorFeatures => ({
      points: [
        { id: 'osm-n1', kind: 'powerTower', position: { x: -200, y: 0 } },
        { id: 'osm-n2', kind: 'powerTower', position: { x: 100, y: 0 } },
      ],
      lines: [
        {
          id: 'osm-w1',
          kind,
          points: [
            { x: -200, y: 0 },
            { x: 100, y: 0 },
            { x: 150, y: 50 },
          ],
        },
      ],
    });
    const p = plan(world({ roads: [], buildings: [] }, { decor: line('powerLine') }));
    expect(p.stats.counts['pylon:mapped']).toBe(3);
    const q = plan(world({ roads: [], buildings: [] }, { decor: line('minorLine') }));
    expect(q.instances.filter((i) => isProp(i.plant, ['poleTimber', 'pylon']))).toHaveLength(3);
  });
});

describe('fences, walls and hedges', () => {
  const fence: DecorFeatures = {
    points: [],
    lines: [
      {
        id: 'osm-w5',
        kind: 'fence',
        material: 'wood',
        points: [
          { x: -50, y: 40 },
          { x: 50, y: 40 },
          { x: 50, y: 80 },
        ],
      },
    ],
  };
  const slope = (x: number, y: number) => GROUND + 0.08 * x + 0.03 * y;

  it('follow their lines in segments, turning at corners, on the ground', () => {
    const terrain = world({ roads: [], buildings: [] }, { decor: fence, ground: slope });
    const p = plan(terrain);
    const panels = p.instances.filter((i) => isProp(i.plant, ['fenceWood']));
    // Each panel lies on its leg of the line, along it.
    let length = 0;
    for (const s of panels) {
      const onFirst = Math.abs(s.y - 40) < 1e-6;
      const onSecond = Math.abs(s.x - 50) < 1e-6;
      expect(onFirst || onSecond).toBe(true);
      expect(Math.abs(Math.sin(s.yaw - (onFirst ? 0 : Math.PI / 2)))).toBeLessThan(1e-6);
      expect(s.scaleW * 2.4).toBeLessThanOrEqual(2.6);
      length += s.scaleW * 2.4;
    }
    expect(length).toBeCloseTo(140, 3);
    // Standing on the ground: the vegetation layer puts each foot at the terrain's height.
    const veg = placeVegetation(terrain, { extra: panels });
    for (let k = 0; k < veg.instances.count; k += 1) {
      const x = veg.instances.position[k * 3] ?? 0;
      const y = veg.instances.position[k * 3 + 1] ?? 0;
      expect(veg.instances.position[k * 3 + 2]).toBeCloseTo(heightAt(terrain, x, y), 3);
    }
  });

  it('leave openings for roads and driveways, and never stand in buildings', () => {
    const terrain = world(
      {
        roads: [
          road(
            'drive',
            [
              [0, 0],
              [0, 100],
            ],
            { widthMeters: 3, highway: 'service', service: 'driveway' },
          ),
        ],
        buildings: [{ id: 'barn', footprint: rectangle(30, 40, 10, 10), heightMeters: 5 }],
      },
      { decor: fence },
    );
    const p = plan(terrain);
    const panels = p.instances.filter((i) => isProp(i.plant, ['fenceWood']));
    for (const s of panels) {
      expect(Math.abs(s.x)).toBeGreaterThan(1.5);
      expect(pointInPolygon(s, rectangle(30, 40, 10, 10))).toBe(false);
    }
  });

  it('are inferred only for some front gardens in built-up streets, with gaps at paths', () => {
    const eu = street(14, {}, 'central-european');
    const p = plan(eu);
    const inferred = Object.entries(p.stats.counts)
      .filter(([k]) => /^(hedge|fenceMetal|fenceWood):inferred$/.test(k))
      .reduce((s, [, v]) => s + v, 0);
    expect(inferred).toBeGreaterThan(0);
    // Not every garden.
    const gardens = new Set(
      p.instances
        .filter((i) => isProp(i.plant, ['hedge', 'fenceMetal', 'fenceWood']))
        .map((i) => Math.round((i.x + 150) / 30)),
    );
    expect(gardens.size).toBeLessThan(14);
    for (const path of p.paths) {
      for (const s of p.instances.filter((i) =>
        isProp(i.plant, ['hedge', 'fenceMetal', 'fenceWood']),
      )) {
        expect(distToLine(s, path.points)).toBeGreaterThan(path.halfWidth);
      }
    }
    // None in North American rural places.
    const lonely = plan(
      world({
        roads: [
          road('lane', [
            [-250, 0],
            [250, 0],
          ]),
        ],
        buildings: [house('h', 0, 25)],
      }),
    );
    expect(
      lonely.instances.filter((i) => isProp(i.plant, ['hedge', 'fenceMetal', 'fenceWood'])),
    ).toHaveLength(0);
  });
});

describe('the roadside details as a whole', () => {
  const terrain = street(12, {
    roads: [
      road(
        'main',
        [
          [-250, 0],
          [250, 0],
        ],
        { roadClass: 'major', highway: 'primary' },
      ),
      // A minor street ending on the main road.
      road('side', [
        [0, -200],
        [0, 0],
      ]),
    ],
  });

  it('are deterministic, whatever order the features come in', () => {
    const a = plan(terrain);
    const shuffled = world({
      ...terrain.features,
      buildings: [...terrain.features.buildings].reverse(),
      roads: [...terrain.features.roads].reverse(),
    });
    const b = plan(shuffled);
    expect(b.instances).toEqual(a.instances);
    expect(b.paths).toEqual(a.paths);
    expect(b.stats.counts).toEqual(a.stats.counts);
    expect(DECOR_VERSION).toBe(2);
  });

  it('produce only finite, grounded geometry', () => {
    const built = buildFeatures(terrain);
    for (const [, m] of built.geometry.paths)
      for (const v of m.positions) expect(Number.isFinite(v)).toBe(true);
    for (const i of built.decorInstances) {
      for (const v of [i.x, i.y, i.yaw, i.scaleW, i.scaleH, ...i.tint])
        expect(Number.isFinite(v)).toBe(true);
    }
    // Paths lie just above the ground, under the roads.
    for (const [, m] of built.geometry.paths) {
      for (let k = 0; k < m.positions.length; k += 3) {
        const x = m.positions[k] ?? 0;
        const z = m.positions[k + 1] ?? 0;
        const y = -(m.positions[k + 2] ?? 0);
        const above = z - heightAt(terrain, x, y);
        expect(above).toBeGreaterThan(0.01);
        expect(above).toBeLessThan(0.04);
      }
    }
    expect(built.geometry.stats.decor.pathTriangles).toBeGreaterThan(0);
  });

  it('add give-way signs where minor roads join main roads', () => {
    const p = plan(terrain);
    expect(p.stats.counts['signGiveWay:inferred']).toBeGreaterThanOrEqual(1);
  });

  it('build every prop model with valid geometry at three levels of detail', () => {
    const models = plantModels();
    for (const m of models.filter((x) => x.spec.kind === 'prop')) {
      expect(m.lods).toHaveLength(3);
      const [near, , far] = m.lods;
      expect(near.triangleCount).toBeGreaterThan(0);
      expect(far.triangleCount).toBeLessThanOrEqual(near.triangleCount);
      for (const v of near.positions) expect(Number.isFinite(v)).toBe(true);
      // Heights as the library says (within 10 %).
      let top = 0;
      for (let i = 1; i < near.positions.length; i += 3)
        top = Math.max(top, near.positions[i] ?? 0);
      expect(top).toBeGreaterThan(m.spec.height * 0.9);
      expect(top).toBeLessThan(m.spec.height * 1.1);
    }
  });

  it('dispose of the scene meshes they add', () => {
    const built = buildFeatures(terrain);
    const layer = createGeoFeatures(built.geometry);
    const paths = layer.group.children.filter((c) => c.name.startsWith('paths: '));
    const markings = layer.group.children.find((c) => c.name === 'road markings');
    expect(paths.length).toBeGreaterThan(0);
    expect(markings).toBeDefined();
    let disposed = 0;
    for (const o of [markings, ...paths]) {
      const g = (
        o as { geometry?: { addEventListener: (t: string, f: () => void) => void } } | undefined
      )?.geometry;
      g?.addEventListener('dispose', () => {
        disposed += 1;
      });
    }
    layer.dispose();
    expect(disposed).toBe(paths.length + 1);
    expect(layer.group.children).toHaveLength(0);
  });

  it('keep room records that test discs and corridors', () => {
    const s = new DecorSpace();
    s.addDisc(0, 0, 1, 'post');
    s.addSegment(10, -20, 10, 20, 1.5, 'path');
    expect(s.free(1.2, 0, 0.4)).toBe(false);
    expect(s.free(3, 0, 0.4)).toBe(true);
    expect(s.free(8.8, 5, 0.5)).toBe(false);
    expect(s.free(8.8, 5, 0.5, ['post'])).toBe(true);
    expect(s.corridorDistance(5, 0, 10, ['path'])).toBeCloseTo(3.5, 6);
    expect(s.nearestCorridor(5, 3, 10, ['path'])).toEqual({ x: 10, y: 3, distance: 5 });
  });
});
