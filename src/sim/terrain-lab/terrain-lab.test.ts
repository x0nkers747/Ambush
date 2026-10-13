import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  waterLevels,
  type EnvironmentFeatures,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import {
  baseSurface,
  clipLine,
  clipRing,
  compileField,
  DECK_CLEARANCE_M,
  DECK_END_M,
  DECK_SEAT_M,
  DECK_THICKNESS_M,
  deckHalfWidth,
  createSurface,
  emptySample,
  generateTile,
  gradientNoise,
  levelAt,
  nearestOnRoad,
  RoadSurface,
  structureTerrain,
  tileHash,
  type TerrainField,
} from './index';

// The terrain lab's field and surface (stage 2 prototype,
// docs/ground-level-terrain-architecture-research.md §5): a small battlefield
// on rolling ground with a road crossing a stream on a bridge, a house on the
// slope, a pond and a wood.

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

const features: EnvironmentFeatures = {
  roads: [
    // West to east across the slope, with a bridge over the stream at x 0.
    {
      id: 'road-w',
      roadClass: 'paved',
      widthMeters: 6,
      centerline: [
        { x: -190, y: -20 },
        { x: -6, y: -20 },
      ],
    },
    {
      id: 'road-b',
      roadClass: 'paved',
      widthMeters: 6,
      bridge: true,
      centerline: [
        { x: -6, y: -20 },
        { x: 6, y: -20 },
      ],
    },
    {
      id: 'road-e',
      roadClass: 'paved',
      widthMeters: 6,
      centerline: [
        { x: 6, y: -20 },
        { x: 190, y: -20 },
      ],
    },
    // A track joining it from the north (a T junction).
    {
      id: 'track',
      roadClass: 'track',
      widthMeters: 3,
      centerline: [
        { x: 80, y: -20 },
        { x: 80, y: 150 },
      ],
    },
  ],
  buildings: [{ id: 'house', footprint: rect(-80, 20, -66, 30), heightMeters: 7 }],
  vegetation: [
    {
      id: 'wood',
      kind: 'woodland',
      boundary: rect(100, 60, 190, 190),
      canopyHeightMeters: 18,
      seeThroughMeters: 40,
    },
  ],
  water: [{ id: 'pond', kind: 'water', waterClass: 'pond', boundary: ring(-120, -120, 30) }],
  waterways: [
    {
      id: 'stream',
      kind: 'stream',
      widthMeters: 2,
      centerline: [
        { x: 0, y: 190 },
        { x: 0, y: -190 },
      ],
    },
  ],
  landUse: [{ id: 'meadow', kind: 'meadow', boundary: rect(-190, 40, 0, 190) }],
};

// Rolling ground: a slope down to the south-east with a valley along x = 0.
const ground = (x: number, y: number) =>
  100 + 0.04 * y - 0.02 * x + 3 * Math.min(1, Math.abs(x) / 40);
const source: TerrainDataset = {
  ...createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
    ground,
    features,
  ),
  formatVersion: 3,
};
const water = waterLevels(source);
const input = { heightfield: source.heightfield, features: source.features, water };
const field = compileField(input, { seed: 7, relief: 1 });

describe('terrain lab: deterministic noise', () => {
  it('is in about [−1, 1], zero on the lattice, and the same every time', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 2000; i += 1) {
      const v = gradientNoise(i * 0.137, i * 0.291, 3);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThan(-1.5);
    expect(hi).toBeLessThan(1.5);
    expect(hi - lo).toBeGreaterThan(1);
    expect(gradientNoise(4, -7, 3)).toBe(0);
    expect(gradientNoise(1.25, 2.5, 9)).toBe(gradientNoise(1.25, 2.5, 9));
    expect(gradientNoise(1.25, 2.5, 9)).not.toBe(gradientNoise(1.25, 2.5, 10));
  });
});

describe('terrain lab: base surface', () => {
  it('goes through the DEM samples and never overshoots a cell', () => {
    const base = baseSurface(source.heightfield);
    const hf = source.heightfield;
    for (let k = 0; k < 500; k += 1) {
      const x = -195 + ((k * 37) % 390);
      const y = -195 + ((k * 53) % 390);
      const c = Math.floor((x - hf.originX) / hf.cellSize);
      const r = Math.floor((y - hf.originY) / hf.cellSize);
      const s = [0, 1, hf.columns, hf.columns + 1].map(
        (o) => hf.elevations[r * hf.columns + c + o] ?? 0,
      );
      const v = base.at(x, y);
      expect(v).toBeGreaterThanOrEqual(Math.min(...s) - 1e-9);
      expect(v).toBeLessThanOrEqual(Math.max(...s) + 1e-9);
    }
    expect(base.at(-100, -50)).toBeCloseTo(hf.elevations[15 * hf.columns + 10] ?? 0, 9);
  });
});

/** Height across a line, every 5 cm: the largest step between neighbours. */
function largestStep(f: TerrainField, a: Vec2, b: Vec2): number {
  const n = Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 0.05);
  let prev = f.height(a.x, a.y);
  let worst = 0;
  for (let i = 1; i <= n; i += 1) {
    const h = f.height(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
    worst = Math.max(worst, Math.abs(h - prev));
    prev = h;
  }
  return worst;
}

describe('terrain lab: the field', () => {
  const s = emptySample();

  it('holds a road level across its carriageway and marks its surface', () => {
    const road = field.roads.find((r) => r.id === 'road-w');
    if (!road) throw new Error('no road');
    const near = nearestOnRoad(road, -120, -20);
    const level = levelAt(road, near.s);
    field.sample(-120, -20, s);
    expect(s.h).toBeCloseTo(level, 9);
    field.sample(-120, -17.5, s);
    // Flat across: no camber.
    expect(s.h).toBeCloseTo(level, 9);
    expect(s.roadSurface).toBe(RoadSurface.Asphalt);
    expect(s.roadEdge).toBeCloseTo(-0.5, 6);
  });

  it('pins a junction: the track meets the road at the road’s level', () => {
    const road = field.roads.find((r) => r.id === 'road-e');
    const track = field.roads.find((r) => r.id === 'track');
    if (!road || !track) throw new Error('no road');
    expect(levelAt(track, 0)).toBeCloseTo(levelAt(road, nearestOnRoad(road, 80, -20).s), 6);
  });

  it('lays a bridge straight between its ends and leaves the ground under it alone', () => {
    const bridge = field.roads.find((r) => r.id === 'road-b');
    if (!bridge) throw new Error('no bridge');
    const p = bridge.profile;
    const mid = (p[0] ?? 0) + ((p[p.length - 1] ?? 0) - (p[0] ?? 0)) / 2;
    expect(levelAt(bridge, 6)).toBeCloseTo(mid, 6);
    // Under the deck the stream's channel is cut, well below the deck.
    field.sample(0, -20, s);
    expect(s.h).toBeLessThan(mid - 1);
    expect(s.shore).toBeLessThan(0);
  });

  it('keeps the ground under a deck below its underside, meeting the road at its ends', () => {
    const bridge = field.roads.find((r) => r.id === 'road-b');
    if (!bridge) throw new Error('no bridge');
    const half = deckHalfWidth(bridge);
    const inner = DECK_SEAT_M + DECK_END_M;
    for (let x = -6 + inner; x <= 6 - inner; x += 0.25)
      for (let dy = -half; dy <= half; dy += 0.25) {
        const top = levelAt(bridge, x + 6);
        expect(field.height(x, -20 + dy)).toBeLessThanOrEqual(
          top - DECK_THICKNESS_M - DECK_CLEARANCE_M + 1e-6,
        );
      }
    // At each end the ground is the road's (just under the deck's seat).
    for (const x of [-6, 6]) {
      const top = levelAt(bridge, x + 6);
      expect(Math.abs(field.height(x, -20) - top)).toBeLessThan(0.05);
    }
  });

  it('levels a pad under the house and keeps it to its apron', () => {
    const pad = field.pads.find((p) => p.id === 'house');
    if (!pad) throw new Error('no pad');
    for (const [x, y] of [
      [-79, 21],
      [-67, 29],
      [-73, 25],
      [-80.5, 25],
    ] as const)
      expect(field.height(x, y)).toBeCloseTo(pad.level, 9);
    field.sample(-73, 25, s);
    expect(s.building).toBe(0);
  });

  it('puts the pond’s bed below its level and its banks at or above it', () => {
    const q = field.water;
    if (!q) throw new Error('no water');
    const level = q.bodyLevel('pond', -120, -120);
    if (level === null) throw new Error('pond not levelled');
    expect(field.height(-120, -120)).toBeLessThan(level - 0.5);
    for (let a = 0; a < 24; a += 1) {
      const t = (2 * Math.PI * a) / 24;
      // 1 m outside the shore.
      const h = field.height(-120 + 31 * Math.cos(t), -120 + 31 * Math.sin(t));
      expect(h).toBeGreaterThanOrEqual(level - 1e-6);
    }
  });

  it('cuts a channel for the stream with water below the banks', () => {
    const c = field.channels.find((ch) => ch.id === 'stream');
    if (!c) throw new Error('no channel');
    field.sample(0, 100, s);
    expect(s.shore).toBeLessThan(0);
    const bank = field.height(4, 100);
    expect(s.h).toBeLessThan(bank - 0.3);
  });

  it('is continuous: no steps over 15 cm in 5 cm across roads, pads, junctions and shores', () => {
    const lines: [Vec2, Vec2][] = [
      [
        { x: -120, y: -40 },
        { x: -120, y: 0 },
      ],
      [
        { x: -95, y: 25 },
        { x: -50, y: 25 },
      ],
      [
        { x: 60, y: -10 },
        { x: 100, y: -30 },
      ],
      [
        { x: -160, y: -120 },
        { x: -80, y: -120 },
      ],
      [
        { x: -15, y: 100 },
        { x: 15, y: 100 },
      ],
      [
        { x: 70, y: 0 },
        { x: 90, y: 0 },
      ],
    ];
    for (const [a, b] of lines) expect(largestStep(field, a, b)).toBeLessThan(0.15);
  });

  it('is reproducible, and its relief follows the seed and the spec', () => {
    const again = compileField(input, { seed: 7, relief: 1 });
    const other = compileField(input, { seed: 8, relief: 1 });
    const flat = compileField(input, { seed: 7, relief: 0 });
    let diffSeed = 0;
    let diffFlat = 0;
    for (let k = 0; k < 200; k += 1) {
      const x = -150 + (k % 20) * 7;
      const y = 60 + Math.floor(k / 20) * 11;
      expect(again.height(x, y)).toBe(field.height(x, y));
      diffSeed = Math.max(diffSeed, Math.abs(other.height(x, y) - field.height(x, y)));
      diffFlat = Math.max(diffFlat, Math.abs(flat.height(x, y) - field.height(x, y)));
    }
    expect(diffSeed).toBeGreaterThan(0.01);
    // Conservative: relief stays within half a metre of the smooth DEM.
    expect(diffFlat).toBeGreaterThan(0.02);
    expect(diffFlat).toBeLessThan(0.5);
  });
});

describe('terrain lab: roads meet level', () => {
  // A lane across a hillside; a major road ending on it (outranking it), a
  // track crossing it with no shared point, and a road stopping short of it.
  const roads: EnvironmentFeatures = {
    roads: [
      {
        id: 'lane',
        roadClass: 'paved',
        widthMeters: 6,
        centerline: [
          { x: -150, y: 0 },
          { x: 150, y: 0 },
        ],
      },
      {
        id: 'main',
        roadClass: 'major',
        widthMeters: 8,
        centerline: [
          { x: -60, y: 150 },
          { x: -60, y: 0 },
        ],
      },
      {
        id: 'cross',
        roadClass: 'track',
        widthMeters: 3,
        centerline: [
          { x: 40, y: -150 },
          { x: 40, y: 150 },
        ],
      },
      {
        id: 'stub',
        roadClass: 'paved',
        widthMeters: 6,
        centerline: [
          { x: 100, y: -150 },
          { x: 100, y: -5.5 },
        ],
      },
    ],
    buildings: [],
    vegetation: [],
  };
  const hill = (x: number, y: number) => 100 + 0.08 * y + 2 * Math.sin(x / 30);
  const terrain = createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
    hill,
    roads,
  );
  const f = compileField(
    { heightfield: terrain.heightfield, features: terrain.features, water: null },
    { seed: 3, relief: 1 },
  );
  const stamp = (id: string) => {
    const r = f.roads.find((q) => q.id === id);
    if (!r) throw new Error(`no ${id}`);
    return r;
  };
  const levelNear = (id: string, x: number, y: number) => {
    const r = stamp(id);
    return levelAt(r, nearestOnRoad(r, x, y).s);
  };

  it('bends a lower road to a higher one ending on it, at crossings too', () => {
    const lane = levelNear('lane', -60, 0);
    expect(Math.abs(levelNear('main', -60, 0) - lane)).toBeLessThan(0.01);
    expect(Math.abs(levelNear('cross', 40, 0) - levelNear('lane', 40, 0))).toBeLessThan(0.01);
    // The stub ends on the lane's shoulder: it is pinned to the lane too.
    expect(Math.abs(levelNear('stub', 100, -5.5) - levelNear('lane', 100, 0))).toBeLessThan(0.01);
  });

  it('has no steps where road surfaces overlap', () => {
    const lines: [Vec2, Vec2][] = [
      [
        { x: -75, y: 0 },
        { x: -45, y: 0 },
      ],
      [
        { x: -60, y: -3.5 },
        { x: -60, y: 20 },
      ],
      [
        { x: 25, y: 0 },
        { x: 55, y: 0 },
      ],
      [
        { x: 40, y: -20 },
        { x: 40, y: 20 },
      ],
      [
        { x: 100, y: -20 },
        { x: 100, y: 3.5 },
      ],
      [
        { x: 85, y: -3.5 },
        { x: 115, y: -3.5 },
      ],
    ];
    // On the surfaces, every 5 cm: at most a 40 % grade.
    for (const [a, b] of lines) expect(largestStep(f, a, b)).toBeLessThan(0.02);
  });
});

describe('terrain lab: the sampled surface', () => {
  for (const spacing of [0.5, 1]) {
    describe(`${String(spacing)} m lattice`, () => {
      const surface = createSurface(field, { spacing, capacity: 64 });

      it('samples the field at every lattice point, in every tile and at every level', () => {
        const t0 = surface.tile(0, 1, 1);
        const t2 = surface.tile(2, 0, 0);
        const cells = surface.cells;
        for (const [i, j] of [
          [0, 0],
          [4, 8],
          [cells, cells],
          [cells - 4, 12],
        ] as const) {
          const x = surface.originX + (cells + i) * spacing;
          const y = surface.originY + (cells + j) * spacing;
          expect(t0.heights[(j + 1) * t0.stride + i + 1]).toBe(Math.fround(field.height(x, y)));
          expect(surface.heightAt(x, y)).toBe(Math.fround(field.height(x, y)));
        }
        // A coarse sample equals the level 0 sample at the same point.
        const x = surface.originX + 4 * 8 * spacing;
        const y = surface.originY + 4 * 12 * spacing;
        expect(t2.heights[(12 + 1) * t2.stride + 8 + 1]).toBe(surface.heightAt(x, y));
      });

      it('is piecewise linear on the lattice, split south-west to north-east', () => {
        const x0 = surface.originX + 101 * spacing;
        const y0 = surface.originY + 77 * spacing;
        const sw = surface.heightAt(x0, y0);
        const se = surface.heightAt(x0 + spacing, y0);
        const ne = surface.heightAt(x0 + spacing, y0 + spacing);
        const nw = surface.heightAt(x0, y0 + spacing);
        expect(surface.heightAt(x0 + 0.75 * spacing, y0 + 0.25 * spacing)).toBeCloseTo(
          sw + 0.75 * (se - sw) + 0.25 * (ne - se),
          9,
        );
        expect(surface.heightAt(x0 + 0.25 * spacing, y0 + 0.75 * spacing)).toBeCloseTo(
          sw + 0.75 * (nw - sw) + 0.25 * (ne - nw),
          9,
        );
      });

      it('makes the same tile whatever was made before it', () => {
        const fresh = createSurface(compileField(input, { seed: 7, relief: 1 }), { spacing });
        fresh.tile(0, 0, 0);
        fresh.tile(2, 0, 0);
        const a = tileHash(fresh.tile(0, 2, 3));
        expect(tileHash(surface.tile(0, 2, 3))).toBe(a);
        expect(
          tileHash(generateTile(field, spacing, surface.originX, surface.originY, 0, 2, 3)),
        ).toBe(a);
      });

      it('traces sight lines exactly as the reference, and agrees with dense sampling', () => {
        let seed = 11;
        const rnd = () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        let blocked = 0;
        for (let k = 0; k < 150; k += 1) {
          const ax = -180 + rnd() * 360;
          const ay = -180 + rnd() * 360;
          const bx = Math.max(-195, Math.min(195, ax + (rnd() - 0.5) * 240));
          const by = Math.max(-195, Math.min(195, ay + (rnd() - 0.5) * 240));
          const a = { x: ax, y: ay, z: surface.heightAt(ax, ay) + 1.7 };
          const b = { x: bx, y: by, z: surface.heightAt(bx, by) + 0.4 };
          const t = surface.traceSight(a, b);
          expect(t).toBe(surface.traceSightReference(a, b));
          if (t !== null) blocked += 1;
          // Dense sampling: the line is above the ground before t, and at t it meets it.
          const end = t ?? 1;
          for (let i = 1; i < 200; i += 1) {
            const u = (end * i) / 200;
            const z = a.z + u * (b.z - a.z);
            expect(z).toBeGreaterThanOrEqual(
              surface.heightAt(a.x + u * (b.x - a.x), a.y + u * (b.y - a.y)) - 1e-6,
            );
          }
          if (t !== null) {
            const z = a.z + t * (b.z - a.z);
            expect(z).toBeCloseTo(
              surface.heightAt(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)),
              5,
            );
          }
        }
        expect(blocked).toBeGreaterThan(5);
      });

      it('keeps its cache within capacity and counts what it holds', () => {
        const small = createSurface(field, { spacing, capacity: 3 });
        for (let i = 0; i < 6; i += 1) small.tile(0, i, 0);
        expect(small.cachedCount()).toBe(3);
        expect(small.stats.evicted).toBe(3);
        expect(small.cachedBytes()).toBeGreaterThan(0);
        small.adopt(surface.tile(0, 1, 1));
        expect(small.peek(0, 1, 1)).not.toBeNull();
      });
    });
  }
});

describe('terrain lab: the structures’ ground', () => {
  it('equals the surface at its samples and crops the features to it', () => {
    const surface = createSurface(field, { spacing: 0.5 });
    const t = structureTerrain(
      surface,
      source,
      water,
      { minX: -150, minY: -100, maxX: 50, maxY: 60 },
      1,
    );
    const hf = t.heightfield;
    for (const [c, r] of [
      [0, 0],
      [37, 81],
      [hf.columns - 1, hf.rows - 1],
    ] as const)
      expect(hf.elevations[r * hf.columns + c]).toBe(
        surface.heightAt(hf.originX + c * hf.cellSize, hf.originY + r * hf.cellSize),
      );
    expect(t.features.buildings.map((b) => b.id)).toEqual(['house']);
    expect(t.features.roads.every((r) => r.centerline.every((p) => p.x >= -150 && p.x <= 50))).toBe(
      true,
    );
    expect(t.grading?.water).toBe(water);
  });

  it('clips lines and rings to a rectangle', () => {
    const r = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(
      clipLine(
        [
          { x: -5, y: 5 },
          { x: 15, y: 5 },
        ],
        r,
      ),
    ).toEqual([
      [
        { x: 0, y: 5 },
        { x: 10, y: 5 },
      ],
    ]);
    expect(
      clipLine(
        [
          { x: -5, y: 5 },
          { x: 5, y: 5 },
          { x: 5, y: 15 },
          { x: 5, y: 20 },
        ],
        r,
      ),
    ).toEqual([
      [
        { x: 0, y: 5 },
        { x: 5, y: 5 },
        { x: 5, y: 10 },
      ],
    ]);
    const clipped = clipRing(rect(-5, -5, 5, 5), r);
    expect(clipped).toHaveLength(4);
    expect(clipped.every((p) => p.x >= 0 && p.y >= 0)).toBe(true);
  });
});
