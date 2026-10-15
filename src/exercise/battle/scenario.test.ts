import { describe, expect, it } from 'vitest';
import { NO_FEATURES, rectangle, type SimEvent } from '#sim';
import { labTerrain } from '../behavior-lab/run';
import { SCENARIO_SCHEMA, type ScenarioDefinition } from '../scenario-definition';
import { createBattle } from './battle';
import {
  addOrder,
  addSquad,
  battleSpecOf,
  clearPlan,
  deleteOrder,
  deleteSquad,
  faceSquadToward,
  migrateAmbushScenario,
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

const v1: ScenarioDefinition = {
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

  it('cannot stand off the map or in a building', () => {
    const d = newBattleScenario(built, 'bf');
    expect(addSquad(built, d, 'BLUEFOR', 'squad', { x: 5000, y: 0 })).toMatchObject({
      ok: false,
      problem: 'A squad must be on the map.',
    });
    expect(addSquad(built, d, 'BLUEFOR', 'squad', { x: 200, y: 200 })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/inside building house/) as unknown,
    });
    const placed = done(addSquad(built, d, 'BLUEFOR', 'squad', { x: 0, y: 0 }));
    expect(moveSquad(built, placed, 'B1', { x: 200, y: 200 }).ok).toBe(false);
    expect(done(moveSquad(built, placed, 'B1', { x: 10, y: 20 })).squads[0]?.position).toEqual({
      east: 10,
      north: 20,
    });
  });

  it('are turned, renamed and reorganized', () => {
    let d = threeSquads();
    d = done(setSquadFacing(d, 'B1', -90));
    expect(d.squads[1]?.facingDeg).toBe(270);
    d = done(faceSquadToward(d, 'B1', { x: -150, y: 0 }));
    expect(d.squads[1]?.facingDeg).toBe(0);
    d = done(renameSquad(d, 'B1', '  Alpha  '));
    expect(d.squads[1]?.name).toBe('Alpha');
    expect(renameSquad(d, 'B1', ' ').ok).toBe(false);
    d = done(setSquadFormation(d, 'B1', 'usmc.squad.line'));
    expect(d.squads[1]?.formation).toBe('usmc.squad.line');
    expect(setSquadFormation(d, 'B1', 'no-such').ok).toBe(false);
    d = done(setSquadOrganization(d, 'B1', 'fireTeam'));
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

  it('refuse a destination off the map or in a building', () => {
    const d = done(
      addSquad(built, newBattleScenario(built, 'bf'), 'OPFOR', 'squad', { x: 0, y: 0 }),
    );
    expect(addOrder(built, d, 'O1', 'move', { x: 0, y: 9000 })).toMatchObject({
      ok: false,
      problem: 'A destination must be on the map.',
    });
    expect(addOrder(built, d, 'O1', 'attack', { x: 200, y: 200 }).ok).toBe(false);
  });
});

describe('what stops a scenario from being played', () => {
  it('a side without a squad', () => {
    const d = done(
      addSquad(terrain, newBattleScenario(terrain, 'bf'), 'BLUEFOR', 'squad', { x: 0, y: 0 }),
    );
    expect(scenarioIssues(terrain, d).map((i) => i.message)).toEqual([
      'Place at least one OPFOR squad.',
    ]);
    expect(scenarioIssues(terrain, threeSquads())).toEqual([]);
  });

  it('soldiers starting in a building, and a destination that became one', () => {
    let d = newBattleScenario(built, 'bf');
    // The squad's centre is clear, but its formation reaches into the building.
    d = done(addSquad(built, d, 'BLUEFOR', 'squad', { x: 200, y: 170 }, 0));
    d = done(addSquad(built, d, 'OPFOR', 'element3', { x: 0, y: 600 }));
    d = {
      ...d,
      squads: d.squads.map((s) =>
        s.id === 'O1'
          ? { ...s, plan: [{ kind: 'move', destination: { east: 200, north: 200 } }] }
          : s,
      ),
    };
    const issues = scenarioIssues(built, d);
    expect(issues.map((i) => [i.squadId, i.orderIndex])).toEqual([
      ['B1', null],
      ['O1', 0],
    ]);
    expect(issues[0]?.message).toMatch(/of its soldiers would start in water, in a building/);
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
    expect(spec.squads[0]?.plan).toEqual([{ kind: 'move', destination: { x: 0, y: 200 } }]);
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
