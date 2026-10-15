import { describe, expect, it } from 'vitest';
import { labTerrain } from '#exercise/behavior-lab';
import {
  addOrder,
  addSquad,
  newBattleScenario,
  type BattleEdit,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import { battleNextBlocker, createPlanner, type BattleStage } from './planner';

// The battle planner (docs/constructive-simulation/03): the rules of Scenario
// Setup and BLUEFOR Planning that the map editor and the side panel use, in
// both the 2D and the 3D view.

const terrain = labTerrain();
const done = (edit: BattleEdit): BattleScenarioDefinition => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};

function twoSides(): BattleScenarioDefinition {
  let d = newBattleScenario(terrain, 'bf');
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 0, y: -400 }));
  d = done(addSquad(terrain, d, 'OPFOR', 'fireTeam', { x: 0, y: 400 }));
  return d;
}

function planner(stage: BattleStage, definition = twoSides()) {
  const saved: BattleScenarioDefinition[] = [];
  const notices: string[] = [];
  const p = createPlanner({
    terrain,
    definition,
    stage,
    save: (d) => {
      saved.push(d);
      return Promise.resolve();
    },
    notify: (m) => notices.push(m),
  });
  return { p, saved, notices };
}

describe('Scenario Setup', () => {
  it('places squads with the place tool, one per click, selecting each', () => {
    const { p, saved } = planner('scenario', newBattleScenario(terrain, 'bf'));
    p.setTool({ kind: 'place', side: 'OPFOR', organization: 'element3' });
    p.click({ x: 100, y: 300 });
    p.click({ x: -100, y: 300 });
    expect(p.definition.squads.map((s) => s.id)).toEqual(['O1', 'O2']);
    expect(p.selection).toEqual({ squadId: 'O2', orderIndex: null });
    expect(saved).toHaveLength(2);
  });

  it('gives OPFOR its plan, each click after the selected order', () => {
    const { p } = planner('scenario');
    p.select('O1');
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: 0, y: 200 });
    p.click({ x: 0, y: 0 });
    // Insert after order 1.
    p.select('O1', 0);
    p.setTool({ kind: 'order', order: 'attack' });
    p.click({ x: 100, y: 100 });
    expect(p.squad('O1')?.plan.map((o) => o.kind)).toEqual(['move', 'attack', 'move']);
    expect(p.selection).toEqual({ squadId: 'O1', orderIndex: 1 });
  });

  it('leaves BLUEFOR plans to planning', () => {
    const { p, notices } = planner('scenario');
    p.select('B1');
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: 0, y: -200 });
    expect(p.squad('B1')?.plan).toEqual([]);
    expect(notices.at(-1)).toMatch(/plan is made in BLUEFOR Planning/);
  });

  it('moves, turns and deletes squads; drags are saved when they end', () => {
    const { p, saved } = planner('scenario');
    expect(p.moveSquadTo('B1', { x: 10, y: -400 }, false)).toBe(true);
    expect(p.moveSquadTo('B1', { x: 20, y: -400 }, false)).toBe(true);
    expect(saved).toHaveLength(0);
    p.commit();
    expect(saved.at(-1)?.squads[0]?.position).toEqual({ east: 20, north: -400 });
    p.turnSquadToward('B1', { x: 120, y: -400 }, true);
    expect(p.squad('B1')?.facingDeg).toBe(90);
    p.select('B1');
    p.removeSquad('B1');
    expect(p.definition.squads.map((s) => s.id)).toEqual(['O1']);
    expect(p.selection.squadId).toBeNull();
  });

  it('refuses an edit with its reason and changes nothing', () => {
    const { p, notices, saved } = planner('scenario');
    const before = p.definition;
    expect(p.moveSquadTo('B1', { x: 9000, y: 0 }, true)).toBe(false);
    expect(p.definition).toBe(before);
    expect(saved).toHaveLength(0);
    expect(notices).toEqual(['A squad must be on the map.']);
  });
});

describe('BLUEFOR Planning', () => {
  it('starts on a BLUEFOR squad and plans BLUEFOR only', () => {
    const { p, notices } = planner('scenario');
    p.select('O1');
    p.setStage('bluefor');
    expect(p.selection.squadId).toBe('B1');
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: 0, y: -200 });
    p.setTool({ kind: 'order', order: 'withdraw' });
    p.click({ x: 0, y: -600 });
    expect(p.squad('B1')?.plan.map((o) => o.kind)).toEqual(['move', 'withdraw']);
    p.select('O1');
    p.click({ x: 0, y: 0 });
    expect(p.squad('O1')?.plan).toEqual([]);
    expect(notices.at(-1)).toMatch(/OPFOR: its plan is set in Scenario Setup/);
  });

  it('cannot place, move or delete squads', () => {
    const { p } = planner('bluefor');
    p.setTool({ kind: 'place', side: 'BLUEFOR', organization: 'squad' });
    expect(p.tool.kind).toBe('select');
    expect(p.moveSquadTo('B1', { x: 50, y: -400 }, true)).toBe(false);
    p.removeSquad('B1');
    expect(p.definition.squads).toHaveLength(2);
    // Turning its own squads is part of the plan.
    expect(p.turnSquadToward('B1', { x: 0, y: 0 }, true)).toBe(true);
    expect(p.turnSquadToward('O1', { x: 0, y: 0 }, true)).toBe(false);
  });

  it('removes an order and selects the one before it', () => {
    let d = twoSides();
    d = done(addOrder(terrain, d, 'B1', 'move', { x: 0, y: -300 }));
    d = done(addOrder(terrain, d, 'B1', 'attack', { x: 0, y: 300 }));
    const { p } = planner('bluefor', d);
    p.removeOrder('B1', 1);
    expect(p.squad('B1')?.plan.map((o) => o.kind)).toEqual(['move']);
    expect(p.selection).toEqual({ squadId: 'B1', orderIndex: 0 });
  });
});

describe('the stage gates', () => {
  it('Setup needs both sides, and every squad and OPFOR order valid', () => {
    const empty = planner('scenario', newBattleScenario(terrain, 'bf')).p;
    expect(empty.rules.next('scenario')).toBe('Place at least one BLUEFOR squad.');
    const { p } = planner('scenario');
    expect(p.rules.next('scenario')).toBeNull();
    expect(p.rules.next('bluefor')).toBeNull();
    expect(p.rules.back('scenario')).toBeNull();
  });

  it('a BLUEFOR plan problem blocks planning, not setup', () => {
    const d = twoSides();
    const bad: BattleScenarioDefinition = {
      ...d,
      squads: d.squads.map((s) =>
        s.id === 'B1'
          ? { ...s, plan: [{ kind: 'move', destination: { east: 9000, north: 0 } }] }
          : s,
      ),
    };
    const { p } = planner('scenario', bad);
    expect(battleNextBlocker('scenario', p.issues(), bad)).toBeNull();
    expect(battleNextBlocker('bluefor', p.issues(), bad)).toMatch(/destination must be on the map/);
    expect(battleNextBlocker('combat', p.issues(), bad)).toMatch(/next milestone/);
  });
});

describe('what the views show', () => {
  it('every soldier where it starts, and the battle’s starting state for the 3D figures', () => {
    const { p } = planner('scenario');
    const soldiers = p.soldiers();
    expect(soldiers.filter((s) => s.squadId === 'B1')).toHaveLength(13);
    expect(soldiers.filter((s) => s.squadId === 'O1')).toHaveLength(4);
    const figures = p.figures();
    expect(figures.soldiers.map((s) => s.id)).toEqual(soldiers.map((s) => s.id));
    expect(figures.log.indexOf(soldiers[0]?.id ?? '')).toBeGreaterThanOrEqual(0);
    expect(Object.values(figures.weapons).filter((w) => w === 'ak-assault-rifle')).toHaveLength(4);
    // Memoized per scenario.
    expect(p.figures()).toBe(figures);
    p.moveSquadTo('B1', { x: 30, y: -400 }, true);
    expect(p.figures()).not.toBe(figures);
  });
});
