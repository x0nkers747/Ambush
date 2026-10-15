import { describe, expect, it } from 'vitest';
import {
  rectangle,
  type Building,
  type EnvironmentFeatures,
  type VegetationArea,
} from './environment';
import type { Vec2, Vec3 } from './geometry';
import { traceSightLine } from './los';
import { createRngState, nextFloat } from './rng';
import { noObstruction, sightLineTracer } from './sight-tracer';
import { createSyntheticTerrain, type ElevationFunction } from './synthetic-terrain';
import { heightAt, type TerrainDataset } from './terrain';
import {
  computeViewshedRows,
  computeViewshedRowsReference,
  viewshedGrid,
  type ViewshedGrid,
} from './viewshed';

// The fast viewshed (docs/adr/0020) must decide every cell exactly as the
// reference, `traceSightLine` per cell, decides it. These tests compare the
// two cell by cell, on terrain shapes, buildings and vegetation chosen to
// exercise every rule of the trace, and observers placed where rounding is
// most delicate: on grid vertices and lines, at cell centres, at the edges.

const SIZE = 400;
/** 400 m square on 10 m terrain cells, the battlefields' terrain resolution. */
function terrain(elevation: ElevationFunction, features: Partial<EnvironmentFeatures> = {}) {
  return createSyntheticTerrain(
    {
      originX: -SIZE / 2,
      originY: -SIZE / 2,
      cellSize: 10,
      columns: SIZE / 10 + 1,
      rows: SIZE / 10 + 1,
    },
    elevation,
    { roads: [], buildings: [], vegetation: [], ...features },
  );
}

const building = (id: string, footprint: readonly Vec2[], heightMeters: number): Building => ({
  id,
  footprint,
  heightMeters,
});

const wood = (
  id: string,
  boundary: readonly Vec2[],
  seeThroughMeters: number,
  holes: readonly (readonly Vec2[])[] = [],
): VegetationArea => ({
  id,
  kind: 'woodland',
  boundary,
  holes,
  canopyHeightMeters: 12,
  seeThroughMeters,
});

/** An irregular, concave polygon with many vertices (like mapped woodland). */
function blob(cx: number, cy: number, radius: number, vertices: number, seed: number): Vec2[] {
  const rng = createRngState(seed);
  return Array.from({ length: vertices }, (_, i) => {
    const a = (i / vertices) * 2 * Math.PI;
    const r = radius * (0.6 + 0.4 * nextFloat(rng));
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

const SHAPES: Record<string, ElevationFunction> = {
  flat: () => 100,
  ridge: (_, y) => 100 + 15 * Math.exp(-(((y - 40) / 25) ** 2)),
  // A valley with flat rims: from its floor, the plateau beyond the rims is hidden.
  valley: (x) => 100 + 20 * Math.min(1, Math.abs(x) / 60),
  hilltop: (x, y) => 100 + 30 * Math.exp(-(x * x + y * y) / 8000),
  saddle: (x, y) => 100 + (x * x - y * y) / 2000,
  rough: (x, y) => 100 + 6 * Math.sin(x / 23) * Math.cos(y / 17) + 3 * Math.sin((x + 2 * y) / 9),
};

const TOWN: Partial<EnvironmentFeatures> = {
  buildings: [
    building('aligned', rectangle(-50, 20, 20, 10), 8),
    building('rotated', rectangle(40, 60, 24, 12, 30), 12),
    building('low', rectangle(0, -40, 16, 8), 1),
    building(
      'L',
      [
        { x: 60, y: -60 },
        { x: 100, y: -60 },
        { x: 100, y: -50 },
        { x: 70, y: -50 },
        { x: 70, y: -20 },
        { x: 60, y: -20 },
      ],
      9,
    ),
    // Edges exactly on terrain grid lines and diagonals.
    building(
      'on-grid',
      [
        { x: -110, y: -110 },
        { x: -90, y: -110 },
        { x: -90, y: -90 },
      ],
      6,
    ),
  ],
};

const FOREST: Partial<EnvironmentFeatures> = {
  vegetation: [
    wood('big', blob(-60, 80, 90, 60, 1), 40, [blob(-70, 90, 20, 14, 2)]),
    wood('belt', rectangle(80, 0, 12, 200), 25),
    wood('overlap', blob(30, 100, 50, 30, 3), 60),
  ],
};

function expectSameViewshed(t: TerrainDataset, observer: Vec2, cellSize = 4) {
  const grid: ViewshedGrid = viewshedGrid(t, cellSize);
  const fast = computeViewshedRows(t, observer, grid, 0, grid.rows);
  const reference = computeViewshedRowsReference(t, observer, grid, 0, grid.rows);
  const differences: string[] = [];
  for (let i = 0; i < fast.length; i += 1) {
    if (fast[i] !== reference[i]) {
      differences.push(`cell ${String(i % grid.columns)},${String(Math.floor(i / grid.columns))}`);
    }
  }
  expect(differences.slice(0, 5)).toEqual([]);
  // Both outcomes occur, so the comparison means something.
  return { visible: reference.reduce((n, v) => n + v, 0), cells: reference.length };
}

describe('the fast viewshed equals the reference cell by cell', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`on ${name} terrain`, () => {
      const t = terrain(shape);
      const { visible, cells } = expectSameViewshed(t, { x: 3, y: -120 });
      expect(visible).toBeGreaterThan(0);
      if (name !== 'flat') expect(visible).toBeLessThan(cells);
    });
  }

  it('among buildings, including concave, rotated and grid-aligned ones', () => {
    const t = terrain(SHAPES['rough'] ?? (() => 0), TOWN);
    expectSameViewshed(t, { x: -12, y: 5 });
    expectSameViewshed(t, { x: 75, y: -40 }); // in the L's crook
  });

  it('through and over vegetation with holes and overlapping areas', () => {
    const t = terrain(SHAPES['hilltop'] ?? (() => 0), FOREST);
    expectSameViewshed(t, { x: 0, y: 0 }); // hilltop, over the canopy
    expectSameViewshed(t, { x: -70, y: 90 }); // in the clearing
    expectSameViewshed(t, { x: 140, y: -150 });
  });

  it('with buildings and vegetation together, on a saddle', () => {
    const t = terrain(SHAPES['saddle'] ?? (() => 0), {
      buildings: TOWN.buildings ?? [],
      vegetation: FOREST.vegetation ?? [],
    });
    expectSameViewshed(t, { x: 5, y: 7 });
  });

  it('from observers on terrain grid vertices and lines, and at cell centres', () => {
    const t = terrain(SHAPES['rough'] ?? (() => 0), TOWN);
    expectSameViewshed(t, { x: 0, y: 0 }); // a terrain vertex
    expectSameViewshed(t, { x: 20, y: -33.3 }); // a vertical grid line
    expectSameViewshed(t, { x: 2, y: 2 }); // on the 4 m viewshed grid's cell centre
    expectSameViewshed(t, { x: -18, y: -18 }); // a diagonal
  });

  it('from observers at the battlefield edges and corners', () => {
    const t = terrain(SHAPES['ridge'] ?? (() => 0), TOWN);
    expectSameViewshed(t, { x: -200, y: 13 });
    expectSameViewshed(t, { x: 199.99, y: -150 });
    expectSameViewshed(t, { x: -200, y: -200 });
    expectSameViewshed(t, { x: 200, y: 200 });
  });

  it('on a coarser preview grid', () => {
    const t = terrain(SHAPES['hilltop'] ?? (() => 0), { ...TOWN, ...FOREST });
    expectSameViewshed(t, { x: -30, y: 40 }, 8);
  });
});

describe('sightLineTracer', () => {
  const t = terrain(SHAPES['rough'] ?? (() => 0), {
    buildings: TOWN.buildings ?? [],
    vegetation: FOREST.vegetation ?? [],
  });
  const tracer = sightLineTracer(t);
  const point = (x: number, y: number, h: number): Vec3 => ({ x, y, z: heightAt(t, x, y) + h });

  it('agrees with traceSightLine on random sight lines', () => {
    const rng = createRngState(42);
    const r = () => -199 + 398 * nextFloat(rng);
    let blocked = 0;
    for (let i = 0; i < 4000; i += 1) {
      const a = point(r(), r(), 1 + 20 * nextFloat(rng));
      const b = point(r(), r(), 0.5 + 5 * nextFloat(rng));
      if (a.x === b.x && a.y === b.y) continue;
      const reference = traceSightLine(t, a, b) !== null;
      expect(tracer.blocked(a, b), `${JSON.stringify(a)} → ${JSON.stringify(b)}`).toBe(reference);
      if (reference) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(400);
    expect(blocked).toBeLessThan(3600);
  });

  it('counts clear lines to several heights of one point exactly as one line at a time', () => {
    const rng = createRngState(11);
    const r = () => -199 + 398 * nextFloat(rng);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i += 1) {
      const a = point(r(), r(), [0.3, 1.0, 1.65][i % 3] ?? 1.65);
      const x = r();
      const y = r();
      if (a.x === x && a.y === y) continue;
      const ground = heightAt(t, x, y);
      const zs = [0.15, 0.55, 1.2, 4 * nextFloat(rng)].slice(0, 1 + (i % 4)).map((h) => ground + h);
      const one = zs.filter((z) => !tracer.blocked(a, { x, y, z })).length;
      const reference = zs.filter((z) => traceSightLine(t, a, { x, y, z }) === null).length;
      const many = tracer.clearCount(a, x, y, zs);
      expect(
        many,
        `${JSON.stringify(a)} → (${String(x)}, ${String(y)}) ${JSON.stringify(zs)}`,
      ).toBe(one);
      expect(one).toBe(reference);
      if (zs.length === 3) counts[many] = (counts[many] ?? 0) + 1;
    }
    // Every outcome occurs: none, some and all of the heights clear.
    for (const c of counts) expect(c).toBeGreaterThan(5);
  });

  it('agrees on sight lines along building edges, grid lines and through grid vertices', () => {
    const lines: [Vec3, Vec3][] = [
      [point(-60, 15, 1.7), point(-40, 15, 1.5)], // along the aligned building's south edge
      [point(-60, 15, 1.7), point(-30, 15, 1.5)],
      [point(-110, -150, 1.7), point(-110, -50, 1.5)], // along a grid line and a building edge
      [point(-150, -150, 1.7), point(-50, -50, 1.5)], // along the diagonal, through vertices
      [point(-150, -110, 1.7), point(-50, -110, 1.5)],
      [point(0, 0, 1.7), point(100, 100, 1.5)],
      [point(-200, -200, 1.7), point(200, 200, 1.5)],
      [point(60, -70, 1.7), point(60, -10, 1.5)], // along the L's west edge
    ];
    for (const [a, b] of lines) {
      expect(tracer.blocked(a, b), JSON.stringify([a, b])).toBe(traceSightLine(t, a, b) !== null);
    }
  });

  it('never proves a clear sight line obstructed', () => {
    const rng = createRngState(7);
    const r = () => -199 + 398 * nextFloat(rng);
    const eye = point(10, -30, 1.7);
    let proofs = 0;
    let previous = noObstruction();
    for (let i = 0; i < 3000; i += 1) {
      const target = point(r(), r(), 1.5);
      const reference = traceSightLine(t, eye, target) !== null;
      const proved =
        tracer.provesQuickly(eye, target, previous) ||
        tracer.provesByWalking(eye, target, previous);
      if (proved) {
        proofs += 1;
        expect(reference, `proof for a clear line to ${JSON.stringify(target)}`).toBe(true);
      }
      const record = noObstruction();
      tracer.blocked(eye, target, record);
      if (record.kind !== 0) previous = record;
    }
    expect(proofs).toBeGreaterThan(100);
  });
});
