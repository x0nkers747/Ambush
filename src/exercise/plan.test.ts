import { describe, expect, it } from 'vitest';
import { orgUnitId, soldierId, waypointId, type Soldier } from '#sim';
import { DEMO_SCENARIO } from './demo-scenario';
import { remainingPlan, samePlan, validatePlan, type SoldierPlan } from './plan';

const S = soldierId('S');
const wp = (id: string, x: number, y: number) => ({ id: waypointId(id), x, y });
const plan = (overrides: Partial<SoldierPlan> = {}): SoldierPlan => ({
  soldierId: S,
  waypoints: [wp('S.1', 0, 10), wp('S.2', 5, 20)],
  finalFacing: 1,
  ...overrides,
});

describe('remainingPlan', () => {
  const base: Soldier = {
    id: S,
    side: 'BLUEFOR',
    unitId: orgUnitId('U'),
    position: { x: 0, y: 0, z: 0 },
    azimuth: 2,
    posture: 'standing',
    status: 'active',
    orders: null,
  };

  it('is an empty route at the current facing for a soldier without orders', () => {
    expect(remainingPlan(base)).toEqual({ soldierId: S, waypoints: [], finalFacing: 2 });
  });

  it('drops the waypoints already reached and keeps their ids', () => {
    const orders = { waypoints: plan().waypoints, finalFacing: 1 };
    expect(
      remainingPlan({
        ...base,
        orders: {
          orders,
          nextWaypointIndex: 1,
          behavior: 'moving',
          legPaths: [[], []],
          nextTurnIndex: 0,
        },
      }),
    ).toEqual({ soldierId: S, waypoints: [wp('S.2', 5, 20)], finalFacing: 1 });
    expect(
      remainingPlan({
        ...base,
        orders: {
          orders,
          nextWaypointIndex: 2,
          behavior: 'inPosition',
          legPaths: [[], []],
          nextTurnIndex: 0,
        },
      }),
    ).toEqual({ soldierId: S, waypoints: [], finalFacing: 1 });
  });
});

describe('samePlan', () => {
  it('compares route points, ids and facing', () => {
    expect(samePlan(plan(), plan())).toBe(true);
    expect(samePlan(plan(), plan({ finalFacing: 1.0001 }))).toBe(false);
    expect(samePlan(plan(), plan({ waypoints: [wp('S.1', 0, 10)] }))).toBe(false);
    expect(samePlan(plan(), plan({ waypoints: [wp('S.1', 0, 10), wp('S.3', 5, 20)] }))).toBe(false);
    expect(samePlan(plan(), plan({ waypoints: [wp('S.1', 0, 10), wp('S.2', 5, 21)] }))).toBe(false);
    expect(samePlan(plan(), plan({ soldierId: soldierId('T') }))).toBe(false);
  });
});

describe('validatePlan', () => {
  const { terrain } = DEMO_SCENARIO;

  it('accepts a plan on the map', () => {
    expect(validatePlan(plan(), terrain)).toEqual([]);
  });

  it('reports waypoints off the map, repeated ids and invalid facings', () => {
    expect(
      validatePlan(
        plan({
          waypoints: [wp('S.1', 0, 10), wp('S.1', 0, 20), wp('S.3', 1000, 0)],
          finalFacing: 7,
        }),
        terrain,
      ),
    ).toEqual([
      'final facing 7 is not an azimuth in [0, 2π)',
      'waypoint 2 repeats id "S.1"',
      'waypoint 3 is off the map',
    ]);
  });
});
