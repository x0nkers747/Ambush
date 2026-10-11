import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  flatElevation,
  hashSimState,
  rectangle,
  shareTerrain,
  terrainModelId,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import { DEMO_SCENARIO } from './demo-scenario';
import { createExercise } from './exercise';
import { orpContains } from './orp';
import {
  addRouteWaypoint,
  buildPreviewScenario,
  buildScenario,
  clearRoute,
  defaultScenarioDefinition,
  deleteRouteWaypoint,
  moveRouteWaypoint,
  orpPlacementProblem,
  parseScenarioDefinition,
  scenarioProblems,
  setOpforStart,
  setOrp,
  type EditResult,
  type ScenarioDefinition,
} from './scenario-definition';

// Scenario definitions (docs/adr/0015): ORP and OPFOR placement and route
// editing on a battlefield, and the playable scenario built from them.

const square = (cx: number, cy: number, half: number): Vec2[] => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half },
];

/** A 1 km battlefield with a lake in the north-west and a building east of centre. */
function terrain(): TerrainDataset {
  const base = createSyntheticTerrain(
    { originX: -500, originY: -500, cellSize: 10, columns: 101, rows: 101 },
    flatElevation(50),
  );
  return {
    ...base,
    formatVersion: 3,
    features: {
      roads: [],
      buildings: [{ id: 'B1', footprint: rectangle(150, 0, 20, 20, 0), heightMeters: 6 }],
      vegetation: [],
      water: [{ id: 'lake', kind: 'water', boundary: square(-300, 300, 60) }],
      waterways: [],
      landUse: [],
    },
  };
}

const T = terrain();
const expectOk = (r: EditResult): ScenarioDefinition => {
  if (!r.ok) throw new Error(`refused: ${r.problem}`);
  return r.definition;
};

/** A scenario with the ORP south of centre and OPFOR coming down from the north. */
function playable(): ScenarioDefinition {
  let d = defaultScenarioDefinition(T, 'bf-test');
  d = expectOk(setOrp(T, d, { x: 0, y: -300 }));
  d = expectOk(setOpforStart(T, d, { x: 0, y: 400 }));
  d = expectOk(addRouteWaypoint(T, d, { x: 0, y: 100 }));
  return expectOk(addRouteWaypoint(T, d, { x: 300, y: 50 }));
}

describe('scenario creation', () => {
  it('starts with the ORP on open ground near the centre and no OPFOR', () => {
    const d = defaultScenarioDefinition(T, 'bf-test');
    expect(d.battlefieldId).toBe('bf-test');
    expect(d.orp).toEqual({ east: 0, north: 0 });
    expect(d.opfor).toEqual({ force: 'patrol-3', route: [] });
    expect(scenarioProblems(T, d)).toEqual(['Place the OPFOR.']);
  });
});

describe('ORP placement', () => {
  it('accepts open ground and moves the ORP', () => {
    const d = expectOk(setOrp(T, defaultScenarioDefinition(T, 'bf'), { x: 200, y: -200 }));
    expect(d.orp).toEqual({ east: 200, north: -200 });
  });

  it('refuses water, buildings and the map edge, leaving the ORP where it was', () => {
    const d = defaultScenarioDefinition(T, 'bf');
    for (const [p, why] of [
      [{ x: -300, y: 300 }, /centre is in water \(lake\)/],
      [{ x: 150, y: 0 }, /centre is inside building B1/],
      [{ x: 495, y: 0 }, /does not fit here/],
      [{ x: 600, y: 0 }, /must be on the map/],
    ] as const) {
      const r = setOrp(T, d, p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem).toMatch(why);
    }
    expect(orpPlacementProblem(T, { x: 0, y: 0 })).toBeNull();
  });
});

describe('OPFOR route editing', () => {
  it('starts the route where the OPFOR is placed, then appends waypoints', () => {
    const d = playable();
    expect(d.opfor.route).toEqual([
      { east: 0, north: 400 },
      { east: 0, north: 100 },
      { east: 300, north: 50 },
    ]);
    expect(scenarioProblems(T, d)).toEqual([]);
  });

  it('moves, deletes and clears waypoints; moving the start moves the OPFOR', () => {
    let d = playable();
    d = expectOk(moveRouteWaypoint(T, d, 1, { x: 50, y: 150 }));
    expect(d.opfor.route[1]).toEqual({ east: 50, north: 150 });
    d = expectOk(setOpforStart(T, d, { x: -50, y: 450 }));
    expect(d.opfor.route[0]).toEqual({ east: -50, north: 450 });
    d = expectOk(deleteRouteWaypoint(T, d, 1));
    expect(d.opfor.route).toHaveLength(2);
    d = clearRoute(d);
    expect(d.opfor.route).toEqual([{ east: -50, north: 450 }]);
    expect(scenarioProblems(T, d)).toEqual([
      'Give the OPFOR a route: at least one waypoint after its start.',
    ]);
  });

  it('refuses waypoints in buildings or water, and routes the OPFOR cannot walk', () => {
    const d = playable();
    const inside = addRouteWaypoint(T, d, { x: 150, y: 0 });
    expect(inside.ok ? '' : inside.problem).toMatch(/inside building B1/);
    const wet = addRouteWaypoint(T, d, { x: -300, y: 300 });
    expect(wet.ok ? '' : wet.problem).toMatch(/in water \(lake\)/);
    const start = setOpforStart(T, d, { x: -300, y: 300 });
    expect(start.ok).toBe(false);
    expect(moveRouteWaypoint(T, d, 7, { x: 0, y: 0 }).ok).toBe(false);
    // The route crossing the map past the building is fine: legs are planned round it.
    expect(addRouteWaypoint(T, d, { x: 300, y: -50 }).ok).toBe(true);
  });
});

describe('the playable scenario', () => {
  it('puts the squad in the ORP and the OPFOR patrol at the route start, on the route', () => {
    const d = playable();
    const s = buildScenario(T, d);
    const squad = s.soldiers.filter((x) => x.side === 'BLUEFOR');
    const opfor = s.soldiers.filter((x) => x.side === 'OPFOR');
    expect(squad).toHaveLength(13);
    for (const m of squad) expect(orpContains(s.orp, m.position)).toBe(true);
    expect(s.orp.centre).toEqual({ east: 0, north: -300 });
    expect(opfor.map((o) => o.id)).toEqual(['EN-1', 'EN-2', 'EN-3']);
    expect(opfor[0]?.position).toEqual({ x: 0, y: 400 });
    // The rest follow in file, 12 m apart, behind the leader (north, since the route heads south).
    expect(opfor[1]?.position.y).toBeCloseTo(412, 6);
    expect(opfor[2]?.position.y).toBeCloseTo(424, 6);
    expect(opfor[0]?.azimuthDeg).toBeCloseTo(180, 6);
    expect(s.opforRoutes).toHaveLength(3);
    expect(s.opforRoutes[0]?.waypoints.map((w) => [w.x, w.y])).toEqual([
      [0, 100],
      [300, 50],
    ]);
    expect(s.units.find((u) => u.id === 'EN-TM')?.leaderId).toBe('EN-1');
  });

  it('is deterministic', () => {
    expect(buildScenario(T, playable())).toEqual(buildScenario(T, playable()));
  });

  it('builds a preview without OPFOR, and refuses a definition without an ORP', () => {
    const preview = buildScenario(T, defaultScenarioDefinition(T, 'bf'));
    expect(preview.soldiers.filter((x) => x.side === 'OPFOR')).toEqual([]);
    expect(() => buildScenario(T, { ...playable(), orp: null })).toThrow(/no ORP/);
  });

  it('plays as an ambush: execute, ready, START OPFOR, the patrol walks its route, the trainee springs the ambush', () => {
    const play = () => {
      const exercise = createExercise({
        config: { tickRateHz: 30, seed: 1 },
        scenario: buildScenario(T, playable()),
      });
      // A kill zone across the route's first leg (x = 0, from y = 400 down to 100).
      for (const p of square(0, 250, 40)) exercise.addKillZoneVertex(p);
      expect(exercise.execute().ok).toBe(true);
      for (let i = 0; i < 200 && exercise.phase === 'bluforOccupation'; i += 1)
        exercise.advance(1, 16);
      expect(exercise.phase).toBe('bluforReady');
      expect(exercise.startOpfor().ok).toBe(true);
      // Entering the kill zone does not spring the ambush (docs/adr/0021): the
      // trainee does, here once the first patrol member is in it.
      for (let i = 0; i < 30 * 4000 && (exercise.killZoneOccupancy()?.inside ?? 0) < 1; i += 1)
        exercise.advance(1 / 30);
      expect(exercise.phase).toBe('opforApproach');
      const entry = exercise.timeline.find((e) => e.type === 'killZoneEntered');
      expect(entry?.type === 'killZoneEntered' && entry.soldierId).toBe('EN-1');
      expect(exercise.triggerAmbush().ok).toBe(true);
      exercise.advance(1 / 30);
      expect(exercise.phase).toBe('engagement');
      return exercise;
    };
    const exercise = play();
    expect(exercise.trigger?.opforInKillZone).toBe(1);
    // Deterministic: the same scenario plays out identically.
    expect(hashSimState(play().simulation.state as never)).toBe(
      hashSimState(exercise.simulation.state as never),
    );
  });
});

describe('repeated edits on one shared terrain', () => {
  it('reuse its navigation data and give exactly the results of a fresh terrain', () => {
    // The editor shares one frozen terrain for the whole page (docs/adr/0015);
    // paths and grids remembered from earlier edits must change no answer.
    const shared = shareTerrain(terrain());
    const edits: ((t: TerrainDataset, d: ScenarioDefinition) => EditResult)[] = [
      (t, d) => setOpforStart(t, d, { x: -450, y: 450 }),
      (t, d) => addRouteWaypoint(t, d, { x: -150, y: 150 }), // round the lake
      (t, d) => addRouteWaypoint(t, d, { x: -300, y: 300 }), // in the lake: refused
      (t, d) => addRouteWaypoint(t, d, { x: 300, y: 0 }), // round the building
      (t, d) => moveRouteWaypoint(t, d, 1, { x: -250, y: 150 }),
      (t, d) => moveRouteWaypoint(t, d, 1, { x: -150, y: 150 }), // back again
      (t, d) => addRouteWaypoint(t, d, { x: 150, y: 0 }), // in the building: refused
      (t, d) => deleteRouteWaypoint(t, d, 1),
      (t, d) => addRouteWaypoint(t, d, { x: -450, y: 200 }),
    ];
    let onShared = defaultScenarioDefinition(shared, 'bf');
    let onFresh = defaultScenarioDefinition(terrain(), 'bf');
    expect(onShared).toEqual(onFresh);
    for (const edit of edits) {
      const a = edit(shared, onShared);
      const b = edit(terrain(), onFresh);
      expect(a).toEqual(b);
      if (a.ok && b.ok) {
        onShared = a.definition;
        onFresh = b.definition;
      }
      expect(scenarioProblems(shared, onShared)).toEqual(scenarioProblems(terrain(), onFresh));
      if (onShared.opfor.route.length >= 2) {
        const preview = createExercise({
          config: { tickRateHz: 30, seed: 1 },
          scenario: buildScenario(shared, onShared),
        });
        // The preview simulates on the shared terrain itself, not a copy.
        expect(preview.simulation.world.terrain).toBe(shared);
        const fresh = createExercise({
          config: { tickRateHz: 30, seed: 1 },
          scenario: buildScenario(terrain(), onFresh),
        });
        // The same planned paths for the patrol (turn points included).
        expect([...preview.opforRoutePaths]).toEqual([...fresh.opforRoutePaths]);
        expect(preview.scenarioFingerprint).toBe(fresh.scenarioFingerprint);
      }
    }
    expect(onShared.opfor.route).toHaveLength(3);
  });
});

describe('saving and reloading', () => {
  it('round-trips through JSON and rebuilds the same scenario', () => {
    const d = playable();
    const back = parseScenarioDefinition(JSON.parse(JSON.stringify(d)));
    expect(back).toEqual(d);
    expect(buildScenario(T, back)).toEqual(buildScenario(T, d));
  });

  it('refuses malformed or incompatible data with a reason', () => {
    const d = JSON.parse(JSON.stringify(playable())) as Record<string, unknown>;
    expect(() => parseScenarioDefinition({ ...d, schemaVersion: 2 })).toThrow(/schema version 2/);
    expect(() => parseScenarioDefinition({ ...d, opfor: { force: 'tanks', route: [] } })).toThrow(
      /force is unknown/,
    );
    expect(() => parseScenarioDefinition({ ...d, orp: { east: 'x' } })).toThrow(
      /ORP is not a map point/,
    );
    expect(() => parseScenarioDefinition(null)).toThrow(/not an object/);
  });
});

describe('a new scenario without an ORP', () => {
  it('has no ORP or OPFOR, and asks for the ORP before it can be played', () => {
    const d = defaultScenarioDefinition(T, 'bf-new', undefined, { withOrp: false });
    expect(d.orp).toBeNull();
    expect(d.opfor.route).toEqual([]);
    expect(scenarioProblems(T, d)[0]).toBe('Place the ORP.');
    expect(() => buildScenario(T, d)).toThrow(/no ORP/);
  });

  it('previews with the squad built but not placed, until the ORP is placed', () => {
    const d = defaultScenarioDefinition(T, 'bf-new', undefined, { withOrp: false });
    const before = buildPreviewScenario(T, d);
    expect(before.squadPlaced).toBe(false);
    // The squad exists (so the exercise has its organization), at the suggested ORP.
    expect(before.scenario.soldiers.some((s) => s.side === 'BLUEFOR')).toBe(true);
    expect(before.scenario.orp.centre).toEqual(defaultScenarioDefinition(T, 'bf-new').orp);
    const placed = expectOk(setOrp(T, d, { x: 0, y: 0 }));
    const after = buildPreviewScenario(T, placed);
    expect(after.squadPlaced).toBe(true);
    expect(after.scenario).toEqual(buildScenario(T, placed));
  });
});

describe('the terrain model a scenario was planned on (docs/adr/0032)', () => {
  it('is recorded, kept through edits and saving, and absent from older scenarios', () => {
    const d = defaultScenarioDefinition(DEMO_SCENARIO.terrain, 'demo');
    expect(d.terrainModel).toBe(terrainModelId(DEMO_SCENARIO.terrain));
    expect(d.terrainModel).toMatch(/^graded-v\d+$/);
    expect(parseScenarioDefinition(JSON.parse(JSON.stringify(d)))).toEqual(d);
    const older: Record<string, unknown> = { ...d };
    delete older['terrainModel'];
    expect(parseScenarioDefinition(older).terrainModel).toBeUndefined();
  });
});
