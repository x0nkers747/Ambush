import { describe, expect, it } from 'vitest';
import { lineOfSight } from './los';
import { isSegmentWalkable, planPath, pointProblem } from './navigation';
import { createSyntheticTerrain, flatElevation } from './synthetic-terrain';
import { validateTerrain, type TerrainDataset } from './terrain';
import type { Vec2 } from './geometry';

// Imported-terrain features (docs/adr/0014): standing water blocks movement,
// wetland does not, and a clearing (a hole in a vegetation area) does not
// obscure sight lines.

const square = (cx: number, cy: number, half: number): Vec2[] => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half },
];

function terrain(): TerrainDataset {
  const base = createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 10, columns: 41, rows: 41 },
    flatElevation(100),
  );
  return {
    ...base,
    formatVersion: 3,
    features: {
      roads: [],
      buildings: [],
      vegetation: [
        {
          id: 'wood',
          kind: 'woodland',
          boundary: square(0, 120, 60),
          holes: [square(0, 120, 25)],
          canopyHeightMeters: 15,
          seeThroughMeters: 20,
        },
      ],
      water: [
        { id: 'lake', kind: 'water', boundary: square(0, -60, 40), holes: [square(0, -60, 10)] },
        { id: 'bog', kind: 'wetland', boundary: square(-150, -150, 20) },
      ],
      waterways: [
        {
          id: 'brook',
          kind: 'stream',
          centerline: [
            { x: 150, y: -200 },
            { x: 150, y: 200 },
          ],
          widthMeters: 2,
        },
      ],
      landUse: [{ id: 'field', kind: 'farmland', boundary: square(150, 150, 40) }],
    },
  };
}

describe('standing water', () => {
  it('cannot be stood in, but wetland and the shore can', () => {
    const t = terrain();
    expect(pointProblem(t, { x: 0, y: -60 })).toEqual({ kind: 'inWater', waterId: 'lake' }); // island
    expect(pointProblem(t, { x: 30, y: -60 })).toEqual({ kind: 'inWater', waterId: 'lake' });
    expect(pointProblem(t, { x: -150, y: -150 })).toBeNull(); // wetland
    expect(pointProblem(t, { x: 41, y: -60 })).toBeNull(); // just ashore
    expect(pointProblem(t, { x: 150, y: 0 })).toBeNull(); // a stream is display only
  });

  it('cannot be walked across: paths go round it', () => {
    const t = terrain();
    const from = { x: 0, y: -150 };
    const to = { x: 0, y: 30 };
    expect(isSegmentWalkable(t, from, to)).toBe(false);
    const path = planPath(t, from, to);
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    const points = [from, ...path.turns, to];
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (a && b) expect(isSegmentWalkable(t, a, b)).toBe(true);
    }
    expect(path.turns.length).toBeGreaterThan(0);
    expect(planPath(t, from, { x: 0, y: -60 })).toEqual({
      ok: false,
      problem: { kind: 'inWater', waterId: 'lake' },
    });
  });

  it('validates holes inside their boundary', () => {
    expect(() => {
      validateTerrain(terrain());
    }).not.toThrow();
    const bad = terrain();
    const broken: TerrainDataset = {
      ...bad,
      features: {
        ...bad.features,
        water: [
          { id: 'lake', kind: 'water', boundary: square(0, -60, 40), holes: [square(100, -60, 5)] },
        ],
      },
    };
    expect(() => {
      validateTerrain(broken);
    }).toThrow(/hole 1 must lie inside the boundary/);
    const missing: TerrainDataset = {
      ...bad,
      features: { roads: [], buildings: [], vegetation: [] },
    };
    expect(() => {
      validateTerrain(missing);
    }).toThrow(/format 3 needs water/);
  });
});

describe('a clearing in a wood', () => {
  it('does not obscure the view: sight lines across it see only the wood around it', () => {
    const t = terrain();
    // Within the clearing (wood edge at ±60, clearing at ±25 around y = 120).
    expect(lineOfSight(t, { x: -20, y: 120 }, { x: 20, y: 120 }).clear).toBe(true);
    // From the clearing out through 35 m of wood (more than 20 m see-through): blocked by the wood.
    const out = lineOfSight(t, { x: 0, y: 120 }, { x: 100, y: 120 });
    expect(out.clear).toBe(false);
    expect(out.obstruction?.cause).toEqual({ kind: 'vegetation', featureId: 'wood' });
    // The obscuration starts at the clearing's edge (x = 25), so it is full 20 m later.
    expect(out.obstruction?.point.x).toBeCloseTo(45, 6);
  });

  it('without the hole, the same sight line is blocked inside the clearing', () => {
    const t = terrain();
    const solid: TerrainDataset = {
      ...t,
      features: {
        ...t.features,
        vegetation: t.features.vegetation.map((v) => ({
          id: v.id,
          kind: v.kind,
          boundary: v.boundary,
          canopyHeightMeters: v.canopyHeightMeters,
          seeThroughMeters: v.seeThroughMeters,
        })),
      },
    };
    expect(lineOfSight(solid, { x: -20, y: 120 }, { x: 20, y: 120 }).clear).toBe(false);
  });
});
