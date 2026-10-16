import { describe, expect, it } from 'vitest';
import { labTerrain } from '#exercise/behavior-lab';
import {
  addOrder,
  addSquad,
  battleSpecOf,
  newBattleScenario,
  setKillZone,
  squadSoldierStarts,
  type BattleEdit,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import type { Vec2 } from '#sim';
import { BATTLE_TICK_RATE_HZ } from './planner';
import { SQUAD_VIEWSHED_SECTOR, viewshedObservers } from './squad-viewshed';

// Where a selected squad's viewshed is seen from (docs/constructive-simulation/03):
// its soldiers where they start, or where they will stand at a selected waypoint.

const terrain = labTerrain();
const done = (edit: BattleEdit): BattleScenarioDefinition => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};
const centre = (ps: readonly Vec2[]) => ({
  x: ps.reduce((a, p) => a + p.x, 0) / ps.length,
  y: ps.reduce((a, p) => a + p.y, 0) / ps.length,
});

function scenario(): BattleScenarioDefinition {
  let d = newBattleScenario(terrain, 'bf');
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 0, y: -400 }));
  d = done(addOrder(terrain, d, 'B1', 'move', { x: 0, y: -100 }));
  d = done(addOrder(terrain, d, 'B1', 'move', { x: 300, y: -100 }));
  d = done(addOrder(terrain, d, 'B1', 'ambush', { x: 300, y: 100 }));
  return done(setKillZone(terrain, d, 'B1', 2, { x: 380, y: 100 }));
}

describe('the viewshed observers of a squad', () => {
  const d = scenario();

  it('are its soldiers where the battle starts them', () => {
    const spec = battleSpecOf(d, BATTLE_TICK_RATE_HZ).squads[0];
    if (!spec) throw new Error('no squad');
    expect(viewshedObservers(terrain, d, 'B1', null)).toEqual(
      squadSoldierStarts(spec, 0, d.seed, terrain).map((s) => s.position),
    );
  });

  it('with a waypoint selected: the whole squad there, facing the way it came', () => {
    const north = viewshedObservers(terrain, d, 'B1', 0);
    const east = viewshedObservers(terrain, d, 'B1', 1);
    if (!north || !east) throw new Error('no observers');
    expect(north).toHaveLength(13);
    const c = centre(east);
    expect(Math.hypot(c.x - 300, c.y + 100)).toBeLessThan(15);
    // A wedge spreads across the way it moves: east–west going north, north–south going east.
    const spread = (ps: readonly Vec2[], axis: 'x' | 'y') =>
      Math.max(...ps.map((p) => p[axis])) - Math.min(...ps.map((p) => p[axis]));
    expect(spread(north, 'x')).toBeGreaterThan(spread(north, 'y'));
    expect(spread(east, 'y')).toBeGreaterThan(spread(east, 'x'));
  });

  it('at an ambush position: its firing line, across the way to the kill zone', () => {
    const line = viewshedObservers(terrain, d, 'B1', 2);
    if (!line) throw new Error('no observers');
    const xs = line.map((p) => p.x);
    const ys = line.map((p) => p.y);
    // The zone is east: the line runs north–south.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(
      3 * (Math.max(...xs) - Math.min(...xs)),
    );
  });

  it('none for an unknown squad or order; all round, as far as anyone can be detected', () => {
    expect(viewshedObservers(terrain, d, 'X9', null)).toBeNull();
    expect(viewshedObservers(terrain, d, 'B1', 7)).toBeNull();
    expect(SQUAD_VIEWSHED_SECTOR.halfWidth).toBe(Math.PI);
    expect(SQUAD_VIEWSHED_SECTOR.rangeM).toBe(1200);
  });
});
