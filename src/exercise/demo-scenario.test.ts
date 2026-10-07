import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  heightAt,
  lineOfSight,
  pointProblem,
  soldierId,
  type Vec2,
} from '#sim';
import { DEMO_SCENARIO } from './demo-scenario';
import { createExercise } from './exercise';

describe('DEMO_SCENARIO', () => {
  const state = createInitialState(DEMO_SCENARIO, 0);

  it('is a valid scenario on 800 m × 600 m of terrain with real relief', () => {
    const { columns, rows, cellSize, elevations } = DEMO_SCENARIO.terrain.heightfield;
    expect((columns - 1) * cellSize).toBe(800);
    expect((rows - 1) * cellSize).toBe(600);
    expect(DEMO_SCENARIO.terrain.georef).toBeNull();
    let min = Infinity;
    let max = -Infinity;
    for (const e of elevations) {
      min = Math.min(min, e);
      max = Math.max(max, e);
    }
    expect(max - min).toBeGreaterThan(20);
  });

  it('has a BLUEFOR rifle squad of a squad leader and two four-soldier fire teams', () => {
    expect(state.units.map((u) => [u.id, u.echelon, u.parentId, u.leaderId])).toEqual([
      ['SQD', 'squad', null, 'SL'],
      ['A-TM', 'fireTeam', 'SQD', 'A-TL'],
      ['B-TM', 'fireTeam', 'SQD', 'B-TL'],
      ['EN-TM', 'fireTeam', null, 'EN-1'],
    ]);
    const members = (unit: string) =>
      state.soldiers.filter((s) => s.unitId === unit).map((s) => s.id);
    expect(members('SQD')).toEqual(['SL']);
    expect(members('A-TM')).toEqual(['A-TL', 'A-AR', 'A-GR', 'A-RFL']);
    expect(members('B-TM')).toEqual(['B-TL', 'B-AR', 'B-GR', 'B-RFL']);
  });

  it('has a small OPFOR element well away from the squad', () => {
    const opfor = state.soldiers.filter((s) => s.side === 'OPFOR');
    expect(opfor).toHaveLength(3);
    for (const s of opfor) expect(s.position.y).toBeGreaterThan(150);
  });

  it('gives every OPFOR soldier a visible route along the road, with stable ids', () => {
    expect(DEMO_SCENARIO.opforRoutes.map((r) => [r.id, r.soldierId, r.shownToTrainee])).toEqual([
      ['EN-1-patrol', 'EN-1', true],
      ['EN-2-patrol', 'EN-2', true],
      ['EN-3-patrol', 'EN-3', true],
    ]);
    const [first] = DEMO_SCENARIO.opforRoutes;
    expect(first?.waypoints.map((w) => w.id)).toEqual(
      Array.from({ length: 9 }, (_, i) => `EN-1-patrol.${String(i + 1)}`),
    );
    // The route crosses the middle of the map from north to south.
    const ys = first?.waypoints.map((w) => w.y) ?? [];
    expect(Math.max(...ys)).toBeGreaterThan(150);
    expect(Math.min(...ys)).toBeLessThan(-150);
  });

  it('has roads, a hamlet of buildings and several kinds of vegetation', () => {
    const { roads, buildings, vegetation } = DEMO_SCENARIO.terrain.features;
    expect(roads.map((r) => [r.id, r.roadClass])).toEqual([
      ['R-1', 'unpaved'],
      ['R-2', 'track'],
    ]);
    expect(buildings.map((b) => b.id)).toEqual([
      'B-1',
      'B-2',
      'B-3',
      'B-4',
      'B-5',
      'B-6',
      'B-7',
      'B-8',
    ]);
    expect(new Set(buildings.map((b) => b.footprint.length)).size).toBeGreaterThan(1); // not all rectangles
    expect(Math.min(...buildings.map((b) => b.heightMeters))).toBeLessThan(2);
    expect(Math.max(...buildings.map((b) => b.heightMeters))).toBeGreaterThan(10);
    expect(new Set(vegetation.map((v) => v.kind))).toEqual(
      new Set(['woodland', 'treeLine', 'scrub']),
    );
  });

  it('sends the patrol along the road without passing through buildings', () => {
    const exercise = createExercise({
      config: { tickRateHz: 30, seed: 0 },
      scenario: DEMO_SCENARIO,
    });
    for (const route of exercise.opforRoutePaths.values()) expect(route.ok).toBe(true);
  });

  it('makes the squad’s direct line north bend around the cottage', () => {
    const exercise = createExercise({
      config: { tickRateHz: 30, seed: 0 },
      scenario: DEMO_SCENARIO,
    });
    const sl = soldierId('SL');
    exercise.addWaypoint(sl, { x: -85, y: -25 });
    const route = exercise.displayedRoute(sl);
    expect(route?.legs[0]?.turns?.length).toBeGreaterThan(0);
    expect(pointProblem(DEMO_SCENARIO.terrain, { x: -72, y: -185 })).toEqual({
      kind: 'insideBuilding',
      buildingId: 'B-6',
    });
  });

  describe('planning choices with different lines of sight into a kill zone across the road', () => {
    const terrain = DEMO_SCENARIO.terrain;
    const zone = {
      id: 'KZ' as never,
      vertices: [
        { x: -25, y: -30 },
        { x: 15, y: -30 },
        { x: 35, y: 40 },
        { x: 0, y: 45 },
      ],
    };
    // Corners, side midpoints and the (inside) centroid of the zone.
    const samples: Vec2[] = zone.vertices.flatMap((a, i) => {
      const b = zone.vertices[(i + 1) % zone.vertices.length] ?? a;
      return [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }];
    });
    samples.push({ x: 7.946, y: 10.524 });
    const tally = (from: Vec2) => {
      const counts: Record<string, number> = {};
      for (const point of samples) {
        const { obstruction } = lineOfSight(terrain, from, point);
        const key =
          obstruction === null
            ? 'clear'
            : obstruction.cause.kind === 'terrain'
              ? 'terrain'
              : obstruction.cause.featureId;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return counts;
    };

    it.each<[string, Vec2, Record<string, number>]>([
      ['the open west ridge sees all of it', { x: -85, y: -25 }, { clear: 9 }],
      ['inside the western woods sees none of it', { x: -130, y: 10 }, { 'V-1': 9 }],
      ['behind the barn sees little of it', { x: -60, y: -58 }, { 'B-2': 7, clear: 2 }],
      ['behind the south ridge sees none of it', { x: 10, y: -160 }, { terrain: 9 }],
      ['behind the tree line sees none of it', { x: 130, y: 10 }, { 'V-2': 5, terrain: 4 }],
      ['beside the farmhouse sees part of it', { x: 60, y: 22 }, { 'B-1': 4, clear: 5 }],
    ])('from %s', (_label, from, expected) => {
      expect(pointProblem(terrain, from)).toBeNull();
      expect(tally(from)).toEqual(expected);
    });
  });

  it('springs an ambush on a kill zone drawn across the draw', () => {
    const exercise = createExercise({
      config: { tickRateHz: 30, seed: 0 },
      scenario: DEMO_SCENARIO,
    });
    for (const v of [
      { x: -40, y: -20 },
      { x: 40, y: -20 },
      { x: 40, y: 30 },
      { x: -40, y: 30 },
    ]) {
      exercise.addKillZoneVertex(v);
    }
    exercise.execute();
    exercise.advance(1 / 30);
    expect(exercise.startOpfor().ok).toBe(true);
    for (let i = 0; i < 30 * 300 && exercise.phase !== 'ambushTriggered'; i += 1)
      exercise.advance(1 / 30);
    expect(exercise.trigger?.soldierId).toBe('EN-1');
    // EN-1 enters through the north edge, y = 30.
    expect(exercise.trigger?.point.y).toBeCloseTo(30, 6);
  });

  it('starts everyone without orders, standing on the terrain', () => {
    for (const s of state.soldiers) {
      expect(s.orders).toBeNull();
      expect(s.position.z).toBe(heightAt(DEMO_SCENARIO.terrain, s.position.x, s.position.y));
    }
  });
});
