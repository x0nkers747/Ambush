import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  createSimulation,
  hashSimState,
  heightAt,
  lineOfSight,
  pointProblem,
  soldierId,
  waypointId,
  type Vec2,
} from '#sim';
import { DEMO_SCENARIO } from './demo-scenario';
import { createExercise } from './exercise';
import { rosterMembers, rosterTree } from './organization';
import { layoutOrp, MIN_START_SPACING_M, orpContains } from './orp';

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

  it('has the 13-Marine rifle squad of the MCWP 3-11.2 template: a squad leader and three fire teams of four', () => {
    expect(DEMO_SCENARIO.organization.template.id).toBe('usmc-rifle-squad-mcwp-3-11-2');
    expect(state.units.map((u) => [u.id, u.echelon, u.parentId, u.leaderId])).toEqual([
      ['SQD', 'squad', null, 'M01'],
      ['FT1', 'fireTeam', 'SQD', 'M02'],
      ['FT2', 'fireTeam', 'SQD', 'M06'],
      ['FT3', 'fireTeam', 'SQD', 'M10'],
      ['EN-TM', 'fireTeam', null, 'EN-1'],
    ]);
    const members = (unit: string) =>
      state.soldiers.filter((s) => s.unitId === unit).map((s) => s.id);
    expect(members('SQD')).toEqual(['M01']);
    expect(members('FT1')).toEqual(['M02', 'M03', 'M04', 'M05']);
    expect(members('FT2')).toEqual(['M06', 'M07', 'M08', 'M09']);
    expect(members('FT3')).toEqual(['M10', 'M11', 'M12', 'M13']);
    const roster = rosterMembers(rosterTree(DEMO_SCENARIO.organization));
    expect(roster.map((m) => `${m.soldierId}:${m.slot.label}`)).toEqual([
      'M01:SL',
      'M02:1-FTL',
      'M03:1-AR',
      'M04:1-AAR',
      'M05:1-R',
      'M06:2-FTL',
      'M07:2-AR',
      'M08:2-AAR',
      'M09:2-R',
      'M10:3-FTL',
      'M11:3-AR',
      'M12:3-AAR',
      'M13:3-R',
    ]);
  });

  it('starts the whole squad in the ORP, at distinct, deterministic places a Marine can stand', () => {
    const { orp, terrain } = DEMO_SCENARIO;
    const squad = state.soldiers.filter((s) => s.side === 'BLUEFOR');
    expect(squad).toHaveLength(13);
    for (const s of squad) {
      expect(orpContains(orp, s.position)).toBe(true);
      expect(pointProblem(terrain, s.position)).toBeNull();
    }
    for (const [i, a] of squad.entries()) {
      for (const b of squad.slice(i + 1)) {
        expect(
          Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y),
        ).toBeGreaterThanOrEqual(MIN_START_SPACING_M);
      }
    }
    // The squad leader at the centre, then outwards; the same every time.
    expect(squad[0]?.position).toMatchObject({ x: orp.centre.east, y: orp.centre.north });
    expect(squad.map((s) => ({ x: s.position.x, y: s.position.y }))).toEqual(
      layoutOrp(orp, terrain, 13),
    );
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
    const sl = soldierId('M01');
    exercise.setDestination(sl, { x: -85, y: -25 });
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

  it('lets the trainee spring an ambush on a kill zone drawn across the draw', () => {
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
    // The patrol walks in; nothing happens until the trainee triggers (docs/adr/0021).
    for (let i = 0; i < 30 * 300 && (exercise.killZoneOccupancy()?.inside ?? 0) < 1; i += 1)
      exercise.advance(1 / 30);
    const entry = exercise.timeline.find((e) => e.type === 'killZoneEntered');
    expect(entry?.type === 'killZoneEntered' && entry.soldierId).toBe('EN-1');
    // EN-1 enters through the north edge, y = 30 (within the tick's walk).
    const leader = exercise.simulation.state.soldiers.find((s) => s.id === 'EN-1');
    expect(leader?.position.y).toBeLessThanOrEqual(30);
    expect(leader?.position.y).toBeGreaterThan(29.9);
    expect(exercise.phase).toBe('opforApproach');
    expect(exercise.triggerAmbush().ok).toBe(true);
    expect(exercise.trigger).toMatchObject({ opforInKillZone: 1, opforTotal: 3 });
    exercise.advance(1 / 30);
    expect(exercise.phase).toBe('engagement');
  });

  it('deploys part of the squad from the ORP to readiness, the same way every time', () => {
    const deploy = () => {
      const exercise = createExercise({
        config: { tickRateHz: 30, seed: 0 },
        scenario: DEMO_SCENARIO,
      });
      exercise.setDestination(soldierId('M01'), { x: -85, y: -25 }); // round the cottage
      exercise.setDestination(soldierId('M03'), { x: -60, y: -58 });
      exercise.setFacing(soldierId('M03'), Math.PI / 4);
      exercise.setFacing(soldierId('M13'), Math.PI); // turns in place at the ORP
      expect(exercise.execute().ok).toBe(true);
      for (let i = 0; i < 30 * 400 && exercise.phase !== 'bluforReady'; i += 1)
        exercise.advance(1 / 30);
      return exercise;
    };
    const a = deploy();
    expect(a.phase).toBe('bluforReady');
    expect(a.deploymentStatus(soldierId('M01'))).toBe('inPosition');
    expect(a.deploymentStatus(soldierId('M13'))).toBe('atOrp');
    expect(a.deploymentStatus(soldierId('M07'))).toBe('atOrp');
    const b = deploy();
    expect(hashSimState(b.simulation.state)).toBe(hashSimState(a.simulation.state));
    expect(b.scenarioFingerprint).toBe(a.scenarioFingerprint);
  });

  it('snapshots and restores the squad mid-deployment, through JSON, to the same future', () => {
    const sim = createSimulation({ tickRateHz: 30, seed: 0 }, DEMO_SCENARIO);
    // The orders an Execute gives one Marine: a single destination waypoint.
    sim.submit({
      type: 'setOrders',
      tick: 0,
      soldierId: soldierId('M03'),
      orders: { waypoints: [{ id: waypointId('M03.dest.1'), x: -60, y: -58 }], finalFacing: 0 },
    });
    for (let i = 0; i < 300; i += 1) sim.step();
    const saved = JSON.parse(JSON.stringify(sim.snapshot())) as ReturnType<typeof sim.snapshot>;
    for (let i = 0; i < 600; i += 1) sim.step();
    const expected = hashSimState(sim.state);
    const fresh = createSimulation({ tickRateHz: 30, seed: 0 }, DEMO_SCENARIO);
    fresh.restore(saved);
    for (let i = 0; i < 600; i += 1) fresh.step();
    expect(hashSimState(fresh.state)).toBe(expected);
    expect(fresh.state.soldiers.filter((s) => s.side === 'BLUEFOR')).toHaveLength(13);
  });

  it('starts everyone without orders, standing on the terrain', () => {
    for (const s of state.soldiers) {
      expect(s.orders).toBeNull();
      expect(s.position.z).toBe(heightAt(DEMO_SCENARIO.terrain, s.position.x, s.position.y));
    }
  });
});
