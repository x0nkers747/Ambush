import { describe, expect, it } from 'vitest';
import { NO_FEATURES, pointProblem, rectangle, type SimEvent } from '#sim';
import { labTerrain } from '../behavior-lab/run';
import { createBattle, squadSoldierStarts } from './battle';
import { addVehicle } from './vehicles';
import {
  addOrder,
  addSquad,
  battleSpecOf,
  clearPlan,
  deleteOrder,
  deleteSquad,
  faceSquadToward,
  migrateAmbushScenario,
  SCENARIO_SCHEMA,
  type AmbushScenarioV1,
  moveOrder,
  moveSquad,
  newBattleScenario,
  parseBattleScenario,
  renameSquad,
  reorderOrder,
  scenarioIssues,
  scenarioSummary,
  setOrderKind,
  setSeed,
  setSquadFacing,
  setSquadFormation,
  setSquadOrganization,
  soldierStarts,
  type BattleEdit,
  type BattleScenarioDefinition,
} from './scenario';

// Battle scenarios (docs/constructive-simulation/03): the version 2 schema,
// migration from version 1, edits and checks.

const terrain = labTerrain();
/** The lab's ground with one building, 40 × 40 m, centred at (200, 200). */
const built = labTerrain({
  ...NO_FEATURES,
  buildings: [{ id: 'house', footprint: rectangle(200, 200, 40, 40), heightMeters: 8 }],
});

const done = (edit: BattleEdit): BattleScenarioDefinition => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};

/** Two BLUEFOR squads in the south, one OPFOR fire team in the north with a plan. */
function threeSquads(): BattleScenarioDefinition {
  let d = newBattleScenario(terrain, 'bf');
  d = done(addSquad(terrain, d, 'OPFOR', 'fireTeam', { x: 0, y: 400 }));
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: -150, y: -400 }));
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 150, y: -400 }));
  d = done(addOrder(terrain, d, 'O1', 'move', { x: 0, y: 200 }));
  return d;
}

const v1: AmbushScenarioV1 = {
  schema: SCENARIO_SCHEMA,
  schemaVersion: 1,
  id: 'bf/1',
  battlefieldId: 'bf',
  name: 'Ambush at the ford',
  orp: { east: 0, north: -300 },
  opfor: {
    force: 'patrol-3',
    route: [
      { east: 300, north: 300 },
      { east: 0, north: 0 },
      { east: -300, north: 0 },
    ],
  },
  terrainModel: 'model-1',
};

describe('migration from version 1', () => {
  it('makes the ORP a BLUEFOR squad and the patrol an OPFOR element moving along its route', () => {
    const d = migrateAmbushScenario(v1);
    expect(d.schemaVersion).toBe(2);
    expect(d.id).toBe('bf/battle');
    expect(d.name).toBe('Ambush at the ford');
    expect(d.terrainModel).toBe('model-1');
    const [blue, red] = d.squads;
    expect(blue).toMatchObject({
      id: 'B1',
      side: 'BLUEFOR',
      organization: 'squad',
      position: { east: 0, north: -300 },
      plan: [],
    });
    // Facing the patrol's start: 300 m east, 600 m north of it.
    expect(blue?.facingDeg).toBeCloseTo((Math.atan2(300, 600) * 180) / Math.PI, 5);
    expect(red).toMatchObject({
      id: 'O1',
      side: 'OPFOR',
      organization: 'element3',
      position: { east: 300, north: 300 },
      plan: [
        { kind: 'move', destination: { east: 0, north: 0 } },
        { kind: 'move', destination: { east: -300, north: 0 } },
      ],
    });
    expect(red?.facingDeg).toBeCloseTo(225, 5);
  });

  it('migrates a scenario without an ORP or a patrol to one without those squads', () => {
    expect(migrateAmbushScenario({ ...v1, orp: null }).squads.map((s) => s.id)).toEqual(['O1']);
    expect(
      migrateAmbushScenario({ ...v1, opfor: { force: 'patrol-3', route: [] } }).squads.map(
        (s) => s.id,
      ),
    ).toEqual(['B1']);
  });

  it('is what reading a stored version 1 scenario gives', () => {
    expect(parseBattleScenario(JSON.parse(JSON.stringify(v1)))).toEqual(migrateAmbushScenario(v1));
  });
});

describe('reading a stored scenario', () => {
  it('reads back what was saved', () => {
    const d = threeSquads();
    expect(parseBattleScenario(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('says what is wrong with one it cannot read', () => {
    const d = JSON.parse(JSON.stringify(threeSquads())) as Record<string, unknown>;
    const squads = d['squads'] as Record<string, unknown>[];
    const read = (patch: Record<string, unknown>) => () => parseBattleScenario({ ...d, ...patch });
    expect(read({ schema: 'other' })).toThrow(/schema/);
    expect(read({ schemaVersion: 3 })).toThrow(/version 3 is not supported/);
    expect(read({ seed: -1 })).toThrow(/seed/);
    expect(read({ squads: [{ ...squads[0], side: 'GREEN' }] })).toThrow(/side/);
    expect(read({ squads: [squads[0], squads[0]] })).toThrow(/used twice/);
    expect(read({ squads: [{ ...squads[0], organization: 'platoon' }] })).toThrow(/organization/);
    expect(read({ squads: [{ ...squads[0], plan: [{ kind: 'charge' }] }] })).toThrow(
      /order 1: the kind is unknown/,
    );
    expect(read({ squads: [{ ...squads[0], position: { east: 'x' } }] })).toThrow(/map point/);
    expect(() => parseBattleScenario({ ...v1, orp: { east: 1 } })).toThrow(/ORP/);
  });
});

describe('squads', () => {
  it('get ids and names by side, and face the nearest enemy', () => {
    const d = threeSquads();
    expect(d.squads.map((s) => [s.id, s.name])).toEqual([
      ['O1', 'Enemy fire team 1'],
      ['B1', '1st Squad'],
      ['B2', '2nd Squad'],
    ]);
    expect(d.squads[0]?.facingDeg).toBe(180);
    // B1, 150 m west and 800 m south of O1, faces it (rounded to the degree).
    expect(d.squads[1]?.facingDeg).toBe(Math.round((Math.atan2(150, 800) * 180) / Math.PI));
    expect(scenarioSummary(d)).toBe('2 BLUEFOR squads, 1 OPFOR squad');
  });

  it('reuse a freed id', () => {
    const d = done(deleteSquad(threeSquads(), 'B1'));
    const again = done(addSquad(terrain, d, 'BLUEFOR', 'element3', { x: 0, y: -300 }));
    expect(again.squads.at(-1)).toMatchObject({ id: 'B1', name: '1st Element' });
  });

  it('cannot be placed off the map', () => {
    expect(
      addSquad(built, newBattleScenario(built, 'bf'), 'BLUEFOR', 'squad', { x: 5000, y: 0 }),
    ).toMatchObject({ ok: false, problem: 'A squad must be on the map.' });
  });

  it('placed with soldiers in a building: only those soldiers move, each to the nearest clear ground', () => {
    const d = newBattleScenario(built, 'bf');
    const edge = addSquad(built, d, 'BLUEFOR', 'squad', { x: 200, y: 165 }, 0);
    if (!edge.ok) throw new Error(edge.problem);
    // The squad stays where it was put.
    expect(edge.definition.squads[0]?.position).toEqual({ east: 200, north: 165 });
    const [spec] = battleSpecOf(edge.definition, 30).squads;
    if (!spec) throw new Error('no squad');
    // Where the formation alone would put its soldiers.
    const formation = squadSoldierStarts(spec, 0, edge.definition.seed);
    const after = soldierStarts(built, edge.definition).get('B1') ?? [];
    expect(after).toHaveLength(13);
    let moved = 0;
    formation.forEach((f, k) => {
      const a = after[k];
      if (!a) throw new Error('missing soldier');
      expect(pointProblem(built, a.position)).toBeNull();
      if (pointProblem(built, f.position) === null) {
        // Clear where the formation puts him: exactly there.
        expect(a.position).toEqual(f.position);
      } else {
        moved += 1;
        // Out of the building, not far from where he would have stood.
        expect(Math.hypot(a.position.x - f.position.x, a.position.y - f.position.y)).toBeLessThan(
          30,
        );
      }
    });
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(13);
    expect(edge.note).toBe(
      `${String(moved)} of 1st Squad's soldiers ${moved === 1 ? 'was' : 'were'} moved clear of the buildings.`,
    );
    expect(scenarioIssues(built, edge.definition).filter((i) => i.squadId === 'B1')).toEqual([]);
  });

  it('placed on a roof, stays there, its soldiers standing round the building', () => {
    const d = newBattleScenario(built, 'bf');
    const onRoof = addSquad(built, d, 'BLUEFOR', 'fireTeam', { x: 200, y: 200 }, 0);
    if (!onRoof.ok) throw new Error(onRoof.problem);
    expect(onRoof.definition.squads[0]?.position).toEqual({ east: 200, north: 200 });
    expect(onRoof.note).toBe(
      "All 4 of 1st Fire team's soldiers were moved clear of the buildings.",
    );
    const after = soldierStarts(built, onRoof.definition).get('B1') ?? [];
    for (const a of after) expect(pointProblem(built, a.position)).toBeNull();
    // Kept apart: no two in one spot.
    for (const a of after)
      for (const b of after)
        if (a !== b)
          expect(
            Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y),
          ).toBeGreaterThan(1.4);
  });

  it('moved, or moved to clear ground, says only what it moved', () => {
    const d = newBattleScenario(built, 'bf');
    const placed = done(addSquad(built, d, 'BLUEFOR', 'squad', { x: 0, y: 0 }));
    const moved = moveSquad(built, placed, 'B1', { x: 200, y: 165 });
    if (!moved.ok) throw new Error(moved.problem);
    expect(moved.note).toMatch(
      /^\d+ of 1st Squad's soldiers? (was|were) moved clear of the buildings\.$/,
    );
    const exact = moveSquad(built, placed, 'B1', { x: 10, y: 20 });
    if (!exact.ok) throw new Error(exact.problem);
    expect(exact.note).toBeUndefined();
    expect(exact.definition.squads[0]?.position).toEqual({ east: 10, north: 20 });
  });

  it('turned or reformed so that soldiers would stand in a building: those soldiers move', () => {
    let d = newBattleScenario(built, 'bf');
    // In line facing north, across the building's south side: clear.
    d = done(addSquad(built, d, 'BLUEFOR', 'squad', { x: 200, y: 150 }, 0));
    d = done(setSquadFormation(built, d, 'B1', 'usmc.squad.line'));
    const turned = setSquadFacing(built, d, 'B1', 90);
    if (!turned.ok) throw new Error(turned.problem);
    // Facing east, the line runs north into the building.
    expect(turned.note).toMatch(
      /^\d+ of 1st Squad's soldiers? (was|were) moved clear of the buildings\.$/,
    );
    expect(scenarioIssues(built, turned.definition)).toEqual([]);
    const back = setSquadFacing(built, turned.definition, 'B1', 0);
    if (!back.ok) throw new Error(back.problem);
    expect(back.note).toBeUndefined();
    const reformed = setSquadOrganization(built, turned.definition, 'B1', 'fireTeam');
    if (!reformed.ok) throw new Error(reformed.problem);
    expect(reformed.definition.squads[0]?.organization).toBe('fireTeam');
  });

  it('are refused only where some soldiers have no clear ground near', () => {
    // A lake covering the whole lab ground but its margins.
    const lake = labTerrain({
      ...NO_FEATURES,
      water: [{ id: 'lake', kind: 'water', boundary: rectangle(0, 0, 2000, 2000) }],
    });
    const d = newBattleScenario(lake, 'bf');
    expect(addSquad(lake, d, 'OPFOR', 'squad', { x: 0, y: 0 })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/no clear ground within 200 m for 13 of/) as unknown,
    });
    // At the shore, it stays; those in the water step out of it.
    const ashore = addSquad(lake, d, 'OPFOR', 'squad', { x: 995, y: 0 }, 90);
    if (!ashore.ok) throw new Error(ashore.problem);
    expect(ashore.definition.squads[0]?.position).toEqual({ east: 995, north: 0 });
    expect(ashore.note).toMatch(/soldiers were moved out of the water\.$/);
    expect(scenarioIssues(lake, ashore.definition).filter((i) => i.squadId === 'O1')).toEqual([]);
  });

  it('are turned, renamed and reorganized', () => {
    let d = threeSquads();
    d = done(setSquadFacing(terrain, d, 'B1', -90));
    expect(d.squads[1]?.facingDeg).toBe(270);
    d = done(faceSquadToward(terrain, d, 'B1', { x: -150, y: 0 }));
    expect(d.squads[1]?.facingDeg).toBe(0);
    d = done(renameSquad(d, 'B1', '  Alpha  '));
    expect(d.squads[1]?.name).toBe('Alpha');
    expect(renameSquad(d, 'B1', ' ').ok).toBe(false);
    d = done(setSquadFormation(terrain, d, 'B1', 'usmc.squad.line'));
    expect(d.squads[1]?.formation).toBe('usmc.squad.line');
    expect(setSquadFormation(terrain, d, 'B1', 'no-such').ok).toBe(false);
    d = done(setSquadOrganization(terrain, d, 'B1', 'fireTeam'));
    expect(d.squads[1]?.organization).toBe('fireTeam');
    expect(d.squads[1]?.formation).toBeUndefined();
    expect(moveSquad(terrain, d, 'X9', { x: 0, y: 0 }).ok).toBe(false);
  });
});

describe('plans', () => {
  it('are built, edited and cleared order by order', () => {
    let d = threeSquads();
    d = done(addOrder(terrain, d, 'B1', 'move', { x: -150, y: -200 }));
    d = done(addOrder(terrain, d, 'B1', 'attack', { x: 0, y: 200 }));
    d = done(addOrder(terrain, d, 'B1', 'move', { x: -150, y: 0 }, 1));
    const plan = () => d.squads.find((s) => s.id === 'B1')?.plan.map((o) => o.kind);
    expect(plan()).toEqual(['move', 'move', 'attack']);
    d = done(setOrderKind(d, 'B1', 2, 'withdraw'));
    expect(plan()).toEqual(['move', 'move', 'withdraw']);
    d = done(reorderOrder(d, 'B1', 2, -1));
    expect(plan()).toEqual(['move', 'withdraw', 'move']);
    expect(reorderOrder(d, 'B1', 0, -1).ok).toBe(false);
    d = done(moveOrder(terrain, d, 'B1', 0, { x: -100, y: -250 }));
    expect(d.squads.find((s) => s.id === 'B1')?.plan[0]?.destination).toEqual({
      east: -100,
      north: -250,
    });
    d = done(deleteOrder(d, 'B1', 1));
    expect(plan()).toEqual(['move', 'move']);
    expect(deleteOrder(d, 'B1', 5).ok).toBe(false);
    d = done(clearPlan(d, 'B1'));
    expect(plan()).toEqual([]);
  });

  it('refuse a destination off the map, and move one in a building out of it', () => {
    const d = done(
      addSquad(built, newBattleScenario(built, 'bf'), 'OPFOR', 'squad', { x: 0, y: 0 }),
    );
    expect(addOrder(built, d, 'O1', 'move', { x: 0, y: 9000 })).toMatchObject({
      ok: false,
      problem: 'A destination must be on the map.',
    });
    const inside = addOrder(built, d, 'O1', 'attack', { x: 200, y: 200 });
    if (!inside.ok) throw new Error(inside.problem);
    expect(inside.note).toMatch(/^The destination was moved \d+ m, clear of the buildings\.$/);
    expect(scenarioIssues(built, inside.definition)).toEqual([]);
    const dragged = moveOrder(built, inside.definition, 'O1', 0, { x: 195, y: 205 });
    if (!dragged.ok) throw new Error(dragged.problem);
    expect(dragged.note).toMatch(/moved/);
  });
});

describe('what stops a scenario from being played', () => {
  it('no unit at all: one of either side (a squad or a vehicle) is enough', () => {
    const empty = newBattleScenario(terrain, 'bf');
    expect(scenarioIssues(terrain, empty).map((i) => i.message)).toEqual([
      'Place at least one unit.',
    ]);
    const d = done(addSquad(terrain, empty, 'BLUEFOR', 'squad', { x: 0, y: 0 }));
    expect(scenarioIssues(terrain, d)).toEqual([]);
    const car = done(addVehicle(terrain, empty, 'OPFOR', { x: 0, y: 0 }, 180, 't72b'));
    expect(scenarioIssues(terrain, car)).toEqual([]);
    expect(scenarioIssues(terrain, threeSquads())).toEqual([]);
  });

  it('soldiers with no clear ground near, and a destination that became a building', () => {
    const lake = labTerrain({
      ...NO_FEATURES,
      water: [{ id: 'lake', kind: 'water', boundary: rectangle(0, 0, 2000, 2000) }],
      buildings: [{ id: 'house', footprint: rectangle(1100, 1100, 40, 40), heightMeters: 8 }],
    });
    let d = newBattleScenario(lake, 'bf');
    d = done(addSquad(lake, d, 'BLUEFOR', 'squad', { x: 1100, y: -1100 }, 0));
    d = done(addSquad(lake, d, 'OPFOR', 'element3', { x: -1100, y: 1100 }));
    // As a scenario saved before, imported, or edited elsewhere can be: the
    // squad in mid-lake, a destination inside the building.
    d = {
      ...d,
      squads: d.squads.map((s) =>
        s.id === 'O1'
          ? { ...s, plan: [{ kind: 'move', destination: { east: 1100, north: 1100 } }] }
          : { ...s, position: { east: 0, north: 0 } },
      ),
    };
    const issues = scenarioIssues(lake, d);
    expect(issues.map((i) => [i.squadId, i.orderIndex])).toEqual([
      ['B1', null],
      ['O1', 0],
    ]);
    expect(issues[0]?.message).toMatch(
      /13 of its soldiers would start in water, in a building or off the map, with no clear ground within 200 m/,
    );
    expect(issues[1]?.message).toMatch(
      /order 1 \(Move\): The destination is inside building house/,
    );
  });

  it('memoizes reachability between checks', () => {
    const paths = new Map<string, string | null>();
    scenarioIssues(terrain, threeSquads(), paths);
    expect([...paths.values()]).toEqual([null]);
  });
});

describe('the battle a scenario makes', () => {
  it('has its squads, soldiers, seed and plans', () => {
    const d = done(setSeed(threeSquads(), 7));
    const spec = battleSpecOf(d, 30);
    expect(spec.seed).toBe(7);
    expect(spec.squads.map((s) => s.id)).toEqual(['O1', 'B1', 'B2']);
    // Each order with its actions on contact (a move's, by default: continue).
    expect(spec.squads[0]?.plan).toEqual([
      { kind: 'move', destination: { x: 0, y: 200 }, actionsOn: 'continue' },
    ]);
    const starts = soldierStarts(terrain, d);
    expect(starts.get('O1')).toHaveLength(4);
    expect(starts.get('B1')).toHaveLength(13);
    expect(setSeed(d, 1.5).ok).toBe(false);
  });

  it('runs: the OPFOR fire team carries out its move', () => {
    const battle = createBattle(battleSpecOf(threeSquads(), 30), terrain);
    const events: SimEvent[] = [];
    while (battle.sim.timeSeconds < 300) events.push(...battle.step());
    const o1 = events.flatMap((e) =>
      e.type === 'orderChanged' && e.unitId.startsWith('O1-') ? [e.to] : [],
    );
    expect(o1).toEqual(['active', 'completed']);
  });
});
