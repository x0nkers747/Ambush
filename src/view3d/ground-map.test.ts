import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIO } from '#exercise';
import {
  createSyntheticTerrain,
  gradeTerrain,
  heightAt,
  lineOfSight,
  rectangle,
  type EnvironmentFeatures,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import {
  bakeGroundMap,
  fieldLook,
  GROUND_LAYERS,
  GROUND_MATERIAL_VERSION,
  groundGrid,
  groundMapBuffers,
  groundParamsAt,
  groundWeightsAt,
  MAX_TEXELS,
  MIN_TEXEL_M,
  type GroundMap,
} from './ground-map';
import { coniferShareAt } from './vegetation-placement';

/** Whether two byte arrays hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// The ground map behind the terrain material (docs/adr/0038): what each
// land-cover class is made of, soft natural edges and sharp man-made ones,
// slopes and earthworks, road shoulders, and that it is stable, mesh-independent
// and display only.

const square = (cx: number, cy: number, half: number): Vec2[] => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half },
];

/** Flat ground, 400 m square, at `z`. */
const flat = (features: Partial<EnvironmentFeatures>, z = 100): TerrainDataset =>
  createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
    () => z,
    { roads: [], buildings: [], vegetation: [], ...features },
  );

const wood = (id: string, boundary: Vec2[]) => ({
  id,
  kind: 'woodland' as const,
  boundary,
  canopyHeightMeters: 15,
  seeThroughMeters: 25,
});

const covers: EnvironmentFeatures = {
  roads: [],
  buildings: [],
  vegetation: [
    wood('wood', square(-100, 100, 60)),
    { ...wood('scrub', square(100, 100, 50)), kind: 'scrub' },
  ],
  water: [
    { id: 'lake', kind: 'water', boundary: square(-100, -100, 40) },
    { id: 'marsh', kind: 'wetland', boundary: square(100, -100, 40) },
  ],
  landUse: [
    { id: 'town', kind: 'residential', boundary: square(0, 0, 40) },
    // A green inside the town: the smaller area shows.
    { id: 'green', kind: 'meadow', boundary: square(0, 0, 12) },
    { id: 'yard', kind: 'industrial', boundary: square(0, -160, 30) },
    { id: 'misc', kind: 'other', boundary: square(160, 0, 25) },
  ],
};
const terrain = flat(covers);
const map = bakeGroundMap(terrain);

const dominant = (m: GroundMap, x: number, y: number) => {
  const w = groundWeightsAt(m, x, y);
  return GROUND_LAYERS.reduce((a, b) => (w[b] > w[a] ? b : a));
};
const sumOf = (w: Record<string, number>, layers: readonly string[]) =>
  layers.reduce((s, l) => s + (w[l] ?? 0), 0);

describe('groundGrid', () => {
  it('covers the heightfield with square points, 2.5 m apart or as fine as the cap allows', () => {
    const g = groundGrid(terrain);
    expect(g.originX).toBe(-200);
    expect(g.originY).toBe(-200);
    expect(g.originX + (g.columns - 1) * g.stepX).toBeCloseTo(200, 9);
    expect(g.originY + (g.rows - 1) * g.stepY).toBeCloseTo(200, 9);
    expect(g.stepX).toBeLessThanOrEqual(MIN_TEXEL_M);
    expect(g.stepX).toBeCloseTo(g.stepY, 9);
    // A 5 km battlefield stays within the cap, at real (metre) scale.
    const big = groundGrid(
      createSyntheticTerrain(
        { originX: -2500, originY: -2500, cellSize: 10, columns: 501, rows: 501 },
        () => 0,
      ),
    );
    expect(big.columns).toBeLessThanOrEqual(MAX_TEXELS);
    expect(big.stepX).toBeCloseTo(5000 / (big.columns - 1), 9);
    expect(big.stepX).toBeLessThan(4);
  });
});

describe('bakeGroundMap: land cover', () => {
  it('gives every point weights summing to exactly 255, and sane parameters', () => {
    const n = map.grid.columns * map.grid.rows;
    expect(map.weights0.length).toBe(n * 4);
    expect(map.weights1.length).toBe(n * 4);
    expect(map.weights2.length).toBe(n * 4);
    expect(map.params.length).toBe(n * 4);
    for (let i = 0; i < n; i += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1)
        s +=
          (map.weights0[i * 4 + k] ?? 0) +
          (map.weights1[i * 4 + k] ?? 0) +
          (map.weights2[i * 4 + k] ?? 0);
      expect(s).toBe(255);
      // The fourth channel of the third texture is no layer.
      expect(map.weights2[i * 4 + 3]).toBe(0);
    }
    expect(map.version).toBe(GROUND_MATERIAL_VERSION);
    const total = Object.values(map.stats.layers).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('grass where there is no data, and in meadows; a meadow inside a town shows', () => {
    const open = groundWeightsAt(map, 170, 170);
    expect(sumOf(open, ['grass', 'meadow'])).toBeGreaterThan(0.85);
    const green = groundWeightsAt(map, 0, 0);
    expect(sumOf(green, ['grass', 'meadow'])).toBeGreaterThan(0.9);
    const town = groundWeightsAt(map, 25, 25);
    expect(town.grass).toBeGreaterThan(0.6);
  });

  it('wood floors are leaf or needle litter, as the trees above them, not green', () => {
    let needles = 0;
    let checked = 0;
    for (let x = -140; x <= -60; x += 10) {
      for (let y = 60; y <= 140; y += 10) {
        const w = groundWeightsAt(map, x, y);
        expect(sumOf(w, ['leaves', 'needles', 'earth'])).toBeGreaterThan(0.6);
        expect(w.grass).toBeLessThan(0.3);
        // More needles where the stand is coniferous.
        const share = coniferShareAt(x, y);
        if (share > 0.75) expect(w.needles).toBeGreaterThan(w.leaves);
        if (share < 0.25) expect(w.leaves).toBeGreaterThan(w.needles);
        needles += w.needles;
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(needles).toBeGreaterThanOrEqual(0);
  });

  it('scrub is sparse grass over soil; wetland damp earth; water beds wet earth', () => {
    const scrub = groundWeightsAt(map, 100, 100);
    expect(scrub.meadow + scrub.grass).toBeGreaterThan(0.4);
    expect(scrub.earth).toBeGreaterThan(0.1);
    const marsh = groundWeightsAt(map, 100, -100);
    expect(marsh.earth).toBeGreaterThan(0.3);
    expect(groundParamsAt(map, 100, -100).wet).toBeGreaterThan(0.5);
    expect(dominant(map, -100, -100)).toBe('earth');
    expect(groundParamsAt(map, -100, -100).wet).toBeGreaterThan(0.9);
  });

  it('industrial yards are gravel and bare earth; other land a rough mix', () => {
    const yard = groundWeightsAt(map, 0, -160);
    expect(yard.gravel + yard.earth).toBeGreaterThan(0.5);
    const misc = groundWeightsAt(map, 160, 0);
    expect(misc.earth + misc.gravel).toBeGreaterThan(0.3);
  });

  it('fields: soil or crop stubble or pasture, with furrows along the long axis', () => {
    const fields = Array.from({ length: 16 }, (_, k) => ({
      id: `field-${String(k)}`,
      kind: 'farmland' as const,
      boundary: rectangle(-150 + (k % 4) * 100, -150 + Math.floor(k / 4) * 100, 80, 60, 30),
    }));
    const farm = bakeGroundMap(flat({ landUse: fields }));
    const looks = new Set<string>();
    for (const [k, f] of fields.entries()) {
      const cx = -150 + (k % 4) * 100;
      const cy = -150 + Math.floor(k / 4) * 100;
      const { look, angle } = fieldLook(f.id, f.boundary);
      looks.add(look);
      // Long axis 30° clockwise from east: 150° counter-clockwise.
      expect(Math.abs(angle - (5 * Math.PI) / 6)).toBeLessThan(0.01);
      const p = groundParamsAt(farm, cx, cy);
      expect(Math.abs(p.furrowAngle - (5 * Math.PI) / 6)).toBeLessThan(0.02);
      const w = groundWeightsAt(farm, cx, cy);
      if (look === 'ploughed') expect(w.soil).toBeGreaterThan(0.7);
      if (look === 'stubble') {
        expect(w.meadow).toBeGreaterThan(0.7);
        expect(p.dry).toBeGreaterThan(0.6);
      }
      if (look === 'pasture') expect(w.grass + w.meadow).toBeGreaterThan(0.8);
      expect(p.furrows).toBeGreaterThan(0);
    }
    // Several looks across sixteen fields; a field keeps its look whatever else is loaded.
    expect(looks.size).toBeGreaterThan(1);
    expect(fieldLook('field-3', fields[3]?.boundary ?? []).look).toBe(
      fieldLook('field-3', square(0, 0, 50)).look,
    );
  });

  it('small farmland is a farmyard: earth and gravel, no furrows', () => {
    const yard = { id: 'yard', kind: 'farmland' as const, boundary: square(0, 0, 25) };
    expect(fieldLook(yard.id, yard.boundary).look).toBe('yard');
    const m = bakeGroundMap(flat({ landUse: [yard] }));
    const w = groundWeightsAt(m, 0, 0);
    expect(w.earth + w.gravel).toBeGreaterThan(0.4);
    expect(w.soil).toBe(0);
    expect(groundParamsAt(m, 0, 0).furrows).toBe(0);
  });

  it('paints vegetation over land use and water over both, whatever the order', () => {
    const shuffled = flat({
      ...covers,
      vegetation: [...covers.vegetation].reverse(),
      water: [...(covers.water ?? [])].reverse(),
      landUse: [...(covers.landUse ?? [])].reverse(),
    });
    const again = bakeGroundMap(shuffled);
    expect(sameBytes(again.weights0, map.weights0)).toBe(true);
    expect(sameBytes(again.weights1, map.weights1)).toBe(true);
    expect(sameBytes(again.weights2, map.weights2)).toBe(true);
    expect(sameBytes(again.params, map.params)).toBe(true);
    // A wood over a field: the wood's floor.
    const over = bakeGroundMap(
      flat({
        vegetation: [wood('w', square(0, 0, 50))],
        landUse: [{ id: 'f', kind: 'farmland', boundary: square(0, 0, 100) }],
      }),
    );
    const w = groundWeightsAt(over, 0, 0);
    expect(w.leaves + w.needles).toBeGreaterThan(0.5);
  });
});

describe('bakeGroundMap: edges', () => {
  it('keeps man-made edges sharp: a field next to a meadow changes within a point', () => {
    const m = bakeGroundMap(
      flat({
        landUse: [
          { id: 'f-ploughed', kind: 'farmland', boundary: square(-100, 0, 100) },
          { id: 'mead', kind: 'meadow', boundary: square(100, 0, 100) },
        ],
      }),
    );
    // Whatever the field's look, its recipe stops at the edge.
    const left = groundWeightsAt(m, -2 * m.grid.stepX, 0);
    const right = groundWeightsAt(m, 2 * m.grid.stepX, 0);
    const diff = GROUND_LAYERS.reduce((s, l) => s + Math.abs(left[l] - right[l]), 0);
    const far = groundWeightsAt(m, -60, 0);
    const farDiff = GROUND_LAYERS.reduce((s, l) => s + Math.abs(left[l] - far[l]), 0);
    // Two points in, each side is (nearly) its own area's ground.
    expect(farDiff).toBeLessThan(0.6);
    expect(diff).toBeGreaterThan(0.4);
    expect(groundParamsAt(m, 2 * m.grid.stepX, 0).furrows).toBe(0);
  });

  it('softens natural edges: a wood fades into grass over metres, irregularly', () => {
    const m = bakeGroundMap(
      flat({
        vegetation: [
          wood('w', [
            { x: -200, y: -200 },
            { x: 0, y: -200 },
            { x: 0, y: 200 },
            { x: -200, y: 200 },
          ]),
        ],
      }),
    );
    let mixed = 0;
    const crossings: number[] = [];
    for (let y = -150; y <= 150; y += 10) {
      const p = Array.from({ length: 61 }, (_, k) => {
        const w = groundWeightsAt(m, k - 30, y);
        return w.leaves + w.needles;
      });
      mixed += p.filter((v) => v > 0.08 && v < 0.55).length;
      crossings.push(p.findIndex((v) => v < 0.3));
    }
    // A transition several metres wide…
    expect(mixed / 31).toBeGreaterThan(2);
    // …that wanders along the edge.
    expect(new Set(crossings).size).toBeGreaterThan(2);
  });

  it('does not depend on the mesh: refined tiles change nothing on flat ground', () => {
    const roads = [
      {
        id: 'r',
        roadClass: 'track' as const,
        widthMeters: 3,
        centerline: [
          { x: -180, y: 50 },
          { x: 180, y: 50 },
        ],
      },
    ];
    const source = flat({ roads, landUse: covers.landUse ?? [] });
    const graded = gradeTerrain(source);
    expect(graded.refinement).toBeUndefined();
    // Make a refined terrain whose refined cells are flat too: the map must match.
    const k = 4;
    const cells = [5 * 40 + 5, 5 * 40 + 6, 20 * 40 + 20];
    const refined: TerrainDataset = {
      ...source,
      refinement: {
        factor: k,
        cells,
        samples: cells.flatMap(() => new Array<number>((k + 1) ** 2).fill(100)),
      },
    };
    const a = bakeGroundMap(source);
    const b = bakeGroundMap(refined);
    expect(sameBytes(a.weights0, b.weights0)).toBe(true);
    expect(sameBytes(a.weights1, b.weights1)).toBe(true);
    expect(sameBytes(a.weights2, b.weights2)).toBe(true);
  });
});

describe('bakeGroundMap: slopes, earthworks and roads', () => {
  it('flat ground has no steep points; terrain edges and extreme elevations are valid', () => {
    for (const z of [-420, 0, 8800]) {
      const m = bakeGroundMap(flat({}, z));
      expect(m.stats.steep).toBe(0);
      for (const [x, y] of [
        [-200, -200],
        [200, 200],
        [-200, 200],
        [200, -200],
      ] as const) {
        const w = groundWeightsAt(m, x, y);
        expect(sumOf(w, GROUND_LAYERS)).toBeCloseTo(1, 6);
      }
    }
  });

  it('steep natural slopes show bare earth, cliffs rock', () => {
    const cliff = createSyntheticTerrain(
      { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
      (x) => 100 + (x > 0 ? 40 : 0) + 0.02 * x,
      { roads: [], buildings: [], vegetation: [] },
    );
    const m = bakeGroundMap(cliff);
    expect(m.stats.steep).toBeGreaterThan(0);
    // The cliff face, between the samples at x = 0 and x = 10.
    const w = groundWeightsAt(m, 5, 0);
    expect(w.rock + w.earth).toBeGreaterThan(0.5);
    expect(groundWeightsAt(m, -150, 0).rock).toBe(0);
  });

  it('graded cuttings and embankments show earth and sparse grass; shoulders are worn', () => {
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
    expect(graded.refinement?.cells.length).toBeGreaterThan(0);
    const before = bakeGroundMap(source);
    const after = bakeGroundMap(graded);
    // Where the road cuts the ridge, the cutting's sides are bared.
    let bared = 0;
    for (let x = -112; x <= -88; x += 1) {
      for (let y = 50; y <= 70; y += 1) {
        const a = groundWeightsAt(after, x, y);
        const b = groundWeightsAt(before, x, y);
        if (a.earth > b.earth + 0.15) bared += 1;
      }
    }
    expect(bared).toBeGreaterThan(5);
    // The shoulder beside the road, away from the ridge: gravel and earth.
    const shoulder = groundWeightsAt(after, -100 + 3 + 0.6, -120);
    expect(shoulder.gravel + shoulder.earth).toBeGreaterThan(0.35);
    const away = groundWeightsAt(after, -60, -120);
    expect(away.gravel).toBe(0);
  });
});

describe('bakeGroundMap: stable and display only', () => {
  it('bakes the same bytes every time', () => {
    const again = bakeGroundMap(terrain);
    expect(sameBytes(again.weights0, map.weights0)).toBe(true);
    expect(sameBytes(again.params, map.params)).toBe(true);
    // Transferable buffers, one per array.
    expect(new Set(groundMapBuffers(map)).size).toBe(4);
    const clone = structuredClone(map);
    expect(sameBytes(clone.weights1, map.weights1)).toBe(true);
    expect(sameBytes(clone.weights2, map.weights2)).toBe(true);
  });

  it('changes nothing the simulation reads: terrain, grading, heights and sight lines', () => {
    const demo = DEMO_SCENARIO.terrain;
    const snapshot = JSON.stringify(demo);
    const graded = gradeTerrain(demo);
    const gradedSnapshot = JSON.stringify(graded);
    const hf = graded.heightfield;
    const span = (n: number) => (n - 1) * hf.cellSize;
    const points = Array.from({ length: 40 }, (_, k) => ({
      x: hf.originX + span(hf.columns) * (((k * 37) % 97) / 97),
      y: hf.originY + span(hf.rows) * (((k * 61) % 89) / 89),
    }));
    const heights = points.map((p) => heightAt(graded, p.x, p.y));
    const sight = points.slice(1).map((p, k) => lineOfSight(graded, points[k] ?? p, p));
    bakeGroundMap(demo);
    bakeGroundMap(graded);
    expect(JSON.stringify(demo)).toBe(snapshot);
    expect(JSON.stringify(graded)).toBe(gradedSnapshot);
    expect(JSON.stringify(gradeTerrain(demo))).toBe(gradedSnapshot);
    expect(points.map((p) => heightAt(graded, p.x, p.y))).toEqual(heights);
    expect(points.slice(1).map((p, k) => lineOfSight(graded, points[k] ?? p, p))).toEqual(sight);
  });
});

describe('bakeGroundMap: shores (docs/adr/0040)', () => {
  const SHORE = 100;
  const seaArea = {
    id: 'osm-sea',
    kind: 'water' as const,
    waterClass: 'sea' as const,
    boundary: [
      { x: SHORE, y: -200 },
      { x: 200, y: -200 },
      { x: 200, y: 200 },
      { x: SHORE, y: 200 },
    ],
  };
  const shores = gradeTerrain(
    createSyntheticTerrain(
      { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
      // A gentle beach in the south, a cliff in the north; the sea floor offshore.
      (x, y) =>
        x >= SHORE
          ? -0.05 * (x - SHORE)
          : (y > 60 ? 1.2 : 0.04) *
            (SHORE - x) *
            Math.min(1, Math.max(0, (y - 40) / 20) + (y > 60 ? 0 : 1)),
      {
        roads: [],
        buildings: [],
        vegetation: [],
        water: [seaArea],
        waterways: [],
        landUse: [
          { id: 'shingle', kind: 'shingle', boundary: rectangle(80, -130, 40, 40) },
          { id: 'town', kind: 'residential', boundary: rectangle(50, -40, 100, 40) },
        ],
      },
    ),
  );
  const m = bakeGroundMap(shores);

  it('puts a sandy beach along a gentle sea shore, damp at the waterline', () => {
    const w = groundWeightsAt(m, SHORE - 3, -80);
    expect(w.sand).toBeGreaterThan(0.5);
    expect(groundParamsAt(m, SHORE - 1, -80).wet).toBeGreaterThan(0.3);
    // Far inland, no sand.
    expect(groundWeightsAt(m, SHORE - 70, -80).sand).toBeLessThan(0.02);
    expect(m.stats.shores).toBeGreaterThan(100);
  });

  it('varies the beach along the shore, and its damp band', () => {
    const reach = (y: number) => {
      let d = 0;
      while (d < 40 && groundWeightsAt(m, SHORE - d, y).sand > 0.3) d += 1;
      return d;
    };
    const reaches = new Set([-190, -170, -100, -90, -80, -70, 0, 20].map(reach));
    expect(reaches.size).toBeGreaterThan(2);
    const wets = new Set(
      [-190, -170, -100, -80, 0, 20].map((y) => groundParamsAt(m, SHORE - 2, y).wet.toFixed(2)),
    );
    expect(wets.size).toBeGreaterThan(1);
  });

  it('gives a cliff a rocky foot, no broad sand', () => {
    const w = groundWeightsAt(m, SHORE - 2, 150);
    expect(w.rock + w.shingle).toBeGreaterThan(0.4);
    expect(groundWeightsAt(m, SHORE - 8, 150).sand).toBeLessThan(0.1);
  });

  it('keeps a mapped shingle beach shingle, and a built waterfront narrow', () => {
    const s = groundWeightsAt(m, 80, -130);
    expect(s.shingle).toBeGreaterThan(s.sand);
    expect(groundWeightsAt(m, SHORE - 8, -40).sand).toBeLessThan(0.05);
  });

  it('shows sand under the sea near the shore, and is deterministic', () => {
    const bed = groundWeightsAt(m, 150, -80);
    expect(bed.sand).toBeGreaterThan(0.5);
    expect(groundParamsAt(m, 150, -80).wet).toBe(1);
    const again = bakeGroundMap(shores);
    expect(sameBytes(again.weights2, m.weights2)).toBe(true);
    expect(sameBytes(again.params, m.params)).toBe(true);
  });
});
