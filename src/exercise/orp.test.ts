import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  flatElevation,
  planPath,
  pointProblem,
  rectangle,
  type Vec2,
} from '#sim';
import { deployInOrp } from './ambush-scenario';
import { USMC_RIFLE_SQUAD_TEMPLATE } from './squad';
import {
  layoutOrp,
  MIN_START_SPACING_M,
  ORP_LAYOUT_MARGIN_M,
  orpContains,
  orpLayoutCandidates,
  orpOutline,
  orpPlacementProblems,
  orpProblems,
  type ObjectiveRallyPoint,
} from './orp';

const TERRAIN = createSyntheticTerrain(
  { originX: -100, originY: -100, cellSize: 10, columns: 21, rows: 21 },
  flatElevation(0),
  // A shed just north-east of the ORP centre.
  {
    roads: [],
    buildings: [{ id: 'SHED', footprint: rectangle(6, 6, 4, 4), heightMeters: 3 }],
    vegetation: [],
  },
);
const CIRCLE: ObjectiveRallyPoint = {
  id: 'ORP-C',
  name: 'ORP',
  centre: { east: 0, north: 0 },
  shape: { kind: 'circle', radiusM: 12 },
};
/** 30 m × 10 m, its long axis running north-east (045°). */
const ELLIPSE: ObjectiveRallyPoint = {
  id: 'ORP-E',
  name: 'ORP East',
  centre: { east: -40, north: -40 },
  shape: { kind: 'ellipse', majorAxisM: 30, minorAxisM: 10, orientationDeg: 45 },
};

describe('ORP shape', () => {
  it('contains points within the circle, boundary included', () => {
    expect(orpContains(CIRCLE, { x: 0, y: 0 })).toBe(true);
    expect(orpContains(CIRCLE, { x: 12, y: 0 })).toBe(true);
    expect(orpContains(CIRCLE, { x: 12.01, y: 0 })).toBe(false);
    expect(orpContains(CIRCLE, { x: 11.6, y: 0 }, ORP_LAYOUT_MARGIN_M)).toBe(false);
  });

  it('orients an ellipse by its major axis, clockwise from grid north', () => {
    const d = 14 / Math.SQRT2; // 14 m along 045° or 135°
    expect(orpContains(ELLIPSE, { x: -40 + d, y: -40 + d })).toBe(true); // along the major axis
    expect(orpContains(ELLIPSE, { x: -40 + d, y: -40 - d })).toBe(false); // across it
    expect(orpContains(ELLIPSE, { x: -40 + 4 / Math.SQRT2, y: -40 - 4 / Math.SQRT2 })).toBe(true);
  });

  it('draws its outline on the boundary', () => {
    for (const orp of [CIRCLE, ELLIPSE]) {
      const outline = orpOutline(orp, 36);
      expect(outline).toHaveLength(36);
      for (const p of outline) {
        expect(orpContains(orp, p, -1e-9)).toBe(true);
        const nudged = {
          x: p.x + (p.x - orp.centre.east) * 0.01,
          y: p.y + (p.y - orp.centre.north) * 0.01,
        };
        expect(orpContains(orp, nudged)).toBe(false);
      }
    }
  });

  it.each<[string, ObjectiveRallyPoint, RegExp]>([
    ['a non-positive radius', { ...CIRCLE, shape: { kind: 'circle', radiusM: 0 } }, /radius/],
    [
      'a minor axis longer than the major',
      { ...ELLIPSE, shape: { kind: 'ellipse', majorAxisM: 5, minorAxisM: 10, orientationDeg: 0 } },
      /major ≥ minor/,
    ],
    ['an area off the terrain', { ...CIRCLE, centre: { east: 95, north: 0 } }, /off the terrain/],
    ['no name', { ...CIRCLE, name: ' ' }, /no name/],
  ])('reports %s', (_label, orp, message) => {
    expect(orpProblems(orp, TERRAIN).join('; ')).toMatch(message);
  });
});

describe('ORP starting layout', () => {
  it('is deterministic, nearest the centre first, never where a soldier cannot stand', () => {
    const points = layoutOrp(CIRCLE, TERRAIN, 13);
    expect(layoutOrp(CIRCLE, TERRAIN, 13)).toEqual(points);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    // Ring by ring: never farther from the centre than the point after it.
    for (let i = 1; i < points.length; i += 1) {
      const r = (p?: Vec2) => (p ? Math.hypot(p.x, p.y) : 0);
      expect(r(points[i - 1])).toBeLessThanOrEqual(r(points[i]) + 1e-9);
    }
    for (const p of points) {
      expect(orpContains(CIRCLE, p, ORP_LAYOUT_MARGIN_M)).toBe(true);
      expect(pointProblem(TERRAIN, p)).toBeNull(); // the shed's grid points are skipped
    }
    expect(
      orpPlacementProblems(
        CIRCLE,
        TERRAIN,
        points.map((point, i) => ({ id: String(i), point })),
      ),
    ).toEqual([]);
  });

  it('works for an ellipse too', () => {
    const points = layoutOrp(ELLIPSE, TERRAIN, 13);
    expect(new Set(points.map((p) => `${String(p.x)},${String(p.y)}`)).size).toBe(13);
    for (const p of points) expect(orpContains(ELLIPSE, p)).toBe(true);
  });

  it('keeps clear of soldiers the scenario placed explicitly', () => {
    const occupied = [{ x: 0, y: 0 }];
    const points = layoutOrp(CIRCLE, TERRAIN, 4, occupied);
    for (const p of points)
      expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(MIN_START_SPACING_M);
  });

  it('refuses more soldiers than the ORP can hold', () => {
    const small: ObjectiveRallyPoint = { ...CIRCLE, shape: { kind: 'circle', radiusM: 4 } };
    expect(orpLayoutCandidates(small, TERRAIN)).toHaveLength(5);
    expect(() => layoutOrp(small, TERRAIN, 13)).toThrow(/room for 5 of 13/);
  });

  it('places the template’s Marines in order, explicit starts kept as given', () => {
    const { soldiers } = deployInOrp(
      USMC_RIFLE_SQUAD_TEMPLATE,
      {
        templateId: USMC_RIFLE_SQUAD_TEMPLATE.id,
        templateVersion: USMC_RIFLE_SQUAD_TEMPLATE.version,
        side: 'BLUEFOR',
        unitIdPrefix: '',
        facingDeg: 0,
        posture: 'standing',
        members: USMC_RIFLE_SQUAD_TEMPLATE.slots.map((s, i) => ({
          soldierId: `M${String(i)}`,
          slotId: s.id,
          ...(i === 3 ? { start: { east: -5.5, north: 7 } } : {}),
        })),
      },
      CIRCLE,
      TERRAIN,
    );
    expect(soldiers).toHaveLength(13);
    expect(soldiers[3]?.position).toEqual({ x: -5.5, y: 7 });
    expect(soldiers[0]?.position).toEqual({ x: 0, y: 0 });
    const problems = orpPlacementProblems(
      CIRCLE,
      TERRAIN,
      soldiers.map((s) => ({ id: s.id, point: s.position })),
    );
    expect(problems).toEqual([]);
  });
});

describe('ORP placement problems', () => {
  it('names soldiers outside it, in a building, or on top of each other', () => {
    expect(
      orpPlacementProblems(CIRCLE, TERRAIN, [
        { id: 'out', point: { x: 20, y: 0 } },
        { id: 'shed', point: { x: 6, y: 6 } },
        { id: 'a', point: { x: -3, y: 0 } },
        { id: 'b', point: { x: -3.5, y: 0 } },
      ]),
    ).toEqual([
      'soldier "out" does not start inside ORP "ORP-C"',
      'soldier "shed" starts where nobody can stand (insideBuilding)',
      'soldiers "a" and "b" start less than 1 m apart',
    ]);
  });
});

describe('the ORP is not an obstacle', () => {
  it('leaves path planning across it unchanged', () => {
    // A path straight through the ORP: navigation knows nothing of it.
    const path = planPath(TERRAIN, { x: -30, y: -2 }, { x: 30, y: -2 });
    expect(path).toEqual({ ok: true, turns: [] });
  });
});
