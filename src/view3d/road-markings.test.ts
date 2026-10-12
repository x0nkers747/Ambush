import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  flatElevation,
  gradeTerrain,
  heightAt,
  NO_FEATURES,
  type DecorPoint,
  type Road,
  type RoadTraffic,
  type TerrainDataset,
} from '#sim';
import { createDraper } from './drape';
import {
  MARKING_STYLES,
  MARKING_VERSION,
  markingSpec,
  planMarkings,
  roadMarkings,
  type PaintPiece,
} from './road-markings';
import { ROAD_STYLE } from './road-geometry';

// Road markings (docs/adr/0037).

const road = (
  id: string,
  pts: [number, number][],
  highway: string,
  extra: Partial<Road> & { traffic?: RoadTraffic } = {},
): Road => ({
  id,
  roadClass:
    highway === 'primary' || highway === 'secondary' || highway === 'motorway' ? 'major' : 'paved',
  widthMeters: highway === 'primary' || highway === 'secondary' || highway === 'motorway' ? 8 : 6,
  centerline: pts.map(([x, y]) => ({ x, y })),
  highway,
  ...extra,
});
const straight = (highway: string, extra: Partial<Road> = {}) =>
  road(
    'r',
    [
      [0, 0],
      [200, 0],
    ],
    highway,
    extra,
  );

function world(
  roads: Road[],
  points: DecorPoint[] = [],
  ground = flatElevation(20),
): TerrainDataset {
  return {
    ...createSyntheticTerrain(
      { originX: -300, originY: -300, cellSize: 10, columns: 61, rows: 61 },
      ground,
      {
        ...NO_FEATURES,
        roads,
      },
    ),
    ...(points.length ? { decor: { points, lines: [] } } : {}),
  };
}

const roles = (s: ReturnType<typeof markingSpec>) => (s?.lines ?? []).map((l) => l.role).sort();
const piecesOf = (pieces: readonly PaintPiece[], role: PaintPiece['role'], offset?: number) =>
  pieces
    .filter((p) => p.role === role && (offset === undefined || Math.abs(p.offset - offset) < 1e-6))
    .sort((a, b) => a.chain - b.chain || a.s0 - b.s0);

describe('which roads are painted', () => {
  const na = 'north-american' as const;
  const eu = 'central-european' as const;

  it('leaves residential streets, service roads, driveways, tracks and paths bare', () => {
    for (const region of [na, eu]) {
      expect(markingSpec(straight('residential', { widthMeters: 4 }), region, true)).toBeNull();
      expect(markingSpec(straight('residential', { widthMeters: 8 }), region, true)).toBeNull();
      expect(markingSpec(straight('service', { widthMeters: 9 }), region, false)).toBeNull();
      expect(markingSpec(straight('service', { service: 'driveway' }), region, false)).toBeNull();
      expect(
        markingSpec(straight('track', { roadClass: 'track', widthMeters: 3 }), region, false),
      ).toBeNull();
      expect(
        markingSpec(straight('footway', { roadClass: 'path', widthMeters: 2 }), region, false),
      ).toBeNull();
      // Unpaved surfaces, roundabout rings, and roads tagged unmarked.
      expect(
        markingSpec(straight('tertiary', { traffic: { surface: 'gravel' } }), region, false),
      ).toBeNull();
      expect(
        markingSpec(straight('tertiary', { traffic: { junction: 'roundabout' } }), region, false),
      ).toBeNull();
      expect(
        markingSpec(straight('primary', { traffic: { laneMarkings: false } }), region, false),
      ).toBeNull();
    }
    // Unless the source says it is painted.
    const tagged = markingSpec(
      straight('residential', { widthMeters: 7, traffic: { laneMarkings: true } }),
      na,
      true,
    );
    expect(roles(tagged)).toEqual(['centre', 'centre', 'edge', 'edge']);
  });

  it('paints a rural paved road with a centreline, and edges only when it is wide', () => {
    const narrow = markingSpec(straight('tertiary'), eu, false);
    expect(roles(narrow)).toEqual(['centre']);
    const centre = narrow?.lines[0];
    expect(centre?.color).toBe('white');
    expect([centre?.dash, centre?.gap]).toEqual([6, 12]); // Leitlinie outside towns
    expect(markingSpec(straight('tertiary'), eu, true)?.lines[0]?.dash).toBe(3); // and in towns
    expect(roles(markingSpec(straight('tertiary', { widthMeters: 7 }), eu, false))).toEqual([
      'centre',
      'edge',
      'edge',
    ]);
    expect(markingSpec(straight('tertiary', { widthMeters: 5 }), eu, false)).toBeNull();
    // Minor roads: painted in North America when wide enough, not by default in Germany.
    expect(roles(markingSpec(straight('unclassified'), na, false))).toEqual(['centre']);
    expect(markingSpec(straight('unclassified'), eu, false)).toBeNull();
  });

  it("paints primary roads with centrelines and edge lines, in the region's colours", () => {
    const us = markingSpec(straight('primary'), na, false);
    const de = markingSpec(straight('primary'), eu, false);
    expect(us?.lines.filter((l) => l.role === 'centre').every((l) => l.color === 'yellow')).toBe(
      true,
    );
    expect(de?.lines.every((l) => l.color === 'white')).toBe(true);
    expect(us?.lines.filter((l) => l.role === 'edge').every((l) => l.color === 'white')).toBe(true);
    // US dashes are 10 ft with 30 ft gaps.
    const dash = us?.lines.find((l) => l.role === 'centre' && l.dash > 0);
    expect(dash?.dash).toBeCloseTo(3.05, 2);
    expect(dash?.gap).toBeCloseTo(9.15, 2);
    // In built-up places a US two-way road gets a double solid yellow line.
    const urban = markingSpec(straight('primary'), na, true);
    const centres = urban?.lines.filter((l) => l.role === 'centre') ?? [];
    expect(centres).toHaveLength(2);
    expect(centres.every((l) => l.dash === 0 && l.color === 'yellow')).toBe(true);
    expect(Math.abs((centres[0]?.offset ?? 0) - (centres[1]?.offset ?? 0))).toBeCloseTo(
      MARKING_STYLES[na].doubleSpacing,
      6,
    );
  });

  it('separates lanes going the same way, where the lanes are', () => {
    const four = markingSpec(
      straight('primary', { widthMeters: 14, traffic: { lanes: 4 } }),
      eu,
      false,
    );
    const seps = four?.lines.filter((l) => l.role === 'separator') ?? [];
    expect(seps).toHaveLength(2);
    expect(seps.every((l) => l.color === 'white' && l.dash > 0)).toBe(true);
    // At lane boundaries: 3.5 m lanes either side of the centre.
    expect(seps.map((l) => Math.abs(l.offset)).sort()).toEqual([3.5, 3.5]);
    // Asymmetric lanes move the centreline.
    const three = markingSpec(
      straight('primary', {
        widthMeters: 10.5,
        traffic: { lanes: 3, lanesForward: 2, lanesBackward: 1 },
      }),
      eu,
      false,
    );
    const c = three?.lines.find((l) => l.role === 'centre');
    expect(c?.offset).toBeCloseTo(10.5 / 2 - 3.5, 6);
    expect(three?.lines.filter((l) => l.role === 'separator')).toHaveLength(1);
  });

  it('gives one-way and divided roads separators and edges, but no line between opposing traffic', () => {
    const oneway = markingSpec(
      straight('secondary', { traffic: { oneway: 'yes', lanes: 2 } }),
      na,
      false,
    );
    expect(oneway?.lines.some((l) => l.role === 'centre')).toBe(false);
    expect(oneway?.lines.filter((l) => l.role === 'separator')).toHaveLength(1);
    // US: the left edge of a divided carriageway is yellow, the right edge white.
    const left = oneway?.lines.find((l) => l.role === 'edge' && l.offset > 0);
    const right = oneway?.lines.find((l) => l.role === 'edge' && l.offset < 0);
    expect(left?.color).toBe('yellow');
    expect(right?.color).toBe('white');
    // A way running against its traffic has its yellow edge on the other side.
    const reverse = markingSpec(
      straight('secondary', { traffic: { oneway: 'reverse', lanes: 2 } }),
      na,
      false,
    );
    expect(reverse?.lines.find((l) => l.role === 'edge' && l.offset < 0)?.color).toBe('yellow');
    // A motorway carriageway with three lanes, in Germany: two separators, wide white edges.
    const autobahn = markingSpec(
      straight('motorway', { widthMeters: 11, traffic: { oneway: 'yes', lanes: 3 } }),
      eu,
      false,
    );
    expect(autobahn?.lines.filter((l) => l.role === 'separator')).toHaveLength(2);
    expect(autobahn?.lines.filter((l) => l.role === 'edge').every((l) => l.width === 0.25)).toBe(
      true,
    );
    // A two-way road with a physical median: edges, no centreline.
    const median = markingSpec(straight('primary', { traffic: { divider: 'barrier' } }), na, false);
    expect(roles(median)).toEqual(['edge', 'edge']);
  });

  it('follows the source on passing: solid where it may not, solid and dashed for one direction', () => {
    const no = markingSpec(straight('primary', { traffic: { overtaking: 'no' } }), eu, false);
    expect(no?.lines.filter((l) => l.role === 'centre')).toHaveLength(1);
    expect(no?.lines.find((l) => l.role === 'centre')?.dash).toBe(0);
    const fwd = markingSpec(straight('primary', { traffic: { overtaking: 'forward' } }), na, false);
    const pair = fwd?.lines.filter((l) => l.role === 'centre') ?? [];
    // Forward traffic (right of the line) may pass: the line nearer it is dashed.
    expect(pair.find((l) => l.offset < 0)?.dash).toBeGreaterThan(0);
    expect(pair.find((l) => l.offset > 0)?.dash).toBe(0);
  });

  it('marks only main roads on older battlefields that keep no road types', () => {
    const old = (roadClass: Road['roadClass']) => {
      const r: Road = {
        id: 'r',
        roadClass,
        widthMeters: 8,
        centerline: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
      };
      return markingSpec(r, 'generic', false);
    };
    expect(old('major')).not.toBeNull();
    expect(old('paved')).toBeNull();
  });
});

describe('marking geometry', () => {
  it('lays dashes by distance, at the regional length and gap, whatever the vertex spacing', () => {
    // One road with unevenly spaced points.
    const pts: [number, number][] = [
      [-250, 0],
      [-243, 0],
      [-200, 0],
      [-199, 0],
      [-50, 0],
      [100, 0],
      [250, 0],
    ];
    const plan = planMarkings(world([road('a', pts, 'tertiary')]), 'central-european');
    const dashes = piecesOf(plan.pieces, 'centre');
    expect(dashes.length).toBeGreaterThan(20);
    for (const d of dashes) expect(d.s1 - d.s0).toBeCloseTo(6, 6);
    for (let i = 1; i < dashes.length; i += 1) {
      expect((dashes[i]?.s0 ?? 0) - (dashes[i - 1]?.s1 ?? 0)).toBeCloseTo(12, 6);
    }
  });

  it('keeps the dash rhythm across a road split into several ways', () => {
    const whole = planMarkings(
      world([
        road(
          'a',
          [
            [-250, 0],
            [250, 0],
          ],
          'tertiary',
        ),
      ]),
      'north-american',
    );
    const split = planMarkings(
      world([
        road(
          'a1',
          [
            [-250, 0],
            [-120, 0],
          ],
          'tertiary',
        ),
        road(
          'a2',
          [
            [-120, 0],
            [37.3, 0],
          ],
          'tertiary',
        ),
        // Drawn backwards: still joined, in the chain's direction.
        road(
          'a3',
          [
            [250, 0],
            [37.3, 0],
          ],
          'tertiary',
        ),
      ]),
      'north-american',
    );
    expect(split.chains).toHaveLength(1);
    expect(split.chains[0]?.roads).toEqual(['a1', 'a2', 'a3']);
    const key = (p: readonly PaintPiece[]) =>
      piecesOf(p, 'centre').map((d) => [d.s0.toFixed(6), d.s1.toFixed(6)]);
    expect(key(split.pieces)).toEqual(key(whole.pieces));
  });

  it('does not join ways with different markings', () => {
    const plan = planMarkings(
      world([
        road(
          'a',
          [
            [-250, 0],
            [0, 0],
          ],
          'tertiary',
        ),
        road(
          'b',
          [
            [0, 0],
            [250, 0],
          ],
          'primary',
        ),
      ]),
      'central-european',
    );
    expect(plan.chains).toHaveLength(2);
  });

  it('follows curves smoothly, at a constant offset from the centreline', () => {
    // A quarter circle of radius 120 m in 30 short segments.
    const pts: [number, number][] = Array.from({ length: 31 }, (_, i) => {
      const a = (i / 30) * (Math.PI / 2);
      return [-150 + 120 * Math.cos(a), -150 + 120 * Math.sin(a)];
    });
    const plan = planMarkings(world([road('curve', pts, 'primary')]), 'central-european');
    const edges = plan.quads.filter(
      (q) => q.halfWidth === MARKING_STYLES['central-european'].edgeWidth / 2,
    );
    expect(edges.length).toBeGreaterThan(20);
    for (const q of edges) {
      for (const p of [q.a, q.b]) {
        const r = Math.hypot(p.x + 150, p.y + 150);
        // The edges lie 3.75 m either side of the 120 m centreline radius (to a few cm: chords).
        expect(Math.min(Math.abs(r - 123.75), Math.abs(r - 116.25))).toBeLessThan(0.05);
      }
    }
  });

  it('breaks offset lines at sharp bends, rather than folding them', () => {
    const plan = planMarkings(
      world([
        road(
          'bend',
          [
            [-200, 0],
            [0, 0],
            [0, 200],
          ],
          'primary',
        ),
      ]),
      'central-european',
    );
    const edges = piecesOf(plan.pieces, 'edge');
    for (const e of edges) expect(e.s0 > 205 || e.s1 < 195).toBe(true);
  });

  it('stops at junctions and side roads, and resumes beyond them in rhythm', () => {
    // A main road with a side road joining from the south at x = 0, and a crossroads at x = 150.
    const plan = planMarkings(
      world([
        road(
          'main',
          [
            [-250, 0],
            [0, 0],
            [150, 0],
            [250, 0],
          ],
          'primary',
        ),
        road(
          'side',
          [
            [0, -200],
            [0, 0],
          ],
          'tertiary',
        ),
        road(
          'cross',
          [
            [150, -200],
            [150, 0],
            [150, 200],
          ],
          'primary',
        ),
      ]),
      'central-european',
    );
    const mainChain = plan.chains.findIndex((c) => c.roads.includes('main'));
    const main = plan.pieces.filter((p) => p.chain === mainChain);
    const atX = (p: PaintPiece): [number, number] => [p.s0 - 250, p.s1 - 250];
    for (const p of main) {
      const [x0, x1] = atX(p);
      // Nothing within the crossing road's surface (4 m) plus a metre.
      expect(x1 <= 145 + 1e-6 || x0 >= 155 - 1e-6).toBe(true);
    }
    // The edge on the side road's side breaks for it; the far edge runs on (no road joins there).
    const south = main.filter((p) => p.role === 'edge' && p.offset < 0);
    const north = main.filter((p) => p.role === 'edge' && p.offset > 0);
    for (const p of south) {
      const [x0, x1] = atX(p);
      expect(x1 < -3 || x0 > 3).toBe(true);
    }
    expect(north.some((p) => atX(p)[0] < -3 && atX(p)[1] > 3)).toBe(true);
    // The side road's centreline stops short of the main road.
    const sideChain = plan.chains.findIndex((c) => c.roads.includes('side'));
    for (const p of plan.pieces.filter((x) => x.chain === sideChain))
      expect(p.s1).toBeLessThan(200 - 4);
    // Dashes resume in rhythm: every dash starts on the 18 m period.
    for (const p of main.filter((x) => x.role === 'centre')) {
      const phase = p.s0 % 18;
      expect(phase < 1e-6 || phase > 18 - 1e-6 || p.s1 - p.s0 < 6 - 1e-6).toBe(true);
    }
  });

  it('leaves out fragments too short to read, and handles very short roads', () => {
    const plan = planMarkings(
      world([
        road(
          'stub',
          [
            [0, 0],
            [1.5, 0],
          ],
          'primary',
        ),
        road(
          't',
          [
            [0, 50],
            [8, 50],
            [8.5, 50],
          ],
          'tertiary',
        ),
      ]),
      'central-european',
    );
    for (const p of plan.pieces) {
      expect(p.s1 - p.s0).toBeGreaterThanOrEqual(p.role === 'edge' ? 2 - 1e-9 : 3 - 1e-9);
    }
  });

  it('leaves roundabout rings bare, and stops the approaches at them', () => {
    const ring: [number, number][] = Array.from({ length: 13 }, (_, i) => {
      const a = (i / 12) * 2 * Math.PI;
      return [20 * Math.cos(a), 20 * Math.sin(a)];
    });
    const plan = planMarkings(
      world([
        road('ring', ring, 'primary', { traffic: { junction: 'roundabout', oneway: 'yes' } }),
        road(
          'west',
          [
            [-250, 0],
            [-20, 0],
          ],
          'primary',
        ),
      ]),
      'central-european',
    );
    expect(plan.chains.every((c) => !c.roads.includes('ring'))).toBe(true);
    // Nothing reaches the ring's surface (4 m from its centreline).
    for (const p of plan.pieces) expect(p.s1).toBeLessThanOrEqual(226);
  });

  it('paints mapped crossings and stop lines, and clears the lines through crossings', () => {
    const plan = planMarkings(
      world(
        [
          road(
            'main',
            [
              [-250, 0],
              [250, 0],
            ],
            'primary',
          ),
          road(
            'side',
            [
              [100, -200],
              [100, 0],
            ],
            'tertiary',
          ),
        ],
        [
          { id: 'x1', kind: 'crossing', position: { x: -100, y: 0 }, crossing: 'zebra' },
          { id: 'x2', kind: 'crossing', position: { x: 0, y: 0.5 }, crossing: 'lines' },
          { id: 's1', kind: 'trafficSign', position: { x: 100, y: -12 }, sign: 'stop' },
        ],
      ),
      'north-american',
    );
    expect(plan.stats.crossings).toBe(2);
    expect(plan.stats.stopLines).toBe(1);
    const main = plan.chains.findIndex((c) => c.roads.includes('main'));
    for (const p of plan.pieces.filter((x) => x.chain === main && x.role === 'centre')) {
      const x0 = p.s0 - 250;
      const x1 = p.s1 - 250;
      expect(x1 < -103 || x0 > -97).toBe(true);
    }
    // The stop line lies across the right half of the side road's approach.
    const stop = plan.quads.find(
      (q) => q.halfWidth === MARKING_STYLES['north-american'].stopLineWidth / 2,
    );
    expect(stop).toBeDefined();
    expect(Math.abs((stop?.a.y ?? 0) - (stop?.b.y ?? 1))).toBeLessThan(1e-6);
    expect(Math.min(stop?.a.x ?? 0, stop?.b.x ?? 0)).toBeGreaterThanOrEqual(100 - 1e-6);
  });
});

describe('the markings mesh', () => {
  const roads = [
    road(
      'main',
      [
        [-250, -40],
        [-60, -20],
        [60, 30],
        [250, 40],
      ],
      'primary',
    ),
    road(
      'side',
      [
        [0, -250],
        [0, 4.3],
      ],
      'tertiary',
    ),
  ];

  it('lies on the graded road surface, crossing refinement tiles, with no invalid values', () => {
    const terrain = gradeTerrain(
      world(roads, [], (x, y) => 20 + 6 * Math.sin(x / 40) + 4 * Math.cos(y / 55)),
    );
    expect(terrain.refinement).toBeDefined();
    const { mesh, stats } = roadMarkings(terrain, createDraper(terrain), 'north-american');
    expect(stats.triangles).toBe(mesh.triangleCount);
    expect(mesh.triangleCount).toBeGreaterThan(50);
    expect(mesh.positions.length).toBe(mesh.triangleCount * 9);
    expect(mesh.colors?.length).toBe(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? NaN;
      const z = mesh.positions[i + 1] ?? NaN;
      const y = -(mesh.positions[i + 2] ?? NaN);
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      // Just above its road's surface, which is just above the ground.
      const above = z - heightAt(terrain, x, y);
      expect(above).toBeGreaterThan(ROAD_STYLE.paved.offset);
      expect(above).toBeLessThan(ROAD_STYLE.major.offset + 0.02);
    }
  });

  it('is the same whatever order the roads come in, and on every build', () => {
    const a = planMarkings(world(roads), 'central-european');
    const b = planMarkings(world([...roads].reverse()), 'central-european');
    expect(b.pieces).toEqual(a.pieces);
    expect(b.quads).toEqual(a.quads);
    expect(planMarkings(world(roads), 'central-european')).toEqual(a);
    expect(MARKING_VERSION).toBe(2);
  });

  it('differs between regions only where conventions differ', () => {
    const us = planMarkings(world(roads), 'north-american');
    const de = planMarkings(world(roads), 'central-european');
    const colours = (p: readonly PaintPiece[]) =>
      new Set(p.filter((x) => x.role === 'centre').map((x) => x.color));
    expect([...colours(us.pieces)]).toEqual(['yellow']);
    expect([...colours(de.pieces)]).toEqual(['white']);
    expect(us.pieces.filter((x) => x.role === 'separator').every((x) => x.color === 'white')).toBe(
      true,
    );
  });
});

describe('markings and grade separation (docs/adr/0044)', () => {
  const eu = 'central-european' as const;
  const across: [number, number][] = [
    [-250, 0],
    [250, 0],
  ];
  const along: [number, number][] = [
    [0, -250],
    [0, 250],
  ];

  it('paints nothing on a road in a tunnel', () => {
    const plan = planMarkings(
      world([road('t', across, 'primary', { crossing: { kind: 'tunnel', value: 'yes' } })]),
      eu,
    );
    expect(plan.pieces).toEqual([]);
  });

  it('does not stop an overpass line for the road under it, but does at a junction', () => {
    // The continuous edge lines (the centre line is dashed).
    const covered = (pieces: readonly PaintPiece[]) =>
      piecesOf(pieces, 'edge', 3.75).some((p) => p.s0 <= 250 && p.s1 >= 250);
    // The bridge crosses the road below with no shared node: its centre line runs on.
    const over = planMarkings(
      world([
        road('below', along, 'primary'),
        road('bridge', across, 'primary', { crossing: { kind: 'bridge', value: 'yes', layer: 1 } }),
      ]),
      eu,
    );
    const bridgeChain = over.chains.findIndex((c) => c.roads.includes('bridge'));
    expect(covered(over.pieces.filter((p) => p.chain === bridgeChain))).toBe(true);
    // The same roads on one level, meeting at a node: the line stops at the junction.
    const level = planMarkings(
      world([
        road(
          'below',
          [
            [0, -250],
            [0, 0],
            [0, 250],
          ],
          'primary',
        ),
        road(
          'cross',
          [
            [-250, 0],
            [0, 0],
            [250, 0],
          ],
          'primary',
        ),
      ]),
      eu,
    );
    const crossChain = level.chains.findIndex((c) => c.roads.includes('cross'));
    const at = (pieces: readonly PaintPiece[], s: number) =>
      piecesOf(pieces, 'centre').some((p) => p.s0 <= s && p.s1 >= s);
    expect(
      at(
        level.pieces.filter((p) => p.chain === crossChain),
        250,
      ),
    ).toBe(false);
  });
});
