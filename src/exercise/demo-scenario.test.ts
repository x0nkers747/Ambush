import { describe, expect, it } from 'vitest';
import { createInitialState, heightAt } from '#sim';
import { DEMO_SCENARIO } from './demo-scenario';

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

  it('starts everyone without orders, standing on the terrain', () => {
    for (const s of state.soldiers) {
      expect(s.orders).toBeNull();
      expect(s.position.z).toBe(heightAt(DEMO_SCENARIO.terrain, s.position.x, s.position.y));
    }
  });
});
