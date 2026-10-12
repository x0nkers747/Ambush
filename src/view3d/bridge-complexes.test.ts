import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  shareTerrain,
  gradeTerrain,
  heightAt,
  lineOfSight,
  planBridges,
  planPath,
  roadNetwork,
  surfaceHeightAt,
  type Bridge,
  type EnvironmentFeatures,
  type Road,
  type TerrainDataset,
  type WaterArea,
} from '#sim';
import { coordinateBridges, cutUnderDecks, LOW_DECK_M, roadEntrances } from './bridge-complexes';
import { bridgeGeometry } from './bridges';
import { finishMesh, meshBuffers } from './drape';
import { buildFeatureGeometry } from './geo-features';
import { diagnoseGeometry, meshIntegrity } from './geometry-diagnostics';
import { coverage } from './test-helpers';

// Bridges drawn as structures (docs/adr/0044): decks mapped side by side are
// one structure with one surface and barriers only on its outside; separate
// bridges stay separate; barriers stop where a road joins; no water over a
// deck too low above it.

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
const road = (id: string, pts: [number, number][], extra: Partial<Road> = {}): Road => ({
  id,
  roadClass: 'paved',
  widthMeters: 6,
  centerline: pts.map(([x, y]) => ({ x, y })),
  ...extra,
});
const footway = (id: string, pts: [number, number][]): Road =>
  road(id, pts, {
    roadClass: 'path',
    highway: 'footway',
    widthMeters: 2,
    crossing: { kind: 'bridge', value: 'yes' },
    bridge: true,
  });
const world = (f: Partial<EnvironmentFeatures>): TerrainDataset =>
  gradeTerrain(
    createSyntheticTerrain(GRID, valley, {
      roads: [],
      buildings: [],
      vegetation: [],
      water: [river],
      waterways: [],
      landUse: [],
      ...f,
    }),
  );
const ground = (t: TerrainDataset) => (x: number, y: number) => heightAt(t, x, y);
const structureOf = (t: TerrainDataset) => {
  const c = coordinateBridges(planBridges(t).bridges);
  const g = bridgeGeometry(c.decks, ground(t), {
    coordinated: c,
    roadEntrance: roadEntrances(t.features.roads, c),
  });
  return { c, g };
};

/** A road across the river at y, with its footways mapped as bridges either side. */
const carriageway = (y: number, id = 'street'): Road[] => [
  road(id, [
    [-150, y],
    [150, y],
  ]),
  footway(`${id}-north`, [
    [-60, y + 4],
    [60, y + 4],
  ]),
  footway(`${id}-south`, [
    [-60, y - 4],
    [60, y - 4],
  ]),
];

describe('bridge structures', () => {
  it('draws a road and its footways mapped side by side as one structure', () => {
    const t = world({ roads: carriageway(0) });
    const { c, g } = structureOf(t);
    expect(c.decks).toHaveLength(3);
    expect(c.complexes).toHaveLength(1);
    expect(c.complexes[0]?.members).toHaveLength(3);
    // Barriers only on the outside: none on another deck of the structure.
    for (const run of g.barriers) {
      const bi = c.decks.findIndex((d) => d.id === run.deck);
      for (let k = 0; k < run.points.length; k += 2)
        expect(c.onOtherDeck(bi, run.points[k] ?? 0, run.points[k + 1] ?? 0, 0)).toBe(false);
    }
    // The outer barriers are those of the footways; the carriageway has none inside.
    expect(g.barriers.filter((b) => b.deck.includes('street:')).length).toBe(0);
    // One surface: continuous across the structure.
    let last: number | null = null;
    for (let y = -4.9; y <= 4.9; y += 0.1) {
      const z = c.index.at(0, y)?.deck ?? null;
      expect(z).not.toBeNull();
      if (last !== null && z !== null) expect(Math.abs(z - last)).toBeLessThan(0.05);
      last = z;
    }
    // No duplicate decks or barriers on roads in the diagnostics.
    const report = diagnoseGeometry(t);
    expect(report.counts.duplicateDeck ?? 0).toBe(0);
    expect(report.counts.barrierOnRoad ?? 0).toBe(0);
    // Every deck still meets its road at its ends, the shorter footways too.
    expect(report.counts.deckStep ?? 0).toBe(0);
    expect(report.expected['sharedStructures']).toBe(1);
  });

  it('keeps separate bridges separate, however close', () => {
    const t = world({
      roads: [
        footway('a', [
          [-60, 0],
          [60, 0],
        ]),
        footway('b', [
          [-60, 6],
          [60, 6],
        ]),
      ],
    });
    const { c } = structureOf(t);
    expect(c.complexes).toHaveLength(2);
  });

  it('stops barriers where a quay road joins the bridge, not across it', () => {
    // A quay along the east bank meets the street at the bridge's end.
    const quay = road('quay', [
      [26, -150],
      [26, 0],
      [26, 150],
    ]);
    const street = road('street', [
      [-150, 0],
      [26, 0],
      [150, 0],
    ]);
    const t = world({ roads: [street, quay] });
    const c = coordinateBridges(planBridges(t).bridges);
    const blind = bridgeGeometry(c.decks, ground(t), { coordinated: c, roadEntrance: () => false });
    const onQuay = (x: number, y: number) => Math.abs(x - 26) < 3 && Math.abs(y) < 200;
    const crosses = (runs: typeof blind.barriers) =>
      runs.some((r) => {
        for (let k = 0; k < r.points.length; k += 2)
          if (onQuay(r.points[k] ?? 0, r.points[k + 1] ?? 0)) return true;
        return false;
      });
    // Without knowing the roads, the barriers would run across the quay.
    expect(crosses(blind.barriers)).toBe(true);
    const { g } = structureOf(t);
    expect(crosses(g.barriers)).toBe(false);
    expect(diagnoseGeometry(t).counts.barrierOnRoad ?? 0).toBe(0);
  });

  it('makes one bridge over a river mapped as overlapping polygons, and over an island', () => {
    const twin: WaterArea = { ...river, id: 'river-twin' };
    const island: WaterArea = {
      ...river,
      id: 'river-island',
      holes: [
        [
          { x: -4, y: -10 },
          { x: 4, y: -10 },
          { x: 4, y: 10 },
          { x: -4, y: 10 },
        ],
      ],
    };
    for (const water of [[river, twin], [island]]) {
      const t = world({
        water,
        roads: [
          road('street', [
            [-150, 0],
            [150, 0],
          ]),
        ],
      });
      const { c } = structureOf(t);
      expect(c.decks).toHaveLength(1);
      expect(c.complexes).toHaveLength(1);
    }
  });

  it('follows a curved road over the river', () => {
    const pts: [number, number][] = [];
    for (let k = 0; k <= 30; k += 1) {
      const x = -150 + k * 10;
      pts.push([x, 0.002 * x * x]);
    }
    const t = world({ roads: [road('bend', pts)] });
    const { c, g } = structureOf(t);
    expect(c.decks).toHaveLength(1);
    expect(meshIntegrity('bridges', g.mesh)).toEqual([]);
    for (const run of g.barriers) expect(run.points.length).toBeGreaterThan(4);
  });

  it('makes no bridge for a road running beside the water', () => {
    const t = world({
      roads: [
        road('quay', [
          [-26, -150],
          [-26, 150],
        ]),
      ],
    });
    expect(planBridges(t).bridges).toHaveLength(0);
  });

  it('is the same whatever the order of the decks', () => {
    const t = world({ roads: [...carriageway(0), ...carriageway(60, 'other')] });
    const plan = planBridges(t).bridges;
    const a = coordinateBridges(plan);
    const b = coordinateBridges([...plan].reverse());
    expect(b.complexes).toEqual(a.complexes);
    expect(b.decks).toEqual(a.decks);
  });

  it('builds finite geometry with no degenerate triangles', () => {
    const t = world({ roads: [...carriageway(0), ...carriageway(60, 'other')] });
    const f = buildFeatureGeometry(t);
    for (const [layer, mesh] of f.roads) expect(meshIntegrity(layer, mesh)).toEqual([]);
    expect(meshIntegrity('bridges', f.bridges)).toEqual([]);
    expect(meshIntegrity('markings', f.markings)).toEqual([]);
    expect(f.stats.bridges.structures).toBe(2);
    expect(f.stats.bridges.shared).toBe(2);
  });
});

describe('water under a low deck', () => {
  it('is cut away under the deck, and left elsewhere', () => {
    // A water sheet at 10 m over x, y ∈ [−50, 50].
    const b = meshBuffers(true);
    for (const [x0, y0] of [
      [-50, -50],
      [0, -50],
      [-50, 0],
      [0, 0],
    ] as const) {
      const corners = [
        [x0, y0],
        [x0 + 50, y0],
        [x0 + 50, y0 + 50],
        [x0, y0 + 50],
      ] as const;
      for (const [i, j, k] of [
        [0, 1, 2],
        [0, 2, 3],
      ] as const)
        for (const q of [corners[i], corners[j], corners[k]]) {
          b.positions.push(q[0], 10, -q[1]);
          b.normals.push(0, 1, 0);
          b.colors?.push(0.1, 0.2, 0.3);
        }
    }
    const water = finishMesh(b);
    // A deck along y = 0, 4 m wide, standing 5 cm above the water.
    const n = 101;
    const deck: Bridge = {
      id: 'low',
      roadIds: ['r'],
      style: 'rural',
      mapped: true,
      xy: Array.from({ length: n }, (_, k) => [-50 + k, 0]).flat(),
      deck: Array.from({ length: n }, () => 10.05),
      lift: Array.from({ length: n }, () => 0.05),
      wet: Array.from({ length: n }, () => true),
      under: Array.from({ length: n }, () => 10),
      halfWidth: 2,
      roadHalfWidth: 1.5,
      lowClearance: true,
    };
    expect(10.05 - 10).toBeLessThan(LOW_DECK_M);
    const { mesh, lowDecks } = cutUnderDecks(water, [deck]);
    expect(lowDecks).toBe(1);
    const cover = coverage(mesh);
    expect(cover.covered(0, 0)).toBe(false);
    expect(cover.covered(20, 1.9)).toBe(false);
    expect(cover.covered(20, 2.2)).toBe(true);
    expect(cover.covered(-30, 30)).toBe(true);
    // A deck well above the water leaves it as it was.
    const high = { ...deck, deck: deck.deck.map(() => 11) };
    expect(cutUnderDecks(water, [high]).mesh).toBe(water);
  });
});

describe('the simulation, untouched', () => {
  it('has the same roads, paths, sight lines and heights after the geometry is built', () => {
    const t = shareTerrain(
      world({
        roads: [
          ...carriageway(0),
          road('quay', [
            [26, -150],
            [26, 150],
          ]),
        ],
      }),
    );
    const snapshot = () => ({
      network: JSON.stringify(roadNetwork(t).component),
      path: JSON.stringify(planPath(t, { x: -100, y: -40 }, { x: 100, y: 40 })),
      roadPath: JSON.stringify(
        planPath(t, { x: -100, y: 0 }, { x: 100, y: 0 }, { followRoads: true }),
      ),
      sight: JSON.stringify(lineOfSight(t, { x: -100, y: 0 }, { x: 100, y: 0 })),
      heights: [0, 3, 30, -30].map((x) => [heightAt(t, x, 0), surfaceHeightAt(t, x, 0)]),
    });
    const before = snapshot();
    const f = buildFeatureGeometry(t);
    expect(f.stats.bridges.shared).toBe(1);
    expect(snapshot()).toEqual(before);
  });
});
