import { describe, expect, it } from 'vitest';
import { conditionOf, NO_FEATURES, type SimEvent, type VehicleCombat } from '#sim';
import { createMotionRecorder, emptyArticulation, MAX_LOGGED_MOUNTS } from '../motion-log';
import { labTerrain } from '../behavior-lab/run';
import { createBattle } from './battle';
import { RANGE_SCENARIOS, rangeTerrain } from './range-scenarios';
import {
  addSquad,
  battleSpecOf,
  newBattleScenario,
  parseBattleScenario,
  setSquadAntiTank,
  type BattleEdit,
  type BattleScenarioDefinition,
} from './scenario';
import { addVehicle, VEHICLE_KINDS } from './vehicles';

// Combined arms in scenarios, the motion log and the range
// (docs/combined-arms.md §11–§14): the four vehicles placed for either side
// and saved, squads' anti-tank weapons saved, files from before loading as
// they were; each vehicle's mounts and condition recorded per tick; and the
// range's scenarios fighting as described, the same every time.

const terrain = labTerrain(NO_FEATURES);
const done = (edit: BattleEdit): BattleScenarioDefinition => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};

describe('combined arms in a scenario', () => {
  it('places the four vehicles for either side, saves and loads them', () => {
    let d = newBattleScenario(terrain, 'bf');
    d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 0, y: -400 }));
    d = done(addSquad(terrain, d, 'OPFOR', 'squad', { x: 0, y: 400 }));
    VEHICLE_KINDS.forEach((kind, i) => {
      d = done(addVehicle(terrain, d, 'BLUEFOR', { x: -300 + i * 40, y: -300 }, 0, kind));
      d = done(addVehicle(terrain, d, 'OPFOR', { x: -300 + i * 40, y: 300 }, 180, kind));
    });
    expect(d.vehicles?.map((v) => v.kind)).toEqual([
      'm113',
      'm113',
      'm1a1',
      'm1a1',
      'bmp2',
      'bmp2',
      't72b',
      't72b',
    ]);
    expect(d.vehicles?.map((v) => v.name).slice(0, 4)).toEqual([
      'M113 1',
      'Enemy M113 2',
      'Abrams 3',
      'Enemy Abrams 4',
    ]);
    const again = parseBattleScenario(JSON.parse(JSON.stringify(d)));
    expect(again).toEqual(d);
    // An unknown vehicle is refused.
    const bad = JSON.parse(JSON.stringify(d)) as { vehicles: { kind: string }[] };
    (bad.vehicles[0] as { kind: string }).kind = 'tiger';
    expect(() => parseBattleScenario(bad)).toThrow(/tiger/);
  });

  it('saves a squad’s anti-tank weapons; without them, the default as before', () => {
    let d = newBattleScenario(terrain, 'bf');
    d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 0, y: -400 }));
    const id = d.squads[0]?.id ?? '';
    expect(d.squads[0]).not.toHaveProperty('antiTank');
    d = done(setSquadAntiTank(d, id, 'rocketsAndMissile'));
    expect(parseBattleScenario(JSON.parse(JSON.stringify(d))).squads[0]?.antiTank).toBe(
      'rocketsAndMissile',
    );
    expect(battleSpecOf(d, 30).squads[0]?.antiTank).toBe('rocketsAndMissile');
    d = done(setSquadAntiTank(d, id, null));
    expect(d.squads[0]).not.toHaveProperty('antiTank');
    const bad = JSON.parse(JSON.stringify(d)) as { squads: Record<string, unknown>[] };
    for (const q of bad.squads) q['antiTank'] = 'nukes';
    expect(() => parseBattleScenario(bad)).toThrow(/anti-tank/);
  });
});

describe('the motion log of vehicles', () => {
  it('records each tick’s mount angles, condition and fire, as the state had them', () => {
    const scenario = RANGE_SCENARIOS.find((s) => s.id === 'tank-duel');
    if (!scenario) throw new Error('no scenario');
    const battle = createBattle(scenario.spec, rangeTerrain());
    const log = createMotionRecorder(30);
    log.record(battle.sim.state);
    const expected: { tick: number; id: string; az: number; el: number; condition: string }[] = [];
    for (let i = 0; i < 40 * 30; i += 1) {
      battle.step();
      log.record(battle.sim.state);
      if (i % 97 === 0)
        for (const v of battle.sim.state.vehicles ?? [])
          expected.push({
            tick: battle.sim.tick,
            id: v.id,
            az: v.combat.mounts[0]?.azimuth ?? 0,
            el: v.combat.mounts[0]?.elevation ?? 0,
            condition: conditionOf(v.combat as VehicleCombat),
          });
    }
    const out = emptyArticulation();
    expect(out.mounts.length).toBe(MAX_LOGGED_MOUNTS * 2);
    for (const e of expected) {
      log.readArticulation(log.indexOf(e.id), e.tick, out);
      expect(out.mounts[0]).toBeCloseTo(e.az, 5);
      expect(out.mounts[1]).toBeCloseTo(e.el, 5);
      expect(out.condition).toBe(e.condition);
    }
    // The turrets turned during the fight.
    expect(expected.some((e) => Math.abs(e.az) > 1e-4 || Math.abs(e.el) > 1e-4)).toBe(true);
  });
});

describe('the combined-arms range', () => {
  it.each(RANGE_SCENARIOS.map((s) => [s.id, s] as const))(
    '%s: valid, fights, and runs the same twice',
    (_, scenario) => {
      const run = () => {
        const battle = createBattle(scenario.spec, rangeTerrain());
        const events: SimEvent[] = [];
        const seconds = Math.min(scenario.seconds, 100);
        for (let i = 0; i < seconds * 30; i += 1) events.push(...battle.step());
        return { battle, events };
      };
      const a = run();
      const fire = a.events.filter((e) => e.type === 'vehicleFire');
      expect(fire.length).toBeGreaterThan(0);
      // No rifle burst is ever aimed at a vehicle.
      const vehicles = new Set((scenario.spec.vehicles ?? []).map((v) => v.id));
      expect(a.events.some((e) => e.type === 'fofFire' && vehicles.has(e.targetId))).toBe(false);
      const b = run();
      expect(b.events).toEqual(a.events);
    },
    60_000,
  );

  it('anti-tank infantry and several vehicles end with vehicles knocked out', () => {
    for (const id of ['anti-tank', 'platoons']) {
      const scenario = RANGE_SCENARIOS.find((s) => s.id === id);
      if (!scenario) throw new Error(id);
      const battle = createBattle(scenario.spec, rangeTerrain());
      for (let i = 0; i < scenario.seconds * 30; i += 1) battle.step();
      const out = (battle.sim.state.vehicles ?? []).filter(
        (v) => conditionOf(v.combat as VehicleCombat) !== 'operational',
      );
      expect(out.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
