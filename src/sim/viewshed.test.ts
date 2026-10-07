import { describe, expect, it } from 'vitest';
import { NO_FEATURES, rectangle, type EnvironmentFeatures } from './environment';
import type { Vec2 } from './geometry';
import { lineOfSight } from './los';
import {
  createSyntheticTerrain,
  flatElevation,
  ridgeElevation,
  type ElevationFunction,
} from './synthetic-terrain';
import {
  cellCentre,
  computeViewshed,
  computeViewshedRows,
  viewshedGrid,
  visibleCellsIn,
  type Viewshed,
} from './viewshed';

/** 200 m square, 5 m terrain cells; viewsheds on a 4 m grid (50 × 50 cells). */
function terrain(
  elevation: ElevationFunction = flatElevation(100),
  features: Partial<EnvironmentFeatures> = {},
) {
  return createSyntheticTerrain(
    { originX: -100, originY: -100, cellSize: 5, columns: 41, rows: 41 },
    elevation,
    { ...NO_FEATURES, ...features },
  );
}
const OBSERVER = { x: 0, y: -80 };

/** Whether the cell containing map point `p` is visible. */
function seen(viewshed: Viewshed, p: Vec2): boolean {
  const { grid } = viewshed;
  const c = Math.floor((p.x - grid.originX) / grid.cellSize);
  const r = Math.floor((p.y - grid.originY) / grid.cellSize);
  return viewshed.visible[r * grid.columns + c] === 1;
}

const share = (v: Viewshed) => v.visible.reduce((sum, x) => sum + x, 0) / v.visible.length;

describe('viewshedGrid', () => {
  it('covers the terrain with whole cells centred on it', () => {
    const grid = viewshedGrid(terrain(), 4);
    expect(grid).toEqual({ originX: -100, originY: -100, cellSize: 4, columns: 50, rows: 50 });
    expect(cellCentre(grid, 0, 0)).toEqual({ x: -98, y: -98 });
    expect(cellCentre(grid, 49, 49)).toEqual({ x: 98, y: 98 });
    expect(() => viewshedGrid(terrain(), 0)).toThrow(RangeError);
  });
});

describe('computeViewshed', () => {
  it('sees everything on open flat terrain', () => {
    const t = terrain();
    expect(share(computeViewshed(t, OBSERVER, viewshedGrid(t, 4)))).toBe(1);
  });

  it('agrees cell by cell with the exact line-of-sight query', () => {
    const t = terrain(ridgeElevation({ base: 100, height: 6, crestY: -20, halfWidth: 25 }), {
      buildings: [{ id: 'B-1', footprint: rectangle(-30, 20, 20, 10, 15), heightMeters: 7 }],
      vegetation: [
        {
          id: 'V-1',
          kind: 'woodland',
          boundary: rectangle(40, 40, 30, 30),
          canopyHeightMeters: 12,
          seeThroughMeters: 15,
        },
      ],
    });
    const grid = viewshedGrid(t, 4);
    const viewshed = computeViewshed(t, OBSERVER, grid);
    let blocked = 0;
    for (let r = 0; r < grid.rows; r += 1) {
      for (let c = 0; c < grid.columns; c += 1) {
        const clear = lineOfSight(t, OBSERVER, cellCentre(grid, c, r)).clear;
        expect(viewshed.visible[r * grid.columns + c]).toBe(clear ? 1 : 0);
        if (!clear) blocked += 1;
      }
    }
    expect(blocked).toBeGreaterThan(200);
  });

  it('is deterministic and the same when computed in parts', () => {
    const t = terrain(ridgeElevation({ base: 100, height: 6, crestY: -20, halfWidth: 25 }));
    const grid = viewshedGrid(t, 4);
    const whole = computeViewshed(t, OBSERVER, grid);
    expect(computeViewshed(t, OBSERVER, grid)).toEqual(whole);
    const parts = new Uint8Array(grid.rows * grid.columns);
    for (const [start, end] of [
      [30, 50],
      [0, 13],
      [13, 30],
    ] as const) {
      parts.set(computeViewshedRows(t, OBSERVER, grid, start, end), start * grid.columns);
    }
    expect(parts).toEqual(whole.visible);
  });

  it('is shadowed behind a ridge but sees its near slope and crest', () => {
    const t = terrain(ridgeElevation({ base: 100, height: 8, crestY: 0, halfWidth: 20 }));
    const v = computeViewshed(t, OBSERVER, viewshedGrid(t, 4));
    expect(seen(v, { x: 0, y: -10 })).toBe(true); // near slope
    expect(seen(v, { x: 0, y: 1 })).toBe(true); // crest
    expect(seen(v, { x: 0, y: 30 })).toBe(false); // behind
    expect(seen(v, { x: 60, y: 60 })).toBe(false);
  });

  it('casts a shadow behind a building but sees past its ends and over a low one', () => {
    const tall = terrain(flatElevation(100), {
      buildings: [{ id: 'B-1', footprint: rectangle(0, -40, 20, 6), heightMeters: 6 }],
    });
    const v = computeViewshed(tall, OBSERVER, viewshedGrid(tall, 4));
    expect(seen(v, { x: 0, y: 0 })).toBe(false); // straight behind
    expect(seen(v, { x: 10, y: 60 })).toBe(false); // the shadow widens with distance
    expect(seen(v, { x: 40, y: 0 })).toBe(true); // beside it
    expect(seen(v, { x: -40, y: 0 })).toBe(true);

    const low = terrain(flatElevation(100), {
      buildings: [{ id: 'B-1', footprint: rectangle(0, -40, 20, 6), heightMeters: 1 }],
    });
    expect(share(computeViewshed(low, OBSERVER, viewshedGrid(low, 4)))).toBeGreaterThan(0.99);
  });

  it('sees through the gap between two buildings', () => {
    const t = terrain(flatElevation(100), {
      buildings: [
        { id: 'B-W', footprint: rectangle(-12, -40, 16, 6), heightMeters: 6 },
        { id: 'B-E', footprint: rectangle(12, -40, 16, 6), heightMeters: 6 },
      ],
    });
    const v = computeViewshed(t, OBSERVER, viewshedGrid(t, 4));
    expect(seen(v, { x: 0, y: 0 })).toBe(true); // through the 8 m gap
    expect(seen(v, { x: 0, y: 60 })).toBe(true);
    expect(seen(v, { x: -20, y: 0 })).toBe(false); // behind the west building
    expect(seen(v, { x: 20, y: 0 })).toBe(false); // behind the east building
  });

  it('is shadowed behind deep woodland but not behind a thin belt of trees', () => {
    const deep = terrain(flatElevation(100), {
      vegetation: [
        {
          id: 'V-1',
          kind: 'woodland',
          boundary: rectangle(0, -30, 60, 30),
          canopyHeightMeters: 12,
          seeThroughMeters: 20,
        },
      ],
    });
    const v = computeViewshed(deep, OBSERVER, viewshedGrid(deep, 4));
    expect(seen(v, { x: 0, y: -42 })).toBe(true); // just inside the near edge
    expect(seen(v, { x: 0, y: 0 })).toBe(false); // behind it
    const thin = terrain(flatElevation(100), {
      vegetation: [
        {
          id: 'V-1',
          kind: 'treeLine',
          boundary: rectangle(0, -30, 60, 6),
          canopyHeightMeters: 12,
          seeThroughMeters: 20,
        },
      ],
    });
    expect(seen(computeViewshed(thin, OBSERVER, viewshedGrid(thin, 4)), { x: 0, y: 0 })).toBe(true);
  });

  it('changes with the observer', () => {
    const t = terrain(flatElevation(100), {
      buildings: [{ id: 'B-1', footprint: rectangle(0, -40, 20, 6), heightMeters: 6 }],
    });
    const grid = viewshedGrid(t, 4);
    expect(computeViewshed(t, { x: 60, y: -80 }, grid)).not.toEqual(
      computeViewshed(t, OBSERVER, grid),
    );
  });
});

describe('visibleCellsIn', () => {
  const t = terrain(flatElevation(100), {
    buildings: [{ id: 'B-1', footprint: rectangle(0, -40, 20, 6), heightMeters: 6 }],
  });
  const v = computeViewshed(t, OBSERVER, viewshedGrid(t, 4));

  it('counts the cells whose centres lie in the polygon and how many are visible', () => {
    // x ∈ [40, 60), y ∈ [0, 20): five columns by five rows of 4 m cells.
    const open = [
      { x: 40, y: 0 },
      { x: 59.9, y: 0 },
      { x: 59.9, y: 19.9 },
      { x: 40, y: 19.9 },
    ];
    expect(visibleCellsIn(v, open)).toEqual({ cells: 25, visible: 25 });
  });

  it('reports none visible in the shadow', () => {
    const shadow = [
      { x: -4, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 12 },
      { x: -4, y: 12 },
    ];
    const result = visibleCellsIn(v, shadow);
    expect(result.cells).toBeGreaterThan(0);
    expect(result.visible).toBe(0);
  });

  it('is deterministic', () => {
    const zone = [
      { x: -30, y: -10 },
      { x: 30, y: -10 },
      { x: 40, y: 30 },
      { x: -20, y: 40 },
    ];
    const first = visibleCellsIn(v, zone);
    expect(first.visible).toBeGreaterThan(0);
    expect(first.visible).toBeLessThan(first.cells);
    expect(visibleCellsIn(v, zone)).toEqual(first);
  });
});
