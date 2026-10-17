import { describe, expect, it } from 'vitest';
import { labTerrain } from '#exercise/behavior-lab';
import {
  addOrder,
  addSquad,
  addVehicle,
  addVehicleWaypoint,
  vehicleRangeRings,
  battleSpecOf,
  newBattleScenario,
  setKillZone,
  squadSoldierStarts,
  type BattleEdit,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import { VEHICLE_PLATFORMS, type Vec2 } from '#sim';
import { BATTLE_TICK_RATE_HZ } from './planner';
import {
  plannedVehicleLook,
  SQUAD_VIEWSHED_SECTOR,
  vehicleLook,
  viewshedObservers,
} from './squad-viewshed';

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

describe('the viewshed of a vehicle', () => {
  it('is from its turret, at its sights’ height, all round as far as its sights see', () => {
    const abrams = VEHICLE_PLATFORMS.find((p) => p.id === 'm1a1');
    const turret = abrams?.mounts.find((m) => m.parent === null);
    if (!abrams || !turret) throw new Error('no Abrams turret');
    // Heading east: the turret's pivot is that far ahead of the hull's centre, eastward.
    const look = vehicleLook('m1a1', { x: 100, y: 50 }, Math.PI / 2);
    const [eye] = look.observers;
    expect(eye?.x).toBeCloseTo(100 + turret.pivot.forward, 9);
    expect(eye?.y).toBeCloseTo(50 - turret.pivot.right, 9);
    expect(look.sectors).toEqual([
      {
        azimuth: 0,
        halfWidth: Math.PI,
        rangeM: vehicleRangeRings('m1a1').detectionM,
        eyeHeightM: abrams.sensors.eyeHeightM,
      },
    ]);
    expect(look.rangeM).toBe(3000);
  });

  it('planned: from its start facing as placed, or at a waypoint facing the way it came', () => {
    let d = newBattleScenario(terrain, 'bf');
    d = done(addVehicle(terrain, d, 'BLUEFOR', { x: 0, y: -400 }, 30, 'm1a1'));
    d = done(addVehicleWaypoint(terrain, d, 'V1', { x: 0, y: -100 }));
    d = done(addVehicleWaypoint(terrain, d, 'V1', { x: 300, y: -100 }));
    const v = d.vehicles?.[0];
    if (!v) throw new Error('no vehicle');
    const start = { x: v.position.east, y: v.position.north };
    expect(plannedVehicleLook(d, 'V1', null)).toEqual(
      vehicleLook('m1a1', start, (v.facingDeg * Math.PI) / 180),
    );
    // Waypoint 2, come from waypoint 1: heading east.
    expect(plannedVehicleLook(d, 'V1', 1)).toEqual(
      vehicleLook('m1a1', { x: 300, y: -100 }, Math.PI / 2),
    );
    expect(plannedVehicleLook(d, 'V1', 2)).toBeNull();
    expect(plannedVehicleLook(d, 'V9', null)).toBeNull();
  });
});
