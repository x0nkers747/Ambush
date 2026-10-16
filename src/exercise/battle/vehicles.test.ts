import { describe, expect, it } from 'vitest';
import { NO_FEATURES, rectangle } from '#sim';
import { createMotionRecorder } from '../motion-log';
import { labTerrain } from '../behavior-lab/run';
import { createBattle, orderVehicle } from './battle';
import {
  addSquad,
  battleSpecOf,
  newBattleScenario,
  parseBattleScenario,
  scenarioIssues,
  scenarioSummary,
  type BattleEdit,
  type BattleScenarioDefinition,
} from './scenario';
import {
  addVehicle,
  addVehicleWaypoint,
  deleteVehicle,
  deleteVehicleWaypoint,
  faceVehicleToward,
  moveVehicle,
  moveVehicleWaypoint,
} from './vehicles';

// Vehicles of a battle scenario (docs/vehicles.md): placed, routed, saved,
// and driven in the battle.

const terrain = labTerrain({
  ...NO_FEATURES,
  buildings: [{ id: 'house', footprint: rectangle(200, 200, 40, 40), heightMeters: 8 }],
});
const done = (edit: BattleEdit): BattleScenarioDefinition => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};

function withVehicle(): BattleScenarioDefinition {
  let d = newBattleScenario(terrain, 'bf');
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 0, y: -400 }));
  d = done(addSquad(terrain, d, 'OPFOR', 'fireTeam', { x: 0, y: 400 }));
  d = done(addVehicle(terrain, d, 'BLUEFOR', { x: -100, y: -300 }));
  d = done(addVehicleWaypoint(terrain, d, 'V1', { x: -100, y: -150 }));
  d = done(addVehicleWaypoint(terrain, d, 'V1', { x: 50, y: -100 }));
  return d;
}

describe('vehicles of a scenario', () => {
  it('places a vehicle facing north for BLUEFOR, with its route', () => {
    const d = withVehicle();
    expect(d.vehicles).toEqual([
      {
        id: 'V1',
        name: 'M113 1',
        side: 'BLUEFOR',
        kind: 'm113',
        position: { east: -100, north: -300 },
        facingDeg: 0,
        route: [
          { east: -100, north: -150 },
          { east: 50, north: -100 },
        ],
      },
    ]);
    expect(scenarioSummary(d)).toBe('1 BLUEFOR squad, 1 OPFOR squad, 1 vehicle');
    expect(scenarioIssues(terrain, d)).toEqual([]);
  });

  it('moves out of a building, turns, edits its route, and is deleted', () => {
    let d = withVehicle();
    const moved = moveVehicle(terrain, d, 'V1', { x: 200, y: 200 });
    expect(moved.ok && moved.note).toMatch(/moved/);
    d = done(moved);
    const at = d.vehicles?.[0]?.position;
    expect(Math.hypot((at?.east ?? 0) - 200, (at?.north ?? 0) - 200)).toBeGreaterThan(20);
    d = done(faceVehicleToward(d, 'V1', { x: (at?.east ?? 0) + 100, y: at?.north ?? 0 }));
    expect(d.vehicles?.[0]?.facingDeg).toBe(90);
    d = done(moveVehicleWaypoint(terrain, d, 'V1', 0, { x: 300, y: -200 }));
    d = done(deleteVehicleWaypoint(d, 'V1', 1));
    expect(d.vehicles?.[0]?.route).toEqual([{ east: 300, north: -200 }]);
    d = done(deleteVehicle(d, 'V1'));
    expect('vehicles' in d).toBe(false);
  });

  it('is saved and read back; a scenario without vehicles is as before', () => {
    const d = withVehicle();
    expect(parseBattleScenario(JSON.parse(JSON.stringify(d)))).toEqual(d);
    const none = done(deleteVehicle(d, 'V1'));
    expect(JSON.stringify(parseBattleScenario(JSON.parse(JSON.stringify(none))))).not.toMatch(
      /vehicles/,
    );
    expect(() => parseBattleScenario({ ...d, vehicles: [{ id: 'B1' }] })).toThrow(/vehicle/);
    expect(() =>
      parseBattleScenario({
        ...d,
        vehicles: [{ ...d.vehicles?.[0], kind: 'tank' }],
      }),
    ).toThrow(/kind/);
  });

  it('drives its route in the battle, recorded in the motion log after the soldiers', () => {
    const d = withVehicle();
    const spec = battleSpecOf(d, 30);
    expect(spec.vehicles).toHaveLength(1);
    const battle = createBattle(spec, terrain);
    const log = createMotionRecorder(30);
    log.record(battle.sim.state);
    const soldiers = battle.sim.state.soldiers.length;
    expect(log.soldierIds[soldiers]).toBe('V1');
    for (let k = 0; k < 30 * 90; k += 1) {
      battle.step();
      log.record(battle.sim.state);
    }
    const v = battle.sim.state.vehicles?.[0];
    expect(v?.orders.map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(Math.hypot((v?.position.x ?? 0) - 50, (v?.position.y ?? 0) + 100)).toBeLessThan(1.5);
    // The log has it where the state does.
    const sample = log.read(log.indexOf('V1'), log.lastTick, {
      x: 0,
      y: 0,
      z: 0,
      azimuth: 0,
      posture: 'standing',
      status: 'active',
    });
    expect(sample.x).toBeCloseTo(v?.position.x ?? NaN);
    expect(sample.azimuth).toBeCloseTo(v?.heading ?? NaN);
  });

  it('takes new orders in the battle: replacing its route, or after it', () => {
    const battle = createBattle(battleSpecOf(withVehicle(), 30), terrain);
    for (let k = 0; k < 30 * 5; k += 1) battle.step();
    battle.submit(orderVehicle(battle, 'V1', 'replace', [{ x: -300, y: -300 }]));
    battle.submit(orderVehicle(battle, 'V1', 'append', [{ x: -300, y: -200 }]));
    for (let k = 0; k < 30 * 120; k += 1) battle.step();
    const v = battle.sim.state.vehicles?.[0];
    expect(v?.orders.map((o) => o.status)).toEqual([
      'superseded',
      'superseded',
      'completed',
      'completed',
    ]);
    expect(Math.hypot((v?.position.x ?? 0) + 300, (v?.position.y ?? 0) + 200)).toBeLessThan(1.5);
    expect(() => orderVehicle(battle, 'V9', 'append', [])).toThrow(/no vehicle/);
  });
});
