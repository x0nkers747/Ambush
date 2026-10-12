import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  flatElevation,
  heightAt,
  NO_FEATURES,
  type Road,
  type RoadClass,
  type RoadCrossing,
} from '#sim';
import { createDraper, type MeshData } from './drape';
import { convexMinus, convexOverlap, signedArea2 } from './planar';
import { ROAD_OFFSET_M, roadSurfaces, type RoadLayer } from './road-geometry';
import { coverage, roughGround, triangles } from './test-helpers';

// Road junctions as one coherent surface (docs/adr/0044): every point of the
// network is covered by one surface, the most important road's; side roads
// stop at the edge of the road they join; corners get small fillets; roads on
// different levels stay whole; tunnels are not drawn on the surface.

const flat = createSyntheticTerrain(
  { originX: -300, originY: -300, cellSize: 10, columns: 61, rows: 61 },
  flatElevation(10),
  NO_FEATURES,
);
const WIDTH: Record<RoadClass, number> = { major: 10, paved: 6, unpaved: 4, track: 3, path: 2 };
const road = (
  id: string,
  roadClass: RoadClass,
  pts: [number, number][],
  extra: Partial<Road> = {},
): Road => ({
  id,
  roadClass,
  widthMeters: WIDTH[roadClass],
  centerline: pts.map(([x, y]) => ({ x, y })),
  ...extra,
});

/** Builds the surface and returns, for any point, the layers covering it there. */
function surface(roads: readonly Road[], terrain = flat) {
  const built = roadSurfaces(roads, createDraper(terrain));
  const cover = [...built.layers].map(([layer, mesh]) => [layer, coverage(mesh)] as const);
  const at = (x: number, y: number): RoadLayer[] =>
    cover.filter(([, c]) => c.covered(x, y)).map(([layer]) => layer);
  return { built, at };
}

/** No point on a grid over the box is covered by two layers. */
function expectNoOverlap(at: (x: number, y: number) => RoadLayer[], box: number, step = 0.37) {
  for (let x = -box; x <= box; x += step)
    for (let y = -box; y <= box; y += step) expect(at(x, y).length).toBeLessThanOrEqual(1);
}

describe('convex pieces', () => {
  it('subtracts one convex polygon from another exactly, into disjoint pieces', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    const hole = [4, 4, 6, 4, 6, 6, 4, 6];
    const pieces = convexMinus(square, hole);
    const area = pieces.reduce((s, p) => s + signedArea2(p) / 2, 0);
    expect(area).toBeCloseTo(100 - 4, 9);
    for (const p of pieces) expect(convexOverlap(p, hole)).toBe(false);
    for (let i = 0; i < pieces.length; i += 1)
      for (let j = i + 1; j < pieces.length; j += 1)
        expect(convexOverlap(pieces[i] ?? [], pieces[j] ?? [])).toBe(false);
    // Disjoint: nothing to subtract.
    expect(convexMinus(square, [20, 20, 30, 20, 30, 30])).toEqual([square]);
    // Covered: nothing left.
    expect(convexMinus(hole, square)).toEqual([]);
  });
});

describe('junctions', () => {
  it('lets a narrow road join a wide one at its edge, with no strip through it', () => {
    const { built, at } = surface([
      road('main', 'major', [
        [-200, 0],
        [0, 0],
        [200, 0],
      ]),
      road('side', 'paved', [
        [0, 0],
        [0, 150],
      ]),
    ]);
    // Across the major road at the junction: only the major road, to its edge.
    for (let y = -4.9; y <= 4.9; y += 0.7) expect(at(0.3, y)).toEqual(['major']);
    // Beyond its edge: the side road, at full width.
    for (let x = -2.9; x <= 2.9; x += 0.5) expect(at(x, 5.4)).toEqual(['paved']);
    // The major road's width is unchanged on the far side: its verge, then nothing.
    expect(at(0, -5.2)).toEqual(['verge']);
    expect(at(0, -5.8)).toEqual([]);
    // Rounded corners: a little of the side road's surface in the corners, none far out.
    expect(at(3.3, 5.3)).toEqual(['paved']);
    expect(at(6, 8)).toEqual([]);
    expect(built.stats.fillets).toBe(2);
    expectNoOverlap(at, 12);
  });

  it('makes T, four-way, acute and five-way junctions single surfaces', () => {
    const arms = (angles: number[], cls: RoadClass[]) =>
      angles.map((deg, i) =>
        road(`arm${String(i)}`, cls[i] ?? 'paved', [
          [0, 0],
          [Math.cos((deg * Math.PI) / 180) * 120, Math.sin((deg * Math.PI) / 180) * 120],
        ]),
      );
    for (const [angles, classes] of [
      [
        [0, 90, 180],
        ['paved', 'unpaved', 'paved'],
      ],
      [
        [0, 90, 180, 270],
        ['major', 'paved', 'major', 'track'],
      ],
      [
        [0, 20, 180],
        ['paved', 'unpaved', 'paved'],
      ],
      [
        [0, 72, 144, 216, 288],
        ['major', 'paved', 'unpaved', 'paved', 'path'],
      ],
    ] as [number[], RoadClass[]][]) {
      const { at } = surface(arms(angles, classes));
      // The junction itself is paved, by the most important road there.
      expect(at(0, 0)).toEqual([classes.includes('major') ? 'major' : 'paved']);
      expectNoOverlap(at, 14);
      // Every arm is drawn out to its end.
      angles.forEach((deg, i) => {
        const x = Math.cos((deg * Math.PI) / 180) * 100;
        const y = Math.sin((deg * Math.PI) / 180) * 100;
        expect(at(x, y)).toEqual([classes[i]]);
      });
    }
  });

  it('handles offset and closely spaced junctions', () => {
    const { at } = surface([
      road('main', 'major', [
        [-150, 0],
        [-4, 0],
        [4, 0],
        [150, 0],
      ]),
      road('north', 'paved', [
        [-4, 0],
        [-4, 100],
      ]),
      road('south', 'paved', [
        [4, 0],
        [4, -100],
      ]),
    ]);
    expectNoOverlap(at, 15);
    expect(at(-4, 6)).toEqual(['paved']);
    expect(at(4, -6)).toEqual(['paved']);
    expect(at(0, 0)).toEqual(['major']);
  });

  it('keeps split OSM ways and changes of width continuous', () => {
    const { at } = surface([
      road('a', 'paved', [
        [-150, 0],
        [0, 0],
      ]),
      road('b', 'paved', [
        [0, 0],
        [60, 20],
      ]),
      road(
        'c',
        'paved',
        [
          [60, 20],
          [150, 20],
        ],
        { widthMeters: 9 },
      ),
    ]);
    // No gap anywhere along the joined ways.
    for (let x = -140; x <= 140; x += 1.3) {
      const y = x < 0 ? 0 : x < 60 ? (x / 60) * 20 : 20;
      expect(at(x, y).length).toBe(1);
    }
    // The wider way is wider.
    expect(at(100, 24)).toEqual(['paved']);
    expect(at(-100, 4)).toEqual([]);
  });

  it('keeps a roundabout a ring, its centre unpaved', () => {
    const ring: [number, number][] = [];
    for (let k = 0; k <= 24; k += 1) {
      const a = (2 * Math.PI * k) / 24;
      ring.push([Math.cos(a) * 20, Math.sin(a) * 20]);
    }
    const { at } = surface([
      road('ring', 'paved', ring, { traffic: { junction: 'roundabout' } }),
      ...[0, 8, 16].map((k) => {
        const p = ring[k] ?? [0, 0];
        return road(`arm${String(k)}`, 'paved', [p, [p[0] * 5, p[1] * 5]]);
      }),
    ]);
    expect(at(0, 0)).toEqual([]);
    expect(at(8, 0)).toEqual([]);
    expect(at(20, 0)).toEqual(['paved']);
    expect(at(60, 0)).toEqual(['paved']);
  });

  it('lies on sloping ground, at one height above it', () => {
    const slope = roughGround();
    const { built } = surface(
      [
        road('m', 'major', [
          [-80, -20],
          [0, 0],
          [80, 30],
        ]),
        road('p', 'paved', [
          [0, 0],
          [-10, 80],
        ]),
      ],
      slope,
    );
    for (const [, mesh] of built.layers)
      for (const t of triangles(mesh))
        for (const v of [t.a, t.b, t.c])
          expect(v.z - heightAt(slope, v.x, v.y)).toBeCloseTo(ROAD_OFFSET_M, 3);
  });
});

describe('grade separation', () => {
  const crossing = (kind: RoadCrossing['kind'], value = 'yes', layer?: number): Partial<Road> => ({
    crossing: { kind, value, ...(layer === undefined ? {} : { layer }) },
    ...(kind === 'bridge' ? { bridge: true as const } : {}),
  });

  it('leaves an overpass and the road under it whole', () => {
    const { built, at } = surface([
      road('under', 'paved', [
        [-150, 0],
        [150, 0],
      ]),
      road(
        'over',
        'major',
        [
          [0, -150],
          [0, 150],
        ],
        crossing('bridge', 'yes', 1),
      ),
    ]);
    // Both surfaces at the crossing (one is lifted onto its bridge), and no junction.
    expect(at(1, 0).sort()).toEqual(['major', 'paved']);
    expect(at(10, 0)).toEqual(['paved']);
    expect(built.stats.junctions).toBe(0);
    expect(built.stats.fillets).toBe(0);
  });

  it('draws no surface for a tunnel, and keeps a culvert road', () => {
    const { at } = surface([
      road(
        't',
        'major',
        [
          [-150, 0],
          [150, 0],
        ],
        crossing('tunnel'),
      ),
      road(
        'c',
        'paved',
        [
          [0, -150],
          [0, 150],
        ],
        crossing('tunnel', 'culvert'),
      ),
    ]);
    expect(at(50, 0)).toEqual([]);
    expect(at(0, 50)).toEqual(['paved']);
  });

  it('does not make a junction of roads crossing without a shared node', () => {
    const { built, at } = surface([
      road('a', 'paved', [
        [-150, 0],
        [150, 0],
      ]),
      road('b', 'major', [
        [0, -150],
        [0, 150],
      ]),
    ]);
    expect(built.stats.junctions).toBe(0);
    expect(built.stats.fillets).toBe(0);
    // On one level they cannot both be seen: one surface.
    expectNoOverlap(at, 10);
  });

  it('keeps roads on different layers whole where they cross', () => {
    const { at } = surface([
      road(
        'low',
        'paved',
        [
          [-150, 0],
          [150, 0],
        ],
        { crossing: { kind: 'bridge', layer: -1 } },
      ),
      road(
        'high',
        'paved',
        [
          [0, -150],
          [0, 150],
        ],
        { crossing: { kind: 'bridge', layer: 1 } },
      ),
    ]);
    // Same class: one mesh, both ways whole.
    expect(at(1, 0)).toEqual(['paved']);
    expect(at(20, 0)).toEqual(['paved']);
    expect(at(0, 20)).toEqual(['paved']);
  });

  it('joins a bridge and its approach at the shared node', () => {
    const { built, at } = surface([
      road('approach', 'paved', [
        [0, -150],
        [0, 0],
      ]),
      road(
        'deck',
        'major',
        [
          [0, 0],
          [0, 150],
        ],
        crossing('bridge', 'yes', 1),
      ),
    ]);
    expect(built.stats.junctions).toBe(1);
    expectNoOverlap(at, 8);
  });
});

describe('determinism', () => {
  it('builds the same surface whatever the order of the roads', () => {
    const roads = [
      road('m', 'major', [
        [-100, 0],
        [0, 0],
        [100, 10],
      ]),
      road('p', 'paved', [
        [0, 0],
        [0, 100],
      ]),
      road('f', 'path', [
        [-50, -50],
        [50, 50],
      ]),
      road('t', 'track', [
        [0, 0],
        [-60, -90],
      ]),
    ];
    const meshes = (rs: readonly Road[]) =>
      [...roadSurfaces(rs, createDraper(flat)).layers].map(
        ([layer, m]: [RoadLayer, MeshData]) => [layer, Array.from(m.positions)] as const,
      );
    expect(meshes([...roads].reverse())).toEqual(meshes(roads));
  });
});
