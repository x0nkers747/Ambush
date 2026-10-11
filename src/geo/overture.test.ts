import { describe, expect, it } from 'vitest';
import { polygonArea, type Vec2 } from '#sim';
import {
  encodeMvt,
  QUANTICO_CENTRE,
  QUANTICO_OVERTURE_TILES,
  type TestFeature,
} from '#geo/fixtures';
import { createFrame, toLocal } from './frame';
import {
  buildingsFromOverture,
  dissolveSeams,
  OVERTURE_ATTRIBUTION,
  overtureAttribution,
  overtureTilesFor,
  type OvertureTile,
} from './overture';

// Buildings from Overture Maps' vector tiles (docs/adr/0023).

const Z = 14;
const EXTENT = 4096;
const frame = createFrame(QUANTICO_CENTRE, 5000);
/** The tile at the battlefield's centre, and its neighbours east and south. */
const tiles = overtureTilesFor(frame);
const centreTile = (() => {
  const n = 2 ** Z;
  const x = Math.floor(((QUANTICO_CENTRE.lon + 180) / 360) * n);
  const phi = (QUANTICO_CENTRE.lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n);
  return { x, y };
})();
const { x: X, y: Y } = centreTile;

/** The local metres of a point given in global tile coordinates at zoom 14. */
const local = (gx: number, gy: number): Vec2 => {
  const world = EXTENT * 2 ** Z;
  return toLocal(frame, {
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / world))) * 180) / Math.PI,
    lon: (gx / world) * 360 - 180,
  });
};
/** The area in square metres of a polygon given in global tile coordinates. */
const areaOf = (ring: readonly (readonly [number, number])[]) =>
  polygonArea(ring.map(([gx, gy]) => local(gx, gy)));

/** A tile at (x, y) holding the given features, each ring given in global tile coordinates. */
function tile(x: number, y: number, features: readonly TestFeature[]): OvertureTile {
  const x0 = x * EXTENT;
  const y0 = y * EXTENT;
  return {
    z: Z,
    x,
    y,
    column: x,
    data: encodeMvt([
      {
        name: 'building',
        features: features.map((f) => ({
          ...f,
          geometry: f.geometry.map((r) =>
            r.map(([gx, gy]): [number, number] => [gx - x0, gy - y0]),
          ),
        })),
      },
    ]),
  };
}
/** A rectangle ring in global tile coordinates (exterior: clockwise with y south). */
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const building = (
  id: string,
  rings: [number, number][][],
  properties: TestFeature['properties'] = {},
): TestFeature => ({ type: 3, properties: { id, ...properties }, geometry: rings });

describe('overtureTilesFor', () => {
  it('covers the battlefield and its margin with zoom 14 tiles', () => {
    expect(tiles.length).toBe(12);
    expect(tiles.every((t) => t.z === 14 && t.column === t.x)).toBe(true);
    expect(tiles).toContainEqual({ z: 14, x: X, y: Y, column: X });
    const xs = tiles.map((t) => t.x);
    const ys = tiles.map((t) => t.y);
    expect(Math.max(...xs) - Math.min(...xs) + 1).toBe(4);
    expect(Math.max(...ys) - Math.min(...ys) + 1).toBe(3);
  });

  it('keeps columns contiguous across ±180°', () => {
    const across = overtureTilesFor(createFrame({ lat: 10, lon: 179.99 }, 5000));
    const columns = [...new Set(across.map((t) => t.column))].sort((a, b) => a - b);
    expect(columns.at(-1)).toBeGreaterThanOrEqual(2 ** 14);
    columns.forEach((c, i) => {
      if (i > 0) expect(c - (columns[i - 1] ?? c)).toBe(1);
    });
    expect(across.every((t) => t.x >= 0 && t.x < 2 ** 14 && t.x === t.column % 2 ** 14)).toBe(true);
  });
});

describe('dissolveSeams', () => {
  it('joins two pieces along a shared seam into one outline', () => {
    const rings = dissolveSeams([rect(0, 0, 10, 5), rect(10, 0, 20, 5)], new Set([10]), new Set());
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
    expect(new Set(rings[0]?.map((p) => p.join(',')))).toEqual(
      new Set(['0,0', '20,0', '20,5', '0,5']),
    );
  });

  it('cuts seam edges where the other piece meets them, so partial overlaps still cancel', () => {
    // An L: a tall piece left of the seam, a short one right of it.
    const rings = dissolveSeams([rect(0, 0, 10, 10), rect(10, 0, 20, 4)], new Set([10]), new Set());
    expect(rings).toHaveLength(1);
    expect(new Set(rings[0]?.map((p) => p.join(',')))).toEqual(
      new Set(['0,0', '20,0', '20,4', '10,4', '10,10', '0,10']),
    );
  });
});

describe('buildingsFromOverture', () => {
  const x0 = X * EXTENT;
  const y0 = Y * EXTENT;

  it('joins a building cut by a tile edge, whatever reaches into each tile’s buffer', () => {
    // One building 400 × 100 units across the seam between X and X + 1; each tile also
    // holds the part in its buffer, as vector tiles do.
    const whole = rect(x0 + 3900, y0 + 1000, x0 + 4300, y0 + 1100);
    const result = buildingsFromOverture(
      [tile(X, Y, [building('b1', [whole])]), tile(X + 1, Y, [building('b1', [whole])])],
      frame,
    );
    expect(result.report.merged).toBe(1);
    expect(result.buildings).toHaveLength(1);
    const [b] = result.buildings;
    expect(b?.id).toBe('ovt-b1');
    expect(b?.footprint).toHaveLength(4);
    expect(polygonArea(b?.footprint ?? [])).toBeCloseTo(areaOf(whole), 6);
  });

  it('keeps Overture’s architecture fields for display, leaving the height rule as it was', () => {
    const r = rect(x0 + 1000, y0 + 1000, x0 + 1100, y0 + 1080);
    const result = buildingsFromOverture(
      [
        tile(X, Y, [
          building('h', [r], {
            class: 'house',
            num_floors: 2,
            roof_shape: 'gabled',
            roof_direction: 30,
            roof_material: 'roof_tiles',
            facade_color: 'white',
          }),
        ]),
      ],
      frame,
    );
    const [b] = result.buildings;
    // Two floors × 3 m, as before.
    expect(b?.heightMeters).toBe(6);
    expect(b?.appearance).toEqual({
      kind: 'house',
      levels: 2,
      roofShape: 'gabled',
      // The ridge bears 30°; the main face points 90° from it.
      roofDirectionDegrees: 120,
      roofMaterial: 'roof_tiles',
      wallColour: '#ffffff',
    });
  });

  it('joins a U-shaped building that crosses a seam twice, and one cut four ways at a tile corner', () => {
    // A U opening south across the seam at x0 + 4096.
    const u: [number, number][] = [
      [x0 + 3900, y0 + 2000],
      [x0 + 4300, y0 + 2000],
      [x0 + 4300, y0 + 2300],
      [x0 + 4200, y0 + 2300],
      [x0 + 4200, y0 + 2100],
      [x0 + 4000, y0 + 2100],
      [x0 + 4000, y0 + 2300],
      [x0 + 3900, y0 + 2300],
    ];
    // A square on the corner shared by four tiles.
    const corner = rect(x0 + 4000, y0 + 4000, x0 + 4200, y0 + 4200);
    const features = [building('u', [u]), building('corner', [corner])];
    const result = buildingsFromOverture(
      [
        tile(X, Y, features),
        tile(X + 1, Y, features),
        tile(X, Y + 1, features),
        tile(X + 1, Y + 1, features),
      ],
      frame,
    );
    expect(result.report.merged).toBe(2);
    const byId = new Map(result.buildings.map((b) => [b.id, b]));
    expect(byId.get('ovt-u')?.footprint).toHaveLength(8);
    expect(polygonArea(byId.get('ovt-u')?.footprint ?? [])).toBeCloseTo(areaOf(u), 6);
    expect(byId.get('ovt-corner')?.footprint).toHaveLength(4);
    expect(polygonArea(byId.get('ovt-corner')?.footprint ?? [])).toBeCloseTo(areaOf(corner), 6);
  });

  it('takes heights from the data, else from floors, else a default (marked estimated)', () => {
    const at = (i: number) => rect(x0 + 100 * i, y0 + 100, x0 + 100 * i + 50, y0 + 150);
    const { buildings, report } = buildingsFromOverture(
      [
        tile(X, Y, [
          building('a', [at(1)], { height: 7.5, num_floors: 9 }),
          building('b', [at(2)], { num_floors: 4 }),
          building('c', [at(3)], {}),
          building('d', [at(4)], { height: 0 }),
        ]),
      ],
      frame,
    );
    expect(buildings.map((b) => [b.id, b.heightMeters, b.source?.estimated ?? []])).toEqual([
      ['ovt-a', 7.5, []],
      ['ovt-b', 12, ['heightMeters']],
      ['ovt-c', 6, ['heightMeters']],
      ['ovt-d', 6, ['heightMeters']],
    ]);
    expect(report.heights).toEqual({ data: 1, floors: 1, defaulted: 2 });
    expect(buildings[0]?.source?.ref).toBe('overture:building/a');
  });

  it('leaves out holes and underground buildings, and counts outline sources and datasets', () => {
    const outer = rect(x0 + 100, y0 + 100, x0 + 300, y0 + 300);
    const hole: [number, number][] = [
      [x0 + 150, y0 + 150],
      [x0 + 150, y0 + 250],
      [x0 + 250, y0 + 250],
      [x0 + 250, y0 + 150],
    ];
    const sources = (datasets: string[]) =>
      JSON.stringify(datasets.map((dataset) => ({ dataset, record_id: 'x' })));
    const { buildings, report } = buildingsFromOverture(
      [
        tile(X, Y, [
          building('court', [outer, hole], {
            '@geometry_source': 'OpenStreetMap',
            sources: sources(['OpenStreetMap', 'Microsoft ML Buildings']),
          }),
          building('cellar', [rect(x0 + 400, y0 + 100, x0 + 450, y0 + 150)], {
            is_underground: true,
          }),
          building('ml', [rect(x0 + 500, y0 + 100, x0 + 550, y0 + 150)], {
            '@geometry_source': 'Esri Community Maps',
            sources: 'not json',
          }),
        ]),
      ],
      frame,
    );
    expect(buildings.map((b) => b.id)).toEqual(['ovt-court', 'ovt-ml']);
    expect(polygonArea(buildings[0]?.footprint ?? [])).toBeCloseTo(areaOf(outer), 6);
    expect(report.bySource).toEqual({ OpenStreetMap: 1, 'Esri Community Maps': 1 });
    expect(report.datasets).toEqual([
      'Esri Community Maps',
      'Microsoft ML Buildings',
      'OpenStreetMap',
    ]);
    expect(report.warnings).toEqual([
      '1 building courtyard(s) are drawn as part of the building',
      '1 underground building(s) were left out',
    ]);
  });

  it('clips buildings to the battlefield, numbering the pieces, and drops what lies outside', () => {
    // The battlefield's west edge (local x = −2500) in global tile coordinates, along row Y.
    const metresPerUnit = (local(x0 + EXTENT, y0).x - local(x0, y0).x) / EXTENT;
    const edge = Math.round(x0 + (-2500 - local(x0, y0).x) / metresPerUnit);
    // A U opening east: its base lies outside the battlefield, its two arms reach inside.
    const u: [number, number][] = [
      [edge - 200, y0 + 500],
      [edge + 200, y0 + 500],
      [edge + 200, y0 + 540],
      [edge - 160, y0 + 540],
      [edge - 160, y0 + 580],
      [edge + 200, y0 + 580],
      [edge + 200, y0 + 620],
      [edge - 200, y0 + 620],
    ];
    const far = rect(edge - 3000, y0 + 500, edge - 2960, y0 + 540);
    const columns = [
      ...new Set([edge - 3000, edge - 200, edge + 200].map((g) => Math.floor(g / EXTENT))),
    ];
    const { buildings } = buildingsFromOverture(
      columns.map((c) => tile(c, Y, [building('u', [u]), building('far', [far])])),
      frame,
    );
    expect(buildings.map((b) => b.id)).toEqual(['ovt-u-1', 'ovt-u-2']);
    for (const b of buildings) {
      expect(Math.min(...b.footprint.map((p) => p.x))).toBeCloseTo(-2500, 6);
      expect(b.source?.ref).toBe('overture:building/u');
    }
  });

  it('skips missing tiles and reports unreadable ones', () => {
    const { buildings, report } = buildingsFromOverture(
      [
        { z: Z, x: X, y: Y, column: X, data: null },
        { z: Z, x: X + 1, y: Y, column: X + 1, data: new Uint8Array([0x1a, 0x05, 0x0a]) },
      ],
      frame,
    );
    expect(buildings).toEqual([]);
    expect(report.dropped).toEqual([
      {
        ref: `overture:tile/14/${String(X + 1)}/${String(Y)}`,
        reason: 'the tile could not be read (truncated field)',
      },
    ]);
  });

  it('joins the buildings real tiles cut, keeping exactly the area of their pieces', () => {
    const both = buildingsFromOverture(QUANTICO_OVERTURE_TILES, frame);
    const alone = QUANTICO_OVERTURE_TILES.map((t) => buildingsFromOverture([t], frame));
    expect(both.report.merged).toBe(6);
    const areaById = (list: typeof both.buildings) => {
      const m = new Map<string, number>();
      for (const b of list) {
        const id = b.source?.ref ?? '';
        m.set(id, (m.get(id) ?? 0) + polygonArea(b.footprint));
      }
      return m;
    };
    const joined = areaById(both.buildings);
    const [left, right] = alone.map((a) => areaById(a.buildings));
    const split = [...joined.keys()].filter((id) => left?.has(id) && right?.has(id));
    expect(split).toHaveLength(6);
    for (const id of split) {
      // One outline, with the area of the two pieces.
      expect(both.buildings.filter((b) => b.source?.ref === id)).toHaveLength(1);
      const parts = (left?.get(id) ?? 0) + (right?.get(id) ?? 0);
      expect(Math.abs((joined.get(id) ?? 0) / parts - 1)).toBeLessThan(1e-9);
    }
    // Every other building is as either tile alone gives it.
    expect(joined.size).toBe((left?.size ?? 0) + (right?.size ?? 0) - split.length);
    // Deterministic, and in Overture id order.
    expect(buildingsFromOverture([...QUANTICO_OVERTURE_TILES].reverse(), frame)).toEqual(both);
    const ids = both.buildings.map((b) => b.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('overtureAttribution', () => {
  it('credits Overture and each dataset as Overture asks, leaving OpenStreetMap to its own credit', () => {
    expect(
      overtureAttribution([
        'Esri Community Maps',
        'Microsoft ML Buildings',
        'OpenStreetMap',
        'Foo',
      ]),
    ).toEqual([
      OVERTURE_ATTRIBUTION,
      'Esri Community Maps contributors (CC BY 4.0)',
      'Global ML Building Footprints, licensed by Microsoft under the ODbL',
      'Foo (via Overture Maps)',
    ]);
  });
});
